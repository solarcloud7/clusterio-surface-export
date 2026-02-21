# Factorio Asset Resolution for the Web UI

## Goal

Serve arbitrary Factorio graphical assets (planet icons, item icons, technology icons, entity sprites, etc.) to the Clusterio Web UI — including assets from installed mods like Maraxis. The primary use case is planet icons next to platform locations, but the infrastructure supports any `__mod__/path` icon reference.

---

## Key Findings (Research)

### Factorio 2.0 headless server has no PNG files

The Factorio headless Docker container (`/opt/factorio/data/`) has virtually zero PNG files. All vanilla sprite data is packed into binary sprite sheets embedded in the executable. The `graphics/` subdirectories contain only `.lua` metadata files describing sprite sheet positions — the actual pixels are inaccessible.

```
/opt/factorio/data/space-age/graphics/entity/...  ← .lua metadata only
/opt/factorio/data/core/graphics/background-image.jpg  ← only image on disk
```

**Consequence**: Vanilla assets (Nauvis, Vulcanus, Gleba, Fulgora, Aquilo icons) cannot be read from disk at runtime. They must be bundled as static files in the plugin.

### Mod ZIPs DO contain PNG files

Mods distributed as `.zip` files store their assets as raw PNGs inside the zip. Confirmed for Maraxis:

```
maraxsis/graphics/planets/maraxsis.png
maraxsis/graphics/planets/maraxsis-starmap-icon.png
```

Node.js can read and extract these. The zip is at `/clusterio/mods/maraxsis_1.31.5.zip`.

### Factorio icon path format

All Factorio icon references use the `__modname__/path` convention, readable from prototype data at runtime:

```lua
-- Vanilla planets:
"__space-age__/graphics/icons/vulcanus.png"
"__space-age__/graphics/icons/gleba.png"

-- Modded planets:
"__maraxsis__/graphics/planets/maraxsis.png"

-- Items, technologies, entities follow the same pattern:
"__base__/graphics/icons/iron-plate.png"
"__space-age__/graphics/technology/tungsten-carbide.png"
```

The `__modname__` prefix maps directly to either `/opt/factorio/data/<modname>/` (vanilla, no PNG) or `/clusterio/mods/<modname>_<version>.zip` (mod, has PNG).

### `game.planets` gives planet prototype data

```lua
for name, planet in pairs(game.planets) do
    planet.prototype.icon          -- "__space-age__/graphics/icons/vulcanus.png"
    planet.prototype.starmap_icon  -- higher-res version
end
```

Any prototype with an `icon` field works the same way: items, technologies, entities, recipes, etc.

---

## Architecture

### The multi-instance problem

With multiple instances, every instance that starts could push asset data. The controller doesn't know which instance to prefer and there's a timing gap — the web UI might request icons before any instance has connected.

**Chosen approach — controller-pull on first request**: The controller caches resolved assets. On the first web UI request, if the cache is empty, the controller picks any running instance and asks it to resolve the requested asset paths. The instance does the filesystem/zip work and returns base64 data. All subsequent requests hit the cache.

### Asset resolution lives in the instance

Only the instance (Node.js plugin on the host) has filesystem access to `/opt/factorio/data/` and `/clusterio/mods/`. The controller and web UI are isolated from those paths.

### Delivery to the Web UI: WebSocket vs HTTP

Two options for the final hop from controller to browser:

**Option A — Base64 inside WebSocket messages (current plan)**
Web UI sends a `GetAssetsRequest` Clusterio message → controller returns `{ assets: { "path": "<base64>" } }` inline. The React component sets `src="data:image/png;base64,..."`.

**Option B — HTTP GET endpoints on the controller**
Controller registers `GET /api/surface_export/asset?path=__maraxsis__%2F...` on Express. Web UI uses plain `<img src="/api/surface_export/asset?path=...">` tags. Browser handles fetching, decoding, and caching natively.

