import type { ConnectionLineComponentProps } from "@xyflow/react";

import { DEFAULT_EDGE_COLOUR } from "./gateway-colours";

export const CONNECTION_VALID = "#52c41a";
export const CONNECTION_INVALID = "#dc4446";

export default function ConnectionLine({ fromX, fromY, toX, toY, connectionStatus }: ConnectionLineComponentProps) {
	const colour = connectionStatus === "valid" ? CONNECTION_VALID
		: connectionStatus === "invalid" ? CONNECTION_INVALID
			: DEFAULT_EDGE_COLOUR;

	return (
		<g data-connection-status={connectionStatus ?? "none"}>
			<path
				fill="none"
				stroke={colour}
				strokeWidth={connectionStatus ? 3 : 2}
				className="animated"
				d={`M${fromX},${fromY} L ${toX},${toY}`}
			/>
			<circle
				cx={toX}
				cy={toY}
				fill="#141414"
				r={connectionStatus ? 5 : 3.5}
				stroke={colour}
				strokeWidth={2}
			/>
		</g>
	);
}
