import React, { useContext, useEffect, useState } from "react";
import { Badge, Tabs, Tooltip } from "antd";

import {
	BaseWebPlugin,
	ControlContext,
	PageHeader,
	PageLayout,
} from "@clusterio/web_ui";
import * as messageDefs from "../messages";
import TransactionLogsTab from "./TransactionLogsTab";
import GatewayCanvas from "./gateway/GatewayCanvas";
import ImportModal from "./ImportModal";
import type { JsonObject, LogEvent, SurfaceExportPlugin, SurfaceExportState, TransferSummary } from "./view-models";

import { summaryFromTransferInfo, mergeTransferSummary, getErrorMessage, getProp } from "./utils";
import { decideSnapshot, entriesChangedSince, freshRevisionWatermarks, isFreshRevision } from "../shared/revision-gate";
import { nextLiveStatus, resubscribeDelayMs, shouldRetryResubscribe } from "../shared/live-status";
import type { ConnectionEvent, LiveStatus, SyncOutcome } from "../shared/live-status";
import "./style.css";

const {
	PERMISSIONS,
	GetPlatformTreeRequest,
	GetStoredExportRequest,
	ImportUploadedExportRequest,
	ExportPlatformForDownloadRequest,
	ListTransactionLogsRequest,
	GetTransactionLogRequest,
	StartPlatformTransferRequest,
	GetGatewaysRequest,
	SetGatewayLinkRequest,
	SetSurfaceExportSubscriptionRequest,
	SurfaceExportTreeUpdateEvent,
	SurfaceExportTransferUpdateEvent,
	SurfaceExportLogUpdateEvent,
} = messageDefs;

type ControlLike = {
	plugins: Map<string, unknown>;
	connector: { connected: boolean };
	send: (message: unknown) => Promise<unknown>;
	handle: (message: unknown, handler: (payload: unknown) => void | Promise<void>) => void;
};

function useSurfaceExportPlugin(control: ControlLike): SurfaceExportPlugin {
	return control.plugins.get("surface_export") as SurfaceExportPlugin;
}

function useSurfaceExportState(plugin: SurfaceExportPlugin) {
	const [state, setState] = useState<SurfaceExportState>(plugin.getState());

	useEffect(() => {
		function onUpdate() {
			setState(plugin.getState());
		}

		plugin.onUpdate(onUpdate);
		return () => plugin.offUpdate(onUpdate);
	}, [plugin]);

	return state;
}

const LIVE_STATUS_DISPLAY: Record<LiveStatus, { status: "success" | "processing" | "default" | "warning"; text: string; hint: string }> = {
	live: { status: "success", text: "live", hint: "Subscribed — the page updates on its own." },
	reconnecting: { status: "processing", text: "reconnecting", hint: "The controller connection dropped. Reconnecting; this page is not updating." },
	offline: { status: "default", text: "offline", hint: "The controller connection is closed. What you see is the last state received, not current." },
	degraded: { status: "warning", text: "not updating", hint: "Connected, but the live subscription failed. Retrying — what you see may be stale." },
};

function LiveStatusBadge({ state }: { state: SurfaceExportState }) {
	const display = LIVE_STATUS_DISPLAY[state.liveStatus];
	const hint = state.liveError ? `${display.hint} (${state.liveError})` : display.hint;
	return (
		<Tooltip title={hint}>
			<span data-testid="live-status" data-live-status={state.liveStatus} style={{ fontSize: 12 }}>
				<Badge status={display.status} text={display.text} />
			</span>
		</Tooltip>
	);
}

