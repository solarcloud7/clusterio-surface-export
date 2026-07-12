# OPS Lab Notebook

Append-only operational measurements for LAB-TAIL. These measure this cluster stack, not Factorio API
semantics.

## 2026-07-11 - T2 focused pass hard stop

Prediction: five clean 1,359-entity transfers complete well inside the 120-second validation timeout,
followed by one densified scaling fixture. No gate mismatch is expected.

Observed normal-transfer controller timings before the stop:

| Run | Validation | Completion | Verdict |
| --- | ---: | ---: | --- |
| 1 | 893 ms | 923 ms | success |
| 2 | 943 ms | 970 ms | success |
| 3 | 932 ms | 956 ms | success |
| 4 | 890 ms | 919 ms | success |
| 5 | 1058 ms | n/a | **failed exact gate** |

Run 5 evidence:

- Transfer ID: `1495071488:025_ops-lab-tail-t2-4-1783813751032`.
- Exact mismatch: `piercing-rounds-magazine expected 7136, actual 7132, delta -4`.
- Destination black box: `failure_black_box_ops-lab-tail-t2-4-1783813751032_131781.json`.
- Destination was discarded after black-box capture.
- Source rollback succeeded at `+1098 ms`; transfer terminated failed at `+1113 ms`.
- Runner cleanup then proved both hosts had zero lab surfaces, exports, lab storage, locked platforms,
  destination holds, async jobs, and committed source tombstones; both games were unpaused.

Classification: **HARD STOP, UNEXPLAINED item-conservation failure**. This is not a timeout result and
does not license any tolerance or gate change. The densified T2 arm, T4 confirmation, evidence passes,
and LAB-TAIL certification were not run.
