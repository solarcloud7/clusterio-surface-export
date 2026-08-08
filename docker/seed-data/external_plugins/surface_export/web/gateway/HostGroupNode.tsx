import React from "react";
import type { NodeProps } from "@xyflow/react";
import { Tag } from "antd";

export type HostGroupNodeData = { hostName: string; connected: boolean };

/**
 * A host, drawn as the box its instances live in.
 *
 * Overrides React Flow's built-in `group` type (registering the name replaces it) purely to carry a
 * label — the built-in is an unlabelled rectangle, which on a two-host cluster would leave the
 * operator guessing which box is which.
 */
export function HostGroupNode({ data }: NodeProps) {
	const node = data as unknown as HostGroupNodeData;
	return (
		<div className="surface-export-host-group">
			<div className="surface-export-host-group-label">
				<Tag color={node.connected ? "blue" : "default"}>{node.hostName}</Tag>
			</div>
		</div>
	);
}

