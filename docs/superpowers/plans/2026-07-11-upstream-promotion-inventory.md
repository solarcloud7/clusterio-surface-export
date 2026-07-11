# Upstream Promotion Sweep — Ranked Inventory (W4)

*FactorioSurfaceExport → clusterio/clusterio; read-only sweep by a delegated agent, orchestrator-audited,
2026-07-11. Inventory only — actual upstream PRs are the follow-on lane (owner approved same day).*

## Executive summary
Two candidates are high-value, well-bounded, verified genuine upstream gaps: (1) the **Link-method
binding hazard** — upstream `Link` methods are confirmed `this`-dependent prototype methods and
upstream's eslint has NO guard (its `no-restricted-syntax` is declared with no selectors — a no-op), so
both an eslint rule and a docs warning land cleanly; (2) the **chunked-RCON send loop**, duplicated
across four upstream plugins (inventory_sync, subspace_storage, research_sync, global_chat) plus this
one, while `escapeString` is already in `@clusterio/lib` — only the split-and-send loop needs promoting.
Close third: a **docs PR for the duplicate-`@clusterio/lib` singleton footgun** (npm 7+ peer
auto-install → "Attempt to import duplicate copy of @clusterio/lib"), verified absent from upstream
docs. Then: the self-discovering message-contract **test harness** (upstream has only manual per-class
round-trip tests); the **controller-hello boot race** (maintainer-gated: orchestration issue with a
plausible defensive core component); small ops-doc notes. `send_json` ergonomics are already adequately
covered upstream — no action. Two corrections surfaced during verification: the real RCON chunk size is
**`RCON_CHUNK_SIZE = 100000` bytes** (`helpers.ts:11`), not the stale "4 KB / 8 KB" prose (fixed in this
repo's docs in the same PR as this inventory); and `escapeString` already lives in lib, shrinking
candidate 2's scope.

## Ranked candidates

### 1. Link-method binding hazard → eslint rule (core) + docs warning — effort S–M, benefit HIGH, risk LOW
This repo's Pitfall #26 (call Link methods bound): extracting/casting `handle`/`sendTo`/`sendRequest`
as a value loses `this` → crashes inside `@clusterio/lib` at start or mid-operation. Verified universal:
`packages/lib/src/link/Link.ts` methods dereference `this` (`sendTo` → `this.sendRequest`). Upstream
`eslint.config.mjs:228` has `no-restricted-syntax: "error"` with **no selectors** and no
`@typescript-eslint/unbound-method`. Promotion: (a) core PR adding the two AST selectors (from this
repo's `eslint.config.js:18-77`, receiver-agnostic already) + `unbound-method`; (b) docs warning in
`writing-plugins.md` § message sending (~lines 440–490). Strip: local pitfall cross-references; the
bundled empty-catch rule is a separate concern — do not bundle.

### 2. Chunked-RCON send helper → `@clusterio/lib` utility — effort M, benefit HIGH, risk LOW–MED
`helpers.ts` `chunkify` (:155) + `sendChunkedJson` (:171) — split, escape (`lib.escapeString`, already
upstream at `packages/lib/src/lua_tools.ts:60`), stream via `sendRcon` with a `%CHUNK%/%INDEX%/%TOTAL%`
template. The split-escape-send loop is duplicated in four upstream plugins (inventory_sync has its own
`chunkify` at instance.ts:25). Promotion: core PR exporting `chunkString(data, size)` and optionally
`sendRconChunked(...)`; migrate the four in-repo plugins same or follow-on PR. Strip: the template
convention (design around the lower primitive); the Lua reassembly buffer is app-specific — document
the "buffer-by-session-id, return progress" pattern at most.

### 3. Duplicate-`@clusterio/lib` singleton footgun → docs PR — effort S, benefit HIGH, risk LOW
npm 7+ auto-installs peer deps, so `npm install` in a plugin dir plants a second `@clusterio/lib` and
`clusterioctl` dies with an opaque error. Verified absent from upstream docs (grep: `duplicate copy`,
`peerDependenc`, `legacy-peer` — nothing). Promotion: short note in `writing-plugins.md` /
`developing-for-clusterio.md` with the exact error string, cause, and `.npmrc legacy-peer-deps=true`
mitigation. Strip: Docker/bind-mount specifics.

### 4. Self-discovering message-contract harness → plugin-template addition — effort M, benefit MEDIUM, risk LOW
`test/messages.roundtrip.test.cjs`: auto-discovers every message class, generates samples from each
class's own `jsonSchema`, asserts wire contract + `toJSON`↔`jsonSchema` agreement. Upstream tests
round-tripping via hand-written per-class tests (`test/common.js` `testRoundTripJsonSerialisable`) —
the delta is auto-discovery (can't forget a new message) + the contract checks that catch the
"Unregistered Event class"/field-drift classes. Promotion: template `test/` file or an opt-in
`testPluginMessages(messages, pluginName)` in `test/common.js`. Strip: `PLUGIN_NAME`, the class-count
floor, the dist-output assumption.

### 5. Controller-hello boot race → maintainer-gated — effort S (docs) / M–L (core), benefit MEDIUM, risk MED
An instance auto-starting before its host completes the controller handshake gets its plugins silently
skipped (no error). Verified undocumented upstream. Primarily a startup-orchestration issue
(clusterio-docker's boot-race guard handles it there); the plausible core component is defensive —
warn or defer instance-plugin init pre-connection. Promotion: docs caveat now; a core issue posing the
warn/defer question to maintainers — do not pre-build. Related small notes worth bundling:
`clusterioctl` has no client-side timeout (hangs on unreachable controller); the shared control config
bakes `controller_url=localhost`. Exclude: git-bash path mangling (machine-local).

### 6. `send_json` ergonomics — ALREADY UPSTREAM, no action
Usage pattern + reorder/size caveats already documented (`writing-plugins.md:304-324`). Optional future
idea only: schema-validated `server.handle(channel, schema, handler)` (payloads today are untyped and
unvalidated, unlike Link messages).

### 7. clusterio-docker base-image fixes — classification only
Boot-race guard: image-specific mechanism, plausible upstream-core component (see 5). Honest readiness:
docker-specific. Plugin-logs-to-stdout: docker-specific workaround; a possible upstream opt-in stdout
transport is a maintainer question, not a plan item.

## Excluded as local-only
git-bash `--config=` mangling; this machine's multi-cluster port map; the FactorioMap/this-repo
node_modules remedies (the *problem* is candidate 3; the mechanisms are local); Factorio-engine facts
(belong in this repo's api-notes, not clusterio/clusterio).

## Owner pick order (benefit × tractability)
1 → 2 → 3 → 4 → 5 (docs + maintainer question) → small ops notes. Follow-on lane: fork workflow per
the dev-env memory (branch off `upstream/master`, changelog entry, `pnpm test` + `pnpm lint`, PR to
clusterio/clusterio).

## Verification trail (agent's evidence, spot-audited)
`Link.ts` this-dependence; upstream eslint no-op selector confirmed; chunk duplication in the four
plugin `instance.ts` files; `lua_tools.ts:60` escapeString; docs greps for the singleton footgun and
boot race returned nothing; `helpers.ts:11` RCON_CHUNK_SIZE=100000; upstream `test/common.js` manual
round-trip pattern; `writing-plugins.md:304-324` send_json coverage.
