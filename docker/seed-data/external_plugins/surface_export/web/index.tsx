import React, { useContext, useEffect, useState } from "react";
import { Badge, Tabs, Tooltip } from "antd";

import {
	BaseWebPlugin,
	ControlContext,
	PageHeader,
	PageLayout,
	notifyErrorHandler,
} from "@clusterio/web_ui";
import * as messageDefs from "../messages";
import TransactionLogsTab from "./TransactionLogsTab";
import GatewayCanvas from "./gateway/GatewayCanvas";
import ImportModal from "./ImportModal";
import type { JsonObject, LiveStatus, LogEvent, SurfaceExportPlugin, SurfaceExportState } from "./view-models";

import { summaryFromTransferInfo, mergeTransferSummary, getErrorMessage, getProp } from "./utils";
import { decideSnapshot, entriesChangedSince, freshRevisionWatermarks, isFreshRevision } from "../shared/revision-gate";
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

const RESUBSCRIBE_BASE_DELAY_MS = 1000;
const RESUBSCRIBE_MAX_DELAY_MS = 30000;

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

	async init() {
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

	onControllerConnectionEvent(event: "connect" | "drop" | "resume" | "close") {
		if (event === "connect") {
			this.setState(freshRevisionWatermarks());
		}
		if (event === "connect" || event === "resume") {
			this.resubscribeUntilLive();
			return;
		}
		this.clearResubscribeTimer();
		this.setState({
			liveStatus: event === "drop" ? "reconnecting" : "offline",
			liveError: null,
		});
	}

	private clearResubscribeTimer() {
		if (this.resubscribeTimer !== null) {
			clearTimeout(this.resubscribeTimer);
			this.resubscribeTimer = null;
		}
	}

	resubscribeUntilLive(attempt = 0) {
		this.clearResubscribeTimer();
		this.syncLiveState().then(() => {
			this.setState({ liveStatus: "live", liveError: null });
		}, (err: unknown) => {
			const message = getErrorMessage(err, "resubscribe failed");
			this.setState({ liveStatus: "degraded", liveError: message });
			if (!this.link.connector.connected) {
				return;
			}
			const delayMs = Math.min(RESUBSCRIBE_MAX_DELAY_MS, RESUBSCRIBE_BASE_DELAY_MS * 2 ** attempt);
			console.warn(`Surface Export live updates degraded (attempt ${attempt + 1}), retrying in ${delayMs}ms: ${message}`);
			this.resubscribeTimer = setTimeout(() => {
				this.resubscribeTimer = null;
				this.resubscribeUntilLive(attempt + 1);
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
		this.syncLiveState().catch(notifyErrorHandler("Failed to start Surface Export live updates"));
	}

	offUpdate(callback: () => void) {
		const index = this.callbacks.lastIndexOf(callback);
		if (index !== -1) {
			this.callbacks.splice(index, 1);
		}
		this.syncLiveState().catch(notifyErrorHandler("Failed to update Surface Export subscription"));
	}

	async syncLiveState() {
		const shouldEnable = this.callbacks.length > 0;
		if (!this.link.connector.connected) {
			this.liveUpdatesEnabled = shouldEnable;
			return;
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
		}
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
		const response = await this.link.send(new GetTransactionLogRequest({ transferId })) as JsonObject;
		if (!getProp(response, "success", false)) {
			throw new Error(String(getProp(response, "error", "Failed to load transaction log")));
		}

		const existing = this.state.logDetails[transferId] || {};
		const transferInfo = getProp(response, "transferInfo", null) as JsonObject | null || existing.transferInfo || null;
		const responseEvents = getProp(response, "events", null);
		const events = Array.isArray(responseEvents) ? responseEvents as Array<LogEvent> : existing.events || [];
		const detail = {
			transferInfo,
			summary: getProp(response, "summary", null) as JsonObject | null || existing.summary || null,
			events,
			detailRetained: getProp(response, "detailRetained", true) as boolean,
		};

		const transferSummary = summaryFromTransferInfo(transferInfo, events.length ? events[events.length - 1].timestampMs : null);
		if (transferSummary) {
			transferSummary.transferId = transferId;
		}

		this.setState({
			logDetails: {
				...this.state.logDetails,
				[transferId]: detail,
			},
			transferSummaries: transferSummary
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
			transferInfo: (event.transferInfo as JsonObject) || existing.transferInfo || null,
			summary: (event.summary as JsonObject) || existing.summary || null,
			events,
		};

		let transferSummary = null;
		if (event.transferInfo) {
			transferSummary = summaryFromTransferInfo(event.transferInfo as JsonObject, incoming.timestampMs || null);
			if (transferSummary) {
				transferSummary.transferId = transferId;
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
