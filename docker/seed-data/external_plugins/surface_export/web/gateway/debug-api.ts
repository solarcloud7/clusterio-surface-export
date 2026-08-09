/**
 * The canvas's console API — `window.surfaceExportCanvas`.
 *
 * WHY A JS COMMAND AND NOT JUST THE PANEL. The panel can only offer what someone thought to put a
 * control on: a number of mock instances, a set of phases. The interesting questions are shapes —
 * a hub and spokes, a chain, two disconnected clusters, one instance with twelve platforms beside
 * one with none, a transfer stuck mid-validation between two named nodes. No number goes up to
 * "that". `load()` takes the whole picture as an object, so the canvas becomes something you can put
 * into an arbitrary state and then look at.
 *
 * It is also what makes the canvas testable without a cluster that happens to be shaped correctly.
 *
 * INSTALLED ALWAYS, not only in debug mode — you need a way to TURN debug mode on, and gating the
 * switch behind itself is a locked door with the key inside. Nothing here is privileged: every
 * object it creates carries a NEGATIVE instance id, which `pending` filters out of the save and
 * `mockLeaksInPayload` re-checks at the write, so the whole API is incapable of changing cluster
 * config. It only changes what this browser draws.
 *
 * Deliberately plain data in, plain data out: a scenario is a literal you can paste into a console,
 * keep in a snippet, or hand to someone else in a bug report.
 */

import { DEFAULT_DEBUG_STATE, SHIP_PHASE_NAMES } from "./debug-mode";
import type { DebugScenario, DebugState, ReplayCandidate } from "./debug-mode";

/** What the canvas hands the API so it can drive it. */
export type CanvasDebugControls = {
	getState: () => DebugState;
	setState: (next: DebugState) => void;
	getScenario: () => DebugScenario | null;
	setScenario: (scenario: DebugScenario | null) => void;
	/** Real transfers the canvas could draw, newest last — the page's own summaries. */
	getReplayCandidates: () => ReplayCandidate[];
	/** A short, human-readable summary of what is currently drawn. */
	describe: () => Record<string, unknown>;
};

/** The global name. Long and specific: `window.debug` would be a collision waiting to happen. */
export const CANVAS_API_GLOBAL = "surfaceExportCanvas";

const HELP = `surfaceExportCanvas — gateway canvas debug API

  help()                      this text
  describe()                  what is on the canvas right now
  state()                     the debug settings
  on() / off()                debug mode (also reveals the toolbar's debug row)

  mocks(instances, platforms) fake instances appended to the real cluster
                              e.g. mocks(6, 3)
  geometry(true|false)        outline the measured node box, portal and edge anchor

  ships(...phases)            draw a fake transfer per phase; no args = all, ships(false) = none
                              phases: ${SHIP_PHASE_NAMES.join(", ")}

  transfers()                 REAL transfers this page can draw (pick one to replay)
  replay(n | ...ids)          draw REAL transfers as ships, whatever their age; replay(false) stops

  load(scenario)              REPLACE the canvas with a scenario (see below)
  reset()                     back to the live cluster

A scenario is one object. Instances are referred to by index:

  load({
    instances: [
      { name: "hub", platforms: ["alpha", "beta"] },
      { name: "spoke-1", platforms: ["gamma"] },
      { name: "spoke-2", online: false },
    ],
    links: [[0, 1], [0, 2]],
    ships: [{ from: 0, to: 1, status: "awaiting_validation" }],
  })

Nothing here can change cluster config: every scenario instance gets a negative id, which the save
path filters and then re-checks. It only changes what this browser draws.`;

/**
 * Install the API, returning an uninstall function.
 *
 * Uninstalls on unmount so a stale closure over a dead React tree cannot be called from a console
 * that is still open — the symptom would be commands that "work" and change nothing.
 */
