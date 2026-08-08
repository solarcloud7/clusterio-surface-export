import React, { useEffect, useState } from "react";

import { SHIP_TRAVEL_MS } from "./transfer-motion";
import type { ShipPhase, ShipTransfer } from "./transfer-motion";

/**
 * The platform, drawn where its transfer actually is.
 *
 * ALWAYS MOUNTED. `phase`/`summary` are nullable and an idle ship simply renders invisible, because
 * the element's own survival is what makes the animation possible: a CSS transition lives on a DOM
 * node, and a node destroyed between phases comes back already at its destination with nothing left
 * to travel. Unmounting it when there was no transfer is exactly what made this teleport, and it was
 * only found by tagging DOM nodes — the edge's path element kept one identity through a node drag
 * while the ship's node was replaced at every phase.
 *
 * MOTION TECHNIQUE — CSS motion path, not SVG `<animateMotion>`. Both follow the curve exactly, and
 * React Flow's own example shows either; the deciding difference is that this animation is
 * STATE-DRIVEN rather than looping. `offset-distance` is a CSS-transitionable property, so a status
 * change is just a new percentage and the browser tweens along the path. SMIL would have needed a
 * remount (or `beginElement()` through a ref) to restart on each phase change, because an
 * `<animateMotion begin="0s">` inserted after the document timeline has started does not reliably
 * begin at insertion.
 *
 * Rendered inside `EdgeLabelRenderer`, which puts it in React Flow's own HTML layer INSIDE the
 * viewport — so flow coordinates work directly and the ship pans and zooms with everything else.
 *
 * A BARE CIRCLE, coloured by phase, with the platform name and phase on hover. It carried the name
 * inline at first; on a real cluster two ships on nearby edges overlapped into an unreadable pile,
 * and the name is the one thing an operator can also get from the transaction log. The colour is
 * the phase, which is what the canvas is uniquely good at showing.
 */
export default function TransferShip({ path, phase, reversed, summary }: {
	/** The edge's own path string, in flow coordinates, from getBezierPath. */
	path: string;
	/** Null when this edge has no transfer on it — the ship stays mounted but invisible. */
	phase: ShipPhase | null;
	/** True when the transfer runs against the edge's canonical orientation. */
	reversed: boolean;
	summary?: ShipTransfer;
}) {
	// The edge is drawn in ONE canonical orientation (lexicographic on endpoint keys), which has
	// nothing to do with which way this transfer is going. Flipping the fraction is enough — the path
	// string itself must not be reversed, since it is shared with the drawn edge.
	//
	// With no phase, park at the source end so a ship that appears later starts from a sane place.
	const sourceEnd = reversed ? 1 : 0;
	const target = phase ? (reversed ? 1 - phase.distance : phase.distance) : sourceEnd;

	// FIRST SIGHT: a transfer seen at its OPENING status really did just leave the source, so it flies
	// from there. A transfer first seen mid-flight (the page was opened while it was running) is
	// placed where it is — we have no evidence about how it got there, and flying it across would be
	// an animation of something we did not observe. The component is keyed on the transfer id, so
	// this initial value is chosen once per transfer.
	const [distance, setDistance] = useState(() => (phase?.opening ? sourceEnd : target));

	useEffect(() => {
		setDistance(target);
	}, [target]);

	if (!phase || !summary) {
		// Mounted, positioned, and invisible. `visibility` rather than unmounting or `display: none`
		// so the element keeps its box and its transition state.
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
