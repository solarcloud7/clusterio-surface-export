import React from "react";
import { Collapse, Table, Tag, Tooltip } from "antd";
import { clockGroups, elapsed, type OperationTiming, type TimingRecord } from "../../shared/timing";

export const timingMs = (value: number | null | undefined) => value == null ? "Not measured" : `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })} ms`;
const labels = { controller: "Clusterio orchestration", instance: "Clusterio instance handling",
	"source-lua": "Source Lua", "destination-lua": "Destination Lua", "recovery-lua": "Recovery Lua" };

function ClockTable({ records, totalMs }: { records: TimingRecord[]; totalMs: number }) {
	return <Table size="small" pagination={false} rowKey={row => `${row.clockId}:${row.id}`} dataSource={records}
		scroll={{ x: 900 }} columns={[
			{ title: "Stage / step", key: "stage", render: (_, row: TimingRecord) => <Tooltip title={row.error || row.kind}><span>{row.stage.replaceAll("_", " ")}{row.batch ? ` · batch ${row.batch}` : ""}</span></Tooltip> },
			{ title: "Status", key: "status", render: (_, row: TimingRecord) => <Tag>{row.status}</Tag> },
			{ title: "Start", key: "start", render: (_, row: TimingRecord) => timingMs(row.startMs) },
			{ title: "End", key: "end", render: (_, row: TimingRecord) => timingMs(row.endMs) },
			{ title: "Elapsed", key: "elapsed", render: (_, row: TimingRecord) => timingMs(elapsed(row)) },
			{ title: "Execution", key: "execution", render: (_, row: TimingRecord) => row.kind === "wait" ? "Waiting" : timingMs(row.executionMs) },
			{ title: "Waterfall (ms)", key: "bar", width: 160, render: (_, row: TimingRecord) =>
				<div className="se-timing-track">{elapsed(row) !== null && totalMs > 0 && <span style={{
					left: `${row.startMs! / totalMs * 100}%`, width: `${elapsed(row)! / totalMs * 100}%`,
					background: row.kind === "wait" ? "#888" : "#1890ff",
				}} />}</div> },
		]} />;
}

export default function MeasuredTiming({ timing, compact }: { timing: OperationTiming; compact: boolean }) {
	return <>{clockGroups(timing.records).map(group => {
		const title = `${labels[group.owner]}${group.records[0].instanceId != null ? ` · instance ${group.records[0].instanceId}` : ""}`;
		const content = <section data-clock={group.clockId}>
		<h3>{title}</h3>
		<p className="se-muted">{group.records[0].jobId} · Local start: 0 ms · {group.owner.includes("lua") ? "Factorio LuaProfiler" : "Node monotonic clock"}</p>
		{group.records[0].operationId && <p className="se-muted">Related operation: {group.records[0].operationId}</p>}
		<ClockTable records={group.records.filter(row => !row.batch)} totalMs={group.totalMs} />
		{!compact && <Collapse items={[
			{ key: "ticks", label: "Tick boundaries and batch counts", children: <Table size="small" pagination={false} rowKey="id"
				dataSource={group.records.filter(row => !row.batch && row.startTick !== undefined)} columns={[
					{ title: "Step", dataIndex: "stage" }, { title: "Start tick", dataIndex: "startTick" },
					{ title: "End tick", dataIndex: "endTick", render: value => value ?? "Not recorded" },
					{ title: "Ticks elapsed", dataIndex: "ticksElapsed", render: value => value ?? "Not recorded" },
					{ title: "Batches", dataIndex: "batchCount" }, { title: "Ticks containing work", dataIndex: "workTicks" },
				]} /> },
			{ key: "batches", label: `Individual batches (${group.records.filter(row => row.batch).length}${group.records.some(row => row.truncated) ? "; truncated at 2000" : ""})`,
				children: group.records.some(row => row.batch) ? <ClockTable records={group.records.filter(row => row.batch)} totalMs={group.totalMs} /> : <p>Individual batch recording was not enabled.</p> },
		]} />}
	</section>;
		return group.owner === "instance" || compact
			? <Collapse key={group.clockId} items={[{ key: group.clockId, label: title, children: content }]} />
			: <React.Fragment key={group.clockId}>{content}</React.Fragment>;
	})}</>;
}
