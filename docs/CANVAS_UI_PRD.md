# Canvas UI — replacing the Manual Transfer and Gateways tabs with a node graph

> Status: **PLAN — not approved, nothing implemented.** Prerequisite audit done 2026-08-06 against
> the live checkout at plugin v0.10.223, Clusterio `2.0.0-alpha.27`, React 18.
> Library under evaluation: [`@xyflow/react`](https://github.com/xyflow/xyflow) v12.11.2 (React Flow).

## What this replaces, precisely

The two tabs total ~500 lines, but almost none of it is behaviour:

| File | Lines | Fate |
|---|---|---|
| `web/ManualTransferTab.tsx` | 260 | **Replaced** — it is a grouped list renderer |
| `web/GatewaysTab.tsx` | 236 | **Replaced** — it is a per-instance form grid |
| `web/TransferModal.tsx` | 126 | **Kept as-is** — triggered by a source selection, not by the table |
| `web/ImportModal.tsx` | 193 | **Kept as-is** — same |
| `web/icons.tsx` (`PlanetIcon`) | 141 | **Kept** — renders inside a node |
| `statusLabel()` (in ManualTransferTab) | 27 | **Moved**, not rewritten |

So the change is a **container swap**, not a behaviour rewrite. The controller wire protocol, the
messages, the permissions and both modals are untouched. That framing matters for risk: nothing on
the transfer path changes.

---

## Prerequisite audit

### Cleared by measurement — do not re-litigate

**1. Bundle size — the mermaid objection does not transfer.**

`web/index.tsx:79` records that this UI deliberately avoids non-shared web deps, "see … why mermaid
was removed", and `web/TransactionLogsTab.tsx:62` names the reason: *a multi-MB dep for one diagram*.
That is the correct bar to hold a new dep to, so it was measured rather than argued.

First estimated by an isolated probe (webpack 5 production, `react`/`react-dom` externalized to mirror
the Module Federation model, CSS included): **198 KiB raw / 60 KiB gzipped**.

Then measured for real, by building the plugin with and without the canvas and reading the chunk set
the browser actually fetches from the live controller:

| | Raw | Gzipped |
|---|---|---|
| Plugin chunks served, before | 123,291 B (120 KiB) | — |
| Plugin chunks served, after | 312,980 B (306 KiB) | 94.6 KiB |
| **Delta** | **+189,689 B (+185 KiB)** | — |

The real delta (185 KiB) matches the isolated probe (198 KiB). Mermaid was multiple megabytes.
**The precedent that killed mermaid does not reach this**, and unlike mermaid this is not "one
diagram" — it replaces a whole tab.

Headroom check: `@clusterio/web_ui/webpack.common.js` sets `performance.maxAssetSize: 2**21` (2 MiB).
The largest emitted chunk is 219 KiB.

**One trap in reading these numbers**, recorded because it produced a false alarm mid-implementation:
`du`-ing all of `dist/web` says the bundle grew by **374 KiB**, nearly double the probe. That count is
wrong for the purpose. The build emits xyflow **twice** — into `main.js` and into the `621` vendors
chunk (137 identical `react-flow__` markers in each) — because `web/index.tsx` is both the webpack
`entry` and a Module Federation `exposes` target, so it is compiled into two chunk graphs. The
controller's `/api/plugins` serves only the MF remote entry, and a live network capture confirms
`main.js` **is never fetched**. It is dead weight on disk, pre-existing (the baseline duplicates its
own code the same way, just at 50 KiB instead of 220 KiB), and costs no user anything. Size claims
about this plugin must therefore be made against **the fetched chunk set**, not `dist/web`.

**2. CSS from `node_modules` already builds.** `webpack.common.js` declares
`{ test: /\.css$/, use: [style-loader, css-loader] }` with **no `include`/`exclude`**, so
`import "@xyflow/react/dist/style.css"` is handled by the existing rule. No loader work.

**3. React version satisfies the peer range.** xyflow v12 requires `react >=17`; the plugin is on
`^18.2.0`.

**4. Licences are clean.** `@xyflow/react`, `@xyflow/system`, `zustand`, `classcat` — **all MIT**.
(React Flow's paid tier is a separate product; the core library is MIT.)

**5. The container build picks the dep up automatically.** `tools/clusterio/build-plugin.ps1`
re-runs `npm ci` whenever `package-lock.json` is newer than what npm last wrote into the cached
volume, so no `-Fresh` is required after the dependency lands.

### Installing and wiring it — the mechanical recipe

Every step below was verified against this checkout on 2026-08-06.

**1. Add the dep WITHOUT touching the live cluster's `node_modules`.**

CLAUDE.md forbids `npm install` in the plugin dir on a running cluster: npm 7+ auto-installs the
`@clusterio/*` peers into the bind-mounted `node_modules`, which breaks `clusterioctl` with
*"Attempt to import duplicate copy of @clusterio/lib"*. `--package-lock-only` sidesteps it — it
rewrites `package.json` + `package-lock.json` and **creates no `node_modules` at all** (verified:
probe run on a copy of the real manifests reported `NO node_modules — untouched`).

```bash
npm install --package-lock-only --save-dev @xyflow/react@^12
```

**`--save-dev` is load-bearing, not stylistic.** Without it npm appends a brand-new `dependencies`
block (verified — the probe produced exactly that). The container-boot `npm install` is
production-only, so anything in `dependencies` gets installed into the bind-mounted `node_modules` on
**every container restart** — pointless, since xyflow is inlined into `dist/web` at build time and is
never resolved at runtime. As a devDependency it sits alongside `react`, `antd` and `webpack`, the
boot install skips it, and the isolated build container's `npm ci` still installs it (npm ci includes
devDeps by default).

**2. Build it.** No `-Fresh` needed — `build-plugin.ps1` re-runs `npm ci` whenever the lockfile is
newer than what npm last wrote into the cached volume.

```powershell
./tools/clusterio/deploy.ps1 -Scope artifacts -Target web -RestartController
```

**3. Import it.** The stylesheet is mandatory — without it the canvas renders unstyled and mostly
invisible. The existing `{ test: /\.css$/ }` rule has no `include`/`exclude`, so this Just Works:

```ts
import { ReactFlow, Background, Controls } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
```

**4. Do NOT add xyflow to the Module Federation `shared` block.** Every entry there is
`import: false`, meaning *"the host provides this"*. Clusterio's `web_ui` does not ship xyflow, so
listing it means **nothing** provides it and the remote fails to load at runtime. It must be bundled.
This is a one-line mistake that looks correct next to `antd` and `react`.

**5. TypeScript needs no changes — but one stale config is worth a one-line fix.**
`tsconfig.browser.json` (the only config that typechecks `web/`, via `npm run build:browser`) already
uses `moduleResolution: "bundler"`, which reads xyflow's `exports` map correctly. `tsconfig.node.json`
excludes `web/**`, and eslint ignores `web/**` and projects only `tsconfig.node.json` — so xyflow
never reaches either. The root `tsconfig.json` is the odd one out: it `include`s `web/**/*.tsx` under
`moduleResolution: "node"`, which cannot read an `exports` map. **No build or lint script uses it**,
so nothing breaks — but editors do, so it would show phantom "cannot find module" errors until it is
switched to `bundler` or stops including `web/`.

### Needed — real work, in rough order of risk

**A. Server-push ↔ user-interaction reconciliation.** *(highest risk; not visible from a file list)*

Platform state arrives as revision-gated `SurfaceExportTreeUpdateEvent`s and is swapped wholesale into
`this.state.tree` (`web/index.tsx:354-373`). xyflow's `useNodesState` holds its own node array
including **positions and selection**, which are user-owned and exist nowhere on the server. A naive
`useEffect(() => setNodes(fromTree(tree)), [tree])` resets position and selection on **every** tree
revision — i.e. on every platform status change, while the user is mid-drag.

Requirement: a **named, pure** `reconcileNodes(prevNodes, tree)` that updates node `data` from server
truth while preserving `position` and `selected` for nodes that still exist. Keep it pure and it is
the one part of this feature that is unit-testable in the existing harness (see F).

**B. The canvas needs an explicit height.** `.surface-export-tab-body` is `display: block` with no
height (`web/style.css:3-6`). React Flow measures its container and renders **zero-height** — the
classic blank-canvas failure. Needs a real height through the `PageLayout → Tabs → tab body` chain.

**C. Layout persistence.** Node positions are a UI preference, not cluster state.
**Recommendation: `localStorage`, keyed per controller.** Named explicitly because in this codebase
everything else persists through the controller, and this should not drift there.

**D. Auto-layout for first paint.** Positions must come from somewhere before a user has dragged
anything. Instances group under hosts and platforms under instances, so a deterministic
columns-by-host / rows-by-instance layout is enough — no layout engine dependency (`dagre`/`elk`
would be a second dep and is not justified by this graph's size).

**E. Permission gating — a gap that exists today and gets worse on a canvas.**

Measured in `messages.ts`: `GetGatewaysRequest` and `GetPlatformTreeRequest` require `UI_VIEW`, while
**every mutation** — `StartPlatformTransferRequest`, `SetGatewayLinkRequest`,
`ExportPlatformForDownloadRequest`, `ImportUploadedExportRequest` — requires `TRANSFER_EXPORTS`.

`grep -rn "TRANSFER_EXPORTS\|canEdit\|hasPermission" web/` returns **nothing**: the web UI never
checks it client-side. Today a `UI_VIEW`-only user sees buttons that fail server-side. On a canvas
that becomes an edge the user drags which silently snaps back. One `canEdit` flag covers all four
mutations (they share a permission) and should gate `nodesConnectable` / `edgesUpdatable`.

**F. There is no React test harness in this repo.** `npm test` is
`node --test "test/*.test.cjs"` — no jsdom, no React Testing Library — and **eslint ignores `web/**`
entirely** (per CLAUDE.md, `lint:catch-swallow` is the web tree's only guard). Given how hard this
repo leans on test grounding, this is named up front rather than discovered at review:

- Verification for this feature = `npm run build:browser` (typecheck) + the browser-preview
  workflow + screenshots.
- The **one** exception is A's `reconcileNodes`, which is coverable by a plain `test/*.test.cjs` if
  it is kept pure. That is a reason to keep it pure.
- Adding jsdom + RTL is a defensible separate decision; it is **not** a prerequisite for this work.

**G. `package-lock.json` changes.** CLAUDE.md requires it byte-identical outside approved dependency
updates. This is one, and should be called out in the PR rather than slipped in.

---

## The gateway half: a near-perfect fit

`onConnect` yields `{ source, sourceHandle, target, targetHandle }`, which maps 1:1 onto
`setGatewayLink({ sourceInstanceId, gatewayName, targets })`. `GATEWAY_COUNT = 4`
(`shared/dto.ts:9`), so each instance node carries 4 source handles and 4 target handles.

**Two existing hazards dissolve structurally**, which is the strongest argument for the change:

- `GatewaysTab.tsx:114-120` guards a "target row with no instance picked", which would otherwise save
  fewer targets and *silently disable the gateway*. An edge always has both endpoints — the failure
  mode cannot be expressed.
- `GatewaysTab.tsx:135-137` deliberately does **not** reload after save, because a reload would
  discard unsaved rows on the other instance cards. With per-edge state there is nothing to discard.

**Two new hazards appear and need decisions:**

- `setGatewayLink` saves the **entire** target list for one `(sourceInstanceId, gatewayName)` key. An
  edge add or delete must recompute that whole list and resend it — a per-edge mental model that
  sends per-edge requests will drop siblings.
- **Zero edges on a handle means that gateway is disabled.** The silent-disable hazard returns in new
  clothing. A handle at zero edges must *look* disabled.

## The manual-transfer half: the mismatch to decide

The two tabs are not the same kind of object. **Gateways is a graph.** **Manual Transfer is a list
with per-row destructive actions** — and a transfer **deletes the source platform**. Drag-to-transfer
on a canvas is one mis-drag away from a real cross-instance platform move.

This is not a reason to narrow the scope, and the fix is cheap — a drag opens the existing
`TransferModal` instead of firing. But it needs an explicit ruling, along with two placement
questions:

1. Does a platform → instance drag **open the confirm modal**, or execute directly?
2. Do gateway edge edits **auto-save on connect**, or stage behind a Save button as they do today?
3. Where do **Import JSON** (currently `tabBarExtraContent`, gated on `effectiveTab === "manual"` —
   `web/index.tsx:128-136`) and per-platform **Export JSON** live on a canvas?

---

## Proposed staging

| PR | Content | Verification |
|---|---|---|
| 1 | Add the dep; bare canvas shell behind the existing tab; container height (B); auto-layout (D) | `build:browser`, preview screenshot |
| 2 | Gateway graph: instance nodes, 4 handles, edges from `getGateways`, `onConnect`/`onEdgesDelete` → full-list `setGatewayLink`; disabled-handle affordance | preview + a real gateway transfer |
| 3 | Platform nodes + `reconcileNodes` (A) + its `.cjs` test; status/`PlanetIcon` port | `npm test` (reconcile), preview |
| 4 | Actions: transfer/export/import entry points per the decisions above; `canEdit` gating (E) | preview as both permission levels |
| 5 | Layout persistence (C); retire the two old tabs | preview |

Landing PR 1 alone matches the `max_export_cache_size` precedent (#161): the dependency and the
lockfile change get their own reviewable commit, separate from the feature.

## What this plan does **not** claim

- No measurement of runtime performance at cluster scale. This cluster is 2 hosts / 2 instances; the
  node count is trivially small and no perf work is anticipated, but that is a prediction, not a
  measurement.
- `React.lazy` for the canvas chunk (so xyflow loads only when the view opens) is compatible with
  `chunkFilename` content-hashing and `lint:web-cache`, but is a nice-to-have, **not** a prerequisite.
- Nothing here changes the transfer path, the gate, or any Lua.
