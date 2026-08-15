# Lab gallery saves

Version-pinned Factorio saves backing the pad gallery. `tests/lab-gallery/manifest.json` is the single
source of truth for what each artifact contains; this file documents how to *change* one.

## What is here

| Artifact | Role | Pinned in manifest? |
|---|---|---|
| `lab-gallery-snapshot-2026-07-28-owner-rig-rebuilt.zip` | Golden **source** — the pad grid (`lab-omnibus-state-v1`) and the transfer fixture (`lab-transfer-fixture-v1`); the manifest's `saves.source.artifact` | yes, `saves.source.sha256` |
| `lab-gallery-destination-surface-export-2.1.11.zip` | Golden **destination** — the matching empty world | yes, `saves.destination.sha256` |
| Other `lab-gallery-snapshot-*.zip`, and `lab-gallery-source-of-truth.zip` (the golden until the 2026-07-28 re-bank) | Dated **restore points** from the live gallery | **no — deliberately unpinned insurance** |

The two goldens are also the cluster's seed saves — byte-identical copies, verified:

```
docker/seed-data/hosts/clusterio-host-1/clusterio-host-1-instance-1/lab-gallery-source.zip
docker/seed-data/hosts/clusterio-host-2/clusterio-host-2-instance-1/lab-gallery-destination.zip
```

Re-banking a golden therefore means writing **two** files. Change only one and the cluster boots
something other than what the tests verify.

## The saves are inputs, not oracles

Runners meter source and destination state independently. Fixtures are single-use: a batch resets by
reloading both artifacts, never by repairing, cloning, or cleaning a consumed fixture.

## Re-banking a golden

There is no build script. Earlier revisions of this file documented `build-save.mjs` and
`verify-save.mjs`; neither has ever existed in this repo. The real procedure is manual:

1. **Save the live instance** — `/sc game.server_save('rebank-<date>')`, then wait for the file to stop
   growing. `non_blocking_saving` is on, so `server_save` returns *before* the write lands.
2. **Copy it out** — `docker cp <container>:/clusterio/data/instances/<instance>/saves/<name>.zip <artifact>`
3. **Copy it to the seed path as well** (see the table above).
4. **Re-pin the SHA-256** in `tests/lab-gallery/manifest.json`.
5. **Re-measure `expectedCensus`** — see the warning below.

Verify:

```bash
node --test tests/lab-gallery/manifest.test.mjs
```

`manifest.test.mjs` hashes both artifacts against their pins; `pad-transfer-suite` re-checks the source
SHA as a preflight and refuses to run on a mismatch.

## Warning: `expectedCensus` is decorative

Only the SHA is enforced. Nothing censuses a golden save and compares it against `expectedCensus`, so a
re-bank carrying wrong entity or chunk counts passes every gate in this repo. Those numbers must be
**measured** on the live instance before they are written down — never carried over or estimated.

## Warning: the seed rename needs a reseed

The seed files were renamed from `test1.zip` / `test2.zip` on 2026-07-25. A cluster seeded before that
still has the old names in its instance saves directory. Run `docker compose down -v` (or
`./tools/clusterio/deploy.ps1 -Scope plugin`) before the gallery runners will resolve them.