**How Clusterio exposes HTTP routing to plugins** (confirmed from source):
The controller uses Express. `this.controller.app` on `BaseControllerPlugin` is the live Express `Application` instance. Plugins register routes directly in `init()`:
```js
// In controller.js init():
this.controller.app.get("/api/surface_export/asset", this.handleAssetHttp.bind(this));
```
There is no dedicated `addRoute()` hook — direct `controller.app` access is the mechanism.

| | **A — Base64 / WebSocket** | **B — HTTP endpoints** |
|---|---|---|
| Transport overhead | +33% size (base64 encoding) | Raw bytes, browser handles compression |
| Browser caching | None — refetched on every page load | Full `Cache-Control` / `ETag` — cached across refreshes and tabs |
| Implementation | Fits existing message pattern | One `app.get()` in `init()` |
| `<img>` tag usage | Requires `src="data:image/png;base64,..."` | Plain `src="/api/..."` — browser lazy-loads |
| Lazy loading | Manual — must fetch before render | Free — browser only fetches visible `<img>` tags |
| Auth | Inherited from WebSocket session | Must validate token on HTTP request (Clusterio uses JWT `x-access-token` header) |
| Works without running instance | Only if controller cache is warm | Same — controller cache must be warm |

**Recommendation: HTTP endpoints (Option B)**

For static assets like planet icons, HTTP is strictly better. The browser cache means a user who opens the UI twice pays the resolution cost only once. `<img src>` lazy loading is free. The only extra work is the auth check on the HTTP handler and URL-encoding the path parameter — both trivial.

The instance→controller leg (resolving zip assets) still uses the existing Clusterio message pattern (`ResolveAssetsRequest`). Only the controller→browser leg switches to HTTP.

### Generic asset API

The API resolves any `__mod__/path` string — planets, items, technologies, entities, anything with a Factorio icon path. The controller exposes two HTTP endpoints:

```
GET /api/surface_export/planet-icon/:planetName
→ 200 image/png  (raw bytes, Cache-Control: max-age=86400)
→ 404 if not resolvable (vanilla/missing)
→ 503 if no instance available

GET /api/surface_export/asset?path=__maraxsis__%2Fgraphics%2Fplanets%2Fmaraxsis.png
→ same, for generic asset resolution by raw Factorio path
```

Planet icons get a clean name-based route (`/planet-icon/maraxsis`) rather than exposing raw `__mod__/path` strings in URLs. The generic `/asset?path=` endpoint remains for future use with items, technologies, etc.

Both endpoints require a JWT token (`x-access-token` header or `?token=` query param).

### Instance routing for mod assets

When instances have different mod sets, the controller must ask the right instance. The controller maintains a `planetRegistry` map of `planet_name → { instanceId, iconPath, modName }` populated when instances register their planet data on startup. On a cache miss, the HTTP handler routes to the specific instance that reported the planet, falling back to any running instance if the registry entry is stale (instance restarted).

---

## Implementation Plan

### Phase 1 — Lua: Expose asset path discovery

The Lua side does **not** resolve pixels — it only knows prototype data (icon path strings). It exposes remote calls for callers to discover what paths are relevant.

**File**: `module/interfaces/remote/get-asset-paths.lua` (new)

```lua
local GetAssetPaths = {}

--- Return icon paths for all planets (vanilla + modded).
--- Caller resolves paths to actual image bytes.
--- @return table: { [planet_name] = { icon = "...", starmap_icon = "..." } }
function GetAssetPaths.get_planet_icon_paths()
    local result = {}
    if not game or not game.planets then return result end
    for name, planet in pairs(game.planets) do
        local proto = planet.prototype
        if proto then
            result[name] = {
                icon = proto.icon,
                starmap_icon = proto.starmap_icon,
            }
        end
    end
    return result
end

--- Return the icon path for a single prototype by type and name.
--- Works for items, technologies, entities, recipes, etc.
--- @param prototype_type string: "item", "technology", "entity", "recipe", ...
--- @param prototype_name string: e.g., "iron-plate", "space-science-pack"
--- @return string|nil: icon path like "__base__/graphics/icons/iron-plate.png"
function GetAssetPaths.get_prototype_icon_path(prototype_type, prototype_name)
    local proto = prototypes[prototype_type] and prototypes[prototype_type][prototype_name]
    if not proto then return nil end
    return proto.icon
end

return GetAssetPaths
```

