import React from "react";
import { Background, Controls, MiniMap, ReactFlow } from "@xyflow/react";
import type { Node } from "@xyflow/react";

// React Flow ships its own stylesheet. `dist/style.css` = the required base styles PLUS the default
// theme; `dist/base.css` would be base only. We take the full sheet and override the parts that
// clash with Clusterio's dark UI in web/style.css, rather than re-implementing node/edge/handle
// geometry ourselves. Loaded by the existing `{ test: /\.css$/ }` webpack rule, which has no
// include/exclude and so already covers node_modules.
import "@xyflow/react/dist/style.css";

import type { SurfaceExportPlugin, SurfaceExportState } from "./view-models";

// Placeholder graph — replaced by the real instance/host projection in the next step. It exists so
// this first cut proves the three things that can only be proven by rendering: the bundle loads,
// the container has a non-zero height, and the MiniMap has something to draw.
const PLACEHOLDER_NODES: Node[] = [
	{ id: "placeholder-a", position: { x: 0, y: 0 }, data: { label: "canvas online" } },
	{ id: "placeholder-b", position: { x: 220, y: 120 }, data: { label: "gateway graph goes here" } },
];

export default function GatewayCanvas({ plugin: _plugin, state: _state }: {
	plugin: SurfaceExportPlugin;
	state: SurfaceExportState;
}) {
	return (
		<div className="surface-export-canvas">
			<ReactFlow
				nodes={PLACEHOLDER_NODES}
				edges={[]}
				// Unconditional, not "system": Clusterio hardcodes antd's darkAlgorithm
				// (@clusterio/web_ui/src/components/App.tsx) and ships no light mode, so following the
				// OS preference would render a light canvas inside a permanently dark page.
				colorMode="dark"
				fitView
			>
				<Background />
				<Controls />
				<MiniMap
					pannable
					zoomable
					// The default mask is rgba(240,240,240,0.6) — a light haze designed for a light
					// canvas, which reads as fog over this one.
					maskColor="rgba(0, 0, 0, 0.6)"
					nodeBorderRadius={20}
				/>
			</ReactFlow>
		</div>
	);
}
