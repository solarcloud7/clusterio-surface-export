# Static-Asset Caching: the stale-chunk problem (and the one-line-ish fix)

> **Status:** Fix applied in [`webpack.config.js`](../docker/seed-data/external_plugins/surface_export/webpack.config.js)
> (content-hashed chunk names). Needs a `build:web` + redeploy to take effect. There is a small
> **dev-workflow** consequence — see [Dev workflow](#dev-workflow-consequence).

## TL;DR

The controller serves every `/static/*` asset with `Cache-Control: public, max-age=31536000, immutable`.
`immutable` is **only** safe for **content-hashed** filenames. The surface_export plugin's webpack was
emitting **fixed** chunk names (`main.js`, `947.js`, `surface_export.js`, …), so after a plugin web
update returning users kept serving the **stale** cached chunk for up to a year.

**The fix is entirely in this plugin** — no Clusterio core change. Clusterio's shared web config
*already* content-hashes by default; our `webpack.config.js` was **overriding it back** to fixed names.
Restoring the hashing (`static/[name].[contenthash].js`) is the whole fix, because the controller
resolves the plugin's remote-entry filename through `dist/web/manifest.json` (shipped via the
`/api/plugins` route — **not** the immutable `/static` cache), so even the entry file is safe to hash.

> **Earlier drafts of this doc were wrong.** They claimed the MF remote entry *couldn't* be hashed and
> that a Clusterio-core `Cache-Control` change was required (a "second interdependent half"). That is
> false: the manifest indirection below means hashing the plugin's own output is sufficient and
> complete. The core change is, at most, optional hardening for Clusterio's *own* shell assets — out of
> scope here.

---

## Symptom

- **Prod:** a user who has visited the web UI before sees the **old** Surface Export UI after the
  plugin's web bundle is updated — broken/old behavior with no error — until they manually do
  "Empty cache and hard reload" or the browser eventually evicts the entry.
- **Dev (before the dev cache patch):** every `npm run build:web` required a manual keyboard
  hard-reload; a normal reload and even the MCP's page-level `Ctrl+Shift+R` did **not** pick up the
  rebuild, because `immutable` sub-resources are exempt from ordinary reloads.

## Root cause

### 1. `immutable` + fixed filenames are incompatible

