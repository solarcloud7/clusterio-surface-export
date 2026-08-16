// differ — two walker snapshots in, WE-SET verdicts and the deduplicated audit report out
//
// requires: two snapshots from the SAME walker (matching fingerprints), derived-exclusions.json,
//           we-set.json
// produces: diff(reference, subject) -> the flat JSON WP5's viewer consumes: per (type, field)
//           WE-SET verdicts with every failing entity enumerated, and one audit row per
//           (type, field) carrying a sample from each arm and the cell's classification
// does not: contact the cluster, read module or API source directly, decide which arm is right, or
//           compare two snapshots whose fingerprints disagree (that is a refusal, not a diff)

import { classify, entryFor } from "./exclusions.mjs";
import { loadWeSet } from "./we-set.mjs";
import { parseSnapshot } from "./snapshot-model.mjs";

export const DIFF_SCHEMA = "one-of-each/diff@1";
export const DEFAULT_BAND_TOLERANCE_TICKS = 60_000;

export const OUTCOMES = ["agree", "differ", "band-agree", "band-differ", "excluded", "both-nil",
	"both-threw", "threw-vs-nil", "threw-vs-present", "unset-difference"];

export function normalizeThrow(text) {
	return String(text)
		.replace(/^[^\s:]*:\d+:\s*/, "")
		.replace(/\b\d{4,}\b/g, "<n>")
		.replace(/\s+/g, " ")
		.trim();
}

function bandDuration(cell, tick) {
	const value = Number(cell.value);
	if (!Number.isFinite(value)) return null;
	return tick - value;
}

export function compareCell(reference, subject, options = {}) {
	const { classification = null, tick = {}, toleranceTicks = DEFAULT_BAND_TOLERANCE_TICKS } = options;
	const ref = reference || { state: "NIL" };
	const sub = subject || { state: "NIL" };

	if (ref.state === "NIL" && sub.state === "NIL") return { outcome: "both-nil", agreement: "agree" };
	if (ref.state === "THREW" && sub.state === "THREW") {
		const same = normalizeThrow(ref.throw) === normalizeThrow(sub.throw);
		return { outcome: "both-threw", agreement: same ? "agree" : "differ" };
	}
	if (ref.state === "THREW" || sub.state === "THREW") {
		const other = ref.state === "THREW" ? sub : ref;
		return {
			outcome: other.state === "NIL" ? "threw-vs-nil" : "threw-vs-present",
			agreement: "differ",
		};
	}
	if (ref.state === "NIL" || sub.state === "NIL") return { outcome: "unset-difference", agreement: "differ" };

	if (classification === "exclude") return { outcome: "excluded", agreement: "agree" };

	if (classification === "band") {
		const refDuration = bandDuration(ref, tick.reference);
		const subDuration = bandDuration(sub, tick.subject);
		if (refDuration === null || subDuration === null) {
			return { outcome: "band-differ", agreement: "differ", detail: "a banded cell did not read as a number" };
		}
		const delta = Math.abs(refDuration - subDuration);
		return delta <= toleranceTicks
			? { outcome: "band-agree", agreement: "agree", delta }
			: { outcome: "band-differ", agreement: "differ", delta };
	}

	if (ref.hashed !== sub.hashed) {
		return { outcome: "differ", agreement: "differ", detail: "one arm hashed and the other did not" };
	}
	return ref.value === sub.value
		? { outcome: "agree", agreement: "agree" }
		: { outcome: "differ", agreement: "differ" };
}

function pairEntities(reference, subject) {
	const refByKey = new Map(reference.entities.map(entity => [entity.key, entity]));
	const subByKey = new Map(subject.entities.map(entity => [entity.key, entity]));
	const paired = [];
	for (const [key, entity] of refByKey) {
		const match = subByKey.get(key);
		if (match) paired.push({ key, reference: entity, subject: match });
	}
	return {
		paired,
		onlyInReference: [...refByKey.keys()].filter(key => !subByKey.has(key)).sort(),
		onlyInSubject: [...subByKey.keys()].filter(key => !refByKey.has(key)).sort(),
	};
}

function weSetApplies(row, entityType) {
	return row.types === null || row.types.includes(entityType);
}

