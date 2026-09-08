import React from "react";
import { Empty, Table } from "antd";
import type { GanttRow, TimelineAttribution } from "../view-models";
import type { OperationTiming } from "../../shared/timing";
import MeasuredTiming, { timingMs } from "./MeasuredTiming";

export default function TimingTable({ rows, timing, compact = false }: {
 rows: GanttRow[]; attribution?: TimelineAttribution; timing?: OperationTiming | null; compact?: boolean;
}) {
 const legacy = rows.filter(row => row.kind === "measured" || row.kind === "event");
 if (!timing?.records.length && !legacy.length) return <Empty description="No measured elapsed times available" />;
 return <div className="se-timing">
  {!compact && <p className="se-muted">Each waterfall uses its own local clock. Positions across clocks are not aligned. Stages can overlap; do not add their durations. Phase elapsed time includes waits between batches; execution measures only instrumented work. Request round trips include remote handling, not just network communication.</p>}
  {timing && <MeasuredTiming timing={timing} compact={compact} />}
  {!timing?.records.some(row => row.owner === "controller") && legacy.length > 0 && <section>
   <h3>Clusterio orchestration - legacy recording</h3>
   <p className="se-muted">Controller elapsed measurements only. Legacy tick evidence remains in Technical details.</p>
   <Table size="small" pagination={false} rowKey="key" dataSource={legacy} columns={[
    { title: "Stage / event", dataIndex: "label" }, { title: "Start", key: "start", render: (_, row: GanttRow) => timingMs(row.startMs) },
    { title: "End", key: "end", render: (_, row: GanttRow) => row.kind === "event" ? "-" : timingMs(row.endMs) },
    { title: "Elapsed", key: "duration", render: (_, row: GanttRow) => row.kind === "event" ? "-" : timingMs(row.durationMs) },
    { title: "Waterfall (ms)", key: "bar", render: (_, row: GanttRow) => <div className="se-timing-track"><span style={{ left: `${row.ganttStartPct}%`, width: row.kind === "event" ? 2 : `${row.ganttWidthPct}%`, background: "#1890ff" }} /></div> },
   ]} />
  </section>}
 </div>;
}
