import React, { useState } from "react";
import { Alert, Empty, Input, Radio, Switch, Table, Tag } from "antd";
import { ItemIcon, FluidIcon } from "../icons";
import { formatNumeric, formatSigned, parseFluidTemperatureKey } from "../utils";
import type { Evidence } from "./evidence";

export const auditLabel = (state: string) => ({ passed: "Passed", mismatch: "Mismatch", pending: "Pending",
	unavailable: "Evidence unavailable", "not-applicable": "Not applicable" }[state] || state);
export default function AuditTable({ model, kind }: { model: Evidence; kind: "items" | "fluids" }) {
	const [search, setSearch] = useState(""), [differences, setDifferences] = useState(false);
	const [view, setView] = useState("raw");
	const audit = model[kind];
	const raw = kind === "items" || view === "raw" ? audit.rows.map(row => ({ ...row, status: row.delta === 0 ? "Counts match" : kind === "items" ? "Mismatch" : "Quantity difference",
		tempDisplay: undefined as string | undefined, isThermalSummary: false, category: "", reconciled: false }))
		: model.fluidRows;
	const filtered = raw.filter(row => (!differences || row.delta !== 0)
		&& `${row.name} ${row.tempDisplay || ""}`.toLowerCase().includes(search.toLowerCase()))
		.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) || a.name.localeCompare(b.name));
	return <div className="se-audit-table" data-testid={`audit-${kind}`}>
		<Alert type={audit.state === "mismatch" ? "error" : audit.state === "passed" ? "success" : "info"} showIcon
			message={`${kind === "items" ? "Item" : "Fluid"} audit · ${auditLabel(audit.state)}`}
			description={kind === "items" ? "Source and destination counts are compared for each recorded key. Count checks do not prove every item's internal state."
				: "Source and destination fluid quantities and recorded temperature buckets. Thermal reconciliation is shown separately from raw quantity differences."} />
		{!audit.available ? <Empty description={audit.state === "not-applicable" ? "An export alone has no destination audit."
			: "Detailed source and destination measurements are unavailable. Missing data is not zero."} /> : <>
			<div className="se-audit-toolbar"><Input allowClear aria-label={`Search ${kind}`} placeholder={`Search ${kind}`} value={search} onChange={e => setSearch(e.target.value)} />
				<label><Switch size="small" checked={differences} onChange={setDifferences} aria-label={`${kind} differences only`} /> Differences only</label></div>
			{kind === "fluids" && <Radio.Group aria-label="Fluid evidence view" value={view} onChange={e => setView(e.target.value)} style={{ marginBottom: 16 }}>
				<Radio.Button value="raw">Raw quantities</Radio.Button><Radio.Button value="thermal">Thermal reconciliation</Radio.Button>
			</Radio.Group>}
			<Table size="small" pagination={false} rowKey="key" dataSource={filtered} scroll={{ x: 650 }}
				locale={{ emptyText: raw.length === 0 ? kind === "fluids" && view === "thermal" ? "No thermal reconciliation recorded" : "Measured empty cargo — zero recorded types" : "No matching comparisons" }}
				columns={[
					{ title: kind === "items" ? "Item / recorded key" : "Fluid / temperature", key: "name", render: (_, row) =>
						<span className="se-cargo-name">{kind === "items" ? <ItemIcon name={row.name} size={22} /> : <FluidIcon name={parseFluidTemperatureKey(row.name).baseName} size={22} />}
							<span>{row.name}<small>{row.tempDisplay || ""}{row.isThermalSummary ? " · Thermal (V×T)" : ""}</small></span></span> },
					{ title: "Source", key: "expected", render: (_, row) => row.expected === null ? "Not recorded" : formatNumeric(row.expected, kind === "items" ? 0 : 8) },
					{ title: "Destination", key: "actual", render: (_, row) => row.actual === null ? "Not recorded" : formatNumeric(row.actual, kind === "items" ? 0 : 8) },
					{ title: "Difference", key: "delta", render: (_, row) => <span className={row.delta !== 0 ? "se-difference" : ""}>{row.delta === null ? "Not recorded" : formatSigned(row.delta, kind === "items" ? 0 : 8)}</span> },
					{ title: "Comparison", key: "status", render: (_, row) => <Tag color={["Mismatch", "Not reconciled"].includes(row.status) ? "error" : row.reconciled || row.delta !== 0 ? "gold" : "default"}>{row.status}</Tag> },
				]} />
		</>}
	</div>;
}
