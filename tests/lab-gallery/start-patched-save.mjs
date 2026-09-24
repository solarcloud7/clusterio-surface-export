export function startPatchedSave(ctl, instance, save) {
	const start = () => ctl("instance", "start", instance, "--save", save);
	try {
		return start();
	} catch (error) {
		const detail = `${error.message}\n${error.stdout || ""}\n${error.stderr || ""}`;
		if (!detail.includes("clusterio_private.update_instance")
			|| !detail.includes("attempt to index global 'clusterio_private' (a nil value)")) throw error;
		const rows = ctl("instance", "list").split(/\r?\n/).map(line => line.split("|").map(cell => cell.trim()));
		if (rows.find(row => row[0] === instance)?.[4] !== "stopped") throw error;
		console.warn(`Scenario migration replaced patched scripts for ${instance}; retrying ${save} once: ${error.message}`);
		return start();
	}
}
