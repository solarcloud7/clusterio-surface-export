// coverage-ui — browser triage for the coverage checklist: click dispositions, one Save writes the ledger
//
// requires: the same inputs as coverage.mjs offline mode; a browser on this machine; network to
//           lua-api.factorio.com ONCE per pin for the full attribute docs (cached in the OS temp
//           dir; the page works without them, minus the info panels)
// produces: a loopback HTTP server (127.0.0.1 only) serving the checklist as an interactive page —
//           each row carries an (i) panel with the FULL upstream description and read/write type;
//           Save POSTs the full decision set, which is validated by the SAME rules as the CLI
//           (unknown attribute, bad disposition, empty reason, born-stale referenced attribute)
//           and then written to coverage-triage.json
// does not: bind beyond loopback, serve anything but the checklist, touch the cluster, commit the
//           full docs anywhere (the vendored index keeps first sentences only), or write the
//           ledger when any decision fails validation — a failed save writes nothing and reports
//           every problem

import http from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DEFAULT_CLASSES, DISPOSITIONS, allRows, coverageOffline,
	moduleIdentifiers, readTriageFile, validateTriageEntries, writeTriageFile,
} from "./coverage.mjs";

function formatType(t) {
	if (t == null) return null;
	if (typeof t === "string") return t;
	switch (t.complex_type) {
		case "array": return `array[${formatType(t.value)}]`;
		case "dictionary": return `dictionary[${formatType(t.key)} → ${formatType(t.value)}]`;
		case "union": return t.options.map(formatType).join(" | ");
		case "literal": return JSON.stringify(t.value);
		case "type": return formatType(t.value);
		case "LuaLazyLoadedValue": return `LuaLazyLoadedValue[${formatType(t.value)}]`;
		case "table": case "tuple": return t.complex_type;
		default: return t.complex_type || "?";
	}
}

