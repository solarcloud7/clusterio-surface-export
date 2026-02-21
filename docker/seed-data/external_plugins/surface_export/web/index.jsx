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
} from "@clusterio/web_ui";
import * as messageDefs from "../messages";
import { summaryFromTransferInfo, mergeTransferSummary } from "./utils";
import ManualTransferTab from "./ManualTransferTab";
import TransactionLogsTab from "./TransactionLogsTab";

import "./style.css";

const {
	PERMISSIONS,
	GetPlatformTreeRequest,
	ListExportsRequest,
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

function useSurfaceExportPlugin(control) {
	return control.plugins.get("surface_export");
}

function useSurfaceExportState(plugin) {
	const [state, setState] = useState(plugin.getState());

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
	const control = useContext(ControlContext);
	const plugin = useSurfaceExportPlugin(control);
	const state = useSurfaceExportState(plugin);
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
	constructor(container, packageData, info, control, logger) {
		super(container, packageData, info, control, logger);
		this.callbacks = [];
		this.liveUpdatesEnabled = false;
		this.state = {
			tree: null,
			loadingTree: false,
			treeError: null,
			exports: [],
			loadingExports: false,
			exportsError: null,
			transferSummaries: [],
			logDetails: {},
			lastTreeRevision: 0,
			lastTransferRevision: 0,
			lastLogRevision: 0,
			canViewLogs: true,
			pluginVersion: packageData?.version || null,
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

		this.control.handle(SurfaceExportTreeUpdateEvent, this.handleTreeUpdate.bind(this));
		this.control.handle(SurfaceExportTransferUpdateEvent, this.handleTransferUpdate.bind(this));
		this.control.handle(SurfaceExportLogUpdateEvent, this.handleLogUpdate.bind(this));
	}

	onControllerConnectionEvent(event) {
		if (event === "connect" || event === "resume") {
			this.syncLiveState().catch(notifyErrorHandler("Failed to resubscribe Surface Export live updates"));
		}
	}

	getState() {
		return this.state;
	}

	setState(partial) {
		this.state = { ...this.state, ...partial };
		for (const callback of this.callbacks) {
			callback();
		}
	}

	onUpdate(callback) {
		this.callbacks.push(callback);
		this.syncLiveState().catch(notifyErrorHandler("Failed to start Surface Export live updates"));
	}

	offUpdate(callback) {
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
		const trySubscribe = logs => this.control.send(new SetSurfaceExportSubscriptionRequest({
			tree: shouldEnable,
			transfers: shouldEnable,
			logs,
			transferId: null,
		}));
		let logsEnabled = shouldEnable && this.state.canViewLogs !== false;
		try {
			await trySubscribe(logsEnabled);
		} catch (err) {
			if (logsEnabled && /permission denied/i.test(err?.message || "")) {
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
		this.setState({ loadingTree: true, treeError: null, loadingExports: true, exportsError: null });
		try {
			const treeResponse = await this.control.send(new GetPlatformTreeRequest({ forceName: "player" }));
			let exports = this.state.exports;
			let exportsError = null;
			try {
				const exportEntries = await this.control.send(new ListExportsRequest());
				exports = Array.isArray(exportEntries)
					? [...exportEntries].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
					: [];
			} catch (err) {
				exports = [];
				exportsError = err.message || "Failed to list exports";
			}
			let transferSummaries = this.state.transferSummaries;
			if (this.state.canViewLogs !== false) {
				try {
					const logSummaries = await this.control.send(new ListTransactionLogsRequest({ limit: 100 }));
					transferSummaries = Array.isArray(logSummaries)
						? [...logSummaries].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
						: [];
				} catch (err) {
					if (/permission denied/i.test(err?.message || "")) {
						this.setState({ canViewLogs: false });
						transferSummaries = [];
					} else {
						throw err;
					}
				}
			}

			this.setState({
				tree: {
					forceName: treeResponse.forceName,
					hosts: treeResponse.hosts || [],
					unassignedInstances: treeResponse.unassignedInstances || [],
					revision: treeResponse.revision,
					generatedAt: treeResponse.generatedAt,
				},
				exports,
				exportsError,
				loadingExports: false,
				transferSummaries,
				loadingTree: false,
				treeError: null,
			});
		} catch (err) {
			this.setState({
				loadingTree: false,
				loadingExports: false,
				treeError: err.message || "Failed to refresh Surface Export state",
			});
		}
	}

	async listExports() {
		this.setState({ loadingExports: true, exportsError: null });
		try {
			const exportEntries = await this.control.send(new ListExportsRequest());
			const exports = Array.isArray(exportEntries)
				? [...exportEntries].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
				: [];
			this.setState({ exports, loadingExports: false, exportsError: null });
			return exports;
		} catch (err) {
			this.setState({
				exports: [],
				loadingExports: false,
				exportsError: err.message || "Failed to list exports",
			});
			throw err;
		}
	}

	async getStoredExport(exportId) {
		return this.control.send(new GetStoredExportRequest({ exportId }));
	}
	async exportPlatformForDownload(payload) {
		return this.control.send(new ExportPlatformForDownloadRequest(payload));
	}

	async importUploadedExport(payload) {
		return this.control.send(new ImportUploadedExportRequest(payload));
	}

	async startTransfer(payload) {
		return this.control.send(new StartPlatformTransferRequest(payload));
	}

	async loadTransactionLog(transferId) {
		const response = await this.control.send(new GetTransactionLogRequest({ transferId }));
		if (!response.success) {
			throw new Error(response.error || "Failed to load transaction log");
		}

		const existing = this.state.logDetails[transferId] || {};
		const transferInfo = response.transferInfo || existing.transferInfo || null;
		const events = Array.isArray(response.events) ? response.events : existing.events || [];
		const detail = {
			transferInfo,
			summary: response.summary || existing.summary || null,
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

	async handleTreeUpdate(event) {
		if (event.revision <= this.state.lastTreeRevision) {
			return;
		}

		this.setState({
			tree: {
				forceName: event.forceName,
				hosts: event.tree?.hosts || [],
				unassignedInstances: event.tree?.unassignedInstances || [],
				revision: event.revision,
				generatedAt: event.generatedAt,
			},
			loadingTree: false,
			treeError: null,
			lastTreeRevision: event.revision,
		});
	}

	async handleTransferUpdate(event) {
		if (event.revision <= this.state.lastTransferRevision) {
			return;
		}

		this.setState({
			transferSummaries: mergeTransferSummary(this.state.transferSummaries, event.transfer),
			lastTransferRevision: event.revision,
		});
	}

	async handleLogUpdate(event) {
		if (event.revision <= this.state.lastLogRevision) {
			return;
		}

		const existing = this.state.logDetails[event.transferId] || { events: [] };
		const events = [...existing.events];
		const incoming = event.event || {};
		const lastEvent = events.length ? events[events.length - 1] : null;
		const isDuplicate = lastEvent
			&& lastEvent.timestampMs === incoming.timestampMs
			&& lastEvent.eventType === incoming.eventType
			&& lastEvent.message === incoming.message;
		if (!isDuplicate) {
			events.push(incoming);
		}

		const detail = {
			transferInfo: event.transferInfo || existing.transferInfo || null,
			summary: event.summary || existing.summary || null,
			events,
		};

		let transferSummary = null;
		if (event.transferInfo) {
			transferSummary = summaryFromTransferInfo(event.transferInfo, incoming.timestampMs || null);
			transferSummary.transferId = event.transferId;
		}

		this.setState({
			logDetails: {
				...this.state.logDetails,
				[event.transferId]: detail,
			},
			transferSummaries: transferSummary
				? mergeTransferSummary(this.state.transferSummaries, transferSummary)
				: this.state.transferSummaries,
			lastLogRevision: event.revision,
		});
	}
}
