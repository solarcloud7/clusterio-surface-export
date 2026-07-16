const assert = require("node:assert/strict");
const { Rcon } = require("/clusterio/node_modules/rcon-client");

const [port = "27977", password = "gallery-verify-only"] = process.argv.slice(2);

const command = `/c
local function census(belts, selected_line)
  local seen, quantity, stacks, maximum = {}, 0, 0, 0
  for _, belt in ipairs(belts) do
    local first = selected_line or 1
    local last = selected_line or belt.get_max_transport_line_index()
    for line_index = first, last do
      for _, row in ipairs(belt.get_transport_line(line_index).get_detailed_contents()) do
        if not seen[row.unique_id] then
          seen[row.unique_id] = true
          quantity = quantity + row.stack.count
          stacks = stacks + 1
          maximum = math.max(maximum, row.stack.count)
        end
      end
    end
  end
  return {quantity=quantity, physical_stacks=stacks, maximum_stack=maximum}
end
local surface = game.surfaces.nauvis
local source = surface.find_entities_filtered{area={{-17,-26},{-12,-21}},name="turbo-transport-belt"}
local target = surface.find_entities_filtered{area={{4,-26},{9,-21}},name="turbo-transport-belt"}
local all = census(source)
local line1 = census(source, 1)
local line2 = census(source, 2)
local empty = census(target)
local index = game.surfaces["lab-gallery-index"]
local index_texts, source_texts = 0, 0
for _, object in ipairs(rendering.get_all_objects("")) do
  if object.type == "text" then
    if object.surface == index then index_texts = index_texts + 1 end
    if object.surface == surface then
      local text = tostring(object.text)
      if string.find(text, "SOURCE:", 1, true) == 1
          or string.find(text, "TARGET:", 1, true) == 1
          or string.find(text, "READY", 1, true) == 1 then
        source_texts = source_texts + 1
      end
    end
  end
end
local index_tags = #game.forces.player.find_chart_tags(index)
local source_tags = 0
for _, tag in ipairs(game.forces.player.find_chart_tags(surface, {{-17,-29},{9,-21}})) do
  if string.find(tostring(tag.text), "LAB ", 1, true) == 1 then source_tags = source_tags + 1 end
end
rcon.print(helpers.table_to_json({
  version=script.active_mods.base,
  gallery_storage=storage.lab_gallery ~= nil,
  index_surface=game.surfaces["lab-gallery-index"] ~= nil,
  source_belts=#source,
  target_belts=#target,
  source_quantity=all.quantity,
  physical_stacks=all.physical_stacks,
  maximum_stack=all.maximum_stack,
  source_line_quantities={line1.quantity,line2.quantity},
  target_quantity=empty.quantity,
  index_texts=index_texts,
  source_texts=source_texts,
  index_tags=index_tags,
  source_tags=source_tags
}))`;

async function main() {
	const rcon = await Rcon.connect({ host: "127.0.0.1", port: Number(port), password });
	try {
		const response = await rcon.send(command.replace(/\s*\n\s*/g, " "));
		const reading = JSON.parse(response.trim().split(/\r?\n/).filter(Boolean).at(-1));
		assert.deepEqual(reading, {
			version: "2.0.77",
			gallery_storage: true,
			index_surface: true,
			source_belts: 16,
			target_belts: 16,
			source_quantity: 125,
			physical_stacks: 125,
			maximum_stack: 1,
			source_line_quantities: [67, 58],
			target_quantity: 0,
			index_texts: 12,
			source_texts: 3,
			index_tags: 12,
			source_tags: 2,
		});
		console.log(JSON.stringify({ status: "PASS", reading }, null, 2));
		try { await rcon.send("/quit"); } catch { /* Expected when Factorio closes the socket first. */ }
	} finally {
		rcon.end();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
