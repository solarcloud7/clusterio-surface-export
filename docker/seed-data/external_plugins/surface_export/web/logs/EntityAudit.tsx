import { useState } from "react";
import { Collapse, Descriptions, Empty, Input, Table } from "antd";
import { EntityIcon, ItemIcon } from "../icons";
import { formatNumeric, formatSigned } from "../utils";
import type { Evidence } from "./evidence";

export const entityAuditLabel = (state: string) => ({ mismatch: "Failure recorded", partial: "Partial evidence",
	pending: "Pending", unavailable: "Evidence unavailable", "not-applicable": "Not applicable" }[state] || state);

export default function EntityAudit({ model }: { model: Evidence }) {
	const [search, setSearch] = useState("");
	const [differenceSearch, setDifferenceSearch] = useState("");
	const audit = model.entities;
	const diagnostic = audit.diagnostic;
	const differences = (diagnostic?.rows || []).filter(row => `${row.name} ${row.item} ${row.x}, ${row.y} ${row.entityId}`.toLowerCase().includes(differenceSearch.toLowerCase()));
	const count = (value: number | null) => value === null ? "Not recorded" : formatNumeric(value, 0);
	const rows = Object.entries(audit.types || {}).filter(([name]) => name.toLowerCase().includes(search.toLowerCase()))
		.sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value }));
	const census = <>
		<Descriptions size="small" bordered column={1} items={[
			{ key: "payload", label: "Reported import entity count", children: count(audit.payload) },
			{ key: "census", label: "Destination count", children: count(audit.census) },
			{ key: "created", label: "Created", children: count(audit.created) },
			{ key: "failed", label: "Placement failures", children: count(audit.failed) },
			{ key: "skipped", label: "Skipped during placement", children: count(audit.skipped) },
		]} />
		<p className="se-muted">Placement counts and the surface count have different scopes; skipped entities are not automatically losses. The prototype count does not identify individual failing positions. Inspect Technical details for any additional retained diagnostics.</p>
		{audit.types === null ? <Empty description={audit.state === "not-applicable" ? "An export alone has no destination count." : "Destination entity breakdown was not recorded."} /> : <>
			<div className="se-audit-toolbar"><Input allowClear aria-label="Search entities" placeholder="Search entity prototypes" value={search} onChange={event => setSearch(event.target.value)} /></div>
			<Table size="small" rowKey="name" dataSource={rows} pagination={{ pageSize: 20, showSizeChanger: false }} columns={[
				{ title: "Entity prototype", key: "name", render: (_, row) => <span className="se-cargo-name"><EntityIcon name={row.name} size={22} /><span>{row.name}</span></span> },
				{ title: "Destination count", key: "count", render: (_, row) => formatNumeric(row.value, 0) },
			]} />
		</>}
	</>;
	return <div className="se-audit-table" data-testid="audit-entities">
		{audit.failure || diagnostic ? <section data-testid="entity-differences">
			<h3>Belt content differences</h3>
			<p className="se-muted">Recorded before rollback: source counts and destination counts at each belt position and line. These differences help investigate the failed check; they are not individual failure verdicts. Some line-level movement is permitted by restoration.</p>
			{diagnostic?.status === "available" ? <>
				<div className="se-audit-toolbar"><Input allowClear aria-label="Search belt differences" placeholder="Item, entity, or position" value={differenceSearch} onChange={event => setDifferenceSearch(event.target.value)} /></div>
				<p className="se-muted">{diagnostic.totalRows} recorded differences{diagnostic.truncated ? ` · first ${diagnostic.rows.length} retained in this view` : ""} · {differences.length} matching</p>
				<Table size="small" dataSource={differences} rowKey={row => `${row.entityId}:${row.line}:${row.item}`} scroll={{ x: 650 }}
					pagination={{ pageSize: 10, showSizeChanger: false }} locale={{ emptyText: diagnostic.totalRows === 0 ? "No belt-line count differences were recorded. This does not override the failed structural check." : "No matching belt differences" }} columns={[
						{ title: "Belt / location", key: "entity", render: (_, row) => <span className="se-cargo-name"><EntityIcon name={row.name} size={22} /><span>{row.name}<small>({row.x}, {row.y}) · line {row.line} · entity {row.entityId}</small></span></span> },
						{ title: "Item", key: "item", render: (_, row) => <span className="se-cargo-name"><ItemIcon name={row.item} size={22} /><span>{row.item}</span></span> },
						{ title: "Source", key: "expected", render: (_, row) => formatNumeric(row.expected, 0) },
						{ title: "Destination", key: "actual", render: (_, row) => formatNumeric(row.actual, 0) },
						{ title: "Difference", key: "delta", render: (_, row) => <span className="se-difference">{formatSigned(row.delta, 0)}</span> },
					]} />
				<p className="se-muted">Source: destination failure diagnostic <code>{diagnostic.file}</code>. This comparison is included in Download diagnostic report.</p>
			</> : <Empty description={diagnostic?.reason || "Affected positions and before/after measurements were not retained in this operation's browser evidence. The count below cannot explain the structural failure."} />}
		</section> : <><h3>Entity evidence</h3><p className="se-muted">Recorded placement and destination count evidence. A complete source-to-destination entity state comparison is not recorded.</p></>}
		{audit.failure || diagnostic ? <Collapse items={[{ key: "census", label: "Placement totals and entity counts", children: census }]} /> : census}
	</div>;
}
