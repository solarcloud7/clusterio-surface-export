import { useContext, useEffect, useState } from "react";
import { Alert, Button, Form, InputNumber, Select, Spin, Typography } from "antd";
import { CheckCircleOutlined, ClockCircleOutlined, DatabaseOutlined, RightOutlined, SettingOutlined } from "@ant-design/icons";
import { ControlContext, useAccount } from "@clusterio/web_ui";
import { Config, ConfigAccess, ControllerConfig, ControllerConfigGetRequest, ControllerConfigSetRequest } from "@clusterio/lib";
import { getErrorMessage } from "./utils";
import "./settings.css";
import type { SurfaceExportState } from "./view-models";

const fields = [
	{ name: "surface_export.platform_source_of_truth", label: "Platform source of truth", group: "recovery", unit: "", help: "Choose how to handle platforms restored by loading an older save. Active and unresolved transfers remain protected in both modes.", applies: "Takes effect when each instance restarts.", min: 0 },
	// Gateway layout stays out of this editor until multi-gateway configuration is ready.
	{ name: "surface_export.transaction_log_detail_entries", group: "records", unit: "transfers", help: "Keep step timings and audit evidence for this many transfers. Failed transfers take priority; older transfers keep their summary and outcome.", applies: "Takes effect at the next log trim.", min: 10, max: 5000 },
	{ name: "surface_export.max_storage_size", group: "records", unit: "files", help: "Keep this many platform files available to download. The oldest file is removed when the limit is reached. Transfer logs are separate.", applies: "Takes effect on the next stored export.", min: 1 },
	{ name: "surface_export.transfer_validation_timeout_seconds", label: "Transfer validation timeout", group: "recovery", unit: "seconds", help: "Wait this long for import and validation after the destination accepts the payload. Recovery begins if time runs out.", applies: "Takes effect on the next transfer.", min: 5, max: 120 },
];

const groups = [
	{ id: "records", title: "Transfer records", description: "Choose what stays available after a transfer.", icon: <DatabaseOutlined /> },
	{ id: "recovery", title: "Transfer recovery", description: "Choose how saves and unfinished transfers are handled.", icon: <ClockCircleOutlined /> },
];

const instanceSettings = [
	{ title: "Batch sizes", help: "Control how much entity and belt work runs per batch. Each captured belt lane group is restored and checked together, so a large group can exceed the limit." },
	{ title: "Belt trace", help: "Record belt item positions after a successful restore. Failed restores keep this evidence even when tracing is off." },
	{ title: "Batch profiling", help: "Save individual timings for up to 2,000 batches per job. Stage totals are always recorded." },
	{ title: "Full destination snapshots", help: "Save a full platform snapshot after successful validation. Requires debug mode and adds a scan that can pause the game. Transfer logs and failure diagnostics remain available when this is off." },
];

type Values = Record<string, ReturnType<ControllerConfig["get"]>>;

