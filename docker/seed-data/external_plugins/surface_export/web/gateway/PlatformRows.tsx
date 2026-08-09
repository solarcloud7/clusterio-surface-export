import React from "react";
import { Handle, Position } from "@xyflow/react";
import { Button, Tag, Tooltip, Typography } from "antd";
import { CaretRightOutlined, DownloadOutlined } from "@ant-design/icons";

import { PLATFORM_LIST_MAX_ROWS, platformHandleId } from "./gateway-graph";
import type { PlatformLike } from "./gateway-graph";
import { isMockInstanceId } from "./debug-mode";
import { platformActionKey, useNodeActions } from "./node-actions";
import { platformStatus } from "../platform-actions";
import { PlanetIcon } from "../icons";

const { Text } = Typography;

function PlatformRow({ platform, instanceId, instanceName, canEdit }: {
	platform: PlatformLike;
	instanceId: number;
	instanceName: string;
	canEdit: boolean;
}) {
	const actions = useNodeActions();
	const status = platformStatus(platform, null);
	const key = platformActionKey(instanceId, platform.platformIndex);
	const locationName = platform.spaceLocation || platform.currentTarget;
	const isMock = isMockInstanceId(instanceId);
	const inert = isMock || !actions;
	const mockNote = "This is a mock platform — it does not exist on any instance, so it cannot be exported or transferred.";
	const source = {
		instanceId,
		instanceName,
		platformIndex: platform.platformIndex,
		platformName: platform.platformName,
		forceName: platform.forceName || "player",
	};

	return (
		<div className="surface-export-platform-node-row">
			{locationName
				? <PlanetIcon name={locationName} size={18} title={`at ${locationName}`} />
				: <span className="surface-export-icon-placeholder" />}
			<Text className="surface-export-platform-node-name" title={`${platform.platformName} #${platform.platformIndex}`}>
				{platform.platformName}
			</Text>
			{status.tag
				? <Tag color={status.tag} className="surface-export-platform-node-tag">{status.text}</Tag>
				: <Text type="secondary" className="surface-export-platform-node-tag">{status.text}</Text>}
			<Tooltip title={isMock ? mockNote : "Export JSON"}>
				<Button
					icon={<DownloadOutlined />}
					size="small"
					disabled={inert}
					loading={actions?.exportingKey === key}
					onClick={() => actions?.onExport(source)}
				/>
			</Tooltip>
			{}
			<Tooltip title={isMock
				? mockNote
				: `Drag onto another instance's portal to transfer ${platform.platformName} there — or click to choose a destination`}>
				<Handle
					type="source"
					position={Position.Right}
					id={platformHandleId(platform.platformIndex)}
					isConnectable={canEdit && !isMock}
					className={`surface-export-platform-handle${canEdit && !isMock ? "" : " surface-export-platform-handle-readonly"}`}
					onClick={inert ? undefined : () => actions?.onTransfer(source, null)}
				>
					{}
					<CaretRightOutlined />
				</Handle>
			</Tooltip>
		</div>
	);
}

export default function PlatformRows({ platforms, instanceId, instanceName, canEdit, onHold, onRelease, onPressed }: {
	platforms: PlatformLike[];
	instanceId: number;
	instanceName: string;
	canEdit: boolean;
	onHold: () => void;
	onRelease: () => void;
	onPressed: () => void;
}) {
	const holdProps = {
		onMouseEnter: onHold,
		onMouseLeave: onRelease,
		onPointerDown: onPressed,
	};

	if (!platforms.length) {
		return (
			<div className="surface-export-platform-list surface-export-platform-list-empty nodrag nopan" {...holdProps}>
				<Text type="secondary" style={{ fontSize: 11 }}>No platforms with a space hub</Text>
			</div>
		);
	}

	const shown = platforms.slice(0, PLATFORM_LIST_MAX_ROWS);
	const hidden = platforms.length - shown.length;

	return (
		<div className="surface-export-platform-list nodrag nopan" {...holdProps}>
			{shown.map(platform => (
				<PlatformRow
					key={platformActionKey(instanceId, platform.platformIndex)}
					platform={platform}
					instanceId={instanceId}
					instanceName={instanceName}
					canEdit={canEdit}
				/>
			))}
			{}
			{hidden > 0 ? (
				<div className="surface-export-platform-node-row surface-export-platform-node-more">
					<Text type="secondary" style={{ fontSize: 11 }}>
						+{hidden} more — see Manual Transfer
					</Text>
				</div>
			) : null}
		</div>
	);
}
