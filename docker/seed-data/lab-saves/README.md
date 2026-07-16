# Surface Export Lab Gallery

This directory contains generated, version-pinned Factorio saves for visually inspecting lab fixtures.

The gallery save is an input, not a test oracle. Runners must independently meter source and destination
state. Mutable destinations are not baked: a test must clear or create its destination and must never repair
an immutable source fixture in place.

Generation source lives in `tests/lab-gallery/`. The first pilot catalogs every `tests/*-lab` family and
bakes the `belt-5x5-125-unstacked` source beside an empty matching target. Later lab fixtures move from
`catalog` to `baked-source` only after a live builder rung and a saved-artifact reload verify them.

Regenerate for Factorio 2.0.77:

```powershell
node tests/lab-gallery/build-save.mjs `
  --runtime-api C:\tmp\runtime-api-2.0.77.json `
  --output docker/seed-data/lab-saves/lab-gallery-surface-export-2.0.77.zip
```

The output is create-only. Remove or rename an obsolete artifact deliberately before regeneration; the
builder never overwrites a committed save.

Reload the generated artifact in a separate, time-bounded Factorio 2.0.77 process and independently meter
the physical belts:

```powershell
node tests/lab-gallery/verify-save.mjs `
  --save docker/seed-data/lab-saves/lab-gallery-surface-export-2.0.77.zip
```

The verifier uses host 2 only as an isolated runtime: it does not stop or modify the managed instance, uses
separate game/RCON ports and a prefix-owned `/tmp` write directory, asks the disposable server to quit after
the census, and removes the directory in `finally`. Acceptance requires Factorio 2.0.77, the visual index,
16 source belts, 16 target belts, 125 physical one-item source stacks split 67/58 by side, zero target
items, 15 gallery text renderings, and 14 navigation tags.

Current certified artifact:

- bytes: `1,191,252`
- SHA-256: `2D1898E2D1FA9B48D39D04F79F8B88C41DA36F8243E6DA33A491D465DCC28A36`
