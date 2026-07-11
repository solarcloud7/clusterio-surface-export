# Metrics cookbook — ready-to-paste PromQL for `surface_export_*`

Scrape point: the controller's `/metrics` (statistics_exporter). Quick check:
`docker exec surface-export-controller sh -c 'curl -s http://localhost:8080/metrics | grep ^surface_export_'`

The four collectors (`lib/metrics.ts`; recorded once per operation at the terminal chokepoint):

| Metric | Type | Labels |
|---|---|---|
| `surface_export_operations_total` | counter | `operation` (transfer/export/import), `result` (success/failure/cleanup_failed), `failure_stage` (items/fluids/none) |
| `surface_export_operation_duration_seconds` | histogram | same three |
| `surface_export_entities_transferred_total` | counter | `operation` |
| `surface_export_export_stall_seconds` | histogram | `operation` — the source-side async export span (the tick-stall window that can heartbeat-drop a connected player) |

## Recipes

**Transfer success rate (last hour):**
```promql
sum(rate(surface_export_operations_total{operation="transfer",result="success"}[1h]))
/ sum(rate(surface_export_operations_total{operation="transfer"}[1h]))
```

**What is failing, by gate category** (items vs fluids — `failure_stage="none"` on successes):
```promql
sum by (failure_stage) (increase(surface_export_operations_total{result="failure"}[24h]))
```

**`cleanup_failed` needs eyes** (a verdict was rendered but teardown/banking failed — source or evidence
preserved; see the operator runbook):
```promql
increase(surface_export_operations_total{result="cleanup_failed"}[24h]) > 0
```

**Transfer duration p95:**
```promql
histogram_quantile(0.95,
  sum by (le) (rate(surface_export_operation_duration_seconds_bucket{operation="transfer"}[6h])))
```

**Entity throughput (entities landed per hour):**
```promql
sum(rate(surface_export_entities_transferred_total[1h])) * 3600
```

**Export tick-stall p95** (player heartbeat-drop risk window — the connected-player drop happens inside
this span; large platforms run ~40s):
```promql
histogram_quantile(0.95,
  sum by (le) (rate(surface_export_export_stall_seconds_bucket[6h])))
```

**Alert sketch — any failed transfer, 15m:**
```promql
increase(surface_export_operations_total{operation="transfer",result=~"failure|cleanup_failed"}[15m]) > 0
```

Metrics tell you *that* and *how long*; the `cluster-*.log` JSON files tell you *why* (see CLAUDE.md
Observability). The banked failure black boxes (`script-output/failure_black_box_*.json`) carry the
per-transfer forensic diff.
