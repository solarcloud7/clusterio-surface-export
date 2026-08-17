// reachability — the conditions a direct entity write inherits from the returns above it
//
// requires: the vendored Lua 5.2 parser (plugin scripts/vendor/luaparse.cjs) and the same Lua sources
//           derive-we-set.mjs scans for direct entity writes
// produces: analyzeSources() -> { considered, evaluated, evaluated_sites, skipped, return_dominated }
//           — the direct entity write sites the walk examined, the subset it could reason about at
//           all (listed, not just counted, so the arm's real surface is auditable), the function
//           scopes it REFUSED by name, and one row per return-dominated write: a write that reads a
//           TOP-LEVEL payload field, names no entity type in its own guard chain, and sits below an
//           `if <cond> then ... return end` in a block enclosing it in the same function, carrying
//           the type literals those returns exclude and the payload fields they require present
// does not: decide that a flagged write is a defect (whether an excluded type can carry the field is a
//           payload question this arm never asks), evaluate a write whose guard chain mentions the
//           receiver's `.type` (its reachability then depends on the handler gating that produces the
//           payload, which is not modelled), evaluate a write keyed only on a local derived from the
//           payload (a `specific_data` field's presence already implies a handler ran), follow `goto`
//           (a function containing one is refused BY NAME, never analyzed quietly — and a CLOSURE
//           containing one is recorded under its enclosing function's name, so two refused closures
//           in one function report the same name twice), read a `return`
//           inside a closure as a function exit, walk into a closure that is not a direct argument of
//           safe_call/pcall/xpcall, read a gate from any block that does not ENCLOSE the write, read
//           any branch shape but the single-clause `if C then ... return end` as a gate (an elseif
//           chain whose arms all return, and an if/else, both go unread), read a type exclusion from
//           anything but the RECEIVER's `.type` (a gate keyed on the payload's own type or name field
//           is opaque to it), pair a multiple assignment whose target and value counts differ, or
//           treat error() as an exit

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const luaparse = require(
	"../../../docker/seed-data/external_plugins/surface_export/scripts/vendor/luaparse.cjs");

export const IMMEDIATE_INVOKE = ["safe_call", "pcall", "xpcall"];

const IMMEDIATE = new Set(IMMEDIATE_INVOKE);
const POSITION_KEYS = new Set(["loc", "range"]);
const CALL_TYPES = new Set(["CallExpression", "StringCallExpression", "TableCallExpression"]);

function* children(node) {
	for (const [key, value] of Object.entries(node)) {
		if (POSITION_KEYS.has(key)) continue;
		if (Array.isArray(value)) {
			for (const item of value) if (item && typeof item === "object" && item.type) yield item;
		} else if (value && typeof value === "object" && value.type) {
			yield value;
		}
	}
}

function containsGoto(nodes) {
	for (const node of nodes) {
		if (node.type === "GotoStatement" || node.type === "LabelStatement") return true;
		if (node.type === "FunctionDeclaration") continue;
		if (containsGoto([...children(node)])) return true;
	}
	return false;
}

function memberPath(node) {
	if (!node) return null;
	if (node.type === "Identifier") return node.name;
	if (node.type === "MemberExpression" && node.indexer === ".") {
		const base = memberPath(node.base);
		return base === null ? null : `${base}.${node.identifier.name}`;
	}
	return null;
}

function stringValue(node) {
	if (!node || node.type !== "StringLiteral") return null;
	if (typeof node.value === "string") return node.value;
	const raw = node.raw || "";
	return raw[0] === "\"" || raw[0] === "'" ? raw.slice(1, -1) : null;
}

export function isEntityReceiver(receiver) {
	return receiver !== null && receiver.split(".").pop() === "entity";
}

function mentionsMember(node, path) {
	if (!node || typeof node !== "object") return false;
	if (node.type === "MemberExpression" && memberPath(node) === path) return true;
	for (const child of children(node)) if (mentionsMember(child, path)) return true;
	return false;
}

export function typeEqualityLiterals(condition, typePath) {
	if (!condition) return null;
	if (condition.type === "LogicalExpression" && condition.operator === "or") {
		const left = typeEqualityLiterals(condition.left, typePath);
		const right = typeEqualityLiterals(condition.right, typePath);
		return left && right ? [...left, ...right] : null;
	}
	if (condition.type === "BinaryExpression" && condition.operator === "==") {
		for (const [side, other] of [[condition.left, condition.right], [condition.right, condition.left]]) {
			if (memberPath(side) !== typePath) continue;
			const literal = stringValue(other);
			if (literal !== null) return [literal];
		}
	}
	return null;
}