Register in `module/interfaces/remote-interface.lua`:
```lua
local GetAssetPaths = require("modules/surface_export/interfaces/remote/get-asset-paths")

-- In the remote interface table:
["get_planet_icon_paths"]    = GetAssetPaths.get_planet_icon_paths,
["get_prototype_icon_path"]  = GetAssetPaths.get_prototype_icon_path,
```

These are called via RCON from instance.js as needed — no push, no per-tick cost.

### Phase 2 — Instance: Generic asset resolver

**File**: `instance.js` — handler + two helper functions

Register the handler in `init()`:
```js
this.instance.handle(messages.ResolveAssetsRequest, this.handleResolveAssets.bind(this));
```

**Handler** — called by the controller when it needs assets resolved:
```js
async handleResolveAssets(request) {
    const factorioDataDir = "/opt/factorio/data";
    const modsDir = "/clusterio/mods";
    const assets = {};

    for (const assetPath of request.paths) {
        try {
            const b64 = await resolveFactorioAsset(assetPath, factorioDataDir, modsDir);
            assets[assetPath] = b64 ?? null;  // null = not resolvable (vanilla/missing)
        } catch (err) {
            this.logger.warn(`Asset resolve failed for ${assetPath}: ${err.message}`);
            assets[assetPath] = null;
        }
    }

    return { assets };
}
```

**`resolveFactorioAsset()`** — core resolution logic (add to `helpers.js`):
```js
/**
 * Resolve a Factorio asset path like "__maraxsis__/graphics/planets/maraxsis.png"
 * to a base64-encoded string, or null if unavailable.
 *
 * Vanilla mods (space-age, base, core, quality, elevated-rails):
 *   Graphics are packed into the executable on headless — returns null.
 *   Falls back to filesystem check for forward-compatibility.
 *
 * Third-party mods:
 *   Reads from /clusterio/mods/<modname>_<version>.zip
 *
 * @param {string} assetPath  e.g. "__maraxsis__/graphics/planets/maraxsis.png"
 * @param {string} factorioDataDir  e.g. "/opt/factorio/data"
 * @param {string} modsDir  e.g. "/clusterio/mods"
 * @returns {Promise<string|null>}  base64 PNG or null
 */
async function resolveFactorioAsset(assetPath, factorioDataDir, modsDir) {
    const match = assetPath.match(/^__([^_](?:[^_]|_(?!_))*[^_]|[^_])__\/(.+)$/);
    if (!match) return null;

    const modName = match[1];    // e.g. "space-age", "maraxsis", "base"
    const filePath = match[2];   // e.g. "graphics/planets/maraxsis.png"

    const VANILLA_MODS = new Set(["space-age", "base", "core", "quality", "elevated-rails"]);

    if (VANILLA_MODS.has(modName)) {
        // Try filesystem (headless has no PNGs, but check for forward-compat)
        try {
            const bytes = await fs.readFile(path.join(factorioDataDir, modName, filePath));
            return bytes.toString("base64");
        } catch {
            return null;  // Expected on headless — caller uses bundled fallback
        }
    }

    // Third-party mod: find the zip
    const modFiles = await fs.readdir(modsDir);
    const zipFile = modFiles.find(f => f.startsWith(modName + "_") && f.endsWith(".zip"));
    if (!zipFile) return null;

    return extractFromModZip(path.join(modsDir, zipFile), modName, filePath);
}

/**
 * Extract a single file from a Factorio mod zip by its in-mod path.
 * Uses yauzl for async, lazy, streaming extraction — never blocks the event loop
 * and only reads the specific entry rather than loading the entire zip into memory.
 *
 * Mod zips use either "<modname>/<path>" or "<modname>_<version>/<path>" as root.
 *
 * @param {string} zipPath   Full path to the .zip file
 * @param {string} modName   e.g. "maraxsis"
 * @param {string} filePath  e.g. "graphics/planets/maraxsis.png"
 * @returns {Promise<string|null>}  base64 or null if not found
 */
function extractFromModZip(zipPath, modName, filePath) {
    const yauzl = require("yauzl");
    return new Promise((resolve, reject) => {
        // lazyEntries: true — reads central directory index, then yields entries
        // one at a time as readEntry() is called. Stops as soon as target is found.
        yauzl.open(zipPath, { lazyEntries: true }, (err, zipFile) => {
            if (err) return reject(err);

            zipFile.readEntry();

            zipFile.on("entry", entry => {
                const parts = entry.fileName.split("/");
                const root = parts[0];
                const rest = parts.slice(1).join("/");
                // Match "maraxsis/path" or "maraxsis_1.31.5/path"
                const rootMatches = root === modName || root.startsWith(modName + "_");

                if (rootMatches && rest === filePath) {
                    zipFile.openReadStream(entry, (err, stream) => {
                        if (err) return reject(err);
                        const chunks = [];
                        stream.on("data", chunk => chunks.push(chunk));
                        stream.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
                        stream.on("error", reject);
                    });
                } else {
                    zipFile.readEntry();  // advance to next entry
                }
            });

            zipFile.on("end", () => resolve(null));  // entry not found
            zipFile.on("error", reject);
        });
    });
}
```

