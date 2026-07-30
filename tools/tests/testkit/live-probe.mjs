// testkit / probe — read one property off one live entity, by position, in one command.
//
// This exact operation was hand-written as an inline /sc snippet FIVE times in one working day
// (pad census, anchor resolution ×2, property-path walk, multi-match count) before becoming a
// command. Per the one-truth ruling: a repeated manual op becomes a testkit command, never a fresh
// snippet — the lazy path and the right path must be the same path.
//
// Read-only. Same property-walk rules as the lifecycle engine's `property` read (identifier-only
// segments, depth cap, indexing only, throw≠nil distinguished) so what probe reports is what a
// fixture's declared verify would see.
import { lua } from "../../../tests/lab-gallery/batch-lifecycle.mjs";
import { resolvePlatformIndex } from "./export-inspect.mjs";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const PROTO = /^[A-Za-z0-9_-]+$/;
const MAX_DEPTH = 8;

/**
 * Parse "entity@x,y:dotted.path" (the same target syntax `inspect --field` uses).
 * Exported for tests: these checks are a trust boundary — the values are spliced into a Lua
 * string, so the charsets are what make injection unrepresentable, not a guard someone remembers.
 */
export function parseTarget(spec) {
	const m = String(spec).match(/^([^@]+)@(-?[\d.]+),(-?[\d.]+):(.+)$/);
	if (!m) throw new Error('target must look like  heat-pipe@43,-13:temperature');
	const [, entity, xs, ys, path] = m;
	if (!PROTO.test(entity)) throw new Error(`entity name ${JSON.stringify(entity)} has illegal characters`);
	if (!IDENT.test(path)) throw new Error(`path ${JSON.stringify(path)} must be a dotted identifier chain`);
	if (path.split(".").length > MAX_DEPTH) throw new Error(`path deeper than ${MAX_DEPTH}`);
	const x = Number(xs), y = Number(ys);
	if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x,y must be finite numbers");
	return { entity, x, y, path };
}

/**
 * Probe the live cluster: find the single `entity` within ±0.6 of (x,y) on `platform` and walk
 * `path`. Returns { value } or throws with the same fail-loud distinctions the engine makes
 * (no match / ambiguous / threw / nil / non-scalar) — a probe that guesses is a probe that lies.
 */
export function probeProperty({ platform, target, host = 1, force = "player" }) {
	const { entity, x, y, path } = parseTarget(target);
	const index = resolvePlatformIndex(host, platform, force);
	const result = lua(host, `
		local surface
		for _, p in pairs(game.forces['${force}'].platforms or {}) do
			if p.index == ${index} and p.surface and p.surface.valid then surface = p.surface end
		end
		if not surface then return {success=false, error='platform index ${index} has no valid surface'} end
		local found = surface.find_entities_filtered{name='${entity}',
			area={{${x - 0.6},${y - 0.6}},{${x + 0.6},${y + 0.6}}}}
		if #found == 0 then return {success=false, error='no ${entity} within 0.6 of (${x},${y})'} end
		if #found > 1 then return {success=false, error=#found .. ' ${entity} entities match — ambiguous, tighten the position'} end
		local cursor = found[1]
		for key in string.gmatch('${path}', '[^%.]+') do
			local ok, v = pcall(function() return cursor[key] end)
			if not ok then return {success=false, error='THREW at ' .. key .. ': ' .. tostring(v)} end
			if v == nil then return {success=false, error='NIL at ' .. key .. ' — unset property or wrong path'} end
			cursor = v
		end
		local t = type(cursor)
		if t ~= 'number' and t ~= 'string' and t ~= 'boolean' then
			return {success=false, error='path ends on a ' .. t .. ' — extend it to a scalar'}
		end
		return {success=true, value=cursor, at={x=found[1].position.x, y=found[1].position.y}}`);
	if (!result.success) throw new Error(result.error);
	return result;
}
