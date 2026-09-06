import React from "react";

import type { EdgeStatusMarker as Marker } from "./transfer-motion";

export default function EdgeStatusMarker({ path, marker }: { path: string; marker: Marker }) {
	const shown = marker.platformNames.slice(0, 5);
	const rest = marker.platformNames.length - shown.length;
	const title = `${marker.count} ${marker.label}: ${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;

	return (
		<div
			className={`surface-export-edge-status surface-export-ship-${marker.tone}`
				+ (marker.tone === "holding" ? " surface-export-ship-holding" : " surface-export-edge-status-terminal")}
			style={{
				offsetPath: `path('${path}')`,
				offsetDistance: `${marker.distance * 100}%`,
				offsetRotate: "0deg",
				offsetAnchor: "center",
			}}
			title={title}
		>
			{marker.count > 1 ? <span className="surface-export-edge-status-count">{marker.count}</span> : null}
		</div>
	);
}