**Dependency**: Add to `package.json`:
```json
"yauzl": "^2.10.0"
```

> **Why yauzl over adm-zip**: `adm-zip`'s constructor (`new AdmZip(path)`) reads the *entire zip into memory synchronously*, blocking the Node.js event loop for the duration — 10–50ms for a typical mod zip. Since the instance Node.js process also handles Clusterio message routing and RCON I/O, a synchronous block can delay those operations. `yauzl` uses `lazyEntries: true` to read only the central directory index on open, then streams individual entries on demand — it never blocks the event loop and uses minimal memory regardless of zip size.

### Phase 3 — Messages: Three message types

**File**: `messages.js`

```js
// Controller → Instance: resolve a list of __mod__/path strings to base64
class ResolveAssetsRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "controller";
    static dst = "instance";
    static jsonSchema = {
        type: "object",
        properties: {
            paths: { type: "array", items: { type: "string" } },
        },
        required: ["paths"],
        additionalProperties: false,
    };

    constructor(json) { this.paths = json.paths; }
    static fromJSON(json) { return new ResolveAssetsRequest(json); }
    toJSON() { return { paths: this.paths }; }

    static Response = {
        jsonSchema: {
            type: "object",
            properties: {
                assets: {
                    type: "object",
                    additionalProperties: { type: ["string", "null"] },
                },
            },
            required: ["assets"],
        },
        fromJSON(json) { return json; },
    };
}

// Instance → Controller: register which planets this instance has and their icon paths.
// Sent on instance startup. Enables the controller to route HTTP cache-miss requests
// to the specific instance that has the mod installed.
class RegisterPlanetPathsRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "instance";
    static dst = "controller";
    static jsonSchema = {
        type: "object",
        properties: {
            planets: {
                type: "object",
                additionalProperties: {
                    type: "object",
                    properties: {
                        iconPath: { type: "string" },   // "__maraxsis__/graphics/planets/maraxsis.png"
                        modName:  { type: "string" },   // "maraxsis"
                    },
                    required: ["iconPath", "modName"],
                    additionalProperties: false,
                },
            },
        },
        required: ["planets"],
        additionalProperties: false,
    };

    constructor(json) { this.planets = json.planets; }
    static fromJSON(json) { return new RegisterPlanetPathsRequest(json); }
    toJSON() { return { planets: this.planets }; }

    static Response = {
        jsonSchema: { type: "object", additionalProperties: false },
        fromJSON(json) { return json; },
    };
}

// Controller → Instance: get planet icon paths via RCON (used to populate planet registry)
class GetPlanetIconPathsRequest {
    static plugin = PLUGIN_NAME;
    static type = "request";
    static src = "controller";
    static dst = "instance";
    static jsonSchema = { type: "object", additionalProperties: false };

    constructor() {}
    static fromJSON() { return new GetPlanetIconPathsRequest(); }
    toJSON() { return {}; }

    static Response = {
        jsonSchema: {
            type: "object",
            properties: {
                planets: {
                    type: "object",
                    additionalProperties: {
                        type: "object",
                        properties: {
                            iconPath: { type: "string" },
                            modName:  { type: "string" },
                        },
                    },
                },
            },
            required: ["planets"],
        },
        fromJSON(json) { return json; },
    };
}
```

