import React, { useEffect, useRef } from "react";

import { shipPosition, shipTravelDuration } from "./ship-motion";
import type { ShipPhase, ShipTransfer } from "./transfer-motion";

export default function TransferShip({ path, phase, reversed, summary, hidden, onSettled }: {
	path: string;
	phase: ShipPhase;
	reversed: boolean;
	summary: ShipTransfer;
	hidden: boolean;
	onSettled: (id: string, status: string, distance: number) => void;
}) {
	const target = reversed ? 1 - phase.distance : phase.distance;
	// A terminal snapshot has no observed journey to replay. Live ships start at their source.
	const initial = useRef(phase.terminal ? target : reversed ? 1 : 0);
	const distance = useRef(initial.current);
	const element = useRef<HTMLDivElement>(null);
	const { transferId } = summary;
	const status = summary.status || "";

	useEffect(() => {
		const from = distance.current;
		const started = performance.now();
		const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const duration = shipTravelDuration(from, target);
		let frame = 0;
		const advance = (now: number) => {
			const elapsed = reducedMotion.matches ? duration : now - started;
			distance.current = shipPosition(from, target, elapsed, duration);
			if (element.current) element.current.style.offsetDistance = `${distance.current * 100}%`;
			if (elapsed >= duration) {
				onSettled(transferId, status, target);
			} else {
				frame = requestAnimationFrame(advance);
			}
		};
		frame = requestAnimationFrame(advance);
		return () => cancelAnimationFrame(frame);
	}, [target, transferId, status, onSettled]);

	const title = `${summary.platformName || "platform"} — ${phase.label}`
		+ (summary.error ? `: ${summary.error}` : "");

	return (
		<div
			ref={element}
			data-transfer-id={transferId}
			className={`surface-export-ship surface-export-ship-${phase.tone}`}
			style={{
				offsetPath: `path('${path}')`,
				offsetDistance: `${initial.current * 100}%`,
				offsetRotate: "0deg",
				offsetAnchor: "center",
				visibility: hidden ? "hidden" : "visible",
			}}
			title={title}
		/>
	);
}
