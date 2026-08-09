import React, { useContext, useEffect, useState } from "react";
import {
	Button,
	Tabs,
	Tooltip,
	Typography,
} from "antd";

import {
	BaseWebPlugin,
	ControlContext,
	PageHeader,
	PageLayout,
	notifyErrorHandler,
} from "@clusterio/web_ui";
import { UploadOutlined } from "@ant-design/icons";
import * as messageDefs from "../messages";
import ManualTransferTab from "./ManualTransferTab";
import TransactionLogsTab from "./TransactionLogsTab";
import GatewayCanvas from "./gateway/GatewayCanvas";
import ImportModal from "./ImportModal";
import type { JsonObject, LogEvent, SurfaceExportPlugin, SurfaceExportState } from "./view-models";

import { summaryFromTransferInfo, mergeTransferSummary, getErrorMessage, getProp } from "./utils";
import { freshRevisionWatermarks, isFreshRevision } from "../shared/revision-gate";
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

const { Text } = Typography;

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

function SurfaceExportPage() {
	const control = useContext(ControlContext) as unknown as ControlLike;
	const plugin = useSurfaceExportPlugin(control);
	const state = useSurfaceExportState(plugin);
	const [importModalOpen, setImportModalOpen] = useState(false);
	// Tab is URL-synced so the view is deep-linkable, e.g. /surface-export?tab=gateways — read on
	// mount, updated on change. Uses the native History API (no react-router import) to avoid
	// bundling a non-shared web dep (see the in-container web build model / why mermaid was removed).
	//
	// Reads against the full set, not a single hard-coded name: this used to accept only "logs", so
	// handleTabChange would WRITE ?tab=gateways and a reload of that exact URL would land on Manual
	// Transfer — the round trip the comment above claims silently did not close. Availability (logs
	// needs a permission) is a separate question, settled by `effectiveTab` below.
	const [activeTab, setActiveTab] = useState<string>(() => {
		const t = new URLSearchParams(window.location.search).get("tab");
		return t && ["manual", "logs", "gateways"].includes(t) ? t : "manual";
	});
	function handleTabChange(key: string) {
		setActiveTab(key);
		const params = new URLSearchParams(window.location.search);
		params.set("tab", key);
		window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
	}
	// Icon spritesheet CSS is injected on demand by the FactorioIcon wrappers in web/icons.tsx
	// (via useExportPrototypeMetadata) when icons render.
	const pluginVersion = state?.pluginVersion || null;
	const tabItems = [
		{
			key: "manual",
			label: "Manual Transfer",
			children: <ManualTransferTab plugin={plugin} state={state} />,
		},
	];
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
		// The canvas opens the page's ONE ImportModal rather than mounting its own. Tabs keep their
		// panes mounted (removeOnLeave: false), so a second copy would be a second live modal.
		children: <GatewayCanvas plugin={plugin} state={state} onOpenImport={() => setImportModalOpen(true)} />,
	});

	// Fall back to manual if the URL asks for a tab that isn't available (e.g. ?tab=logs without view perms).
	const effectiveTab = tabItems.some(t => t.key === activeTab) ? activeTab : "manual";

	// Paints Clusterio's page frame to match the canvas. Applied as a body class this page adds and
	// removes — NOT as a bare selector in our stylesheet, which is global from the moment our web
	// module loads and would restyle every other plugin's page too.
	useEffect(() => {
		document.body.classList.add("surface-export-page");
		return () => document.body.classList.remove("surface-export-page");
	}, []);

	return (
		// `nav={[]}` — no breadcrumb. It rendered "Surface Export" immediately above PageHeader's
		// "Surface Export", so the page opened by saying its own name twice; the heading is the one
		// that carries weight, and this page is one level deep with nowhere to navigate back to.
		<PageLayout nav={[]}>
			<PageHeader title="Surface Export" />
			{pluginVersion ? (
				<Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
					v{pluginVersion}
				</Text>
			) : null}
			<Tabs
				activeKey={effectiveTab}
				onChange={handleTabChange}
				items={tabItems}
				tabBarExtraContent={effectiveTab === "manual" ? (
					<Tooltip title="Import JSON">
						<Button
							icon={<UploadOutlined />}
							size="small"
							onClick={() => setImportModalOpen(true)}
						/>
					</Tooltip>
				) : null}
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
	// Escape hatch: the framework's Control type is broader than the slice we use.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private get link(): ControlLike { return this.control as unknown as ControlLike; }

	private callbacks: Array<() => void>;
	private liveUpdatesEnabled: boolean;
	private state: SurfaceExportState;

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
			pluginVersion: (packageData && typeof packageData === "object" && "version" in packageData && typeof packageData.version === "string")
				? packageData.version
				: null,
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

	onControllerConnectionEvent(event: string) {
		if (event === "connect" || event === "resume") {
			// Watermarks are scoped to one controller session, so this reconnect starts them over.
			// Carrying them across would gate the new session's revisions against the old one's.
			this.setState(freshRevisionWatermarks());
			this.syncLiveState().catch(notifyErrorHandler("Failed to resubscribe Surface Export live updates"));
		}
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
		try {
			const treeResponse = await this.link.send(new GetPlatformTreeRequest({ forceName: "player" })) as JsonObject;
			let transferSummaries = this.state.transferSummaries;
			if (this.state.canViewLogs !== false) {
				try {
					const logSummaries = await this.link.send(new ListTransactionLogsRequest({ limit: 100 }));
					transferSummaries = Array.isArray(logSummaries)
						? [...logSummaries].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
						: [];
				} catch (err: unknown) {
					if (/permission denied/i.test(getErrorMessage(err))) {
						this.setState({ canViewLogs: false });
						transferSummaries = [];
					} else {
						throw err;
					}
				}
			}

			// A pushed update that landed while this request was in flight carries a newer revision
			// than the snapshot, and keeps its place.
			const snapshotRevision = Number(getProp(treeResponse, "revision", 0));
			const snapshotState = isFreshRevision(snapshotRevision, this.state.lastTreeRevision)
				? {
					tree: {
						forceName: String(getProp(treeResponse, "forceName", "player")),
						hosts: getProp(treeResponse, "hosts", []) as NonNullable<SurfaceExportState["tree"]>["hosts"],
						unassignedInstances: getProp(treeResponse, "unassignedInstances", []) as NonNullable<SurfaceExportState["tree"]>["unassignedInstances"],
						revision: snapshotRevision,
						generatedAt: Number(getProp(treeResponse, "generatedAt", Date.now())),
					},
					lastTreeRevision: snapshotRevision,
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
			// Absent on an un-redeployed controller, which is why the default is true rather than false:
			// an unknown answer must not render a "detail was discarded" notice over a real timeline.
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