export function diff(referenceRaw, subjectRaw, options = {}) {
	const reference = parseSnapshot(referenceRaw);
	const subject = parseSnapshot(subjectRaw);
	if (reference.fingerprint !== subject.fingerprint) {
		throw new Error(`refusing to diff: reference walker ${reference.fingerprint} but subject walker `
			+ `${subject.fingerprint} — two different walkers produce two different questions`);
	}
	if (reference.class_name !== subject.class_name) {
		throw new Error(`refusing to diff: ${reference.class_name} against ${subject.class_name}`);
	}

	const toleranceTicks = options.bandToleranceTicks ?? DEFAULT_BAND_TOLERANCE_TICKS;
	const className = reference.class_name;
	const tick = { reference: reference.tick, subject: subject.tick };
	const walked = new Set(reference.attributes);
	const weSet = options.weSet || loadWeSet();

	const { paired, onlyInReference, onlyInSubject } = pairEntities(reference, subject);

	const verdicts = new Map();
	const unwalked = new Set();
	const audit = new Map();

	for (const row of weSet.we_set) if (!walked.has(row.property)) unwalked.add(row.property);

	for (const { key, reference: refEntity, subject: subEntity } of paired) {
		const entityType = refEntity.etype;

		for (const attribute of reference.attributes) {
			const classification = classify(className, attribute);
			const result = compareCell(refEntity.cells?.[attribute], subEntity.cells?.[attribute],
				{ classification, tick, toleranceTicks });
			const auditKey = `${entityType}\0${attribute}`;
			const existing = audit.get(auditKey);
			if (existing) {
				existing.instances += 1;
				existing.outcomes[result.outcome] = (existing.outcomes[result.outcome] || 0) + 1;
				if (existing.agreement === "agree" && result.agreement === "differ") {
					existing.agreement = "differ";
					existing.outcome = result.outcome;
					existing.sample = sampleOf(key, refEntity, subEntity, attribute);
				}
			} else {
				audit.set(auditKey, {
					type: entityType,
					field: attribute,
					classification,
					reason: entryFor(className, attribute)?.reason ?? null,
					outcome: result.outcome,
					agreement: result.agreement,
					instances: 1,
					outcomes: { [result.outcome]: 1 },
					sample: sampleOf(key, refEntity, subEntity, attribute),
				});
			}
		}

		for (const row of weSet.we_set) {
			if (!weSetApplies(row, entityType)) continue;
			if (!walked.has(row.property)) continue;
			const verdictKey = `${entityType}\0${row.property}`;
			const verdict = verdicts.get(verdictKey) || {
				type: entityType, field: row.property, origins: row.origins,
				classification: classify(className, row.property),
				checked: 0, failures: [],
			};
			const result = compareCell(refEntity.cells?.[row.property], subEntity.cells?.[row.property],
				{ classification: verdict.classification, tick, toleranceTicks });
			verdict.checked += 1;
			if (result.agreement === "differ") {
				verdict.failures.push({
					entity: key,
					outcome: result.outcome,
					...sampleOf(key, refEntity, subEntity, row.property),
				});
			}
			verdicts.set(verdictKey, verdict);
		}
	}

	const verdictRows = [...verdicts.values()]
		.map(verdict => ({
			...verdict,
			status: verdict.checked === 0 ? "UNEXERCISED" : (verdict.failures.length ? "FAIL" : "PASS"),
		}))
		.sort((a, b) => a.type.localeCompare(b.type) || a.field.localeCompare(b.field));

	const auditRows = [...audit.values()]
		.sort((a, b) => a.type.localeCompare(b.type) || a.field.localeCompare(b.field));

	return {
		schema: DIFF_SCHEMA,
		class_name: className,
		arms: { reference: reference.arm, subject: subject.arm },
		fingerprint: reference.fingerprint,
		tick,
		band_tolerance_ticks: toleranceTicks,
		entities: {
			reference: reference.entities.length,
			subject: subject.entities.length,
			paired: paired.length,
			only_in_reference: onlyInReference,
			only_in_subject: onlyInSubject,
		},
		verdicts: verdictRows,
		unwalked_we_set: [...unwalked].sort(),
		audit: auditRows,
		summary: {
			verdicts_total: verdictRows.length,
			verdicts_failed: verdictRows.filter(row => row.status === "FAIL").length,
			verdicts_unexercised: verdictRows.filter(row => row.status === "UNEXERCISED").length,
			audit_rows: auditRows.length,
			audit_differing: auditRows.filter(row => row.agreement === "differ").length,
			entities_unpaired: onlyInReference.length + onlyInSubject.length,
		},
	};
}

function sampleOf(key, refEntity, subEntity, attribute) {
	return {
		entity: key,
		reference: refEntity.cells?.[attribute] ?? null,
		subject: subEntity.cells?.[attribute] ?? null,
	};
}
