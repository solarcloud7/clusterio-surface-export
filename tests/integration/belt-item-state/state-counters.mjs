// Factorio emits one ITEM STATE record per restore_side_groups call.
export function parseStateCounters(output, clone) {
	const marker = `[BeltRestoration] ITEM STATE ${clone}:`;
	const lines = output.split(/\r?\n/).map(line => line.trim()).filter(line => line.includes(marker));
	if (!lines.length) return null;
	const totals = { line: lines.join("\n"), records: lines.length,
		applied: 0, unmatched: 0, failed: 0, mergeDiscarded: 0, declined: 0 };
	const fields = ["applied", "unmatched", "failed", "mergeDiscarded", "declined"];
	for (const line of lines) {
		const reading = line.slice(line.indexOf(marker) + marker.length).trim();
		const nums = reading.match(
			/^applied (\d+) \| unmatched (\d+) \| failed (\d+) \| merge-discarded (\d+) \| declined (\d+)$/);
		if (!nums) throw new Error(`Malformed belt item-state record: ${line}`);
		fields.forEach((field, index) => {
			const value = Number(nums[index + 1]);
			if (!Number.isSafeInteger(value) || !Number.isSafeInteger(totals[field] + value)) {
				throw new Error(`Unsafe belt item-state count: ${line}`);
			}
			totals[field] += value;
		});
	}
	return totals;
}