Register all three in `index.js` `messages` array.

### Phase 4 — Controller: HTTP endpoints + pull-on-demand cache

**File**: `controller.js`

The controller stores resolved assets as raw `Buffer` objects. The instance→controller leg uses a Clusterio WebSocket message (`ResolveAssetsRequest`, returns base64). The controller decodes base64→Buffer and serves raw bytes over HTTP — no base64 penalty on the browser-facing leg.

> **Note**: `this.controller.app` is a live Express `Application` instance, confirmed from Clusterio source. There is no `addWebRoutes()` hook — plugins register routes directly via `this.controller.app.get(...)` in `init()`.

```js
// In init():
// Buffer cache: __mod__/path → Buffer (raw PNG) | null (not resolvable)
this.assetCache = new Map();
// Planet registry: planet_name → { instanceId, iconPath, modName }
// Populated when instances register their planet data on startup.
// Enables routing cache-miss requests to the specific instance that has the mod.
this.planetRegistry = new Map();

this.controller.handle(messages.ResolveAssetsRequest, this.handleResolveAssets.bind(this));
this.controller.handle(messages.RegisterPlanetPathsRequest, this.handleRegisterPlanetPaths.bind(this));

// Clean name-based route for planet icons (no internal path strings in URLs)
this.controller.app.get("/api/surface_export/planet-icon/:planetName", this.handlePlanetIconHttp.bind(this));
// Generic route for arbitrary Factorio asset paths (items, tech, etc.)
this.controller.app.get("/api/surface_export/asset", this.handleAssetHttp.bind(this));
```

