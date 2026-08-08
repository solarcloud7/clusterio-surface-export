import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { SHIP_TRAVEL_MS, recallShipDistance, rememberShipDistance } from "./transfer-motion";
import type { ShipPhase } from "./transfer-motion";
import type { TransferSummary } from "../view-models";

/**
 * The platform, drawn where its transfer actually is.
 *
 * MOTION TECHNIQUE — CSS motion path, not SVG `<animateMotion>`. Both follow the curve exactly, and
 * React Flow's own example shows either; the deciding difference is that this animation is
 * STATE-DRIVEN rather than looping. `offset-distance` is a CSS-transitionable property, so a status
 * change is just a new percentage and the browser tweens along the path. SMIL would have needed the
 * element remounted (or `beginElement()` through a ref) to restart on each phase change, because a
 * `<animateMotion begin="0s">` inserted after the document timeline has started does not reliably
 * begin at insertion.
 *
 * Rendered inside `EdgeLabelRenderer`, which puts it in React Flow's own HTML layer INSIDE the
 * viewport — so flow coordinates work directly and the ship pans and zooms with everything else.
 *
 * `offset-rotate: 0deg` because the chip carries text: the default (`auto`) turns the element to
 * face along the path, which would stand the platform name on its side halfway across.
 */
export default function TransferShip({ path, phase, reversed, summary }: {
	/** The edge's own path string, in flow coordinates, from getBezierPath. */
	path: string;
	phase: ShipPhase;
	/** True when the transfer runs against the edge's canonical orientation. */
	reversed: boolean;
	summary: TransferSummary;
}) {
	// The edge is drawn in ONE canonical orientation (lexicographic on endpoint keys), which has
	// nothing to do with which way this transfer is going. Flipping the fraction is enough — the path
	// string itself must not be reversed, since it is shared with the drawn edge.
	const target = reversed ? 1 - phase.distance : phase.distance;

	// WHERE THIS SHIP STARTS THIS MOUNT. React Flow remounts the edge on every update (measured: the
	// ship's DOM node was a different element at each phase), so component state cannot carry the
	// position across a phase change — a plain `useState(target)` re-appears already AT the target and
	// the transition has nothing to travel from, which is why this used to teleport. The last rendered
	// distance is therefore kept outside the component; see transfer-motion.ts.
	//
	// Falling back, in order:
	//   remembered   — a remount mid-journey continues from where the previous element was;
	//   source end   — first sight at the OPENING status, where the ship really did just leave;
	//   the target   — first sight mid-flight (page opened while it was running). We have no evidence
	//                  about how it got there, so we place it rather than animate a journey we did
	//                  not observe.
	const initial = useRef(
		recallShipDistance(summary.transferId)
		?? (phase.opening ? (reversed ? 1 : 0) : target),
	);
	const [distance, setDistance] = useState(initial.current);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		setDistance(target);
	}, [target]);

	// Hand the NEXT mount the position this element actually reached — measured off the element, not
	// the target it was heading for. Remembering the target instead would re-initialise the ship at
	// its destination and leave the transition nothing to travel, which is the teleport this whole
	// mechanism exists to stop.
	//
	// `useLayoutEffect` because its cleanup is guaranteed to run BEFORE React detaches the node; a
	// passive effect can be torn down late, and `getComputedStyle` on a detached element reports
	// nothing. If the read does fail we simply remember nothing, and the next mount falls back to
	// placing the ship — degraded, never wrong.
	useLayoutEffect(() => {
		const node = ref.current;
		return () => {
			if (!node) {
				return;
			}
			const reached = Number.parseFloat(getComputedStyle(node).offsetDistance);
			if (Number.isFinite(reached)) {
				rememberShipDistance(summary.transferId, reached / 100);
			}
		};
	}, [summary.transferId]);

	const title = `${summary.platformName || "platform"} — ${phase.label}`
		+ (summary.error ? `: ${summary.error}` : "");

	return (
		<div
			ref={ref}
			className={`surface-export-ship surface-export-ship-${phase.tone}${phase.holding ? " surface-export-ship-holding" : ""}`}
			style={{
				offsetPath: `path('${path}')`,
				offsetDistance: `${distance * 100}%`,
				offsetRotate: "0deg",
				offsetAnchor: "center",
				transitionDuration: `${SHIP_TRAVEL_MS}ms`,
			}}
			title={title}
		>
			<span className="surface-export-ship-dot" />
			<span className="surface-export-ship-name">{summary.platformName || "platform"}</span>
		</div>
	);
}