function SurfaceExportPage() {
	const control = useContext(ControlContext) as unknown as ControlLike;
	const plugin = useSurfaceExportPlugin(control);
	const state = useSurfaceExportState(plugin);
	const [importModalOpen, setImportModalOpen] = useState(false);
	const [activeTab, setActiveTab] = useState<string>(() => {
		const t = new URLSearchParams(window.location.search).get("tab");
		return t && ["logs", "gateways"].includes(t) ? t : "gateways";
	});
	function handleTabChange(key: string) {
		setActiveTab(key);
		const params = new URLSearchParams(window.location.search);
		params.set("tab", key);
		window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
	}
	const tabItems: Array<{ key: string; label: string; children: React.ReactNode }> = [];
	if (state.canViewLogs !== false) {
		tabItems.push({
			key: "logs",
			label: "Transaction Logs",
			children: <TransactionLogsTab plugin={plugin} state={state} />,
		});
	}
	tabItems.push({
		key: "gateways",
		label: "Gateways",
		children: <GatewayCanvas plugin={plugin} state={state} onOpenImport={() => setImportModalOpen(true)} />,
	});

	const effectiveTab = tabItems.some(t => t.key === activeTab) ? activeTab : "gateways";

	useEffect(() => {
		document.body.classList.add("surface-export-page");
		return () => document.body.classList.remove("surface-export-page");
	}, []);

	return (
		<PageLayout nav={[]}>
			{}
			<PageHeader title="Surface Export" />
			<Tabs
				activeKey={effectiveTab}
				onChange={handleTabChange}
				items={tabItems}
				tabBarExtraContent={<LiveStatusBadge state={state} />}
			/>
			<ImportModal
				open={importModalOpen}
				onClose={() => setImportModalOpen(false)}
				plugin={plugin}
				state={state}
			/>
		</PageLayout>
	);
}

export class WebPlugin extends BaseWebPlugin {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private get link(): ControlLike { return this.control as unknown as ControlLike; }

	private callbacks: Array<() => void>;
	private liveUpdatesEnabled: boolean;
	private state: SurfaceExportState;
	private resubscribeTimer: number | null = null;
	private lastConnectionEvent: ConnectionEvent | null = null;
	private resubscribeGeneration = 0;