```js
handleRegisterPlanetPaths(request, src) {
    for (const [planetName, data] of Object.entries(request.planets || {})) {
        this.planetRegistry.set(planetName, {
            instanceId: src.instanceId,
            iconPath: data.iconPath,
            modName: data.modName,
        });
    }
    return {};
}

// Shared auth helper
async verifyRequestToken(req, res) {
    const token = req.headers["x-access-token"] || req.query.token;
    if (!token) { res.status(401).end(); return false; }
    try {
        const secret = this.controller.config.get("controller.auth_secret");
        await lib.verifyToken(token, secret, "user");
        return true;
    } catch {
        res.status(403).end();
        return false;
    }
}

async handlePlanetIconHttp(req, res) {
    if (!await this.verifyRequestToken(req, res)) return;
    const { planetName } = req.params;

    // Look up the icon path from the registry
    const entry = this.planetRegistry.get(planetName);
    if (!entry) return res.status(404).end();

    return this.serveAsset(req, res, entry.iconPath, entry.instanceId);
}

async handleAssetHttp(req, res) {
    if (!await this.verifyRequestToken(req, res)) return;
    const assetPath = req.query.path;
    if (!assetPath || typeof assetPath !== "string") return res.status(400).end();

    return this.serveAsset(req, res, assetPath, null);
}

// Shared resolution + serving logic used by both routes
async serveAsset(req, res, assetPath, preferredInstanceId) {
    // Cache hit
    if (this.assetCache.has(assetPath)) {
        const buf = this.assetCache.get(assetPath);
        if (!buf) return res.status(404).end();
        return this.sendImageBuffer(req, res, buf);
    }

    // Cache miss: route to preferred instance first, fall back to any running instance
    const instances = [...this.controller.instances.values()];
    const target =
        (preferredInstanceId && instances.find(i => i.id === preferredInstanceId && i.status === "running")) ||
        instances.find(i => i.status === "running");

    if (!target) return res.status(503).json({ error: "no running instance" });

    try {
        const response = await this.controller.sendTo(
            target.id,
            new messages.ResolveAssetsRequest({ paths: [assetPath] })
        );
        const b64 = response.assets?.[assetPath];
        const buf = b64 ? Buffer.from(b64, "base64") : null;
        this.assetCache.set(assetPath, buf);
        if (!buf) return res.status(404).end();
        return this.sendImageBuffer(req, res, buf);
    } catch (err) {
        this.logger.warn(`Asset resolve failed for ${assetPath}: ${err.message}`);
        return res.status(500).end();
    }
}

sendImageBuffer(req, res, buf) {
    const etag = `"${buf.length}"`;
    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "max-age=86400, immutable");
    res.setHeader("ETag", etag);
    return res.send(buf);
}
```

The `planetRegistry` is populated by instances on startup via `RegisterPlanetPathsRequest`. On a cache miss, the controller routes to the specific instance that reported the planet, ensuring mod assets are fetched from an instance that actually has the mod installed.

### Phase 5 — Web UI: Plain `<img src>` with HTTP asset URLs

With HTTP delivery, the web UI needs only to build a URL per planet name — no base64 state, no WebSocket round-trip on render. The planet registry is populated by instances at startup, so the controller already knows the icon path for each planet name.

**`planetIconUrl()` utility** (add to `web/utils.js`):
```js
/**
 * Build a URL for the controller's planet-icon endpoint.
 * The browser fetches this as a plain HTTP GET (raw PNG),
 * and caches the result using Cache-Control / ETag headers.
 *
 * @param {string} planetName  e.g. "maraxsis", "vulcanus"
 * @param {string} token       Clusterio user JWT
 * @returns {string}  URL suitable for <img src>
 */
export function planetIconUrl(planetName, token) {
    return `/api/surface_export/planet-icon/${encodeURIComponent(planetName)}?token=${token}`;
}
```

**`PlanetIcon` component** — plain `<img>` for mod planets, bundled static for vanilla, `onError` fallback for everything else:

```jsx
// Bundled vanilla planet icons — static webpack assets, zero HTTP requests.
// Vanilla PNGs are not available on headless Factorio server, so they're bundled.
const VANILLA_PLANET_ICONS = {
    "nauvis":   new URL("../assets/planets/nauvis.png",   import.meta.url).href,
    "vulcanus": new URL("../assets/planets/vulcanus.png", import.meta.url).href,
    "gleba":    new URL("../assets/planets/gleba.png",    import.meta.url).href,
    "fulgora":  new URL("../assets/planets/fulgora.png",  import.meta.url).href,
    "aquilo":   new URL("../assets/planets/aquilo.png",   import.meta.url).href,
};
const DEFAULT_PLANET_ICON = new URL("../assets/planets/default-planet.svg", import.meta.url).href;

function PlanetIcon({ planetName, token, size = 24 }) {
    // Vanilla planets use bundled static assets (always available, no HTTP).
    // Mod planets use the controller HTTP endpoint (browser-cached after first fetch).
    const src = VANILLA_PLANET_ICONS[planetName]
        ?? planetIconUrl(planetName, token);

    return (
        <img
            src={src}
            alt={planetName}
            title={planetName}
            style={{ width: size, height: size, objectFit: "contain", verticalAlign: "middle" }}
            loading="lazy"
            onError={(e) => { e.target.onerror = null; e.target.src = DEFAULT_PLANET_ICON; }}
        />
    );
}
```

