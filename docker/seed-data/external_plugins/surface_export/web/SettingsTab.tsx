import React, { useContext, useEffect, useState } from "react";
import { Alert, Button, Form, InputNumber, Select, Space, Spin, Typography } from "antd";
import { ControlContext, useAccount } from "@clusterio/web_ui";
import { Config, ConfigAccess, ControllerConfig, ControllerConfigGetRequest, ControllerConfigSetRequest } from "@clusterio/lib";
import type { SurfaceExportState } from "./view-models";
import { getErrorMessage } from "./utils";
import "./settings.css";

const fields = [
	{ name: "surface_export.gateway_mode", help: "Match the mod pack’s surfexp-gateway-layout setting. Return platforms to a planet before changing layout, then restart instances and clients.", applies: "Coordinated layout change", options: [{ value: "one_gate", label: "One gateway per instance" }, { value: "multi", label: "Four gateways per instance" }] },
	{ name: "surface_export.max_storage_size", help: "Keeps downloadable platform payloads. Eviction removes the download, while transfer history remains.", applies: "On the next stored export", min: 1 },
	{ name: "surface_export.transaction_log_detail_entries", help: "Keeps full timings and audit evidence, prioritizing failures. Older operations remain listed with their outcome.", applies: "On the next detail retention pass", min: 10, max: 5000 },
	{ name: "surface_export.transfer_validation_timeout_seconds", help: "Waits for import and validation after payload acceptance. Expiry triggers recovery; this is not a network timeout.", applies: "On the next transfer", min: 5, max: 120 },
];

type Values = Record<string, ReturnType<ControllerConfig["get"]>>;

export default function SettingsTab({ state, active }: { state: SurfaceExportState; active: boolean }) {
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
			setNotice(changes["surface_export.gateway_mode"]
				? "Saved. Complete the mod-pack layout change and restart instances and clients."
				: "Saved to controller configuration.");
		} catch (err: unknown) {
			return setError(getErrorMessage(err, "Could not save or verify controller settings. Reload to check the stored values."));
		} finally { setBusy(false); }
	}

	const instances = [...(state.tree?.hosts.flatMap(host => host.instances) ?? []), ...(state.tree?.unassignedInstances ?? [])];
	return <section className="se-settings" aria-label="Surface Export settings">
		<header><Typography.Title level={3}>Settings</Typography.Title>
			<Typography.Paragraph type="secondary">Manage cluster-wide behavior here. Tune Factorio work and diagnostics on each instance.</Typography.Paragraph>
		</header>
		<div className="se-settings-layout">
			<section aria-label="Controller settings">
				<Typography.Title level={4}>Controller</Typography.Title>
				{!canRead ? <Alert type="info" message="Controller settings require permission to view controller configuration." /> : <>
					{error && <Alert type="error" showIcon message={error} />}
					{!canWrite && <Alert type="info" message="Read only. Saving requires permission to update controller configuration." />}
					{busy && !config && <Spin aria-label="Loading controller settings" />}
					{config && <Form form={form} layout="vertical" onFinish={save} disabled={busy || !canWrite}
						onValuesChange={(_, values: Values) => { setDirty(fields.some(field => values[field.name] !== saved[field.name])); setNotice(""); }}>
						{fields.filter(field => config.canAccess(field.name, ConfigAccess.read)).map(field => {
							const def = config.constructor.fieldDefinitions[field.name];
							return <div className="se-setting-row" key={field.name}>
								<Form.Item name={field.name} label={def.title || field.name} tooltip={def.description}
									rules={[{ required: true, message: "Enter a value." }, ...(field.options ? [] : [{ type: "integer" as const, min: field.min, max: field.max }])]}>
									{field.options ? <Select options={field.options} disabled={busy || !canWrite || !config.canAccess(field.name, ConfigAccess.write)} />
										: <InputNumber min={field.min} max={field.max} precision={0} disabled={busy || !canWrite || !config.canAccess(field.name, ConfigAccess.write)} />}
								</Form.Item>
								<p>{field.help}</p><span className="se-setting-applies">{field.applies}</span>
							</div>;
						})}
						<Space wrap><Button htmlType="submit" type="primary" loading={busy} disabled={!dirty || !canWrite}>Save changes</Button>
							<Button disabled={!dirty || busy} onClick={() => { form.setFieldsValue(saved); setDirty(false); setError(null); }}>Discard changes</Button>
							<span role="status">{dirty ? "Unsaved changes" : notice}</span>
						</Space>
					</Form>}
				</>}
			</section>
			<aside aria-label="Instance settings">
				<Typography.Title level={4}>On each instance</Typography.Title>
				<p>These settings apply when the instance starts. Save changes in its configuration, then restart that instance.</p>
				<dl>
					<dt>Batching</dt><dd>Entity and belt batch sizes control work per callback. Connected belt networks remain atomic.</dd>
					<dt>Belt trace</dt><dd>Detailed belt positions after successful restoration. Failures retain tracing independently.</dd>
					<dt>Batch profiling</dt><dd>Retain individual batch measurements, up to 2,000 per job. Phase totals remain available when this is off.</dd>
					<dt>Full destination snapshots</dt><dd>Optional rescan after successful validation. Requires debug mode and adds synchronous work. Transfer logs and failure black boxes remain available when this is off.</dd>
				</dl>
				{account.hasPermission("core.instance.get_config") && <ul>{instances.map(instance => <li key={instance.instanceId}>
					<a href={`/instances/${instance.instanceId}/view`}>{instance.instanceName}</a>
				</li>)}</ul>}
				<a href="/instances">Open instances</a>
			</aside>
		</div>
	</section>;
}
