# Clusterio Core Development

This repo is a **plugin + dev cluster**; the dev cluster runs **published** `@clusterio/* 2.0.0-alpha.25`
baked into the `ghcr.io/solarcloud7/clusterio-docker-*` images. When you need to change **Clusterio core
itself** (lib/host/controller/ctl), here is where that work lives and how to test it with `surface_export`.

### Home: the sibling fork checkout `../clusterio`
All Clusterio core development lives in the **canonical fork** at `C:\Users\Solar\source\clusterio`
(`origin` = your fork `solarcloud7/clusterio`, `upstream` = `clusterio/clusterio`) — a **sibling** of this
repo, NOT an in-repo checkout (the old `FactorioSurfaceExport/clusterio` was retired; the `/clusterio/`
.gitignore line is a guard so it can't be re-committed). Clusterio uses a **fork-based, pnpm** workflow
(see its `docs/contributing.md`):
- `git fetch upstream` (never `git pull upstream`) → branch off `upstream/master` → push to `origin` →
  PR to `clusterio/clusterio`. Update a branch by rebasing (`git rebase upstream/master`, force-push `+branch`).
- Long-lived fork-only work (e.g. `ExtendedExportData`) stays on its own fork branch.
- Add a changelog entry for user-visible changes; run `pnpm test` + `pnpm lint`.
- To touch a different branch without disturbing in-progress work, use a `git worktree` off `upstream/master`.

### Two ways to test a core change with the plugin
1. **Native pnpm dev env (recommended for *iterating* on a core feature).** Per Clusterio's contributing.md,
   in `../clusterio`: `pnpm install`, put/junction the plugin into `external_plugins/surface_export`,
   `node packages/ctl plugin add ./external_plugins/surface_export`, run `node packages/controller run` +
   `node packages/host run`, iterate with `pnpm watch`. Core edits go live immediately, with source maps.
   The upstream-blessed loop; no version-compat hacks.
2. **Full-cluster Docker override (this repo's 2-host cluster running your fork build).** `pnpm build` the
   fork, then layer `docker-compose.clusterio-src.yml` (bind-mounts each `../clusterio/packages/<pkg>/dist`
   over the image's `@clusterio/<pkg>/dist`):
   ```powershell
   ./tools/rebuild-clusterio.ps1          # pnpm build the fork + recreate the cluster on it
   # revert to the published image:  docker compose up -d --force-recreate
   ```
   **Compatibility caveat:** the fork build must be API-compatible with the plugin's pinned `@clusterio`
   version (alpha.25). Build a branch CLOSE to that release; a heavily-diverged branch may not drop in — if
   instances fail to start, use loop 1 instead. `CLUSTERIO_SRC` overrides the fork path (default `../clusterio`).

### Promoting a change
- **General fix/feature** → verify (loop 1 or 2) → upstream PR to `clusterio/clusterio`. When merged & released,
  the published `@clusterio` version advances.
- **Fork-baseline feature the cluster must persist on** → bake into the images via the **`clusterio-docker`**
  builder (`C:\Users\Solar\source\clusterio-docker`: build from the fork or publish fork packages, bump
  `CLUSTERIO_VERSION`), then bump the pinned tag in `docker-compose.yml` + the plugin `package.json`.
