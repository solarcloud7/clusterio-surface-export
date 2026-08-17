// capture-join — the payload fields the export WRITES, joined to the fields the import READS
//
// requires: the vendored Lua 5.2 parser (plugin scripts/vendor/luaparse.cjs), the capture-side
//           sources passed as captureFiles, and the import-side sources passed as restoreFiles
// produces: analyzeJoin({ captureFiles, restoreFiles, handlerCaptures, restoreRuleFields }) ->
//           entity_captures (top-level per-entity payload fields, from entity-scanner's table
//           constructors and from every payload-root write in a capture file), payload_reads (one
//           row per plane+field listing the file:function sites that read it), scoped_roots (the
//           per-function identifiers a `.specific_data` member is read through, beyond the global
//           root names), alias_params (each callee parameter a call binds to a specific_data
//           table), and the two join directions: captured_without_consumer (a field the export
//           writes that no import-side read and no restore rule names) and consumed_without_producer
//           (a field the import reads that no capture-side write produces)
// does not: prove a consumed field is RESTORED (a read is a read: the differ and the fidelity gate
//           decide what landed), count a read of a LIVE entity member as a payload read (a read
//           enters only through a payload root — the discriminator #260's hand audit applied by eye
//           when it kept `mining_target`'s live read and deleted its capture), read the top-level
//           payload plane (`job.export_data.*`, whose consumers are split across Lua and TS, so a
//           Lua-only join over it reports live fields as orphans), count reads under `interfaces/`
//           or `validators/` as consumers, resolve an index whose variable no enclosing
//           `for _, VAR in ipairs({"lit",...})` binds to literals, bind a callee parameter reached
//           through a call whose base is not a resolvable declaration name in the scanned set,
//           or refuse a function containing `goto` (a read needs no reachability, so refusing one
//           would drop real reads)

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const luaparse = require(
	"../../../docker/seed-data/external_plugins/surface_export/scripts/vendor/luaparse.cjs");

export const SPECIFIC_DATA_PLANE = "specific_data";
export const ENTITY_PLANE = "entity";

const SPECIFIC_DATA = "specific_data";
const VALUE = "value";
const MAX_ALIAS_PASSES = 8;

export const GLOBAL_PAYLOAD_ROOTS = ["entity_data"];

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