export function absentFieldGate(condition, isPayloadRoot) {
	let member = null;
	if (condition.type === "UnaryExpression" && condition.operator === "not") {
		member = condition.argument;
	} else if (condition.type === "BinaryExpression" && condition.operator === "==") {
		if (condition.right && condition.right.type === "NilLiteral") member = condition.left;
		else if (condition.left && condition.left.type === "NilLiteral") member = condition.right;
	}
	if (!member || member.type !== "MemberExpression" || member.indexer !== ".") return null;
	if (member.base.type !== "Identifier" || !isPayloadRoot(member.base.name)) return null;
	return member.identifier.name;
}

function payloadReads(node, isPayloadRoot, found = new Set()) {
	if (!node || typeof node !== "object") return found;
	if (node.type === "MemberExpression" && node.indexer === "."
		&& node.base.type === "Identifier" && isPayloadRoot(node.base.name)) {
		found.add(node.identifier.name);
	}
	for (const child of children(node)) payloadReads(child, isPayloadRoot, found);
	return found;
}

function alwaysReturns(body) {
	return body.some(statement => statement.type === "ReturnStatement");
}

function isExitGate(statement) {
	return statement.type === "IfStatement"
		&& statement.clauses.length === 1
		&& statement.clauses[0].type === "IfClause"
		&& alwaysReturns(statement.clauses[0].body);
}

function ipairsLiterals(statement, inherited) {
	if (statement.iterators.length !== 1 || statement.variables.length < 2) return inherited;
	const call = statement.iterators[0];
	if (!CALL_TYPES.has(call.type) || memberPath(call.base) !== "ipairs") return inherited;
	const table = (call.arguments || [])[0];
	if (!table || table.type !== "TableConstructorExpression") return inherited;
	const names = [];
	for (const field of table.fields) {
		const literal = field.type === "TableValue" ? stringValue(field.value) : null;
		if (literal === null) return inherited;
		names.push(literal);
	}
	if (names.length === 0) return inherited;
	return new Map([...inherited, [statement.variables[1].name, names]]);
}

function directTargets(target, loopLiterals) {
	if (target.type === "MemberExpression" && target.indexer === ".") {
		const receiver = memberPath(target.base);
		return isEntityReceiver(receiver) ? [{ receiver, property: target.identifier.name }] : [];
	}
	if (target.type === "IndexExpression") {
		const receiver = memberPath(target.base);
		if (!isEntityReceiver(receiver) || target.index.type !== "Identifier") return [];
		return (loopLiterals.get(target.index.name) || []).map(property => ({ receiver, property }));
	}
	return [];
}

function evaluateWrite({ receiver, property, line, value, ctx, out }) {
	const root = receiver.split(".")[0];
	const typePath = `${receiver}.type`;
	const isPayloadRoot = name => ctx.params.has(name) && name !== root;

	const fields = payloadReads(value, isPayloadRoot);
	for (const guard of ctx.guards) payloadReads(guard, isPayloadRoot, fields);
	if (fields.size === 0) return;
	if (ctx.guards.some(guard => mentionsMember(guard, typePath))) return;
	out.evaluated_sites.push({ file: ctx.file, line, property, gates: ctx.gates.length });

	const excluded = new Set();
	const required = new Set();
	for (const gate of ctx.gates) {
		const literals = typeEqualityLiterals(gate, typePath);
		if (literals) {
			for (const literal of literals) excluded.add(literal);
			continue;
		}
		const absent = absentFieldGate(gate, isPayloadRoot);
		if (absent !== null && !fields.has(absent)) required.add(absent);
	}
	if (excluded.size === 0 && required.size === 0) return;

	out.return_dominated.push({
		file: ctx.file,
		function: ctx.fnLabel,
		line,
		property,
		payload_fields: [...fields].sort(),
		excluded_types: [...excluded].sort(),
		required_fields: [...required].sort(),
	});
}

function visitAssignment(node, ctx, out) {
	const paired = node.variables.length === node.init.length;
	node.variables.forEach((target, index) => {
		for (const { receiver, property } of directTargets(target, ctx.loopLiterals)) {
			out.considered++;
			evaluateWrite({
				receiver,
				property,
				line: target.loc.start.line,
				value: paired ? node.init[index] : null,
				ctx,
				out,
			});
		}
	});
}

