import React, { useCallback, useEffect, useState } from "react";

import { groupEdgeShips, shipPhaseFor } from "./transfer-motion";
import type { ShipTransfer } from "./transfer-motion";
import TransferShip from "./TransferShip";
import EdgeStatusMarker from "./EdgeStatusMarker";

export default function EdgeTransfers({ path, ships, anchorInstanceId }: {
	path: string;
	ships: ShipTransfer[];
	anchorInstanceId?: number;
}) {
	const [settled, setSettled] = useState<Record<string, { status: string; distance: number }>>({});
	const onSettled = useCallback((id: string, status: string, distance: number) => {
		setSettled(previous => previous[id]?.status === status && previous[id]?.distance === distance
			? previous : { ...previous, [id]: { status, distance } });
	}, []);
	useEffect(() => {
		const ids = new Set(ships.map(ship => ship.transferId));
		setSettled(previous => Object.keys(previous).some(id => !ids.has(id))
			? Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))) : previous);
	}, [ships]);
	const reversed = (ship: ShipTransfer) => anchorInstanceId !== undefined && ship.sourceInstanceId !== anchorInstanceId;
	const { markers, transit } = groupEdgeShips(ships, reversed, ship => {
		const phase = shipPhaseFor(ship.status);
		const at = settled[ship.transferId];
		return !!phase && at?.status === ship.status
			&& at.distance === (reversed(ship) ? 1 - phase.distance : phase.distance);
	});
	const moving = new Set(transit.map(ship => ship.transferId));
	return <>
		{ships.map(ship => {
			const phase = shipPhaseFor(ship.status);
			return phase ? <TransferShip
				key={ship.transferId}
				path={path}
				phase={phase}
				reversed={reversed(ship)}
				summary={ship}
				hidden={!moving.has(ship.transferId)}
				onSettled={onSettled}
			/> : null;
		})}
		{markers.map(marker => <EdgeStatusMarker key={marker.key} path={path} marker={marker} />)}
	</>;
}
