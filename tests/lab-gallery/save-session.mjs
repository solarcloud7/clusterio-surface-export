// Coordinates a temporary pair of test worlds. All recovery state is captured before stopping.
export function createSaveSession(io, saves) {
	let prepared = false, displaced = false, restored = false;
	let before;
	const recovered = new Set();
	return {
		async prepare() {
			if (prepared || displaced) throw new Error("Save session already prepared");
			await io.preflight();
			before = await io.capture();
			await io.record({ saves, before });
			for (const host of [1, 2]) await io.save(host, saves[host]);
			for (const host of [1, 2]) await io.confirm(host, saves[host]);
			prepared = true;
		},
		async enter(load) {
			if (!prepared || displaced) throw new Error("Both snapshots must be confirmed before loading test worlds");
			displaced = true; // A failed stop/start may already have changed the world.
			await load();
		},
		async restore() {
			if (!displaced) return { skipped: "test worlds never loaded" };
			if (restored) return { saves, verified: true };
			const errors = [];
			for (const host of [1, 2]) {
				if (recovered.has(host)) continue;
				try { await io.reload(host, saves[host]); recovered.add(host); }
				catch (error) { errors.push(`host ${host}: ${error.message}`); }
			}
			if (errors.length) throw new Error(`Snapshot restore failed; retain ${JSON.stringify(saves)}: ${errors.join("; ")}`);
			await io.verify(before);
			restored = true;
			return { saves, verified: true };
		},
	};
}
