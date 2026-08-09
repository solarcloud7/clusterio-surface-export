import React, { useEffect, useState } from "react";

import { SHIP_TRAVEL_MS } from "./transfer-motion";
import type { ShipPhase, ShipTransfer } from "./transfer-motion";

export default function TransferShip({ path, phase, reversed, summary }: {
	path: string;
	phase: ShipPhase | null;
	reversed: boolean;
	summary?: ShipTransfer;
}) {
	const sourceEnd = reversed ? 1 : 0;
	const target = phase ? (reversed ? 1 - phase.distance : phase.distance) : sourceEnd;

	const [distance, setDistance] = useState(() => (phase?.opening ? sourceEnd : target));

	useEffect(() => {
		setDistance(target);
	}, [target]);

	if (!phase || !summary) {
		return (
			<div
				className="surface-export-ship"
				style={{
					offsetPath: `path('${path}')`,
					offsetDistance: `${distance * 100}%`,
					offsetRotate: "0deg",
					offsetAnchor: "center",
					visibility: "hidden",
				}}
				aria-hidden
			/>
		);
	}

	const title = `${summary.platformName || "platform"} — ${phase.label}`
		+ (summary.error ? `: ${summary.error}` : "");

	return (
		<div
			className={`surface-export-ship surface-export-ship-${phase.tone}${phase.holding ? " surface-export-ship-holding" : ""}`}
			style={{
				offsetPath: `path('${path}')`,
				offsetDistance: `${distance * 100}%`,
				offsetRotate: "0deg",
				offsetAnchor: "center",
				transitionDuration: `${SHIP_TRAVEL_MS}ms`,
			}}
			title={title}
		/>
	);
}
