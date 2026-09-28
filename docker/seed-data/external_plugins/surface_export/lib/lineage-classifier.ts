import { isGeneration, isLineage, type LineageEntry, type LineageVerdict, type LineageVerdictName, type PlatformFacts } from "../shared/lineage";
import type { PlatformSourceOfTruth } from "../shared/recovery";

export type { LineageVerdict, LineageVerdictName, PlatformFacts } from "../shared/lineage";

export interface ControllerHints {
	inTransit: boolean;
	ownerJobId?: string | null;
	historyMatch: boolean;
	duplicateLocal: boolean;
}

export type Presence = { state: "present"; generation?: number } | { state: "absent" } | { state: "unknown"; reason: string };

export interface ClassifyContext {
	instanceId: number;
	epoch: string;
	mode: PlatformSourceOfTruth;
	allowAdoption: boolean;
}

export function mintedLineage(epoch: string, hubUnitNumber: number): string {
	return `lineage:${epoch}:${hubUnitNumber}`;
}

export function lineageKey(facts: PlatformFacts, epoch: string): string | null {
	if (facts.lineage !== null) return facts.lineage;
	return facts.hubUnitNumber !== null ? mintedLineage(epoch, facts.hubUnitNumber) : null;
}

export function needsVerdict(facts: PlatformFacts): boolean {
	return facts.lockKind === "startup" || facts.journalUidMatch;
}

export function classifyPlatform(facts: PlatformFacts, controller: ControllerHints, entry: LineageEntry | undefined,
	presence: Presence | undefined, context: ClassifyContext): LineageVerdict {
	const hints = { journalUidMatch: facts.journalUidMatch, journalHubMatch: facts.journalHubMatch, historyMatch: controller.historyMatch };
	const result = (verdict: LineageVerdictName, extra: Partial<LineageVerdict> = {}): LineageVerdict =>
		({ platformIndex: facts.platformIndex, verdict, ...extra, hints: { ...hints, ...extra.hints } });
	if (!needsVerdict(facts)) return result("unchanged");
	const owner = controller.ownerJobId ? { ownerJobId: controller.ownerJobId } : {};
	if (!facts.platformUid || facts.hubUnitNumber === null) {
		return facts.jobOwns && facts.lineage === null ? result("normal") : result("no_identity");
	}
	let lineage = facts.lineage;
	let generation = facts.generation;
	let mint = false;
	if (lineage === null) {
		if (facts.protected) return result("unresolved_handoff", owner);
		if (facts.journalUidMatch) return result("legacy_unclassified");
		if (!facts.hadIdentity && facts.journalHubMatch) return result("legacy_unclassified");
		if (controller.historyMatch) return result("legacy_unclassified");
		if (facts.jobOwns) return result("normal");
		lineage = mintedLineage(context.epoch, facts.hubUnitNumber);
		generation = 0;
		mint = true;
	}
	if (!isLineage(lineage) || !isGeneration(generation)) return result("unverified", { hints: { ...hints, presence: "Local lineage is invalid" } });
	const own = { lineage, generation, ...(mint ? { mint: true as const } : {}) };
	if (controller.duplicateLocal) return result("duplicate_local", own);
	if (controller.inTransit) return result("in_transit", { ...own, ...owner });
	if (facts.protected) return result("unresolved_handoff", { ...own, ...owner });
	if (!entry) {
		if (generation !== 0) return result("unregistered", own);
		return result("normal", facts.journalUidMatch ? own : { ...own, claim: true });
	}
	const holder = { holderInstanceId: entry.instanceId, holderGeneration: entry.generation };
	if (generation > entry.generation) return result("ahead_of_registry", { ...own, ...holder });
	if (entry.instanceId === context.instanceId) {
		return result(generation === entry.generation ? "normal" : "stale_self", { ...own, ...holder });
	}
	if (!presence) return result("unverified", { ...own, ...holder, presenceNeeded: entry.instanceId });
	if (presence.state === "unknown") return result("unverified", { ...own, ...holder, hints: { ...hints, presence: presence.reason } });
	if (presence.state === "present") return result("duplicate", { ...own, ...holder });
	if (context.mode === "save_game" && context.allowAdoption) {
		return result("rollback_other", { ...own, ...holder, adopt: true, adoptGeneration: entry.generation + 1 });
	}
	return result("rollback_other", { ...own, ...holder });
}
