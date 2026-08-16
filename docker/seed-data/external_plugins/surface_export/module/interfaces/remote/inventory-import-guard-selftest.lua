local Deserializer = require("modules/surface_export/core/deserializer")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")

local UNKNOWN_ENTITY = "modded-entity-the-destination-lacks"

local function chest_readback(inv)
  local out = { stacks = 0, name = "none", count = -1, entities = -1, label = "none",
    book_slots = -1, book_filled = -1, filled_slot = -1 }
  for i = 1, #inv do
    local stack = inv[i]
    if stack.valid_for_read then
      out.stacks = out.stacks + 1
      out.filled_slot = i
      out.name = stack.name
      out.count = stack.count
      out.entities = stack.is_blueprint and stack.get_blueprint_entity_count() or -1
      out.label = tostring((stack.is_item_with_label and stack.label) or "none")
      if stack.is_item_with_inventory then
        local inner = stack.get_inventory(defines.inventory.item_main)
        if inner and inner.valid then
          out.book_slots = #inner
          out.book_filled = 0
          for j = 1, #inner do
            if inner[j].valid_for_read then out.book_filled = out.book_filled + 1 end
          end
        end
      end
    end
  end
  return out
end

local function restore_into_chest(items, use_session)
  local surface = game.surfaces["nauvis"]
  local spot = surface.find_non_colliding_position("wooden-chest", { x = 0, y = 0 }, 400, 1)
  local chest = spot and surface.create_entity({ name = "wooden-chest", position = spot, force = "player",
    raise_built = false })
  if not (chest and chest.valid) then return { built = false } end

  local session = use_session ~= false and Deserializer.new_item_state_session() or nil
  local entity_data = { specific_data = { inventories = { { type = "chest", items = items } } } }
  local ok, err = pcall(Deserializer.restore_inventories, chest, entity_data, nil, session)
  Deserializer.release_item_state_session(session)

  local result = chest_readback(chest.get_inventory(defines.inventory.chest))
  result.built = true
  result.ok = ok
  result.err = ok and "" or tostring(err)
  result.applied = session and session.applied or -1
  result.declined = session and session.declined or -1
  result.failed = session and session.failed or -1
  chest.destroy()
  return result
end

local function report(label, r)
  if not r.built then return label .. ": chest did not build" end
  return string.format("%s: ok=%s err=%s applied=%d declined=%d failed=%d stacks=%d slot=%d name=%s count=%d "
    .. "entities=%d label=%s book_slots=%d book_filled=%d", label, tostring(r.ok), r.err, r.applied, r.declined,
    r.failed, r.stacks, r.filled_slot, r.name, r.count, r.entities, r.label, r.book_slots, r.book_filled)
end

