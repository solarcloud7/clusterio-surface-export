# Fixtures, pads and seed saves

A fixture is a known game setup with explicit observations. A pad is a small
labelled test area in the gallery; it compares a source area with a restored area.
A baked save contains fixtures prepared before the test starts. None is a
correctness certificate merely because its file exists or matches a hash.

## Gallery inputs

`tests/lab-gallery/manifest.json` names the source and destination archives, their
hashes, fixture anchors and expected observations. Use `saves.<role>.artifact`
for the archive path; `name` is a save name. The manifest's engine/mod versions
describe the banked save, which predates the current runtime pin. Keep those
historical values when testing that save on a newer engine.

Gallery batches consume a fixture once and restore the paired checkpoints for a
new batch. Repairing or cloning a consumed fixture does not reestablish the baked
baseline. Other integration suites create their own small temporary worlds;
they do not all use gallery clones.

The readiness check uses expected surfaces and declared fixture platform names.
The manifest's aggregate entity/chunk counts are recorded metadata, not a full
runtime comparison of the save. A hash proves input identity, not game correctness.

## Add a property observation

Read the relevant fixture's manifest entry and place an unambiguous anchor. The
declarative `lifecycle.verify` list supports the physical reads implemented by
`tests/lab-gallery/manifest.mjs` and the Lua lifecycle engine. A property read
walks fields; it does not call arbitrary methods.

For an existing heat-pipe fixture, the workflow is:

```powershell
node tools/tests/testkit/cli.mjs probe lab-omnibus-state-v1 'heat-pipe@43,-13:temperature'
# Edit that fixture's lifecycle.verify entry using the measured property.
node tests/lab-gallery/push-roster.mjs --instance clusterio-host-1-instance-1
./tools/clusterio/rcon.ps1 11 '/test-run <name-filter>'
```

These commands use the running gallery and require its fixtures/debug settings.
Substitute an actual filter rather than the placeholder. Use exact comparison for
discrete values and a justified tolerance for measured fractional values. Prove
the assertion detects a changed expected value, then restore it. A method-based
observation may require a dedicated meter; declaring a new name alone adds no
runtime implementation.

The pad runner exercises serialize/create/restore on its comparison areas. A real
inter-instance gallery transfer additionally exercises transport, ownership and
cleanup. Keep both scopes distinct. The current anchor lookup can select the
first matching entity inside its search box; place anchors so this is unambiguous.

## Replace a baked checkpoint

Do this only in a fixture-maintenance environment. Preserve the previous archive
and its failure evidence. Save the prepared world, wait for saving to finish, copy
out the completed archive, and verify it opens. A return from `game.server_save`
alone is insufficient when non-blocking saving is enabled.

Update both the gallery artifact and its matching seed copy, then update the
manifest hash and remeasure any recorded observations. The seed destinations are:

```text
docker/seed-data/hosts/clusterio-host-1/clusterio-host-1-instance-1/lab-gallery-source.zip
docker/seed-data/hosts/clusterio-host-2/clusterio-host-2-instance-1/lab-gallery-destination.zip
```

Run `node --test tests/lab-gallery/manifest.test.mjs` and the relevant real gallery
suite on fresh fixture worlds. Never reseed a valuable development world merely
to pick up a renamed fixture. Full-state comparisons and recovery tests belong to
their declared [test scope](testing.md), not an unverified count in a manifest.

Source locations: [gallery](../../tests/lab-gallery/),
[gallery runner](../../tests/integration/gallery-suite/run-tests.mjs),
[seed archives](../../docker/seed-data/lab-saves/).
