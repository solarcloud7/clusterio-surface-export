import { createContext, useContext } from "react";

import type { PlatformActionSource } from "../platform-actions";

export type GatewayNodeActions = {
	exportingKey: string | null;
	onExport: (source: PlatformActionSource) => void;
	onTransfer: (source: PlatformActionSource, presetTargetInstanceId: number | null) => void;
};

export const NodeActionsContext = createContext<GatewayNodeActions | null>(null);

export function platformActionKey(instanceId: number, platformIndex: number): string {
	return `${instanceId}:${platformIndex}`;
}

export function useNodeActions(): GatewayNodeActions | null {
	return useContext(NodeActionsContext);
}