The controller mounts static assets with one shared options object
([`packages/controller/src/Controller.ts:849`](https://github.com/clusterio/clusterio/blob/master/packages/controller/src/Controller.ts) in the Clusterio fork):

```ts
const staticOptions = { immutable: true, maxAge: 1000 * 86400 * 365 };
// reused for: core web UI (851), data-export icon files (853), and EACH plugin's dist/web/static (869)
```

Express turns that into `Cache-Control: public, max-age=31536000, immutable`. `immutable` is a promise
that *the bytes at this URL will never change*, so the browser won't even revalidate it within
`max-age`. That promise is only true when **the filename changes whenever the content changes** — i.e.
content-hashed names like `main.4f1a9c2b.js`. With a fixed name, a rebuild reuses the same URL → the
browser keeps the year-old copy. That is the bug.

### 2. Our webpack config was un-doing Clusterio's hashing

Clusterio's shared `@clusterio/web_ui/webpack.common.js` already does the right thing:

```js
output: { filename: "static/[name].[contenthash].js" },      // content-hashed by default
plugins: [ new WebpackManifestPlugin({ publicPath: "" }) ],   // emits dist/web/manifest.json
```

But [`webpack.config.js`](../docker/seed-data/external_plugins/surface_export/webpack.config.js)
`merge`s that with an `output` block that **overrode** `filename`/`chunkFilename` back to
`"static/[name].js"`. `webpack-merge` lets the later scalar win, so the plugin shipped fixed names and
the resulting `manifest.json` mapped `surface_export.js → static/surface_export.js` (no hash). We were
actively defeating the caching Clusterio hands us for free.

### 3. Why hashing the entry is safe — the manifest indirection

The host shell does **not** hardcode `/static/surface_export.js`. At boot it:

1. `fetch("/api/plugins")` ([`web_ui/src/bootstrap.tsx:33,51`](https://github.com/clusterio/clusterio/blob/master/packages/web_ui/src/bootstrap.tsx)),
   then `loadScript(webRoot + meta.web.main)`.
2. The controller computes `meta.web.main` from the manifest
   ([`controller/src/routes.ts:122`](https://github.com/clusterio/clusterio/blob/master/packages/controller/src/routes.ts)):
   ```ts
   web.main = pluginInfo.manifest[`${pluginInfo.name}.js`];   // "surface_export.js" → actual emitted filename
   ```

So the remote-entry filename is **data**, resolved fresh on every page load via `/api/plugins` (an API
route, **not** under the immutable `/static` cache). Hash the entry → the manifest maps
`surface_export.js → static/surface_export.<hash>.js` → `/api/plugins` returns the new name → the
browser loads a URL it has never cached. Every `/static` file is now content-hashed, so the `immutable`
header is finally **correct for all of them**. No core change required.

---

## The fix (applied)

In [`webpack.config.js`](../docker/seed-data/external_plugins/surface_export/webpack.config.js), restore
content-hashing instead of overriding it away:

```js
output: {
    path: path.resolve(__dirname, "dist", "web"),
    filename: "static/[name].[contenthash].js",       // was "static/[name].js"
    chunkFilename: "static/[name].[contenthash].js",   // was "static/[name].js"
    clean: false,
},
```

The MF container entry follows `output.filename` (we deliberately do **not** set
`ModuleFederationPlugin.filename`), so it gets hashed too and the manifest records the hashed name.
`CleanWebpackPlugin` (from the shared config) removes old-hash files each build, so `dist/web/static`
doesn't accumulate cruft.

---

## Dev-workflow consequence

There is one tradeoff. The controller reads each plugin's `manifest.json` **once, at startup**
(`pluginInfo.manifest`), and caches it. With **fixed** names a web rebuild changed the file *in place*
under the same URL, so the documented loop was just `build:web` → hard-refresh. With **hashed** names
the filename changes every build, so after `npm run build:web` you must **restart the controller** so it
re-reads the manifest and serves the new entry name via `/api/plugins`:

```powershell
npm run build:web
docker restart surface-export-controller   # re-read dist/web/manifest.json
# then a NORMAL browser reload picks up the new hashed chunks
```

Upside: the dev `max-age=0` patch
([`docker/patches/disable-immutable-cache.js`](../docker/patches/disable-immutable-cache.js)) is now
**redundant for this plugin** — each build emits brand-new hashed URLs the browser has never cached, so
there's nothing stale to bust. It's harmless to keep (it still helps if you're iterating on Clusterio
*core* web assets), but it can be removed once this fix is verified. The faster, restart-free dev path
is Clusterio's `--dev-plugin` webpack-dev-middleware (the `devPlugins` branch in `routes.ts:118-120`,
which resolves the entry from live stats), but our Docker cluster serves built `dist/web` rather than
running that middleware.

---

## Verification

Builds run in your node environment (the agent shell and the host plugin dir have no `node`/web
deps; the in-container build can't resolve `@clusterio/web_ui` because the entrypoint strips
`@clusterio`). After `npm run build:web` + `docker restart surface-export-controller`:

1. **Manifest is hashed:**
   ```
   docker/seed-data/external_plugins/surface_export/dist/web/manifest.json
   → "surface_export.js": "static/surface_export.<hash>.js"   (and every chunk hashed)
   ```
2. **`/api/plugins` serves the hashed entry:**
   ```bash
   curl -s http://localhost:8080/api/plugins | grep -o '"main":"[^"]*"'   # → static/surface_export.<hash>.js
   ```
3. **Returning-user freshness (the actual bug):** load the UI; change a `web/*.tsx` with a visible
   marker; `build:web` + restart controller; do a **normal reload**. The marker appears — because the
   new hashed entry/chunks are URLs the browser never cached. (Confirm in DevTools that the new chunk
   was a fresh `200` while unchanged chunks may still serve `200 (from disk cache)`.)
4. **No regression on icons:** export-data icon files (`<kind>.<hash>.{json,png}`) are unaffected — they
   were already content-hashed and stay `immutable`. The Entities tab icons still load (see
   [Pitfall #27 in CLAUDE.md](../CLAUDE.md)).

---

## References

- Fix: [`webpack.config.js`](../docker/seed-data/external_plugins/surface_export/webpack.config.js).
- Manifest resolution: `web_ui/src/bootstrap.tsx` (`loadScript(web.main)`),
  `controller/src/routes.ts:122` (`manifest["<plugin>.js"]`), `controller/src/Controller.ts:849`
  (the `staticOptions` that make hashing necessary).
- Dev cache patch (now redundant for this plugin):
  [`docker/patches/disable-immutable-cache.js`](../docker/patches/disable-immutable-cache.js),
  [`docker-compose.yml`](../docker-compose.yml).
- Background: MDN — *Cache-Control* (`immutable`); webpack — *Caching* (`[contenthash]`),
  *Module Federation*; `webpack-manifest-plugin`.
