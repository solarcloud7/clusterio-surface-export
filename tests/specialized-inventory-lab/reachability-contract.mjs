const allowedSections = ["prototype", "placement"];

const expectedReachability = {
	"chemical-plant": true,
	"storage-tank": true,
	pump: true,
	"flamethrower-turret": false,
	"fluid-wagon": false,
	"electric-mining-drill": false,
};

export function parseSections(value) {
	const sections = String(value).split(",").map(section => section.trim().toLowerCase()).filter(Boolean);
	if (!sections.length || sections.some(section => !allowedSections.includes(section))) {
		throw new Error(`Sections must be ${allowedSections.join(",")}`);
	}
	return sections;
}

export function classifyReachability(evidence) {
	const rows = evidence?.prototype?.entities || {};
	const result = {};
	for (const name of Object.keys(expectedReachability)) {
		const row = rows[name];
		result[name] = Boolean(
			row?.fluidbox_count > 0
			&& row?.can_place === true
			&& (row.surface_conditions || []).every(condition => condition.passes === true),
		);
	}

	const drill = evidence?.placement?.drill;
	result["electric-mining-drill"] = Boolean(
		result["electric-mining-drill"]
		&& drill?.created === true
		&& drill?.live_fluidbox_count > 0
		&& drill?.read_ok === true,
	);
	return result;
}

export function validateEvidence(evidence) {
	const failures = [];
	const classification = classifyReachability(evidence);
	if (!evidence?.prototype?.tick || !evidence?.placement?.tick) failures.push("both rungs need tick-stamped evidence");
	if (evidence?.prototype?.pin !== "2.0.77" || evidence?.placement?.pin !== "2.0.77") {
		failures.push("the current contract is pinned to Factorio 2.0.77");
	}
	if (evidence?.prototype?.platform?.pressure !== 0 || evidence?.prototype?.platform?.gravity !== 0) {
		failures.push("space-platform pressure/gravity no longer match the measured control");
	}
	for (const [name, expected] of Object.entries(expectedReachability)) {
		if (classification[name] !== expected) failures.push(`${name} reachability changed: expected ${expected}, measured ${classification[name]}`);
	}
	const drill = evidence?.placement?.drill;
	if (drill?.write_ok !== false || drill?.live_fluidbox_count !== 0 || drill?.mining_target !== null) {
		failures.push("electric-mining-drill live zero-fluidbox evidence changed");
	}
	return failures;
}

export { allowedSections, expectedReachability };