The `onError` handler catches any failure (instance offline, mod not installed, 404) and swaps in a default SVG — no broken image icons, no crash. Setting `e.target.onerror = null` prevents infinite loops if the fallback itself fails.

Use in the platform table:
```jsx
// token from Clusterio control session
const token = control.connector?.token ?? "";
// In the location column render:
<Space>
    <PlanetIcon planetName={platform.spaceLocation} token={token} />
    <span>{locationLabel(platform, nowMs)}</span>
</Space>
```

No hooks, no state, no `useEffect` in the component. The browser fetches each `<img src>` lazily as it enters the viewport and caches the result across page loads.

**Generic asset URL utility** — for any non-planet Factorio icon path (items, technologies, entities):

```js
/**
 * Build a URL for the generic asset endpoint.
 * Use this for any __mod__/path icon reference from Factorio prototype data
 * that is NOT a planet (items, technologies, entities, recipes, etc.).
 *
 * The caller is responsible for supplying the correct __mod__/path string,
 * typically sourced from a Lua remote call that reads prototype.icon.
 *
 * @param {string} factorioPath  e.g. "__base__/graphics/icons/iron-plate.png"
 * @param {string} token         Clusterio user JWT
 * @returns {string}  URL suitable for <img src>
 */
export function factorioAssetUrl(factorioPath, token) {
    return `/api/surface_export/asset?path=${encodeURIComponent(factorioPath)}&token=${token}`;
}
```

**Generic `FactorioIcon` component** — for any asset path, no bundled fallback:

```jsx
const DEFAULT_ICON = new URL("../assets/planets/default-planet.svg", import.meta.url).href;

function FactorioIcon({ assetPath, label, token, size = 24 }) {
    if (!assetPath) return <Tag>{label}</Tag>;
    return (
        <img
            src={factorioAssetUrl(assetPath, token)}
            alt={label}
            title={label}
            style={{ width: size, height: size, objectFit: "contain", verticalAlign: "middle" }}
            loading="lazy"
            onError={(e) => { e.target.onerror = null; e.target.src = DEFAULT_ICON; }}
        />
    );
}
```

Usage examples:
```jsx
const token = control.connector?.token ?? "";

// Planet (name-based route, bundled vanilla fallback):
<PlanetIcon planetName="maraxsis" token={token} />

// Item icon (generic path route, no bundled fallback):
<FactorioIcon assetPath="__base__/graphics/icons/iron-plate.png" label="iron-plate" token={token} />

// Technology icon:
<FactorioIcon assetPath="__space-age__/graphics/technology/tungsten-carbide.png" label="tungsten-carbide" token={token} />
```

The `assetPath` for items and technologies must come from somewhere — either hardcoded, or from a Lua remote call that reads `prototypes["item"]["iron-plate"].icon`. The existing `get_prototype_icon_path(type, name)` remote function in Phase 1 covers this: call it via RCON when you need a specific prototype's icon path.

---

## File Summary

| File | Change |
|------|--------|
| `module/interfaces/remote/get-asset-paths.lua` | New: `get_planet_icon_paths()` + `get_prototype_icon_path()` remote functions |
| `module/interfaces/remote-interface.lua` | Register both new remote functions |
| `helpers.js` | Add `resolveFactorioAsset()` + `extractFromModZip()` |
| `instance.js` | Add `handleResolveAssets()` handler; on `onStart` send `RegisterPlanetPathsRequest` |
| `messages.js` | Add `ResolveAssetsRequest` + `RegisterPlanetPathsRequest` + `GetPlanetIconPathsRequest` |
| `index.js` | Register all new message classes in `messages` array |
| `controller.js` | Register `GET /api/surface_export/planet-icon/:name` + `/asset` on `this.controller.app`; `planetRegistry` Map; Buffer cache |
| `web/utils.js` | Add `planetIconUrl()` (planet name → URL) + `factorioAssetUrl()` (generic `__mod__/path` → URL) |
| `web/ManualTransferTab.jsx` | Add `PlanetIcon` (planet-specific, bundled fallback) + `FactorioIcon` (generic); render in location column |
| `web/assets/planets/` | Bundled PNGs for vanilla planets + `default-planet.svg` fallback |
| `package.json` | Add `"yauzl": "^2.10.0"` |

