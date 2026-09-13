# Gallery save inputs

`tests/lab-gallery/manifest.json` identifies the source and destination archives
and their SHA-256 hashes. Other dated snapshots retain earlier checkpoints.
The manifest's engine/mod versions describe the banked files, not the runtime
currently loading them. Do not rewrite those values as a compatibility claim.

The gallery archives have matching seed copies under `docker/seed-data/hosts/`.
Follow [fixture maintenance](../../../docs/developers/fixtures.md) when replacing
one. Preserve old evidence, update both copies, remeasure the fixture and run
the hash and live checks. Never wipe an existing cluster merely to rename a seed.