function enterFunction(node, ctx, out, transparent) {
	const label = node.identifier ? memberPath(node.identifier) || "<anonymous>" : ctx.fnLabel;
	if (containsGoto(node.body)) {
		out.skipped.push({ file: ctx.file, function: label, line: node.loc.start.line });
		return;
	}
	const params = new Set(ctx.params);
	for (const parameter of node.parameters) if (parameter.type === "Identifier") params.add(parameter.name);
	visitBlock(node.body, {
		...ctx,
		fnLabel: label,
		params,
		gates: transparent ? ctx.gates : [],
		guards: transparent ? ctx.guards : [],
		loopLiterals: transparent ? ctx.loopLiterals : new Map(),
	}, out);
}

function visitExpression(node, ctx, out) {
	if (!node || typeof node !== "object") return;
	if (node.type === "FunctionDeclaration") {
		enterFunction(node, ctx, out, false);
		return;
	}
	if (CALL_TYPES.has(node.type)) {
		visitExpression(node.base, ctx, out);
		const transparent = IMMEDIATE.has(memberPath(node.base)?.split(".").pop());
		const args = node.arguments || (node.argument ? [node.argument] : []);
		for (const argument of args) {
			if (argument && argument.type === "FunctionDeclaration" && argument.identifier === null) {
				enterFunction(argument, ctx, out, transparent);
			} else {
				visitExpression(argument, ctx, out);
			}
		}
		return;
	}
	for (const child of children(node)) visitExpression(child, ctx, out);
}

function visitStatement(node, ctx, out) {
	switch (node.type) {
	case "IfStatement": {
		const conditions = node.clauses.map(clause => clause.condition).filter(Boolean);
		for (const clause of node.clauses) {
			if (clause.condition) visitExpression(clause.condition, ctx, out);
			visitBlock(clause.body, { ...ctx, guards: [...ctx.guards, ...conditions] }, out);
		}
		return;
	}
	case "DoStatement":
		visitBlock(node.body, ctx, out);
		return;
	case "WhileStatement":
		visitExpression(node.condition, ctx, out);
		visitBlock(node.body, ctx, out);
		return;
	case "RepeatStatement":
		visitBlock(node.body, ctx, out);
		visitExpression(node.condition, ctx, out);
		return;
	case "ForNumericStatement":
		for (const bound of [node.start, node.end, node.step]) visitExpression(bound, ctx, out);
		visitBlock(node.body, ctx, out);
		return;
	case "ForGenericStatement":
		for (const iterator of node.iterators) visitExpression(iterator, ctx, out);
		visitBlock(node.body, { ...ctx, loopLiterals: ipairsLiterals(node, ctx.loopLiterals) }, out);
		return;
	case "FunctionDeclaration":
		enterFunction(node, ctx, out, false);
		return;
	case "AssignmentStatement":
		visitAssignment(node, ctx, out);
		for (const expression of [...node.variables, ...node.init]) visitExpression(expression, ctx, out);
		return;
	default:
		for (const child of children(node)) visitExpression(child, ctx, out);
	}
}

function visitBlock(statements, ctx, out) {
	let gates = ctx.gates;
	for (const statement of statements) {
		visitStatement(statement, { ...ctx, gates }, out);
		if (isExitGate(statement)) gates = [...gates, statement.clauses[0].condition];
	}
}

export function analyzeSource(file, source) {
	const ast = luaparse.parse(source, { luaVersion: "5.2", scope: false, locations: true, comments: false });
	const out = { considered: 0, evaluated_sites: [], skipped: [], return_dominated: [] };
	if (containsGoto(ast.body)) {
		out.skipped.push({ file, function: "<chunk>", line: 1 });
	} else {
		visitBlock(ast.body, {
			file,
			fnLabel: "<chunk>",
			params: new Set(),
			gates: [],
			guards: [],
			loopLiterals: new Map(),
		}, out);
	}
	return { ...out, evaluated: out.evaluated_sites.length };
}

export function analyzeSources(files) {
	const merged = { considered: 0, evaluated_sites: [], skipped: [], return_dominated: [] };
	for (const { rel, source } of files) {
		const one = analyzeSource(rel, source);
		merged.considered += one.considered;
		merged.evaluated_sites.push(...one.evaluated_sites);
		merged.skipped.push(...one.skipped);
		merged.return_dominated.push(...one.return_dominated);
	}
	const order = (a, b) => a.file.localeCompare(b.file) || a.line - b.line;
	const byProperty = (a, b) => order(a, b) || a.property.localeCompare(b.property);
	merged.skipped.sort((a, b) => order(a, b) || a.function.localeCompare(b.function));
	merged.evaluated_sites.sort(byProperty);
	merged.return_dominated.sort(byProperty);
	return { ...merged, evaluated: merged.evaluated_sites.length };
}