export function installCanvasDebugApi(controls: CanvasDebugControls): () => void {
	/**
	 * The state AFTER React has re-rendered, not before.
	 *
	 * Every command here is a `setState`, which does not take effect synchronously — so returning
	 * `describe()` straight away reported the state the command REPLACED. Measured: `load()` printed
	 * "live cluster, 2 instances" for a scenario that had just put four on screen, which reads exactly
	 * like the command silently failing.
	 *
	 * Two frames, because one is not enough: the first commits the state, the second is after the
	 * layout effects that follow it. In a console the promise resolves and prints on its own.
	 */
	const settled = () => new Promise<Record<string, unknown>>(resolve => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve(controls.describe())));
	});

	const patch = (fields: Partial<DebugState>) => {
		const next = { ...controls.getState(), ...fields };
		// Any command implies wanting to SEE the result. Turning the mode on as a side effect of using
		// the API avoids the "I called mocks(6) and nothing happened" dead end.
		controls.setState({ ...next, enabled: true });
		return settled();
	};

	const api = {
		help() {
			console.log(HELP);
			return undefined;
		},
		describe: () => controls.describe(),
		state: () => controls.getState(),
		on: () => patch({}),
		off: () => {
			controls.setState({ ...controls.getState(), enabled: false });
			return settled();
		},

		mocks(instances = DEFAULT_DEBUG_STATE.mockInstances, platforms = DEFAULT_DEBUG_STATE.mockPlatforms) {
			return patch({ mockInstances: Number(instances) || 0, mockPlatforms: Number(platforms) || 0 });
		},

		geometry(on = true) {
			return patch({ showGeometry: Boolean(on) });
		},

		/**
		 * `ships()` = every phase, `ships(false)` = none, `ships("failed", …)` = those.
		 *
		 * An unknown phase is REFUSED rather than ignored: `transfer-motion.ts` draws nothing for a
		 * status it does not map, so a typo would silently produce an empty canvas and look like a bug
		 * in the ships feature.
		 */
		ships(...phases: Array<string | boolean>) {
			if (phases.length === 1 && phases[0] === false) {
				return patch({ shipPhases: [] });
			}
			const wanted = phases.length ? phases.map(String) : [...SHIP_PHASE_NAMES];
			const unknown = wanted.filter(name => !(SHIP_PHASE_NAMES as readonly string[]).includes(name));
			if (unknown.length) {
				throw new Error(`unknown transfer phase(s): ${unknown.join(", ")}. Known: ${SHIP_PHASE_NAMES.join(", ")}`);
			}
			return patch({ shipPhases: wanted });
		},

		load(scenario: DebugScenario) {
			if (!scenario || !Array.isArray(scenario.instances) || !scenario.instances.length) {
				throw new Error("a scenario needs an `instances` array — see surfaceExportCanvas.help()");
			}
			const count = scenario.instances.length;
			for (const [from, to] of scenario.links || []) {
				if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= count || to >= count) {
					throw new Error(`link [${from}, ${to}] is out of range — instances are indexed 0..${count - 1}`);
				}
			}
			for (const ship of scenario.ships || []) {
				if (!Number.isInteger(ship?.from) || !Number.isInteger(ship?.to) || ship.from >= count || ship.to >= count) {
					throw new Error(`ship ${JSON.stringify(ship)} is out of range — instances are indexed 0..${count - 1}`);
				}
				if (!(SHIP_PHASE_NAMES as readonly string[]).includes(ship.status)) {
					throw new Error(`ship status "${ship.status}" draws nothing. Known: ${SHIP_PHASE_NAMES.join(", ")}`);
				}
			}
			controls.setScenario(scenario);
			return patch({});
		},

		/**
		 * Real transfers the canvas can draw, newest last — pick one and `replay()` it.
		 *
		 * Filtered to what is actually drawable (a transfer, two endpoints, a status the phase model
		 * maps) rather than the whole log, so nothing offered here can be selected and then not appear.
		 */
		transfers(limit = 20) {
			const all = controls.getReplayCandidates();
			const shown = all.slice(-Math.max(1, Number(limit) || 20));
			console.table(shown);
			return { drawable: all.length, showing: shown.length, transfers: shown };
		},

		/**
		 * Draw REAL transfers as ships, whatever their age.
		 *
		 * `replay()` takes the most recent few, `replay(id, …)` takes those, `replay(false)` stops.
		 * Nothing is synthesized: the endpoints, the status and the id are the ones the controller
		 * recorded, so a banked failure is replayed with the real transfer behind it and its ship sits
		 * where the two-phase commit actually left the platform.
		 */
		replay(...ids: Array<string | number | boolean>) {
			if (ids.length === 1 && ids[0] === false) {
				return patch({ replayTransferIds: [] });
			}
			const candidates = controls.getReplayCandidates();
			if (!candidates.length) {
				throw new Error("no drawable transfers — this page has seen no transfer summaries with two endpoints");
			}
			if (!ids.length || typeof ids[0] === "number") {
				const count = ids.length ? Math.max(1, Number(ids[0])) : 3;
				return patch({ replayTransferIds: candidates.slice(-count).map(candidate => candidate.transferId) });
			}
			const wanted = ids.map(String);
			const known = new Set(candidates.map(candidate => candidate.transferId));
			const missing = wanted.filter(id => !known.has(id));
			if (missing.length) {
				throw new Error(
					`not drawable: ${missing.join(", ")}. `
					+ "Call transfers() for the list — an id is missing here if it is not a transfer, "
					+ "lacks an endpoint, or has a status the canvas does not map to a position.",
				);
			}
			return patch({ replayTransferIds: wanted });
		},

		reset() {
			controls.setScenario(null);
			return settled();
		},
	};

	(window as unknown as Record<string, unknown>)[CANVAS_API_GLOBAL] = api;
	return () => {
		if ((window as unknown as Record<string, unknown>)[CANVAS_API_GLOBAL] === api) {
			delete (window as unknown as Record<string, unknown>)[CANVAS_API_GLOBAL];
		}
	};
}
