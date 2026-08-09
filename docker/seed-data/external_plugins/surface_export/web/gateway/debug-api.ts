
import { DEFAULT_DEBUG_STATE, SHIP_PHASE_NAMES } from "./debug-mode";
import type { DebugScenario, DebugState, ReplayCandidate } from "./debug-mode";

export type CanvasDebugControls = {
	getState: () => DebugState;
	setState: (next: DebugState) => void;
	getScenario: () => DebugScenario | null;
	setScenario: (scenario: DebugScenario | null) => void;
	getReplayCandidates: () => ReplayCandidate[];
	describe: () => Record<string, unknown>;
};

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

export function installCanvasDebugApi(controls: CanvasDebugControls): () => void {
	const settled = () => new Promise<Record<string, unknown>>(resolve => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve(controls.describe())));
	});

	const patch = (fields: Partial<DebugState>) => {
		const next = { ...controls.getState(), ...fields };
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

		transfers(limit = 20) {
			const all = controls.getReplayCandidates();
			const shown = all.slice(-Math.max(1, Number(limit) || 20));
			console.table(shown);
			return { drawable: all.length, showing: shown.length, transfers: shown };
		},

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
