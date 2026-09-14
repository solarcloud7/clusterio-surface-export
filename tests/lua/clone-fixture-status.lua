local query = assert(load(io.read("*a"), "generated clone status"))

function table_size(value)
	local count = 0
	for _ in pairs(value) do count = count + 1 end
	return count
end

local function reset()
	storage = { async_jobs = {}, async_job_results = {} }
	game = { forces = { player = { platforms = {} } } }
end

local function platform(index)
	return { valid = true, name = "fixture", index = index, surface = { valid = true } }
end

local function completed()
	return { type = "import", platform_name = "fixture", status = "complete", complete = true }
end

reset()
local empty = query()
assert(empty.success and empty.active == false and empty.jobId == nil and empty.sourceError == nil)
game.forces.player.platforms = { platform(7) }
assert(query().index == 7 and query().jobId == nil)

for _, status in ipairs({ "failed", "interrupted" }) do
	reset()
	storage.async_job_results.export_1 = { status = status, error = "export error" }
	assert(query().sourceError == "export error")
	storage.async_job_results.export_1.error = nil
	assert(query().sourceError == status)
end

for _, field in ipairs({ "completion_interrupted", "setup_cleanup" }) do
	reset()
	storage.async_jobs.export_1 = { [field] = { error = "source cleanup" } }
	assert(query().sourceError == "source cleanup")
	reset()
	storage.async_jobs.import_1 = { type = "import", platform_name = "fixture", [field] = { error = "import cleanup" } }
	local active = query()
	assert(active.active == true and active.error == "import cleanup")
end

reset()
storage.async_job_results.import_1 = { type = "import", platform_name = "fixture", status = "failed", error = "import failed" }
assert(query().status == "failed" and query().error == "import failed")
storage.async_job_results.import_1 = completed()
storage.async_job_results.import_1.validation = { success = false }
assert(query().validationSuccess == false)

reset()
game.forces.player.platforms = { platform(7) }
storage.async_job_results.import_1 = completed()
local done = query()
assert(done.jobId == "import_1" and done.status == "complete" and done.complete == true)
assert(done.index == 7 and done.active == false and done.error == nil and done.validationSuccess == nil)
storage.async_jobs.import_1 = completed()
assert(query().active == true and query().complete == true)

storage.async_jobs.import_2 = completed()
local ok, err = pcall(query)
assert(not ok and err:find("Ambiguous clone import job", 1, true))
reset()
game.forces.player.platforms = { platform(7), platform(8) }
ok, err = pcall(query)
assert(not ok and err:find("Ambiguous clone platform", 1, true))

reset()
storage.async_job_results.export_1 = { status = "complete", complete = true }
local refused = query()
assert(refused.sourceStatus == "complete" and refused.sourceComplete == true and refused.jobId == nil)
print("clone fixture status: PASS")
