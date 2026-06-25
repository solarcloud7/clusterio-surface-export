# Static-Asset Caching: the stale-chunk problem (and the one-line-ish fix)

## Contents

- [Behavior](#behavior)
- [Symptom](#symptom)
- [Why content-hashing is required](#why-content-hashing-is-required)
- [Content-hashing configuration](#content-hashing-configuration)
- [Dev-workflow consequence](#dev-workflow-consequence)
- [Verification](#verification)
- [References](#references)

## Behavior

The controller serves every `/static/*` asset with `Cache-Control: public, max-age=31536000, immutable`.
`immutable` is only safe for content-hashed filenames. The surface_export plugin's webpack output is
content-hashed (`static/[name].[contenthash].js`), so a content change yields a new URL and returning
users can never serve a stale chunk.

The hashing is entirely in this plugin — no Clusterio core change. Clusterio's shared web config
content-hashes by default; the plugin's [webpack.config.js](../docker/seed-data/external_plugins/surface_export/webpack.config.js)
inherits that rather than overriding it back to fixed names. The controller resolves the plugin's
remote-entry filename through `dist/web/manifest.json` (shipped via the `/api/plugins` route — not the
immutable `/static` cache), so even the Module-Federation entry file is safely hashed.

## Symptom

When the webpack output is NOT content-hashed (fixed names like `main.js`, `947.js`,
`surface_export.js`):

- **Prod:** a user who has visited the web UI before sees the old Surface Export UI after the plugin's
  web bundle is updated — broken/old behavior with no error — until they manually do "Empty cache and
  hard reload" or the browser eventually evicts the entry.
- **Dev (without the dev cache patch):** every `npm run build:web` requires a manual keyboard
  hard-reload; a normal reload and even a page-level `Ctrl+Shift+R` do not pick up the rebuild, because
  `immutable` sub-resources are exempt from ordinary reloads.

## Why content-hashing is required

### 1. `immutable` + fixed filenames are incompatible

The controller mounts static assets with one shared options object
([Controller.ts](https://github.com/clusterio/clusterio/blob/master/packages/controller/src/Controller.ts)):

```ts
const staticOptions = { immutable: true, maxAge: 1000 * 86400 * 365 };
// reused for: core web UI, data-export icon files, and EACH plugin's dist/web/static
```

Express turns that into `Cache-Control: public, max-age=31536000, immutable`. `immutable` is a promise
that the bytes at this URL will never change, so the browser won't even revalidate it within `max-age`.
That promise is only true when the filename changes whenever the content changes — i.e. content-hashed
names like `main.4f1a9c2b.js`. With a fixed name, a rebuild reuses the same URL and the browser keeps
the year-old copy.

### 2. The plugin inherits Clusterio's hashing

Clusterio's shared `@clusterio/web_ui/webpack.common.js` hashes by default:

```js
output: { filename: "static/[name].[contenthash].js" },      // content-hashed by default
plugins: [ new WebpackManifestPlugin({ publicPath: "" }) ],   // emits dist/web/manifest.json
```

[webpack.config.js](../docker/seed-data/external_plugins/surface_export/webpack.config.js) `merge`s
that and sets `filename`/`chunkFilename` to the same hashed pattern. A fixed-name override (e.g.
`"static/[name].js"`) would let `webpack-merge`'s later scalar win, shipping fixed names and a
`manifest.json` that maps `surface_export.js → static/surface_export.js` (no hash) — defeating the
caching Clusterio provides. The lint guard
[lint-webpack-cache.mjs](../docker/seed-data/external_plugins/surface_export/scripts/lint-webpack-cache.mjs)
(`npm run lint:web-cache`, gated in CI) fails on any `filename:`/`chunkFilename:` literal without a
content-hash token.

### 3. Why hashing the entry is safe — the manifest indirection

The host shell does not hardcode `/static/surface_export.js`. At boot it:

1. `fetch("/api/plugins")` ([bootstrap.tsx](https://github.com/clusterio/clusterio/blob/master/packages/web_ui/src/bootstrap.tsx)),
   then `loadScript(webRoot + meta.web.main)`.
2. The controller computes `meta.web.main` from the manifest
   ([routes.ts](https://github.com/clusterio/clusterio/blob/master/packages/controller/src/routes.ts)):
   ```ts
   web.main = pluginInfo.manifest[`${pluginInfo.name}.js`];   // "surface_export.js" → actual emitted filename
   ```

So the remote-entry filename is data, resolved fresh on every page load via `/api/plugins` (an API
route, not under the immutable `/static` cache). With hashing, the manifest maps
`surface_export.js → static/surface_export.<hash>.js`, `/api/plugins` returns the new name, and the
browser loads a URL it has never cached. Every `/static` file is content-hashed, so the `immutable`
header is correct for all of them — no core change required.

## Content-hashing configuration

[webpack.config.js](../docker/seed-data/external_plugins/surface_export/webpack.config.js) restores
content-hashing:

```js
output: {
    path: path.resolve(__dirname, "dist", "web"),
    filename: "static/[name].[contenthash].js",
    chunkFilename: "static/[name].[contenthash].js",
    clean: false,
},
```

The Module-Federation container entry follows `output.filename` (the config deliberately does not set
`ModuleFederationPlugin.filename`), so it is hashed too and the manifest records the hashed name.
`CleanWebpackPlugin` (from the shared config) removes old-hash files each build, so `dist/web/static`
doesn't accumulate cruft.

## Dev-workflow consequence

The controller reads each plugin's `manifest.json` once, at startup (`pluginInfo.manifest`), and caches
it. Because hashed filenames change every build, after `npm run build:web` you must restart the
controller so it re-reads the manifest and serves the new entry name via `/api/plugins`:

```powershell
npm run build:web
docker restart surface-export-controller   # re-read dist/web/manifest.json
# then a NORMAL browser reload picks up the new hashed chunks
```

The dev cluster also applies a `max-age=0` patch
([disable-immutable-cache.js](../docker/patches/disable-immutable-cache.js)), wired as the controller
entrypoint in [docker-compose.yml](../docker-compose.yml). With content-hashed plugin output each build
emits brand-new hashed URLs the browser has never cached, so there is nothing stale to bust for this
plugin; the patch still helps when iterating on Clusterio core web assets. Clusterio's `--dev-plugin`
webpack-dev-middleware (the `devPlugins` branch in
[routes.ts](https://github.com/clusterio/clusterio/blob/master/packages/controller/src/routes.ts),
which resolves the entry from live stats) is a restart-free path, but the Docker cluster serves built
`dist/web` rather than running that middleware.

## Verification

Builds run in your node environment (the agent shell and the host plugin dir have no `node`/web deps;
the in-container build can't resolve `@clusterio/web_ui` because the entrypoint strips `@clusterio`).
After `npm run build:web` + `docker restart surface-export-controller`:

1. **Manifest is hashed:**
   ```
   docker/seed-data/external_plugins/surface_export/dist/web/manifest.json
   → "surface_export.js": "static/surface_export.<hash>.js"   (and every chunk hashed)
   ```
2. **`/api/plugins` serves the hashed entry:**
   ```bash
   curl -s http://localhost:8080/api/plugins | grep -o '"main":"[^"]*"'   # → static/surface_export.<hash>.js
   ```
3. **Returning-user freshness:** load the UI; change a `web/*.tsx` with a visible marker; `build:web` +
   restart controller; do a normal reload. The marker appears — because the new hashed entry/chunks are
   URLs the browser never cached. (Confirm in DevTools that the new chunk was a fresh `200` while
   unchanged chunks may still serve `200 (from disk cache)`.)
4. **No regression on icons:** export-data icon files (`<kind>.<hash>.{json,png}`) are unaffected — they
   are already content-hashed and stay `immutable`. The Entities tab icons still load (see Pitfall #27
   in [CLAUDE.md](../CLAUDE.md)).

## References

- Content-hashing config: [webpack.config.js](../docker/seed-data/external_plugins/surface_export/webpack.config.js).
- Lint guard: [lint-webpack-cache.mjs](../docker/seed-data/external_plugins/surface_export/scripts/lint-webpack-cache.mjs).
- Manifest resolution: `web_ui/src/bootstrap.tsx` (`loadScript(web.main)`), `controller/src/routes.ts`
  (`manifest["<plugin>.js"]`), `controller/src/Controller.ts` (the `staticOptions` that make hashing
  necessary).
- Dev cache patch: [disable-immutable-cache.js](../docker/patches/disable-immutable-cache.js),
  [docker-compose.yml](../docker-compose.yml).
- Background: MDN — *Cache-Control* (`immutable`); webpack — *Caching* (`[contenthash]`),
  *Module Federation*; `webpack-manifest-plugin`.