	constructor(container: unknown, packageData: JsonObject, info: JsonObject, control: ControlLike, logger: unknown) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		super(container, packageData, info as any, control as any, logger as any);
		this.callbacks = [];
		this.liveUpdatesEnabled = false;
		this.state = {
			tree: null,
			loadingTree: false,
			treeError: null,
			transferSummaries: [],
			logDetails: {},
			lastTreeRevision: 0,
			lastTransferRevision: 0,
			lastLogRevision: 0,
			canViewLogs: true,
			liveStatus: "reconnecting",
			liveError: null,
		};
	}

	override async init() {
		this.pages = [
			{
				path: "/surface-export",
				sidebarName: "Surface Export",
				permission: PERMISSIONS.UI_VIEW,
				content: <SurfaceExportPage />,
			},
		];

		this.link.handle(SurfaceExportTreeUpdateEvent, payload => this.handleTreeUpdate(payload as JsonObject));
		this.link.handle(SurfaceExportTransferUpdateEvent, payload => this.handleTransferUpdate(payload as JsonObject));
		this.link.handle(SurfaceExportLogUpdateEvent, payload => this.handleLogUpdate(payload as JsonObject));
	}

	override onControllerConnectionEvent(event: ConnectionEvent) {
		this.lastConnectionEvent = event;
		if (event === "connect") {
			this.setState(freshRevisionWatermarks());
		}
		if (event === "connect" || event === "resume") {
			this.resubscribeUntilLive();
			return;
		}
		this.resubscribeGeneration += 1;
		this.clearResubscribeTimer();
		this.applyLiveStatus(null, null);
	}

	private clearResubscribeTimer() {
		if (this.resubscribeTimer !== null) {
			clearTimeout(this.resubscribeTimer);
			this.resubscribeTimer = null;
		}
	}

	applyLiveStatus(outcome: SyncOutcome | null, error: string | null) {
		const status = nextLiveStatus({
			previous: this.state.liveStatus,
			connected: this.link.connector.connected,
			lastEvent: this.lastConnectionEvent,
			outcome,
		});
		this.setState({ liveStatus: status, liveError: error });
		return status;
	}

	syncAndReport(): Promise<SyncOutcome | null> {
		return this.syncLiveState().then(
			outcome => { this.applyLiveStatus(outcome, null); return outcome; },
			(err: unknown) => {
				const message = getErrorMessage(err, "live subscription failed");
				this.applyLiveStatus("failed", message);
				console.warn(`Surface Export live updates: ${message}`);
				return null;
			},
		);
	}

	resubscribeUntilLive(attempt = 0, generation = ++this.resubscribeGeneration) {
		this.clearResubscribeTimer();
		this.syncAndReport().then(() => {
			if (generation !== this.resubscribeGeneration) {
				return;
			}
			if (!shouldRetryResubscribe(this.state.liveStatus, this.link.connector.connected)) {
				return;
			}
			const delayMs = resubscribeDelayMs(attempt);
			this.resubscribeTimer = setTimeout(() => {
				this.resubscribeTimer = null;
				this.resubscribeUntilLive(attempt + 1, generation);
			}, delayMs) as unknown as number;
		});
	}

	getState() {
		return this.state;
	}

	setState(partial: Partial<SurfaceExportState>) {
		this.state = { ...this.state, ...partial };
		for (const callback of this.callbacks) {
			callback();
		}
	}

	onUpdate(callback: () => void) {
		this.callbacks.push(callback);
		this.syncAndReport();
	}

	offUpdate(callback: () => void) {
		const index = this.callbacks.lastIndexOf(callback);
		if (index !== -1) {
			this.callbacks.splice(index, 1);
		}
		this.syncAndReport();
	}

	async syncLiveState(): Promise<SyncOutcome> {
		const shouldEnable = this.callbacks.length > 0;
		if (!this.link.connector.connected) {
			this.liveUpdatesEnabled = shouldEnable;
			return "skipped";
		}
		const trySubscribe = (logs: boolean) => this.link.send(new SetSurfaceExportSubscriptionRequest({
			tree: shouldEnable,
			transfers: shouldEnable,
			logs,
			transferId: null,
		}));
		let logsEnabled = shouldEnable && this.state.canViewLogs !== false;
		try {
			await trySubscribe(logsEnabled);
		} catch (err: unknown) {
			if (logsEnabled && /permission denied/i.test(getErrorMessage(err))) {
				logsEnabled = false;
				this.setState({ canViewLogs: false });
				await trySubscribe(false);
			} else {
				throw err;
			}
		}

		this.liveUpdatesEnabled = shouldEnable;
		if (shouldEnable) {
			await this.refreshSnapshots();
			return "subscribed";
		}
		return "unsubscribed";
	}

	async refreshSnapshots() {
		this.setState({ loadingTree: true, treeError: null });
		const summariesBeforeFetch = new Map(this.state.transferSummaries.map(summary => [summary.transferId, summary]));
		try {
			const treeResponse = await this.link.send(new GetPlatformTreeRequest({ forceName: "player" })) as JsonObject;
			let transferSummaries = this.state.transferSummaries;
			if (this.state.canViewLogs !== false) {
				try {
					const logSummaries = await this.link.send(new ListTransactionLogsRequest({ limit: 100 }));
					transferSummaries = Array.isArray(logSummaries)
						? [...logSummaries].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
						: [];
					for (const pushed of entriesChangedSince(summariesBeforeFetch, this.state.transferSummaries)) {
						transferSummaries = mergeTransferSummary(transferSummaries, pushed);
					}
				} catch (err: unknown) {
					if (/permission denied/i.test(getErrorMessage(err))) {
						this.setState({ canViewLogs: false });
						transferSummaries = [];
					} else {
						throw err;
					}
				}
			}

			const snapshotRevision = Number(getProp<number>(treeResponse, "revision", NaN));
			const snapshot = decideSnapshot(snapshotRevision, this.state.lastTreeRevision);
			const snapshotState = snapshot.apply
				? {
					tree: {
						forceName: String(getProp(treeResponse, "forceName", "player")),
						hosts: getProp(treeResponse, "hosts", []) as NonNullable<SurfaceExportState["tree"]>["hosts"],
						unassignedInstances: getProp(treeResponse, "unassignedInstances", []) as NonNullable<SurfaceExportState["tree"]>["unassignedInstances"],
						revision: snapshot.watermark ?? 0,
						generatedAt: Number(getProp(treeResponse, "generatedAt", Date.now())),
					},
					...(snapshot.watermark !== null ? { lastTreeRevision: snapshot.watermark } : {}),
				}
				: {};

			this.setState({
				...snapshotState,
				transferSummaries,
				loadingTree: false,
				treeError: null,
			});
		} catch (err: unknown) {
			console.error("Failed to refresh Surface Export state", err);
			this.setState({
				loadingTree: false,
				treeError: getErrorMessage(err, "Failed to refresh Surface Export state"),
			});
		}
	}

	async getStoredExport(exportId: string) {
		return this.link.send(new GetStoredExportRequest({ exportId }));
	}
	async exportPlatformForDownload(payload: { sourceInstanceId: number; sourcePlatformIndex: number; forceName?: string }) {
		return this.link.send(new ExportPlatformForDownloadRequest(payload));
	}

	async importUploadedExport(payload: { targetInstanceId: number; exportData: Record<string, unknown>; forceName?: string; platformName?: string | null; targetPlanet?: string | null }) {
		return this.link.send(new ImportUploadedExportRequest(payload));
	}

	async startTransfer(payload: { sourceInstanceId: number; sourcePlatformIndex: number; targetInstanceId: number; forceName?: string; targetPlanet?: string | null }) {
		return this.link.send(new StartPlatformTransferRequest(payload));
	}

	async getGateways() {
		return this.link.send(new GetGatewaysRequest({}));
	}

	async setGatewayLink(payload: {
		sourceInstanceId: number;
		gateways: Array<{ gatewayName: string; targets: Array<{ targetInstanceId: number; targetGateway: string }> }>;
	}) {
		return this.link.send(new SetGatewayLinkRequest(payload));
	}

	async loadTransactionLog(transferId: string) {
		const before = this.state.logDetails[transferId];
		const summaryBefore = this.state.transferSummaries.find(entry => entry.transferId === transferId);
		const response = await this.link.send(new GetTransactionLogRequest({ transferId })) as JsonObject;
		if (!getProp(response, "success", false)) {
			throw new Error(String(getProp(response, "error", "Failed to load transaction log")));
		}

		const existing = this.state.logDetails[transferId] || {};
		let transferInfo = getProp(response, "transferInfo", null) as JsonObject | null || existing.transferInfo || null;
		const responseEvents = getProp(response, "events", null);
		let events = Array.isArray(responseEvents) ? responseEvents as Array<LogEvent> : existing.events || [];
		let summary = getProp(response, "summary", null) as JsonObject | null || existing.summary || null;
		let detailRetained = getProp(response, "detailRetained", true) as boolean;
		// A log push can arrive while the snapshot request is in flight. Preserve its evidence and outcome.
		if (existing !== before && existing.events?.length) {
			const latest = (entries: LogEvent[]) => Math.max(0, ...entries.map(entry => Number(entry.timestampMs) || 0));
			if (latest(existing.events) >= latest(events)) {
				transferInfo = existing.transferInfo || transferInfo;
				summary = existing.summary || summary;
				detailRetained = existing.detailRetained !== false;
			}
			const identity = (entry: LogEvent) => JSON.stringify([entry.timestampMs, entry.eventType, entry.message]);
			const merged = new Map(events.map(entry => [identity(entry), entry]));
			for (const entry of existing.events) merged.set(identity(entry), entry);
			events = [...merged.values()].sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
		}
		const detail = {
			transferInfo,
			summary,
			events,
			detailRetained,
		};

		const transferSummary = summaryFromTransferInfo(transferInfo, events.length ? events[events.length - 1].timestampMs : null);
		const currentSummary = this.state.transferSummaries.find(entry => entry.transferId === transferId);
		if (transferSummary) {
			transferSummary.transferId = transferId;
			transferSummary.downloadable = currentSummary?.downloadable ?? false;
		}
		const latestSummaryTime = (entry?: TransferSummary | null) => Math.max(entry?.lastEventAt || 0, entry?.completedAt || 0, entry?.failedAt || 0, entry?.startedAt || 0);
		const keepPushedSummary = currentSummary !== summaryBefore
			&& latestSummaryTime(currentSummary) >= latestSummaryTime(transferSummary);

		this.setState({
			logDetails: {
				...this.state.logDetails,
				[transferId]: detail,
			},
			transferSummaries: transferSummary && !keepPushedSummary
				? mergeTransferSummary(this.state.transferSummaries, transferSummary)
				: this.state.transferSummaries,
		});
	}

	async handleTreeUpdate(event: JsonObject) {
		const revision = Number(event.revision ?? 0);
		if (!isFreshRevision(revision, this.state.lastTreeRevision)) {
			return;
		}
		const tree = (event.tree ?? {}) as { hosts?: Array<unknown>; unassignedInstances?: Array<unknown> };

		this.setState({
			tree: {
				forceName: String(event.forceName || "player"),
				hosts: (tree.hosts || []) as NonNullable<SurfaceExportState["tree"]>["hosts"],
				unassignedInstances: (tree.unassignedInstances || []) as NonNullable<SurfaceExportState["tree"]>["unassignedInstances"],
				revision,
				generatedAt: Number(event.generatedAt ?? Date.now()),
			},
			loadingTree: false,
			treeError: null,
			lastTreeRevision: revision,
		});
	}

	async handleTransferUpdate(event: JsonObject) {
		const revision = Number(event.revision ?? 0);
		if (!isFreshRevision(revision, this.state.lastTransferRevision)) {
			return;
		}

		this.setState({
			transferSummaries: mergeTransferSummary(this.state.transferSummaries, event.transfer as SurfaceExportState["transferSummaries"][number]),
			lastTransferRevision: revision,
		});
	}

	async handleLogUpdate(event: JsonObject) {
		const revision = Number(event.revision ?? 0);
		if (!isFreshRevision(revision, this.state.lastLogRevision)) {
			return;
		}
		const transferId = String(event.transferId || "");
		if (!transferId) {
			return;
		}

		const existing = this.state.logDetails[transferId] || { events: [] };
		const events = [...existing.events];
		const incoming = (event.event || {}) as LogEvent;
		const lastEvent = events.length ? events[events.length - 1] : null;
		const isDuplicate = lastEvent
			&& lastEvent.timestampMs === incoming.timestampMs
			&& lastEvent.eventType === incoming.eventType
			&& lastEvent.message === incoming.message;
		if (!isDuplicate) {
			events.push(incoming);
		}

		const detail = {
			...existing,
			detailRetained: true,
			transferInfo: (event.transferInfo as JsonObject) || existing.transferInfo || null,
			summary: (event.summary as JsonObject) || existing.summary || null,
			events,
		};

		let transferSummary = null;
		if (event.transferInfo) {
			transferSummary = summaryFromTransferInfo(event.transferInfo as JsonObject, incoming.timestampMs || null);
			if (transferSummary) {
				transferSummary.transferId = transferId;
				transferSummary.downloadable = this.state.transferSummaries.find(entry => entry.transferId === transferId)?.downloadable ?? false;
			}
		}

		this.setState({
			logDetails: {
				...this.state.logDetails,
				[transferId]: detail,
			},
			transferSummaries: transferSummary
				? mergeTransferSummary(this.state.transferSummaries, transferSummary)
				: this.state.transferSummaries,
			lastLogRevision: revision,
		});
	}
}