local function inventory_import_guard_selftest()
  local details = {}
  local passed, failed = 0, 0

  local function check(name, condition, message)
    if condition then
      passed = passed + 1
      details[#details + 1] = { name = name, ok = true }
    else
      failed = failed + 1
      details[#details + 1] = { name = name, ok = false, msg = message or "assertion failed" }
    end
  end

  local fixture_inv = game.create_inventory(2)
  fixture_inv[1].set_stack({ name = "blueprint", count = 1 })
  fixture_inv[1].set_blueprint_entities({
    { entity_number = 1, name = "wooden-chest", position = { x = 0.5, y = 0.5 } },
    { entity_number = 2, name = "iron-chest", position = { x = 1.5, y = 0.5 } },
  })
  fixture_inv[1].label = "chest-blueprint"
  local same_type_string = fixture_inv[1].export_stack()

  fixture_inv[2].set_stack({ name = "blueprint-book", count = 1 })
  local book_inner = fixture_inv[2].get_inventory(defines.inventory.item_main)
  for _, page_label in ipairs({ "page-one", "page-two" }) do
    book_inner.insert({ name = "blueprint", count = 1 })
    for i = 1, #book_inner do
      if book_inner[i].valid_for_read and book_inner[i].label == nil then
        book_inner[i].set_blueprint_entities({
          { entity_number = 1, name = "wooden-chest", position = { x = 0.5, y = 0.5 } },
        })
        book_inner[i].label = page_label
        break
      end
    end
  end
  fixture_inv[2].label = "the-book"
  local book_string = fixture_inv[2].export_stack()
  local book_state = InventoryScanner.extract_item_properties(fixture_inv[2])
  fixture_inv.destroy()

  local decoded = helpers.json_to_table(helpers.decode_string(same_type_string:sub(2)))
  decoded.blueprint.entities[2].name = UNKNOWN_ENTITY
  decoded.blueprint.icons = { { signal = { name = "wooden-chest" }, index = 1 } }
  local partial_string = "0" .. helpers.encode_string(helpers.table_to_json(decoded))

  check("fixture_string_names_an_entity_this_install_lacks", prototypes.entity[UNKNOWN_ENTITY] == nil,
    "the partial-import fixture is only a fixture if the entity it names really is unknown here")

  local function blueprint_item(export_string, slot)
    return { name = "blueprint", count = 1, quality = "normal", slot = slot or 1, export_string = export_string }
  end

  local clean = restore_into_chest({ blueprint_item(same_type_string) })
  check("chest_applies_a_clean_export_string",
    clean.built and clean.ok and clean.applied == 1 and clean.declined == 0 and clean.failed == 0
      and clean.stacks == 1 and clean.name == "blueprint" and clean.entities == 2
      and clean.label == "chest-blueprint",
    "a blueprint's own export string must reach the chest stack and land both entities and its label; "
      .. report("clean", clean))

  local partial = restore_into_chest({ blueprint_item(partial_string) })
  check("chest_declines_a_partially_importable_export_string",
    partial.built and partial.ok and partial.declined == 1 and partial.applied == 0 and partial.failed == 0
      and partial.stacks == 1 and partial.name == "blueprint" and partial.count == 1
      and partial.entities == 0,
    "a string the engine can only import PARTIALLY (import_stack returns -1, dropping the entities this "
      .. "install lacks) must be declined whole: the plain stack stays placed so the census still balances, "
      .. "and the loss is counted rather than shipped as a blueprint quietly missing entities; "
      .. report("partial", partial))

  local cross = restore_into_chest({ blueprint_item(book_string) })
  check("chest_declines_a_type_changing_export_string",
    cross.built and cross.ok and cross.declined == 1 and cross.applied == 0 and cross.failed == 0
      and cross.stacks == 1 and cross.name == "blueprint",
    "a blueprint-book string imported into a blueprint stack changes the item name while import_stack still "
      .. "returns 0, and the item name is the census dimension; " .. report("cross-type", cross))

  local garbage = restore_into_chest({ blueprint_item("not-a-real-export-string") })
  check("chest_keeps_a_plain_stack_when_the_string_is_unparseable",
    garbage.built and garbage.ok and garbage.declined == 1 and garbage.applied == 0 and garbage.failed == 0
      and garbage.stacks == 1 and garbage.name == "blueprint" and garbage.count == 1,
    "import_stack returns 1 and writes NOTHING for an unparseable string: the slot must still hold the "
      .. "plain item the payload promised the census, not stay empty; " .. report("garbage", garbage))

  local slotted = restore_into_chest({ blueprint_item(same_type_string, 3) })
  check("chest_places_an_export_string_stack_at_its_captured_slot",
    slotted.built and slotted.ok and slotted.stacks == 1 and slotted.filled_slot == 3
      and slotted.entities == 2,
    "the captured slot is restored rather than the first free one; " .. report("slotted", slotted))

  local book = restore_into_chest({ { name = "blueprint-book", count = 1, quality = "normal", slot = 1,
    export_string = book_string, label = book_state.label, nested_inventory = book_state.nested_inventory } })
  check("chest_book_keeps_its_pages",
    book.built and book.ok and book.applied == 1 and book.declined == 0 and book.failed == 0
      and book.name == "blueprint-book" and book.book_slots == 2 and book.book_filled == 2,
    "a book arrives full from its export string: the plain blueprint-book placed first is an EMPTY book "
      .. "(inventory size 0) and import_stack must fill it, and the nested_inventory the same capture also "
      .. "carries must never be replayed over it — restore_nested_inventory clears the inventory, which "
      .. "SHRINKS a book to size 0, after which its free-slot scan has no slots; " .. report("book", book))

  local sessionless = restore_into_chest({ blueprint_item(same_type_string) }, false)
  check("chest_declines_when_no_item_state_session_is_threaded",
    sessionless.built and sessionless.ok and sessionless.stacks == 1
      and sessionless.name == "blueprint" and sessionless.entities == 0,
    "with no session there is no preflight and no counter, so the string must NOT be written: an "
      .. "uncounted write is the dead-field class this guard exists to prevent; " .. report("sessionless", sessionless))

  return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return inventory_import_guard_selftest