New files: ~7 (1 Lua, 5 PNGs, counts as minor). Lines added: ~200 across JS files.

---

## Caveats and Limitations

### Vanilla planet icons must be bundled
The Factorio 2.0 headless server has no PNG files on disk — vanilla assets are compiled into binary sprite sheets. Bundle the 5 vanilla planet icons as static files in `web/assets/planets/`. The `PlanetIcon` component uses dynamic resolution first (catches mods) and falls back to bundled assets for vanilla planets. Check Factorio's [asset usage policy](https://factorio.com/terms-of-service) before bundling.

### `yauzl` dependency
Pure JavaScript, MIT licensed, no native bindings. It is the standard zip reader used by Electron, VS Code's extension host, and npm itself. `lazyEntries: true` means it reads the central directory index on open, then yields entries one at a time — only the bytes you actually need are read. Alternative if you want zero new dependencies: use Node's built-in `zlib.inflateRaw()` to implement minimal DEFLATE extraction (~60 lines), but yauzl handles edge cases (data descriptors, zip64, encoding) that manual implementations miss.

### Cache invalidation
The controller-side `Map` cache is in-memory. It's cleared on controller restart. If a mod is updated (new zip), the cache naturally clears on the next restart. If you need forced cache invalidation, add a `ClearAssetCacheRequest` endpoint (trivial: `this.assetCache.clear()`).

### Response size and caching
Each planet icon HTTP response is raw PNG bytes (~50–200 KB for a typical starmap icon). The browser caches each URL individually under `Cache-Control: max-age=86400, immutable`. On subsequent page loads, the browser sends `If-None-Match` and gets `304 Not Modified` with zero body bytes — no controller work, no instance involvement. The WebSocket leg (instance→controller) carries base64 only on the first resolution, after which the controller Buffer cache handles all subsequent HTTP requests without touching the instance.

### Asset path regex
The `__modname__` regex in `resolveFactorioAsset()` handles hyphenated mod names (`space-age`, `elevated-rails`) correctly. Verify for any mod with unusual naming.

### Instance registry vs pull-on-demand
The `planetRegistry` is populated by `RegisterPlanetPathsRequest` sent from each instance on `onStart`. If an instance restarts and re-sends, the registry entry is simply overwritten with the new `instanceId`. The `serveAsset()` fallback (any running instance) handles the gap between restart and re-registration. For the generic `/asset?path=` endpoint where no registry entry exists, any running instance is used — mod assets will fail if that instance doesn't have the mod, but this endpoint is intended for cross-instance generic use rather than instance-specific mods.

---

## Testing

1. Start cluster: `docker compose up -d`
2. Open Web UI → confirm planet icons appear in the Manual Transfer tab location column
3. Maraxis: ensure `/clusterio/mods/maraxsis_*.zip` exists on host-1 and the planet appears in platform schedules
4. Vanilla planets: confirm bundled fallback images render for Nauvis/Vulcanus/etc.
5. Unknown planet: confirm graceful `<Tag>` text fallback (no crash, no broken image)
6. Restart controller: confirm cache refills on next icon request without errors

## What "done" looks like

- `useFactorioAssets(control, paths)` is a reusable hook for any Factorio asset by `__mod__/path`
- Planet location column shows icons: Maraxis from zip, vanilla from bundled PNGs, unknown as text tag
- Controller logs show cache hits after first request
- No errors, no polling, no per-tick overhead
