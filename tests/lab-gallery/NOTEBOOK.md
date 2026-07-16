# Lab Gallery Notebook

## GALLERY-R1 [empirical, 2.0.77] — Paired golden saves and first migrated lab

Prediction: the PR #111 gallery seed can be reduced to a paired source/destination lifecycle while preserving its
125-stack belt pilot and baking the specialized-fluid reachability control into the same source game file.

Observed on Factorio 2.0.77 with the manifest's exact mod set:

- The original seed contained 2,832 entities across 4,568 generated chunks.
- The source golden save contains 34 entities across 248 chunks: the compact index, 32 belts on two Nauvis
  chunks, and a two-entity platform containing the hub and one electric mining drill.
- The destination golden save contains zero entities across 92 chunks and no space platform.
- Independent reload metering observed 125 physical one-item iron-plate stacks split 67/58, plus platform
  `pressure=0`, `gravity=0`, `mining_target=nil`, live fluidbox count zero, and rejected fluidbox read/write.
- An injected post-load runner failure exited nonzero, removed its prefix-owned runtime, and the immediately
  following clean reload reproduced the full reachability classification with no contract failures.
- No managed transfer instance was mutated. The verified source copy was loaded only into the dedicated
  `surface-export-lab-gallery` instance; the prior gallery save remains available for rollback.

Artifacts and exact censuses are pinned in `manifest.json`. The build and reload instruments are not behavioral
oracles; acceptance comes from the independent physical reload meter and the specialized lab's evidence validator.
