import React, { useContext, useEffect, useState } from "react";
import {
	Tabs,
	Typography,
} from "antd";

import {
	BaseWebPlugin,
	ControlContext,
	PageHeader,
	PageLayout,
	notifyErrorHandler,
	useItemMetadata,
	useEntityMetadata,
	usePlanetMetadata,
} from "@clusterio/web_ui";
import * as messageDefs from "../messages";
import ManualTransferTab from "./ManualTransferTab";
import TransactionLogsTab from "./TransactionLogsTab";
import type { JsonObject, LogEvent, SurfaceExportPlugin, SurfaceExportState } from "./view-models";

import { summaryFromTransferInfo, mergeTransferSummary, getErrorMessage, getProp } from "./utils";

const {
	PERMISSIONS,
	GetPlatformTreeRequest,
	GetStoredExportRequest,
	ImportUploadedExportRequest,
	ExportPlatformForDownloadRequest,
	ListTransactionLogsRequest,
	GetTransactionLogRequest,
	StartPlatformTransferRequest,
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
	// Trigger spritesheet CSS injection for categories used across tabs
	useItemMetadata();
	useEntityMetadata();
	usePlanetMetadata();
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

	return (
		<PageLayout nav={[{ name: "Surface Export" }]}>
			<PageHeader title="Surface Export" />
			{pluginVersion ? (
				<Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
					v{pluginVersion}
				</Text>
			) : null}
			<Tabs
				defaultActiveKey="manual"
				items={tabItems}
			/>
		</PageLayout>
	);
}

export class WebPlugin extends BaseWebPlugin {
	declare control: ControlLike;
	declare pages: Array<Record<string, unknown>>;

	private callbacks: Array<() => void>;
	private liveUpdatesEnabled: boolean;
	private state: SurfaceExportState;

	constructor(container: unknown, packageData: JsonObject, info: JsonObject, control: ControlLike, logger: unknown) {
		super(container, packageData, info, control, logger);
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

		this.control.handle(SurfaceExportTreeUpdateEvent, payload => this.handleTreeUpdate(payload as JsonObject));
		this.control.handle(SurfaceExportTransferUpdateEvent, payload => this.handleTransferUpdate(payload as JsonObject));
		this.control.handle(SurfaceExportLogUpdateEvent, payload => this.handleLogUpdate(payload as JsonObject));
	}

	onControllerConnectionEvent(event: string) {
		if (event === "connect" || event === "resume") {
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
		if (!this.control.connector.connected) {
			this.liveUpdatesEnabled = shouldEnable;
			return;
		}
		const trySubscribe = (logs: boolean) => this.control.send(new SetSurfaceExportSubscriptionRequest({
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
			const treeResponse = await this.control.send(new GetPlatformTreeRequest({ forceName: "player" })) as JsonObject;
			let transferSummaries = this.state.transferSummaries;
			if (this.state.canViewLogs !== false) {
				try {
					const logSummaries = await this.control.send(new ListTransactionLogsRequest({ limit: 100 }));
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

			this.setState({
				tree: {
					forceName: String(getProp(treeResponse, "forceName", "player")),
					hosts: getProp(treeResponse, "hosts", []) as NonNullable<SurfaceExportState["tree"]>["hosts"],
					unassignedInstances: getProp(treeResponse, "unassignedInstances", []) as NonNullable<SurfaceExportState["tree"]>["unassignedInstances"],
					revision: Number(getProp(treeResponse, "revision", 0)),
					generatedAt: Number(getProp(treeResponse, "generatedAt", Date.now())),
				},
				transferSummaries,
				loadingTree: false,
				treeError: null,
			});
		} catch (err: unknown) {
			this.setState({
				loadingTree: false,
				treeError: getErrorMessage(err, "Failed to refresh Surface Export state"),
			});
		}
	}

	async getStoredExport(exportId: string) {
		return this.control.send(new GetStoredExportRequest({ exportId }));
	}
	async exportPlatformForDownload(payload: { sourceInstanceId: number; sourcePlatformIndex: number; forceName?: string }) {
		return this.control.send(new ExportPlatformForDownloadRequest(payload));
	}

	async importUploadedExport(payload: { targetInstanceId: number; exportData: Record<string, unknown>; forceName?: string; platformName?: string | null }) {
		return this.control.send(new ImportUploadedExportRequest(payload));
	}

	async startTransfer(payload: { sourceInstanceId: number; sourcePlatformIndex: number; targetInstanceId: number; forceName?: string }) {
		return this.control.send(new StartPlatformTransferRequest(payload));
	}

	async loadTransactionLog(transferId: string) {
		const response = await this.control.send(new GetTransactionLogRequest({ transferId })) as JsonObject;
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
		if (revision <= this.state.lastTreeRevision) {
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
		if (revision <= this.state.lastTransferRevision) {
			return;
		}

		this.setState({
			transferSummaries: mergeTransferSummary(this.state.transferSummaries, event.transfer as SurfaceExportState["transferSummaries"][number]),
			lastTransferRevision: revision,
		});
	}

	async handleLogUpdate(event: JsonObject) {
		const revision = Number(event.revision ?? 0);
		if (revision <= this.state.lastLogRevision) {
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
