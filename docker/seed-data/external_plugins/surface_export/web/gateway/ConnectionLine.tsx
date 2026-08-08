import React from "react";
import { useConnection } from "@xyflow/react";
import type { ConnectionLineComponentProps } from "@xyflow/react";

import { gatewayFromHandleId } from "./gateway-graph";
import { gatewayColour } from "./gateway-colours";

/**
 * The line you drag while making a connection, before it becomes an edge.
 *
 * React Flow's default is a plain grey curve identical for every handle. This tints it with the
 * gateway's own portal colour and puts a dot on the cursor end, so mid-drag you can see WHICH gate
 * you are pulling from — the thing that matters in Multi Cluster mode, where four gates on one node
 * lead to four different places.
 *
 * NOTE for anyone comparing this with React Flow's floating-edges example: that example writes
 * `stroke={fromHandle.id}` because its handle ids are literally colour strings. Ours are
 * `s:surfexp_gateway_hub@right`, so using the id as a colour would silently produce an invalid
 * stroke and a black line. The id is decoded to a gateway name and mapped to a real colour instead.
 */
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
