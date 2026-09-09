# Moving belt capture experiment

This is a read-only capture candidate on disposable belts, not a production exporter.
Engine: Factorio 2.1.17. No production module, scheduler, pause or configuration changes.

Hypothesis: merging observed item IDs across batches, including immediate input/output
neighbors of the selected belt, captures every item in a closed moving network.
Candidates are plain selected-belt reads, ID-deduplicated selected-belt reads, and the
union of ID-deduplicated selected-belt plus one-hop neighbor reads. None has crossing
events or access to observations made between its batches. This is not a test of every
possible neighbor-reconciliation algorithm.

Invariant: one inserted normal iron plate remains one item in the closed fixture,
and a completed candidate must contain that item exactly once. Raw positions are
retained, but passing quantity alone does not prove a same-tick position snapshot.
No clearing, reinsertion, repair, inventory buffering, freezing or output removal is
allowed between seed and final observation. Different ticks and item positions are expected.

The independent observer rereads every fixture belt in one callback, checks against
the known one-item seed, records its ID and all visible positions, and checks for
ground items. Candidate reads execute separately and never consume observer rows.
In the loop arm only, the observer chooses an adversarial but legal sampling schedule:
take the next batch when the item is on the opposite belt, outside its one-hop window.
Intervening observer reads are not candidate reads. If that window cannot be reached
within the bound, the arm is inconclusive (HARNESS_ERROR), not a passed candidate.

Ladder: injected-failure cleanup, API shape smoke, straight upstream/downstream scan
orders, splitter traversal, then loop. Plain/deduplicated reads are negative controls;
stop extending the candidate ladder when the one-hop candidate misses or duplicates
an item. Larger networks, stack merges/splits, spoilage, stateful items, loaders,
linked belts, production transfer, and performance improvements remain NOT TESTED.

Bounds: one 32x32 disposable surface at a time; at most five belts/splitters;
256 prepared tiles; one generated chunk; one item; 24 polls per step, 100 probe RCON calls
and 150 seconds for the fixture ladder, plus at most 16 pre/postflight and independent
cleanup reads. Cleanup remains allowed after a budget expires. Commands below 16 KiB, each response below
128 KiB, artifact below 8 MiB. Pre/postflight requires both instances idle, no players,
jobs, locks, holds or tombstones, and no existing surfaces/storage with this lab prefix.
An API error, changed item identity/count, missing crossing, timeout or cleanup error
is HARNESS_ERROR. A proven candidate omission is STOP. No scheduler change follows STOP.

The runner hashes this contract, fixture, Lua observer/construction/cleanup and runner.
It saves raw observations before analysis and supports `--analyze` without cluster access.
Cleanup runs inside the probe and independently in the runner's finally block; the
runner verifies that no owned surface or storage remains and the simulation is unpaused.
Surface deletion can be deferred until callback return; the independent follow-up read
owns the absence verdict, not the deletion callback's immediate observation.
