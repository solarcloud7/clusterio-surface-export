import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Empty, Input, Pagination, Select, Spin, Tag } from "antd";
import { BugOutlined, SearchOutlined } from "@ant-design/icons";
import type { SurfaceExportPlugin, SurfaceExportState } from "./view-models";
import { getErrorMessage, statusColor } from "./utils";
import { formatMs } from "../shared/utils";
import { duration, outcomeGroup, route, statusLabel } from "./logs/evidence";
import TransferDetail from "./logs/TransferDetail";
import LogPreview from "./logs/LogPreview";
import "./logs/style.css";

export default function TransactionLogsTab({ plugin, state }: { plugin: SurfaceExportPlugin; state: SurfaceExportState }) {
	const [selected, setSelected] = useState<string | null>(null);
	const [search, setSearch] = useState(""), [outcome, setOutcome] = useState("all"), [operation, setOperation] = useState("all");
	const [page, setPage] = useState(1), [preview, setPreview] = useState(false);
	const [requests, setRequests] = useState<Record<string, { loading: boolean; error?: string }>>({});
	const requested = useRef(new Set<string>());
	const generations = useRef(new Map<string, number>());
	const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
	useEffect(() => () => { timers.current.forEach(clearTimeout); generations.current.clear(); }, []);
	const load = (id: string) => {
		requested.current.add(id);
		const generation = (generations.current.get(id) || 0) + 1;
		generations.current.set(id, generation);
		setRequests(prev => ({ ...prev, [id]: { loading: true } }));
		let expired = false;
		const timer = setTimeout(() => {
			expired = true;
			if (generations.current.get(id) !== generation) return;
			setRequests(prev => ({ ...prev, [id]: { loading: false, error: "The request timed out. Check the connection and retry." } }));
		}, 15000);
		timers.current.add(timer);
		plugin.loadTransactionLog(id).then(() => {
			if (generations.current.get(id) === generation) setRequests(prev => ({ ...prev, [id]: { loading: false } }));
		}, err => {
			if (!expired && generations.current.get(id) === generation) setRequests(prev => ({ ...prev, [id]: { loading: false, error: getErrorMessage(err, "Request failed") } }));
		}).finally(() => { clearTimeout(timer); timers.current.delete(timer); });
	};
	const sorted = useMemo(() => [...state.transferSummaries].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)
		|| a.transferId.localeCompare(b.transferId)), [state.transferSummaries]);
	useEffect(() => { if (!selected && sorted.length) setSelected(sorted[0].transferId); }, [selected, sorted]);
	useEffect(() => { if (selected && !requested.current.has(selected)) load(selected); }, [selected, plugin]);
	const filtered = useMemo(() => sorted.filter(row => (outcome === "all" || outcomeGroup(row.status) === outcome)
		&& (operation === "all" || (row.operationType || "transfer") === operation)
		&& [row.platformName, row.transferId, row.sourceInstanceName, row.targetInstanceName, row.sourceInstanceId, row.targetInstanceId]
			.join(" ").toLowerCase().includes(search.trim().toLowerCase())), [sorted, search, outcome, operation]);
	const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / 10)));
	const row = sorted.find(entry => entry.transferId === selected);
	const request = selected ? requests[selected] : undefined;
	return <div className="se-logs" data-testid="transfer-logs">
		<div className="se-logs-heading"><div><h2>Transfer history</h2><p className="se-muted">Follow each operation. Inspect recorded step timings and item-by-item, fluid-by-fluid audit evidence.</p></div>
			<Button aria-label="Preview logs" icon={<BugOutlined />} onClick={() => setPreview(true)}>Preview logs</Button></div>
		{state.liveStatus !== "live" && <Alert showIcon type="warning" message={state.liveStatus === "reconnecting" ? "Reconnecting — displayed history may be out of date" : "Live updates unavailable"} description={state.liveError || "Existing history remains available while the connection recovers."} />}
		{state.treeError && <Alert type="error" showIcon message="Could not refresh loaded history" description={state.treeError}
			action={plugin.refreshSnapshots && <Button onClick={() => void plugin.refreshSnapshots!()}>Retry history</Button>} />}
		<div className="se-logs-layout">
			<section className="se-history" aria-label="Operation history">
				<div className="se-history-controls">
					<Input prefix={<SearchOutlined />} allowClear aria-label="Search loaded operations" placeholder="Platform, instance or operation ID" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
					<div className="se-history-filters"><Select aria-label="Outcome filter" value={outcome} onChange={value => { setOutcome(value); setPage(1); }} options={[
						{ value: "all", label: "All outcomes" }, { value: "completed", label: "Completed" }, { value: "attention", label: "Needs attention" }, { value: "active", label: "In progress" },
					]} /><Select aria-label="Operation filter" value={operation} onChange={value => { setOperation(value); setPage(1); }} options={[
						{ value: "all", label: "All operations" }, { value: "transfer", label: "Transfers" }, { value: "export", label: "Exports" }, { value: "import", label: "Imports" },
					]} /></div>
					<small className="se-muted">Searching {sorted.length} loaded operations · {filtered.length} matching</small>
				</div>
				<div className="se-history-list">{filtered.slice((currentPage - 1) * 10, currentPage * 10).map(entry => {
					const ms = duration(entry, Date.now());
					return <button key={entry.transferId} className={`se-history-row${entry.transferId === selected ? " is-selected" : ""}`}
						onClick={() => setSelected(entry.transferId)} aria-pressed={entry.transferId === selected} data-transfer-id={entry.transferId}>
						<span className="se-history-title"><strong>{entry.platformName || "Unnamed platform"}</strong><Tag color={statusColor(entry.status || "")}>{statusLabel(entry.status)}</Tag></span>
						<span className="se-history-route">{route(entry)}</span>
						<span className="se-history-meta"><span>{entry.operationType || "transfer"}</span><span>{ms == null ? "Duration unavailable" : formatMs(ms) || "0 ms"}</span>
							<time>{entry.startedAt == null ? "Start unavailable" : new Date(entry.startedAt).toLocaleString()}</time></span>
					</button>;
				})}</div>
				{!filtered.length && (state.loadingTree && !sorted.length ? <div className="se-loading" role="status"><Spin /><p>Loading recent operations…</p></div>
					: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={sorted.length ? "No operations match these filters" : "No operations loaded"} />)}
				<Pagination size="small" current={currentPage} pageSize={10} total={filtered.length} showSizeChanger={false} onChange={setPage} />
			</section>
			<div className="se-detail-panel">{row ? <TransferDetail row={row} detail={state.logDetails[row.transferId]} loading={request?.loading ?? true}
				 error={request?.error} onRetry={() => load(row.transferId)} plugin={plugin} /> : <Empty description="Select an operation to inspect its evidence" />}</div>
		</div>
		{preview && <LogPreview onClose={() => setPreview(false)} />}
	</div>;
}
