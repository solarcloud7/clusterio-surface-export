# Surface Export Lab Gallery

This directory contains generated, version-pinned Factorio saves for visually inspecting and executing physical lab fixtures.

The paired gallery saves are inputs, not test oracles. Runners independently meter source and destination state.
The source contains single-use fixtures; the destination contains the matching empty world. A batch resets by
reloading both artifacts, never by repairing, cloning, reconstructing, or cleaning a consumed fixture.

Generation source lives in `tests/lab-gallery/`. The source currently bakes the
`belt-5x5-125-unstacked` and `specialized-fluid-reachability` fixtures in the same game file. The destination
retains the compact visual catalog but contains neither physical fixture. Exact mod pins, SHA-256 values, world
censuses, fixture revisions, and physical fingerprints live in `tests/lab-gallery/manifest.json`.

Regenerate for Factorio 2.0.77:

```powershell
node tests/lab-gallery/build-save.mjs `
  --runtime-api C:\tmp\runtime-api-2.0.77.json `
  --seed docker/seed-data/lab-saves/lab-gallery-surface-export-2.0.77.zip `
  --source-output docker/seed-data/lab-saves/lab-gallery-source-surface-export-2.0.77.zip `
  --destination-output docker/seed-data/lab-saves/lab-gallery-destination-surface-export-2.0.77.zip
```

The output is create-only. Remove or rename an obsolete artifact deliberately before regeneration; the
builder never overwrites a committed save.

Reload both generated artifacts in separate, time-bounded Factorio 2.0.77 processes and independently meter
both physical contracts:

```powershell
node tests/lab-gallery/verify-save.mjs `
  --source-save docker/seed-data/lab-saves/lab-gallery-source-surface-export-2.0.77.zip `
  --destination-save docker/seed-data/lab-saves/lab-gallery-destination-surface-export-2.0.77.zip
```

The verifier uses host 2 only as an isolated runtime: it does not stop or modify the managed instance, uses
separate game/RCON ports and a prefix-owned `/tmp` write directory, asks the disposable server to quit after
the census, and removes the directory in `finally`. Acceptance requires Factorio 2.0.77, the visual index,
the compact visual catalog, the exact 125-stack belt source, the specialized drill's live zero-fluidbox state,
and an empty destination with no conflicting platform identity.

Current certified artifacts:

- source: `705,897` bytes; SHA-256 `6F6DB4ADA0D6CF8747F01FA74880C5C6C272C7E4063BA2CE956ABF88D6E060A7`
- destination: `702,678` bytes; SHA-256 `9F89B25F9CFA605A25A02D7BD42F3CB12554B9594E1581F84D998F15566C2C23`

The older single gallery save is retained only as the deterministic PR #111 generation seed. Test runners consume
the paired artifacts, not that seed.
