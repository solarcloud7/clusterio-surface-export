import React, { useEffect, useState } from "react";
import { Button, Modal, Space, Typography } from "antd";

import EdgeTransfers from "./EdgeTransfers";
import { shipPhaseFor } from "./transfer-motion";

const STEPS = [
	{ sourceInstanceId: -1, targetInstanceId: -2, status: "transporting" },
	{ sourceInstanceId: -1, targetInstanceId: -2, status: "awaiting_validation" },
	{ sourceInstanceId: -1, targetInstanceId: -2, status: "completed" },
	{ sourceInstanceId: -2, targetInstanceId: -1, status: "transporting" },
	{ sourceInstanceId: -2, targetInstanceId: -1, status: "awaiting_validation" },
	{ sourceInstanceId: -2, targetInstanceId: -1, status: "failed" },
	{ sourceInstanceId: -2, targetInstanceId: -1, status: "transporting" },
	{ sourceInstanceId: -2, targetInstanceId: -1, status: "awaiting_validation" },
	{ sourceInstanceId: -2, targetInstanceId: -1, status: "cleanup_failed" },
];

// Uses the real edge renderer, but never calls the plugin or changes gateway configuration.
export default function MotionPreview({ onClose }: { onClose: () => void }) {
	const [step, setStep] = useState(0);
	const [playing, setPlaying] = useState(true);
	useEffect(() => {
		if (!playing) return undefined;
		const timer = setInterval(() => setStep(value => value + 1), 2200);
		return () => clearInterval(timer);
	}, [playing]);
	const current = STEPS[step % STEPS.length];
	const ship = {
		...current,
		transferId: `preview-${Math.floor(step / STEPS.length)}-${Math.floor((step % STEPS.length) / 3)}`,
		operationType: "transfer" as const,
		platformName: "Preview platform",
	};
	const path = "M 35 85 C 140 15, 340 155, 445 85";
	return <Modal open title="Transfer motion preview" onCancel={onClose} footer={null} width={560}>
		<Typography.Paragraph>Preview only — no platforms move in the game.</Typography.Paragraph>
		<div style={{ overflowX: "auto", overflowY: "hidden" }}>
			<div data-testid="transfer-motion-preview" style={{ width: 480, height: 170, position: "relative" }}>
				<svg width="480" height="170" style={{ display: "block" }} aria-hidden>
					<path d={path} fill="none" stroke="#777" strokeWidth="2" />
					<circle cx="35" cy="85" r="22" fill="#222" stroke="#777" />
					<circle cx="445" cy="85" r="22" fill="#222" stroke="#777" />
					<text x="35" y="130" textAnchor="middle" fill="currentColor">A</text>
					<text x="445" y="130" textAnchor="middle" fill="currentColor">B</text>
				</svg>
				<EdgeTransfers path={path} ships={[ship]} anchorInstanceId={-1} />
			</div>
		</div>
		<Typography.Paragraph>
			{current.sourceInstanceId === -1 ? "A → B" : "B → A"}: {shipPhaseFor(current.status)?.label}
		</Typography.Paragraph>
		<Space>
			<Button onClick={() => setPlaying(value => !value)}>{playing ? "Pause" : "Play round trip"}</Button>
			<Button onClick={() => { setPlaying(false); setStep(value => value + 1); }}>Next phase</Button>
		</Space>
	</Modal>;
}