function plainText(description) {
	return String(description || "")
		.replace(/\[([^\]]+)\]\((?:runtime|prototype):[^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

async function loadRichDocs(pin) {
	const cachePath = path.join(os.tmpdir(), `factorio-runtime-api-${pin}.json`);
	let api = null;
	let source = null;
	if (existsSync(cachePath)) {
		try {
			api = JSON.parse(readFileSync(cachePath, "utf8"));
			source = "cache";
		} catch (error) {
			console.error(`coverage ui: cache at ${cachePath} unreadable (${error.message}) — refetching`);
		}
	}
	if (!api) {
		try {
			const response = await fetch(`https://lua-api.factorio.com/${pin}/runtime-api.json`);
			if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
			const body = await response.text();
			api = JSON.parse(body);
			writeFileSync(cachePath, body);
			source = "fetched";
		} catch (error) {
			console.error(`coverage ui: full docs unavailable (${error.message}) — info panels will fall back`);
			return { source: "unavailable", byKey: new Map() };
		}
	}
	if (api.application_version !== pin) {
		console.error(`coverage ui: cached/fetched docs are for ${api.application_version}, not ${pin} — ignoring`);
		return { source: "unavailable", byKey: new Map() };
	}
	const byKey = new Map();
	for (const cls of api.classes) {
		for (const attribute of cls.attributes) {
			byKey.set(`${cls.name}.${attribute.name}`, {
				text: plainText(attribute.description),
				readType: formatType(attribute.read_type),
				writeType: formatType(attribute.write_type),
			});
		}
	}
	return { source, byKey };
}

function pageModel(classes, richDocs) {
	const report = coverageOffline({ classes });
	const enrich = row => {
		const rich = richDocs.byKey.get(`${row.definingClass}.${row.attribute}`);
		return {
			...row,
			info: rich ? {
				text: rich.text || "(upstream carries no description)",
				type: [
					rich.readType ? `Read: ${rich.readType}` : null,
					rich.writeType ? `Write: ${rich.writeType}` : null,
				].filter(Boolean).join("   "),
				definedOn: row.definingClass,
			} : null,
		};
	};
	return {
		pin: report.pin,
		classes: report.classes,
		dispositions: DISPOSITIONS,
		docsSource: richDocs.source,
		groups: report.byClass.map(cls => ({
			className: cls.className,
			writable: cls.writable,
			sections: [
				...(cls.universal.length
					? [{ title: "Universal (no subclass restriction)", rows: cls.universal.map(enrich) }] : []),
				...cls.subclassSections.map(s => ({ title: s.subclass, rows: s.rows.map(enrich) })),
			],
		})),
	};
}

function renderPage(model) {
	const data = JSON.stringify(model).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Property coverage triage — Factorio ${model.pin}</title>
<style>
	body { font: 14px/1.5 system-ui, sans-serif; margin: 0; background: #16181d; color: #d8dbe2; }
	a { color: #7ab7ff; }
	code { background: #23262e; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
	#bar { position: sticky; top: 0; background: #1d2026; border-bottom: 1px solid #30343d;
		padding: 10px 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; z-index: 5; }
	#bar input[type=text] { background: #23262e; color: inherit; border: 1px solid #3a3f4a;
		border-radius: 6px; padding: 6px 10px; width: 260px; }
	#counts span { margin-right: 10px; }
	button { background: #2b5cab; color: #fff; border: 0; border-radius: 6px; padding: 7px 16px;
		cursor: pointer; font-size: 14px; }
	button:disabled { background: #3a3f4a; cursor: default; }
	#banner { padding: 8px 16px; display: none; white-space: pre-wrap; }
	#banner.ok { display: block; background: #1d3323; color: #9fdcae; }
	#banner.bad { display: block; background: #3a2126; color: #f0a9b1; }
	main { padding: 8px 16px 60px; max-width: 1100px; }
	h2 { margin: 26px 0 4px; } h3 { margin: 18px 0 6px; color: #aeb4c0; }
	.row { border: 1px solid #2a2e37; border-radius: 8px; padding: 8px 12px; margin: 6px 0;
		background: #1a1d23; }
	.row.decided-track { border-left: 4px solid #4f9ee8; }
	.row.decided-derived { border-left: 4px solid #b98add; }
	.row.decided-ignore { border-left: 4px solid #6e7686; opacity: .75; }
	.row .doc { color: #aeb4c0; }
	.row .warn { color: #e8c46f; font-size: 13px; margin-top: 2px; }
	.controls { margin-top: 6px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
	.controls .d { background: #23262e; border: 1px solid #3a3f4a; color: #d8dbe2; padding: 4px 12px; }
	.controls .d.on-open { background: #3a3f4a; }
	.controls .d.on-track { background: #2b5cab; }
	.controls .d.on-derived { background: #6b3fa0; }
	.controls .d.on-ignore { background: #4a4f5a; }
	.controls input { background: #23262e; color: inherit; border: 1px solid #3a3f4a;
		border-radius: 6px; padding: 5px 10px; flex: 1; min-width: 240px; }
	button.i { background: #23262e; border: 1px solid #3a3f4a; color: #7ab7ff; border-radius: 50%;
		width: 22px; height: 22px; padding: 0; font-style: italic; font-weight: 700; line-height: 1; }
	.info { background: #12141a; border: 1px solid #2a2e37; border-radius: 6px; padding: 8px 12px;
		margin-top: 6px; white-space: pre-wrap; color: #c2c8d2; font-size: 13px; }
	.info .type { color: #8ecf9d; font-family: monospace; margin-bottom: 6px; }
	.dirty { outline: 1px dashed #e8c46f; }
	.hide { display: none; }
</style>
</head>
<body>
<div id="bar">
	<strong>Coverage triage</strong>
	<input id="filter" type="text" placeholder="filter rows (name, doc, warning)...">
	<span id="counts"></span>
	<button id="save" disabled>Save</button>
</div>
<div id="banner"></div>
<main id="main"></main>
<script>window.__MODEL__ = ${data};</script>
<script>
"use strict";
(function () {
	var model = window.__MODEL__;
	var state = {};
	var baseline = {};
	var main = document.getElementById("main");
	var banner = document.getElementById("banner");
	var saveButton = document.getElementById("save");
	var filterBox = document.getElementById("filter");

	function key(row) { return row.class + "." + row.attribute; }
	function esc(text) {
		var div = document.createElement("div");
		div.textContent = text == null ? "" : String(text);
		return div.innerHTML;
	}

	model.groups.forEach(function (group) { group.sections.forEach(function (section) {
		section.rows.forEach(function (row) {
			var value = { disposition: row.disposition || "open", reason: row.reason || "" };
			state[key(row)] = { disposition: value.disposition, reason: value.reason };
			baseline[key(row)] = value.disposition + "\\u0000" + value.reason;
		});
	}); });

	function isDirty(k) {
		var v = state[k];
		return baseline[k] !== (v.disposition + "\\u0000" + v.reason);
	}
	function anyDirty() { return Object.keys(state).some(isDirty); }

	function refreshCounts() {
		var counts = { open: 0, track: 0, derived: 0, ignore: 0 };
		Object.keys(state).forEach(function (k) { counts[state[k].disposition] += 1; });
		document.getElementById("counts").innerHTML =
			"<span>OPEN " + counts.open + "</span><span>track " + counts.track +
			"</span><span>derived " + counts.derived + "</span><span>ignore " + counts.ignore + "</span>";
		saveButton.disabled = !anyDirty();
	}

	function render() {
		var html = "";
		model.groups.forEach(function (group) {
			html += "<h2>" + esc(group.className) + " <small>(" + group.writable + " RW attributes)</small></h2>";
			group.sections.forEach(function (section) {
				html += "<h3>" + esc(section.title) + "</h3>";
				section.rows.forEach(function (row) {
					var k = key(row);
					html += '<div class="row" data-key="' + esc(k) + '" data-text="' +
						esc((row.attribute + " " + (row.doc || "") + " " + row.warnings.join(" ")).toLowerCase()) + '">';
					html += "<div><code>" + esc(row.attribute) + "</code> ";
					if (row.doc) html += '<span class="doc">' + esc(row.doc) + "</span> ";
					html += '<a href="' + esc(row.docUrl) + '" target="_blank">docs</a> ';
					if (row.info) html += '<button type="button" class="i" title="full upstream doc">i</button>';
					html += "</div>";
					if (row.info) {
						html += '<div class="info hide"><div class="type">' + esc(row.info.type) +
							"   (defined on " + esc(row.info.definedOn) + ")</div>" + esc(row.info.text) + "</div>";
					}
					row.warnings.forEach(function (w) { html += '<div class="warn">&#9888; ' + esc(w) + "</div>"; });
					html += '<div class="controls">';
					["open"].concat(model.dispositions).forEach(function (d) {
						html += '<button type="button" class="d" data-d="' + d + '">' + d + "</button>";
					});
					html += '<input type="text" placeholder="reason (required for a decision)" value="' +
						esc(state[k].reason) + '">';
					html += "</div></div>";
				});
			});
		});
		main.innerHTML = html;
		Array.prototype.forEach.call(main.querySelectorAll(".row"), wireRow);
		refreshAll();
	}

	function wireRow(rowEl) {
		var k = rowEl.getAttribute("data-key");
		var infoButton = rowEl.querySelector("button.i");
		if (infoButton) {
			infoButton.addEventListener("click", function () {
				var panel = rowEl.querySelector(".info");
				panel.className = panel.className.indexOf("hide") !== -1 ? "info" : "info hide";
			});
		}
		Array.prototype.forEach.call(rowEl.querySelectorAll("button.d"), function (button) {
			button.addEventListener("click", function () {
				state[k].disposition = button.getAttribute("data-d");
				refreshRow(rowEl);
				refreshCounts();
			});
		});
		rowEl.querySelector("input").addEventListener("input", function (event) {
			state[k].reason = event.target.value;
			refreshRow(rowEl);
			refreshCounts();
		});
	}

	function refreshRow(rowEl) {
		var k = rowEl.getAttribute("data-key");
		var v = state[k];
		rowEl.className = "row" + (v.disposition !== "open" ? " decided-" + v.disposition : "");
		if (isDirty(k)) rowEl.className += " dirty";
		Array.prototype.forEach.call(rowEl.querySelectorAll("button.d"), function (button) {
			var d = button.getAttribute("data-d");
			button.className = "d" + (v.disposition === d ? " on-" + d : "");
		});
	}

	function refreshAll() {
		Array.prototype.forEach.call(main.querySelectorAll(".row"), refreshRow);
		refreshCounts();
	}

	filterBox.addEventListener("input", function () {
		var needle = filterBox.value.toLowerCase();
		Array.prototype.forEach.call(main.querySelectorAll(".row"), function (rowEl) {
			var hit = !needle || rowEl.getAttribute("data-text").indexOf(needle) !== -1;
			rowEl.className = rowEl.className.replace(" hide", "");
			if (!hit) rowEl.className += " hide";
		});
	});

	saveButton.addEventListener("click", function () {
		var decisions = [];
		Object.keys(state).forEach(function (k) {
			var v = state[k];
			if (v.disposition === "open") return;
			var dot = k.indexOf(".");
			decisions.push({ class: k.slice(0, dot), attribute: k.slice(dot + 1),
				disposition: v.disposition, reason: v.reason });
		});
		saveButton.disabled = true;
		fetch("/save", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ classes: model.classes, decisions: decisions }),
		}).then(function (response) { return response.json(); }).then(function (result) {
			if (result.ok) {
				banner.className = "ok";
				banner.textContent = "Saved: " + result.entries + " decision(s) in coverage-triage.json" +
					(result.fallbacks ? " (" + result.fallbacks + " with the batch fallback reason — " +
						"add per-row notes whenever a decision has context worth keeping)" : "");
				Object.keys(state).forEach(function (k) {
					var v = state[k];
					baseline[k] = v.disposition + "\\u0000" + v.reason;
				});
				refreshAll();
			} else {
				banner.className = "bad";
				banner.textContent = "NOT saved — fix these and save again:\\n" + result.problems.join("\\n");
				saveButton.disabled = false;
			}
		}).catch(function (error) {
			banner.className = "bad";
			banner.textContent = "Save failed: " + error;
			saveButton.disabled = false;
		});
	});

	render();
})();
</script>
</body>
</html>`;
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", chunk => {
			size += chunk.length;
			if (size > 1_048_576) { reject(new Error("request body over 1MB")); req.destroy(); return; }
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

export async function startTriageUi({ classes = DEFAULT_CLASSES, port = 3199 } = {}) {
	const pin = coverageOffline({ classes }).pin;
	const richDocs = await loadRichDocs(pin);
	console.log(`coverage ui: full upstream docs ${richDocs.source} (${richDocs.byKey.size} attributes)`);
	const server = http.createServer(async (req, res) => {
		try {
			if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(renderPage(pageModel(classes, richDocs)));
				return;
			}
			if (req.method === "POST" && req.url === "/save") {
				const body = JSON.parse(await readBody(req));
				const decisions = Array.isArray(body.decisions) ? body.decisions : [];
				const scope = new Set(Array.isArray(body.classes) ? body.classes : classes);
				const kept = readTriageFile().filter(e => !scope.has(e.class));
				const fallbackReason = `batch triage in the UI — no per-row note (owner, ${
					new Date().toISOString().slice(0, 10)})`;
				let fallbacks = 0;
				const next = [...kept, ...decisions.map(d => {
					const typed = typeof d.reason === "string" ? d.reason.trim() : "";
					if (!typed) fallbacks += 1;
					return {
						class: d.class, attribute: d.attribute, disposition: d.disposition,
						reason: typed || fallbackReason,
					};
				})];
				const { identifiers } = moduleIdentifiers();
				const problems = validateTriageEntries(next, identifiers);
				if (problems.length) {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: false, problems }));
					return;
				}
				writeTriageFile(next);
				console.log(`coverage ui: saved ${next.length} entries (${fallbacks} with the batch fallback reason)`);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, entries: next.length, fallbacks }));
				return;
			}
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
		} catch (error) {
			console.error(`coverage ui: ${error.stack || error}`);
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: false, problems: [String(error.message || error)] }));
		}
	});
	return new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(port, "127.0.0.1", () => {
			const actual = server.address().port;
			console.log(`coverage triage UI: http://127.0.0.1:${actual}/  (Ctrl+C to stop; Save writes coverage-triage.json)`);
			resolve(server);
		});
	});
}
