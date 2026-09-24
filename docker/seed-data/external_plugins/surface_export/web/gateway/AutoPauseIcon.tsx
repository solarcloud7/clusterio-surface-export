export const AUTO_PAUSE_LABEL = "auto-pause on";

export default function AutoPauseIcon({ size = 44 }: { size?: number }) {
	return (
		<svg
			className="surface-export-autopause-icon"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			role="img"
			aria-label={AUTO_PAUSE_LABEL}
		>
			<path
				d="M13.5 1.5 3.5 13.5h7l-1.5 9 11-13h-7.2z"
				fill="#ff3b2f"
				stroke="#1c0503"
				strokeWidth="1.4"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
