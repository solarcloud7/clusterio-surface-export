import React from "react";
import { useConnection } from "@xyflow/react";
import type { ConnectionLineComponentProps } from "@xyflow/react";

import { gatewayFromHandleId } from "./gateway-graph";
import { gatewayColour } from "./gateway-colours";

export default function ConnectionLine({ fromX, fromY, toX, toY }: ConnectionLineComponentProps) {
	const { fromHandle } = useConnection();
	const colour = gatewayColour(gatewayFromHandleId(fromHandle?.id));

	return (
		<g>
			<path
				fill="none"
				stroke={colour}
				strokeWidth={2}
				className="animated"
				d={`M${fromX},${fromY} C ${fromX} ${toY} ${fromX} ${toY} ${toX},${toY}`}
			/>
			<circle
				cx={toX}
				cy={toY}
				fill="#141414"
				r={3.5}
				stroke={colour}
				strokeWidth={2}
			/>
		</g>
	);
}
