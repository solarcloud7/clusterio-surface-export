local Json = require("modules/surface_export/utils/json-compat")
local SectionCodec = { VERSION = 1, MAX_FRAME_BYTES = 65536, MAX_FRAMES = 4096 }

local function encode(value)
  local scalar = type(value) ~= "table"
  local text, err = Json.encode_json_compat(scalar and {value} or value)
  assert(text, err or "Section JSON encoding failed")
  return scalar and text:sub(2, -2) or text
end

-- Each frame is independently valid JSON. The ordinary document is retained for
-- existing file/debug consumers and an explicit legacy fallback for oversized data.
function SectionCodec.encode_step(job, budget)
  local payload = job.export_data
  local state = job.section_cursor
  if not state then
    local keys = {}
    for key in pairs(payload) do
      assert(type(key) == "string", "section object key must be a string")
      keys[#keys + 1] = key
    end
    table.sort(keys)
    state = {keys=keys,index=1,frames={},document={"{"}}
    job.section_cursor = state
  end
  local key = state.keys[state.index]
  if not key then
    state.document[#state.document + 1] = "}"
    job.section_cursor = nil
    return {json=table.concat(state.document),frames=not state.fallback and state.frames or nil,
      fallback=state.fallback}
  end
  local value = payload[key]
  local key_json = encode(key)
  local function emit(body)
    if state.fallback then return end
    local frame = '{"version":1,"seq":' .. (#state.frames + 1) .. ',"key":' .. key_json .. ',' .. body .. '}'
    if #frame > SectionCodec.MAX_FRAME_BYTES or #state.frames >= SectionCodec.MAX_FRAMES then
      state.fallback = string.format("field %s: %d frame bytes, %d frames; limits %d bytes / %d frames",
        key, #frame, #state.frames + 1, SectionCodec.MAX_FRAME_BYTES, SectionCodec.MAX_FRAMES)
      state.frames = {}
      return
    end
    state.frames[#state.frames + 1] = frame
  end
  if not state.item then
    state.document[#state.document + 1] = (state.index > 1 and "," or "") .. key_json .. ":"
    if (key == "entities" or key == "tiles" or key == "belt_side_groups") and type(value) == "table" and #value > 0 then
      state.item = 1
      state.document[#state.document + 1] = "["
    else
      local encoded = encode(value)
      state.document[#state.document + 1] = encoded
      emit('"value":' .. encoded)
      state.index = state.index + 1
      return nil
    end
  end
  local limit = math.max(1, math.floor((budget or 50) / 5))
  if key == "tiles" then limit = limit * 100 end
  local first, parts, bytes = state.item, {}, 150
  while state.item <= #value and #parts < limit do
    local encoded = state.carry or encode(value[state.item])
    state.carry = nil
    if #parts > 0 and bytes + #encoded + 1 > 60000 then state.carry = encoded; break end
    state.document[#state.document + 1] = (state.item > 1 and "," or "") .. encoded
    parts[#parts + 1] = encoded
    bytes = bytes + #encoded + 1
    state.item = state.item + 1
  end
  emit('"first":' .. first .. ',"values":[' .. table.concat(parts, ",") .. ']')
  if state.item > #value then
    state.document[#state.document + 1] = "]"
    state.item = nil
    state.index = state.index + 1
  end
  return nil
end

function SectionCodec.new_decoder(count)
  assert(type(count)=="number" and count%1==0 and count>=1 and count<=SectionCodec.MAX_FRAMES, "invalid section count")
  return {count=count,next=1,data={},fields={},array_fields={}}
end

function SectionCodec.decode_step(state, text)
  assert(type(text)=="string" and #text<=SectionCodec.MAX_FRAME_BYTES,"invalid section size")
  local frame = assert(Json.json_to_table_compat(text), "invalid section JSON")
  assert(type(frame)=="table", "section must be an object")
  assert(frame.version==1 and frame.seq==state.next and state.next<=state.count,"invalid section sequence")
  assert(type(frame.key)=="string" and #frame.key<=256,"invalid section key")
  local key = frame.key
  if frame.first ~= nil then
    assert(frame.value == nil, "ambiguous section value")
    assert(key=="entities" or key=="tiles" or key=="belt_side_groups","invalid sectional array")
    assert(not state.fields[key] or state.array_fields[key],"duplicate section field")
    assert(type(frame.values)=="table" and #frame.values>0,"empty section array")
    local array = state.data[key] or {}
    assert(frame.first==#array+1,"invalid section range")
    for index in pairs(frame.values) do
      assert(type(index)=="number" and index%1==0 and index>=1 and index<=#frame.values, "invalid array entry")
    end
    for i=1,#frame.values do
      assert(type(frame.values[i])=="table", "invalid array record")
      array[#array+1]=frame.values[i]
    end
    state.data[key]=array
    state.array_fields[key]=true
  else
    assert(frame.value ~= nil and frame.values == nil, "missing or ambiguous section value")
    assert(not state.fields[key],"duplicate section field")
    state.data[key]=frame.value
  end
  state.fields[key]=true
  state.next=state.next+1
  return state.next>state.count and state.data or nil
end

return SectionCodec
