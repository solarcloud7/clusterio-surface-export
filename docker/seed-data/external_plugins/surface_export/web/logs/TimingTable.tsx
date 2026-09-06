import React from "react";
import { Alert, Empty, Table, Tooltip } from "antd";
import type { GanttRow, TimelineAttribution } from "../view-models";
import { formatMs } from "../../shared/utils";
import { describeAttribution, describeSourceExportAnomaly, describeImportGapAnomaly, TIMELINE_PALETTE, tickHatch } from "../../shared/transfer-timeline";

const basis = (row: GanttRow) => ({ measured: "Elapsed time", tickDerived: "Game ticks", event: "Event",
	residual: "Unattributed", detailGap: "Within measured stage" }[row.kind]);
export default function TimingTable({ rows, attribution, compact = false }: {
	rows: GanttRow[]; attribution?: TimelineAttribution; compact?: boolean;
}) {
	const shown = compact ? rows.filter(row => row.indent <= 1 && row.kind !== "event" && row.kind !== "residual") : rows;
	const notices = attribution ? [describeAttribution(attribution), describeSourceExportAnomaly(attribution), describeImportGapAnomaly(attribution)].filter(Boolean) : [];
	if (!shown.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No recorded stage timings available" />;
	return <div className="se-timing">
		{!compact && <><p className="se-muted">Elapsed time and game-tick measurements are distinct. Stages can overlap; their durations must not be added together.</p>
			{notices.map(notice => <Alert key={notice!.headline} type="warning" showIcon message={notice!.headline} description={notice!.detail} />)}</>}
		<Table size="small" pagination={false} rowKey="key" dataSource={shown} scroll={{ x: compact ? 460 : 700 }}
			columns={[
				{ title: "Stage / step", key: "label", render: (_, row: GanttRow) => <Tooltip title={row.note}><span style={{ paddingLeft: compact ? 0 : row.indent * 12 }}>{row.label.replaceAll("_", " ")}</span></Tooltip> },
				{ title: "Start", key: "start", render: (_, row: GanttRow) => formatMs(row.startMs) || "0 ms" },
				{ title: "Duration", key: "duration", render: (_, row: GanttRow) => row.kind === "event" ? "—"
					: row.kind === "tickDerived" && (row.durationMs === 0 || row.note?.startsWith("Under one tick")) ? "<1 tick" : row.durationMs == null ? "Not measured" : formatMs(row.durationMs) || "0 ms" },
				{ title: "Measured by", key: "basis", render: (_, row: GanttRow) => <small className="se-muted">{basis(row)}</small> },
				...(!compact ? [{ title: "Timeline", key: "bar", width: 150, render: (_: unknown, row: GanttRow) =>
					<div className="se-timing-track"><span style={{ left: `${row.ganttStartPct}%`,
						width: row.kind === "event" ? 2 : `${row.ganttWidthPct}%`,
						background: row.kind === "tickDerived" ? tickHatch(TIMELINE_PALETTE[row.color] || "#888") : TIMELINE_PALETTE[row.color] || "#888" }} /></div> }] : []),
			]} />
	</div>;
}
