export const contract = {
	requires: ["a clusterioctl wrapper that throws with the command output", "a stopped instance owned by the caller"],
	produces: ["the started save, retried once after Clusterio's documented clusterio_private scenario-migration failure"],
	"does not": ["retry any other failure or an instance not confirmed stopped", "prove the migrated world kept its state"],
};

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
