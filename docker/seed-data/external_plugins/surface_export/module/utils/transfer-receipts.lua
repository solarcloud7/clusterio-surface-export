-- Receipts prove actions already accepted in this save. They never authorize a new action.
local Receipts = {}
local capacity = 2048

function Receipts.get(kind, id)
    local bucket = storage.surface_export_transfer_receipts
        and storage.surface_export_transfer_receipts[kind]
    return bucket and bucket.records[id] or nil
end

function Receipts.put(kind, id, record)
    assert(type(id) == "string" and id ~= "", "receipt requires a transfer identity")
    storage.surface_export_transfer_receipts = storage.surface_export_transfer_receipts or {}
    local buckets = storage.surface_export_transfer_receipts
    local bucket = buckets[kind]
    if not bucket then
        bucket = {records = {}, order = {}, next_slot = 1}
        buckets[kind] = bucket
    end
    if bucket.records[id] then return end
    local old = bucket.order[bucket.next_slot]
    if old then bucket.records[old] = nil end
    bucket.order[bucket.next_slot] = id
    bucket.next_slot = bucket.next_slot % capacity + 1
    bucket.records[id] = record
end

return Receipts
