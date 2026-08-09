/**
 * The debug row: controls for the things a real cluster cannot show you.
 *
 * Deliberately a separate strip below the normal toolbar rather than more buttons in it. These are
 * not operator controls — everything here draws something that is not true of the cluster — so they
 * should never be one mis-click away from Reset or Import, and they should be obvious about what
 * they are. Hence the "debug" tag and the ✕ that turns the whole thing off.
 */
import React from "react";
import { Button, Checkbox, Space, Switch, Tag, Tooltip, Typography } from "antd";
import { CloseOutlined, MinusOutlined, PlusOutlined } from "@ant-design/icons";

import { MAX_MOCK_INSTANCES, MAX_MOCK_PLATFORMS, SHIP_PHASE_NAMES } from "./debug-mode";
import { shipPhaseFor } from "./transfer-motion";
import type { DebugState } from "./debug-mode";

const { Text } = Typography;

/** A ± pair around a live count. The count is the label, so the row reads as one control. */
function Stepper({ label, value, min, max, onChange, tooltip }: {
	label: string;
	value: number;
	min: number;
	max: number;
	onChange: (next: number) => void;
	tooltip: string;
}) {
	return (
		<Tooltip title={tooltip}>
			<span className="surface-export-debug-stepper">
				<Button
					size="small"
					icon={<MinusOutlined />}
					disabled={value <= min}
					onClick={() => onChange(Math.max(min, value - 1))}
					aria-label={`one fewer ${label}`}
				/>
				<Text className="surface-export-debug-count">{value} {label}</Text>
				<Button
					size="small"
					icon={<PlusOutlined />}
					disabled={value >= max}
					onClick={() => onChange(Math.min(max, value + 1))}
					aria-label={`one more ${label}`}
				/>
			</span>
		</Tooltip>
	);
}

export default function DebugPanel({ state, onChange, mockCount }: {
	state: DebugState;
	onChange: (next: DebugState) => void;
	/** How many mock instances are actually on the canvas, for the "not real" warning's count. */
	mockCount: number;
}) {
	const set = (patch: Partial<DebugState>) => onChange({ ...state, ...patch });

	return (
		<div className="surface-export-debug-panel nodrag nopan">
			<Space size="small" wrap>
				<Tag color="purple" className="surface-export-debug-tag">debug</Tag>

				<Stepper
					label="mock instances"
					value={state.mockInstances}
					min={0}
					max={MAX_MOCK_INSTANCES}
					onChange={mockInstances => set({ mockInstances })}
					tooltip={
						"Fake instances, added to the tree upstream of the graph so they go through the real "
						+ "layout and rendering. They can link to each other but never to a real instance, and "
						+ "their links are never saved."
					}
				/>

				<Stepper
					label="platforms each"
					value={state.mockPlatforms}
					min={0}
					max={MAX_MOCK_PLATFORMS}
					onChange={mockPlatforms => set({ mockPlatforms })}
					tooltip={
						"Fake platforms on each mock instance. Past six the list caps and shows a '+k more' "
						+ "line, and the layout reserves height per instance — go past six to see both."
					}
				/>

				{/* PER PHASE, not one switch. Comparing "validating" against "failed — returned" means
				    having exactly those two on screen; all-or-nothing put five ships up and left you
				    picking one out of the pile. Names come from the phase model, so a phase the canvas
				    stops drawing cannot linger here as a checkbox that does nothing. */}
				<Tooltip title="Draw a fake ship for each selected transfer phase, without running a transfer. They spread across the available instances, so add mock instances to stop them sharing edges.">
					<span className="surface-export-debug-switch">
						<Text className="surface-export-debug-label">ships</Text>
						<Checkbox.Group
							className="surface-export-debug-phases"
							value={state.shipPhases}
							onChange={shipPhases => set({ shipPhases: shipPhases as string[] })}
							options={SHIP_PHASE_NAMES.map(name => ({
								label: shipPhaseFor(name)?.label ?? name,
								value: name,
							}))}
						/>
					</span>
				</Tooltip>

				<Tooltip title="Outline the things you cannot normally see: the 150px box React Flow measures (what fitView frames), the portal's connect zone, and the point edges actually attach to.">
					<span className="surface-export-debug-switch">
						<Switch size="small" checked={state.showGeometry} onChange={showGeometry => set({ showGeometry })} />
						<Text className="surface-export-debug-label">geometry</Text>
					</span>
				</Tooltip>

				{mockCount > 0 ? (
					<Text type="warning" className="surface-export-debug-warning">
						{mockCount} mock instance{mockCount === 1 ? "" : "s"} drawn — not real, never saved
					</Text>
				) : null}

				<Tooltip title="Turn debug mode off">
					<Button
						size="small"
						type="text"
						icon={<CloseOutlined />}
						onClick={() => set({ enabled: false })}
						aria-label="turn debug mode off"
					/>
				</Tooltip>
			</Space>
		</div>
	);
}
