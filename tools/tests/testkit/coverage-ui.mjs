// coverage-ui — browser triage for the coverage checklist: click dispositions, one Save writes the ledger
//
// requires: the same inputs as coverage.mjs offline mode; a browser on this machine
// produces: a loopback HTTP server (127.0.0.1 only) serving the checklist as an interactive page;
//           Save POSTs the full decision set, which is validated by the SAME rules as the CLI
//           (unknown attribute, bad disposition, empty reason, born-stale referenced attribute)
//           and then written to coverage-triage.json
// does not: bind beyond loopback, serve anything but the checklist, touch the cluster, or write
//           the ledger when any decision fails validation — a failed save writes nothing and
//           reports every problem

import http from "node:http";
import {
	DEFAULT_CLASSES, DISPOSITIONS, allRows, coverageOffline,
	moduleIdentifiers, readTriageFile, validateTriageEntries, writeTriageFile,
} from "./coverage.mjs";

function pageModel(classes) {
	const report = coverageOffline({ classes });
	return {
		pin: report.pin,
		classes: report.classes,
		dispositions: DISPOSITIONS,
		groups: report.byClass.map(cls => ({
			className: cls.className,
			writable: cls.writable,
			sections: [
				...(cls.universal.length ? [{ title: "Universal (no subclass restriction)", rows: cls.universal }] : []),
				...cls.subclassSections.map(s => ({ title: s.subclass, rows: s.rows })),
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
					html += '<a href="' + esc(row.docUrl) + '" target="_blank">docs</a></div>';
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
				banner.textContent = "Saved: " + result.entries + " decision(s) in coverage-triage.json";
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

export function startTriageUi({ classes = DEFAULT_CLASSES, port = 3199 } = {}) {
	const server = http.createServer(async (req, res) => {
		try {
			if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(renderPage(pageModel(classes)));
				return;
			}
			if (req.method === "POST" && req.url === "/save") {
				const body = JSON.parse(await readBody(req));
				const decisions = Array.isArray(body.decisions) ? body.decisions : [];
				const scope = new Set(Array.isArray(body.classes) ? body.classes : classes);
				const kept = readTriageFile().filter(e => !scope.has(e.class));
				const next = [...kept, ...decisions.map(d => ({
					class: d.class, attribute: d.attribute, disposition: d.disposition,
					reason: typeof d.reason === "string" ? d.reason.trim() : d.reason,
				}))];
				const { identifiers } = moduleIdentifiers();
				const problems = validateTriageEntries(next, identifiers);
				if (problems.length) {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: false, problems }));
					return;
				}
				writeTriageFile(next);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, entries: next.length }));
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
