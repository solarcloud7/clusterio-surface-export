
export function createCase(context) {
	const { lua, sleep, docker, HOSTS, say, fail, pass, platformLua, SOURCE_HOST, DEST_HOST, CLONE } = context;
	const LABEL_PREFIX = CLONE + "-inventory";
	const storedField = (id, field) => context.storedField(field);
	const STATE_LOG_ATTEMPTS = 10;

	const BP_LABEL = `${LABEL_PREFIX}-bp`;
	const BOOK_LABEL = `${LABEL_PREFIX}-book`;
	const PAGE_LABELS = [`${LABEL_PREFIX}-page-1`, `${LABEL_PREFIX}-page-2`];

	const BP_ENTITIES = [
		{ name: "transport-belt", x: 0.5, y: 0.5 },
		{ name: "fast-inserter", x: 1.5, y: 0.5 },
		{ name: "wooden-chest", x: 2.5, y: 0.5 },
	];
	const BP_WRITE = `{ ${BP_ENTITIES.map((e, i) => `{ entity_number = ${i + 1}, name = "${e.name}", `
		+ `position = { x = ${e.x}, y = ${e.y} } }`).join(", ")} }`;
	const BP_EXPECT = `n=${BP_ENTITIES.length} `
		+ BP_ENTITIES.map(e => `${e.name}@${e.x.toFixed(2)},${e.y.toFixed(2)}`).sort().join(",");

	const STATE_LOG_MARKER = `[Import] INVENTORY ITEM STATE ${CLONE}:`;
	const STORED_COUNTER_FIELDS = {
		inventory_state_applied: "applied",
		inventory_state_declined: "declined",
		inventory_state_failed: "failed",
	};

	const READBACK_LUA = `local bp, book = nil, nil
	for _, e in pairs(s.find_entities_filtered{}) do
	  if e.valid then
	    for i = 1, e.get_max_inventory_index() do
	      local inv = e.get_inventory(i)
	      if inv and inv.valid then
	        for j = 1, #inv do
	          local st = inv[j]
	          if st.valid_for_read and st.is_item_with_label then
	            if st.is_blueprint and st.label == '${BP_LABEL}' then
	              local parts = {}
	              for _, ent in ipairs(st.get_blueprint_entities() or {}) do
	                parts[#parts + 1] = string.format("%s@%.2f,%.2f", ent.name, ent.position.x, ent.position.y)
	              end
	              table.sort(parts)
	              bp = { key = string.format("n=%d %s", st.get_blueprint_entity_count(), table.concat(parts, ",")),
	                holder = e.name, count = st.count }
	            elseif st.is_blueprint_book and st.label == '${BOOK_LABEL}' then
	              local inner = st.get_inventory(defines.inventory.item_main)
	              local labels, filled = {}, 0
	              if inner and inner.valid then
	                for k = 1, #inner do
	                  if inner[k].valid_for_read then
	                    filled = filled + 1
	                    labels[#labels + 1] = tostring(inner[k].label) .. "/"
	                      .. tostring(inner[k].is_blueprint and inner[k].get_blueprint_entity_count() or -1)
	                  end
	                end
	              end
	              table.sort(labels)
	              book = { slots = inner and #inner or -1, filled = filled,
	                pages = table.concat(labels, ","), holder = e.name, count = st.count }
	            end
	          end
	        end
	      end
	    end
	  end
	end
	return { success = true, bp = bp, book = book }`;

	function buildAndArm() {
		return lua(SOURCE_HOST, `${platformLua(CLONE)}
	local chest = s.find_entities_filtered{ type = "space-platform-hub" }[1]
	if not (chest and chest.valid) then return { success = false, error = "clone has no hub to arm" } end
	local inv = chest.get_inventory(defines.inventory.hub_main)
	if not (inv and inv.valid and inv.count_empty_stacks() >= 2) then
	  return { success = false, error = "the clone's hub has no free slots to arm" }
	end

	inv.insert{ name = "blueprint", count = 1 }
	local bp = inv.find_item_stack("blueprint")
	bp.set_blueprint_entities(${BP_WRITE})
	bp.label = '${BP_LABEL}'

	inv.insert{ name = "blueprint-book", count = 1 }
	local book = inv.find_item_stack("blueprint-book")
	local inner = book.get_inventory(defines.inventory.item_main)
	for _, page_label in ipairs({ '${PAGE_LABELS[0]}', '${PAGE_LABELS[1]}' }) do
	  inner.insert{ name = "blueprint", count = 1 }
	  for i = 1, #inner do
	    if inner[i].valid_for_read and inner[i].label == nil then
	      inner[i].set_blueprint_entities({ { entity_number = 1, name = "wooden-chest",
	        position = { x = 0.5, y = 0.5 } } })
	      inner[i].label = page_label
	      break
	    end
	  end
	end
	book.label = '${BOOK_LABEL}'
	return { success = true, chest = string.format("%s (%.1f, %.1f)", chest.name, chest.position.x, chest.position.y),
	  book_slots = #inner }`);
	}

	function adjudicateStoredCounters(transferId, counters) {
		let stored;
		let applied;
		try {
			stored = storedField(transferId, "summary.import");
			applied = storedField(transferId, "summary.import.inventory_state_applied");
		} catch (error) {
			console.error(error && error.stack ? error.stack : error);
			fail(`reading the persisted counters of ${transferId} failed: ${error.message} `
				+ `${String(error.stderr || "").trim().slice(-300)} — the counters reach the controller's raw `
				+ "event, but only enter summary.import if buildImportMetrics carries them, and summary.import "
				+ "is what an operator and testkit log actually read");
			return;
		}
		for (const [field, prop] of Object.entries(STORED_COUNTER_FIELDS)) {
			if (stored[field] !== counters[prop]) {
				fail(`summary.import.${field} reads ${JSON.stringify(stored[field])}, the destination's own log `
					+ `line says ${counters[prop]} — the store is the only copy that outlives the instance log, `
					+ "so a disagreement here is the number every later reader gets");
				return;
			}
		}
		if (applied !== counters.applied) {
			fail(`the dotted query path summary.import.inventory_state_applied answers ${JSON.stringify(applied)}, `
				+ `not the ${counters.applied} the destination reported`);
			return;
		}
		pass(`summary.import carries applied=${stored.inventory_state_applied} `
			+ `declined=${stored.inventory_state_declined} failed=${stored.inventory_state_failed}, `
			+ "each agreeing with the destination's log line");
	}

	async function readStateCounters(host) {
		const path = `/clusterio/data/instances/${HOSTS[host].instance}/factorio-current.log`;
		for (let attempt = 1; attempt <= STATE_LOG_ATTEMPTS; attempt++) {
			const out = docker(["exec", HOSTS[host].container, "sh", "-c",
				`grep -aF '${STATE_LOG_MARKER}' ${path} | tail -1 || true`]);
			const hit = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop();
			if (hit) {
				const nums = hit.match(/applied (\d+) \| declined (\d+) \| failed (\d+)/);
				if (nums) {
					return { line: hit, applied: Number(nums[1]), declined: Number(nums[2]), failed: Number(nums[3]) };
				}
			}
			if (attempt < STATE_LOG_ATTEMPTS) await sleep(1000);
		}
		return null;
	}
	let before;

	return {
		async prepare() {
			say("\n=== SOURCE: arm a chest with a blueprint and a blueprint book ===");
			const built = buildAndArm();
			say(`  chest: ${built.chest}; book slots after paging: ${built.book_slots}`);

		},
		async source() {
			before = lua(SOURCE_HOST, `${platformLua(CLONE)}\n${READBACK_LUA}`);
			if (!before.bp || before.bp.key !== BP_EXPECT) {
				fail(`the source blueprint reads ${JSON.stringify(before.bp && before.bp.key)}, not ${BP_EXPECT} — `
					+ "the transfer below cannot measure what was never armed");
				return;
			}
			if (!before.book || before.book.filled !== 2) {
				fail(`the source book reads ${JSON.stringify(before.book)} — expected 2 filled pages; the transfer `
					+ "below cannot measure what was never armed");
				return;
			}
			pass(`source armed: blueprint ${before.bp.key}; book ${before.book.filled} page(s) [${before.book.pages}]`);

		},
		async verify(transferId) {
			say("\n=== DESTINATION: physical readback off the arrived stacks ===");
			const after = lua(DEST_HOST, `${platformLua(CLONE)}\n${READBACK_LUA}`);
			if (!after.bp) {
				fail(`no blueprint labelled '${BP_LABEL}' arrived at all — the stack itself is missing, not just `
					+ "its content");
			} else if (after.bp.key !== BP_EXPECT) {
				fail(`the arrived blueprint decodes to ${JSON.stringify(after.bp.key)}, not ${BP_EXPECT} — content `
					+ "was stripped or altered in restore (a partial import_stack drops the entities the destination "
					+ "cannot build and returns -1, which is invisible to the census because blueprint contents are "
					+ "not census items)");
			} else {
				pass(`blueprint content survived: ${after.bp.key} (in ${after.bp.holder})`);
			}

			if (!after.book) {
				fail(`no blueprint book labelled '${BOOK_LABEL}' arrived at all`);
			} else if (after.book.filled !== 2 || after.book.pages !== before.book.pages) {
				fail(`the arrived book reads slots=${after.book.slots} filled=${after.book.filled} `
					+ `pages=[${after.book.pages}], the source had filled=${before.book.filled} `
					+ `pages=[${before.book.pages}] — a book restored from its export string and then replayed `
					+ "through the nested-inventory restore arrives EMPTY, because that restore clears the "
					+ "inventory and a cleared book SHRINKS to size 0");
			} else {
				pass(`book kept its pages: ${after.book.filled} page(s) [${after.book.pages}] (in ${after.book.holder})`);
			}

			say("\n=== COUNTERS: the destination's own log line, bound to this clone ===");
			const counters = await readStateCounters(DEST_HOST);
			if (counters === null) {
				fail(`the destination emitted no "${STATE_LOG_MARKER}" line for THIS clone — the restore either `
					+ "never ran an export_string stack or the counters are not being emitted, and an unemitted "
					+ "counter is unreadable everywhere downstream");
				return;
			}
			say(`  ${counters.line.trim().slice(-160)}`);
			if (counters.applied < 2) {
				fail(`the destination counted applied=${counters.applied}, but this run armed 2 export_string `
					+ "stacks (a blueprint and a book) that both demonstrably restored");
			} else {
				pass(`applied=${counters.applied} covers the 2 stacks this run armed`);
			}
			if (counters.declined !== 0 || counters.failed !== 0) {
				fail(`declined=${counters.declined} failed=${counters.failed} on a same-mods transfer: every string `
					+ "here was written by the same engine build that reads it, so a decline means the preflight is "
					+ "refusing strings it should accept");
			} else {
				pass("declined=0 failed=0 — the preflight accepted every honestly-captured string");
			}

			say("\n=== STORE: the same counters through the testkit query path ===");
			adjudicateStoredCounters(transferId, counters);

		},
	};
}