export function memberPath(node) {
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

function parse(source) {
	return luaparse.parse(source, { luaVersion: "5.2", scope: false, locations: true, comments: false });
}

function isSpecificDataMember(node) {
	return Boolean(node)
		&& node.type === "MemberExpression"
		&& node.indexer === "."
		&& node.identifier.name === SPECIFIC_DATA;
}

function localRoots(statements) {
	const names = new Set();
	const visit = node => {
		if (!node || typeof node !== "object") return;
		if (isSpecificDataMember(node) && node.base.type === "Identifier") names.add(node.base.name);
		for (const child of children(node)) visit(child);
	};
	for (const statement of statements) visit(statement);
	return names;
}

export function declaredFunctions(files) {
	const declarations = new Map();
	for (const { rel, source } of files) {
		const visit = node => {
			if (!node || typeof node !== "object") return;
			if (node.type === "FunctionDeclaration" && node.identifier) {
				const label = memberPath(node.identifier);
				if (label !== null) {
					declarations.set(label, {
						file: rel,
						params: node.parameters.map(p => (p.type === "Identifier" ? p.name : null)),
					});
				}
			}
			for (const child of children(node)) visit(child);
		};
		visit(parse(source));
	}
	return declarations;
}

const childScope = parent => ({ names: new Map(), parent });

function lookup(scope, name) {
	for (let current = scope; current; current = current.parent) {
		if (current.names.has(name)) return current.names.get(name);
	}
	return null;
}

function aliasKind(init, scope) {
	let node = init;
	if (node && node.type === "LogicalExpression" && node.operator === "or") node = node.left;
	if (isSpecificDataMember(node)) return SPECIFIC_DATA_PLANE;
	if (node && node.type === "Identifier" && lookup(scope, node.name) === SPECIFIC_DATA_PLANE) {
		return SPECIFIC_DATA_PLANE;
	}
	return VALUE;
}

function planeOf(base, scope, ctx) {
	if (isSpecificDataMember(base)) return SPECIFIC_DATA_PLANE;
	if (base.type !== "Identifier") return null;
	if (lookup(scope, base.name) === SPECIFIC_DATA_PLANE) return SPECIFIC_DATA_PLANE;
	return ctx.roots.has(base.name) ? ENTITY_PLANE : null;
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

function record(out, plane, field, ctx) {
	const key = `${plane}\0${field}`;
	const row = out.get(key) || { plane, field, sites: new Set() };
	row.sites.add(`${ctx.file}:${ctx.fnLabel}`);
	out.set(key, row);
}

function touch(base, fields, scope, ctx, out) {
	const plane = planeOf(base, scope, ctx);
	if (plane === null) return;
	for (const field of fields) record(out, plane, field, ctx);
}

function indexFields(node, ctx) {
	if (node.index.type === "Identifier") return ctx.loopLiterals.get(node.index.name) || [];
	const literal = stringValue(node.index);
	return literal === null ? [] : [literal];
}

function noteCall(node, scope, ctx) {
	const label = memberPath(node.base);
	const declaration = label === null ? null : ctx.declarations.get(label);
	if (!declaration) return;
	(node.arguments || []).forEach((argument, index) => {
		const isAlias = isSpecificDataMember(argument)
			|| (argument.type === "Identifier" && lookup(scope, argument.name) === SPECIFIC_DATA_PLANE);
		if (isAlias && declaration.params[index]) ctx.aliasParams.add(`${label}#${index}`);
	});
}

function visitExpression(node, scope, ctx, out) {
	if (!node || typeof node !== "object") return;
	if (node.type === "FunctionDeclaration") {
		visitFunction(node, scope, ctx, out);
		return;
	}
	if (node.type === "MemberExpression" && node.indexer === ".") {
		if (ctx.mode === "read") touch(node.base, [node.identifier.name], scope, ctx, out);
		visitExpression(node.base, scope, ctx, out);
		return;
	}
	if (node.type === "IndexExpression") {
		if (ctx.mode === "read") touch(node.base, indexFields(node, ctx), scope, ctx, out);
		visitExpression(node.base, scope, ctx, out);
		visitExpression(node.index, scope, ctx, out);
		return;
	}
	if (CALL_TYPES.has(node.type)) noteCall(node, scope, ctx);
	for (const child of children(node)) visitExpression(child, scope, ctx, out);
}

function visitTarget(target, scope, ctx, out) {
	if (target.type === "MemberExpression" && target.indexer === ".") {
		if (ctx.mode === "write") touch(target.base, [target.identifier.name], scope, ctx, out);
		visitExpression(target.base, scope, ctx, out);
		return;
	}
	if (target.type === "IndexExpression") {
		if (ctx.mode === "write") touch(target.base, indexFields(target, ctx), scope, ctx, out);
		visitExpression(target.base, scope, ctx, out);
		visitExpression(target.index, scope, ctx, out);
	}
}

function visitFunction(node, scope, ctx, out) {
	const label = node.identifier ? memberPath(node.identifier) || "<anonymous>" : ctx.fnLabel;
	const inner = childScope(scope);
	const scoped = localRoots(node.body);
	node.parameters.forEach((parameter, index) => {
		if (parameter.type !== "Identifier") return;
		inner.names.set(parameter.name,
			ctx.aliasParams.has(`${label}#${index}`) ? SPECIFIC_DATA_PLANE : VALUE);
	});
	for (const name of scoped) {
		if (ctx.roots.has(name) || GLOBAL_PAYLOAD_ROOTS.includes(name)) continue;
		ctx.scoped.push({ file: ctx.file, function: label, name });
	}
	visitBody(node.body, inner, {
		...ctx,
		fnLabel: label,
		roots: new Set([...ctx.roots, ...scoped]),
	}, out);
}

function visitStatement(node, scope, ctx, out) {
	switch (node.type) {
	case "LocalStatement":
		for (const init of node.init) visitExpression(init, scope, ctx, out);
		node.variables.forEach((variable, index) => {
			scope.names.set(variable.name, aliasKind(node.init[index], scope));
		});
		return;
	case "AssignmentStatement":
		for (const init of node.init) visitExpression(init, scope, ctx, out);
		for (const target of node.variables) visitTarget(target, scope, ctx, out);
		return;
	case "FunctionDeclaration":
		visitFunction(node, scope, ctx, out);
		return;
	case "IfStatement":
		for (const clause of node.clauses) {
			if (clause.condition) visitExpression(clause.condition, scope, ctx, out);
			visitBlock(clause.body, scope, ctx, out);
		}
		return;
	case "DoStatement":
		visitBlock(node.body, scope, ctx, out);
		return;
	case "WhileStatement":
		visitExpression(node.condition, scope, ctx, out);
		visitBlock(node.body, scope, ctx, out);
		return;
	case "RepeatStatement": {
		const inner = childScope(scope);
		visitBody(node.body, inner, ctx, out);
		visitExpression(node.condition, inner, ctx, out);
		return;
	}
	case "ForNumericStatement": {
		for (const bound of [node.start, node.end, node.step]) visitExpression(bound, scope, ctx, out);
		const inner = childScope(scope);
		inner.names.set(node.variable.name, VALUE);
		visitBody(node.body, inner, ctx, out);
		return;
	}
	case "ForGenericStatement": {
		for (const iterator of node.iterators) visitExpression(iterator, scope, ctx, out);
		const inner = childScope(scope);
		for (const variable of node.variables) inner.names.set(variable.name, VALUE);
		visitBody(node.body, inner, { ...ctx, loopLiterals: ipairsLiterals(node, ctx.loopLiterals) }, out);
		return;
	}
	default:
		for (const child of children(node)) visitExpression(child, scope, ctx, out);
	}
}

function visitBody(statements, scope, ctx, out) {
	for (const statement of statements) visitStatement(statement, scope, ctx, out);
}

function visitBlock(statements, parent, ctx, out) {
	visitBody(statements, childScope(parent), ctx, out);
}

function onePass(files, mode, declarations, aliasParams) {
	const out = new Map();
	const scoped = [];
	for (const { rel, source } of files) {
		visitBlock(parse(source).body, null, {
			file: rel,
			fnLabel: "<chunk>",
			mode,
			roots: new Set(GLOBAL_PAYLOAD_ROOTS),
			loopLiterals: new Map(),
			declarations,
			aliasParams,
			scoped,
		}, out);
	}
	return { touches: out, scoped };
}

export function scanPayloadTouches(files, mode, declarations) {
	const aliasParams = new Set();
	let pass = null;
	for (let attempt = 0; attempt < MAX_ALIAS_PASSES; attempt++) {
		const before = aliasParams.size;
		pass = onePass(files, mode, declarations, aliasParams);
		if (aliasParams.size === before) break;
	}
	const seen = new Set();
	const scoped = pass.scoped.filter(row => {
		const key = `${row.file}:${row.function}:${row.name}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return {
		touches: [...pass.touches.values()]
			.map(row => ({ plane: row.plane, field: row.field, sites: [...row.sites].sort() }))
			.sort((a, b) => a.plane.localeCompare(b.plane) || a.field.localeCompare(b.field)),
		scoped_roots: scoped.sort((a, b) => a.file.localeCompare(b.file)
			|| a.function.localeCompare(b.function) || a.name.localeCompare(b.name)),
		alias_params: [...aliasParams].sort(),
	};
}

function tableKeys(table) {
	const keys = [];
	for (const field of table.fields) {
		if (field.type === "TableKeyString") keys.push(field.key.name);
		else if (field.type === "TableKey") {
			const literal = stringValue(field.key);
			if (literal !== null) keys.push(literal);
		}
	}
	return keys;
}

export function extractConstructorCaptures(rel, source) {
	const rows = new Map();
	const add = (keys, label) => {
		for (const key of keys) {
			const sites = rows.get(key) || new Set();
			sites.add(`${rel}:${label}`);
			rows.set(key, sites);
		}
	};
	const visit = (node, label) => {
		if (!node || typeof node !== "object") return;
		const own = node.type === "FunctionDeclaration" && node.identifier
			? memberPath(node.identifier) || label
			: label;
		if (node.type === "LocalStatement") {
			for (const init of node.init) {
				if (init && init.type === "TableConstructorExpression") add(tableKeys(init), own);
			}
		}
		if (CALL_TYPES.has(node.type) && memberPath(node.base) === "table.insert") {
			for (const argument of node.arguments || []) {
				if (argument.type === "TableConstructorExpression") add(tableKeys(argument), own);
			}
		}
		for (const child of children(node)) visit(child, own);
	};
	visit(parse(source), "<chunk>");
	return [...rows.entries()]
		.map(([field, sites]) => ({ field, sites: [...sites].sort() }))
		.sort((a, b) => a.field.localeCompare(b.field));
}

export const joinKey = row => `${row.plane}:${row.site}:${row.field}`;

function merge(target, field, sites) {
	const existing = target.get(field) || new Set();
	for (const site of sites) existing.add(site);
	target.set(field, existing);
}

export function analyzeJoin({ captureFiles, restoreFiles, handlerCaptures, restoreRuleFields }) {
	const declarations = declaredFunctions([...captureFiles, ...restoreFiles]);
	const capture = scanPayloadTouches(captureFiles, "write", declarations);
	const restore = scanPayloadTouches(restoreFiles, "read", declarations);
	const scannerFile = captureFiles.find(file => file.rel.endsWith("entity-scanner.lua"));
	if (!scannerFile) throw new Error("captureFiles carries no entity-scanner.lua — the entity plane "
		+ "would derive zero constructor fields and report every read of one as unproduced");
	const constructorCaptures = extractConstructorCaptures(scannerFile.rel, scannerFile.source);

	const produced = { [SPECIFIC_DATA_PLANE]: new Map(), [ENTITY_PLANE]: new Map() };
	for (const row of handlerCaptures) {
		for (const field of row.fields) merge(produced[SPECIFIC_DATA_PLANE], field, [row.category]);
	}
	for (const row of constructorCaptures) merge(produced[ENTITY_PLANE], row.field, row.sites);
	for (const row of capture.touches) merge(produced[row.plane], row.field, row.sites);

	const consumed = {
		[SPECIFIC_DATA_PLANE]: new Set(restoreRuleFields),
		[ENTITY_PLANE]: new Set(),
	};
	for (const row of restore.touches) consumed[row.plane].add(row.field);

	const capturedWithoutConsumer = [];
	for (const plane of [ENTITY_PLANE, SPECIFIC_DATA_PLANE]) {
		for (const [field, sites] of produced[plane]) {
			if (consumed[plane].has(field)) continue;
			for (const site of sites) capturedWithoutConsumer.push({ plane, site, field });
		}
	}
	const consumedWithoutProducer = [];
	for (const row of restore.touches) {
		if (produced[row.plane].has(row.field)) continue;
		for (const site of row.sites) consumedWithoutProducer.push({ plane: row.plane, site, field: row.field });
	}
	const order = (a, b) => a.plane.localeCompare(b.plane) || a.field.localeCompare(b.field)
		|| a.site.localeCompare(b.site);

	return {
		global_roots: [...GLOBAL_PAYLOAD_ROOTS],
		scoped_roots: [...capture.scoped_roots, ...restore.scoped_roots],
		alias_params: [...new Set([...capture.alias_params, ...restore.alias_params])].sort(),
		entity_captures: [...produced[ENTITY_PLANE].entries()]
			.map(([field, sites]) => ({ field, sites: [...sites].sort() }))
			.sort((a, b) => a.field.localeCompare(b.field)),
		payload_reads: restore.touches,
		captured_without_consumer: capturedWithoutConsumer.sort(order),
		consumed_without_producer: consumedWithoutProducer.sort(order),
		counts: {
			scoped_roots: capture.scoped_roots.length + restore.scoped_roots.length,
			alias_params: new Set([...capture.alias_params, ...restore.alias_params]).size,
			entity_captures: produced[ENTITY_PLANE].size,
			specific_data_captures: produced[SPECIFIC_DATA_PLANE].size,
			entity_reads: restore.touches.filter(row => row.plane === ENTITY_PLANE).length,
			specific_data_reads: restore.touches.filter(row => row.plane === SPECIFIC_DATA_PLANE).length,
			captured_without_consumer: capturedWithoutConsumer.length,
			consumed_without_producer: consumedWithoutProducer.length,
		},
	};
}