export default function SettingsTab({ active, state }: { active: boolean; state?: SurfaceExportState }) {
	const control = useContext(ControlContext);
	const account = useAccount();
	const canRead = account.hasPermission("core.controller.get_config") === true;
	const canWrite = account.hasPermission("core.controller.update_config") === true;
	const [form] = Form.useForm<Values>();
	const [config, setConfig] = useState<Config<Values> | null>(null);
	const [saved, setSaved] = useState<Values>({});
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState("");
	const instances = [...(state?.tree?.hosts.flatMap(host => host.instances) || []), ...(state?.tree?.unassignedInstances || [])];

	function acceptConfig(next: Config<Values>) {
		const values: Values = {};
		for (const field of fields) {
			if (next.canAccess(field.name, ConfigAccess.read)) values[field.name] = next.get(field.name);
		}
		setConfig(next);
		setSaved(values);
		form.setFieldsValue(values);
		setDirty(false);
	}

	useEffect(() => {
		if (!active || !canRead) return;
		let cancelled = false;
		setBusy(true);
		setError(null);
		control.send(new ControllerConfigGetRequest()).then(serialized => {
			if (!cancelled) acceptConfig(ControllerConfig.fromJSON(serialized, "control") as unknown as Config<Values>);
		}).catch((err: unknown) => {
			if (!cancelled) setError(getErrorMessage(err, "Could not load controller settings."));
		}).finally(() => { if (!cancelled) setBusy(false); });
		return () => { cancelled = true; };
	}, [control, active, canRead]);

	async function save(values: Values) {
		if (!canWrite || !config || busy) return;
		const changes: Record<string, string> = {};
		for (const field of fields) {
			if (config.canAccess(field.name, ConfigAccess.write) && values[field.name] !== saved[field.name]) {
				changes[field.name] = String(values[field.name]);
			}
		}
		if (!Object.keys(changes).length) return;
		setBusy(true);
		setError(null);
		setNotice("");
		try {
			await control.send(new ControllerConfigSetRequest(changes));
			const serialized = await control.send(new ControllerConfigGetRequest());
			acceptConfig(ControllerConfig.fromJSON(serialized, "control") as unknown as Config<Values>);
			setNotice("Settings saved.");
		} catch (err: unknown) {
			return setError(getErrorMessage(err, "Could not save or verify controller settings. Reload to check the stored values."));
		} finally { setBusy(false); }
	}

	return <section className="se-settings" aria-label="Surface Export settings">
		<header className="se-settings-header"><Typography.Title level={3}>Settings</Typography.Title>
			<Typography.Paragraph>Manage saved transfer records and recovery limits across this cluster.</Typography.Paragraph>
		</header>
		<div className="se-settings-layout">
			<section className="se-settings-controller" aria-label="Controller settings">
				{!canRead ? <Alert type="info" message="Controller settings require permission to view controller configuration." /> : <>
					{error && <Alert type="error" showIcon message={error} />}
					{!canWrite && <Alert type="info" message="Read only. Saving requires permission to update controller configuration." />}
					{busy && !config && <Spin aria-label="Loading controller settings" />}
					{config && <Form form={form} layout="vertical" requiredMark={false} onFinish={save} disabled={busy || !canWrite}
						onValuesChange={(_, values: Values) => { setDirty(fields.some(field => values[field.name] !== saved[field.name])); setNotice(""); }}>
						<div className="se-settings-editor">
							{groups.map(group => {
								const visibleFields = fields.filter(field => field.group === group.id && config.canAccess(field.name, ConfigAccess.read));
								if (!visibleFields.length) return null;
								return <section className="se-settings-group" key={group.id} aria-labelledby={`se-settings-${group.id}`}>
									<header className="se-settings-group-header">
										<span className="se-settings-group-icon" aria-hidden="true">{group.icon}</span>
										<div><Typography.Title level={4} id={`se-settings-${group.id}`}>{group.title}</Typography.Title>
											<p>{group.description}</p></div>
									</header>
									{visibleFields.map(field => {
										const def = config.constructor.fieldDefinitions[field.name];
										const id = `se-setting-${field.name}`;
										return <div className="se-setting-row" key={field.name}>
											<div className="se-setting-copy">
												<label htmlFor={id}>{field.label || def.title || field.name}</label>
												<p id={`${id}-help`}>{field.help}</p>
												<span className="se-setting-applies" id={`${id}-applies`}>{field.applies}</span>
												{field.name === "surface_export.platform_source_of_truth" && <>
													<p><strong>Save game:</strong> Accept restored platforms with a warning. Example: reload yesterday’s save to recover a destroyed platform. Copies on other instances remain unchanged.</p>
													<p><strong>Plugin history:</strong> Protect restored copies that already transferred away. Example: roll back one instance while keeping the platform that arrived elsewhere.</p>
													{instances.map(instance => <p key={instance.instanceId}>{instance.instanceName}: {instance.status !== "running" || !instance.connected || !instance.recovery?.mode
														? "applied mode unverified" : `${instance.recovery.mode === "save_game" ? "Save game" : "Plugin history"} applied${instance.recovery.mode !== saved[field.name] ? " · restart required" : ""}${instance.recovery.state !== "ready" ? " · recovery not ready" : ""}`}</p>)}
												</>}
											</div>
											{field.name === "surface_export.platform_source_of_truth" ? <Form.Item name={field.name} rules={[{ required: true }]}>
												<Select id={id} aria-describedby={`${id}-help ${id}-applies`} size="large" options={[
													{ value: "save_game", label: "Save game" }, { value: "plugin_history", label: "Plugin history" },
												]} disabled={busy || !canWrite || !config.canAccess(field.name, ConfigAccess.write)} />
											</Form.Item> : <Form.Item name={field.name} rules={[{ required: true, message: "Enter a value." },
												{ type: "integer" as const, min: field.min, max: field.max,
													message: field.max ? `Enter a whole number from ${field.min} to ${field.max}.` : `Enter a whole number of ${field.min} or more.` }]}>
												<InputNumber id={id} aria-describedby={`${id}-help ${id}-applies`} addonAfter={field.unit} size="large"
													min={field.min} max={field.max} precision={0} disabled={busy || !canWrite || !config.canAccess(field.name, ConfigAccess.write)} />
											</Form.Item>}
										</div>;
									})}
								</section>;
							})}
						</div>
						<div className={`se-settings-actions${dirty ? " se-settings-actions-dirty" : ""}`}>
							<span role="status" className="se-settings-save-status">
								{dirty ? <span className="se-settings-unsaved-dot" aria-hidden="true" /> : <CheckCircleOutlined aria-hidden="true" />}
								{dirty ? "Unsaved changes" : notice || (canWrite ? "All changes saved" : "Read only")}
							</span>
							{canWrite && <div className="se-settings-buttons">
								<Button disabled={!dirty || busy} onClick={() => { form.setFieldsValue(saved); setDirty(false); setError(null); setNotice(""); }}>Discard changes</Button>
								<Button htmlType="submit" type="primary" loading={busy} disabled={!dirty || !canWrite}>Save changes</Button>
							</div>}
						</div>
					</Form>}
				</>}
			</section>
			<aside className="se-settings-instance" aria-label="Instance settings">
				<Typography.Title level={4}>Instance tuning</Typography.Title>
				<p>Batch sizes and diagnostics are set separately on each instance.</p>
				<Button href="/instances" icon={<SettingOutlined />}>Open instances</Button>
				<div className="se-settings-reference">
					{instanceSettings.map(setting => <details key={setting.title}>
						<summary>{setting.title}<RightOutlined aria-hidden="true" /></summary>
						<p>{setting.help}</p>
					</details>)}
				</div>
				<p className="se-settings-restart"><ClockCircleOutlined aria-hidden="true" /> Restart the instance after changing its settings.</p>
			</aside>
		</div>
	</section>;
}
