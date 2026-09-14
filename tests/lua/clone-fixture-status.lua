local query = assert(load(io.read("*a"), "generated clone status"))
local platforms
remote = {call = function() return platforms end}

local function reset()
	storage = {async_jobs = {}, async_job_results = {}}
	platforms = {}
end

local function completed()
	local identity = {platform_index = 7, surface_index = 17, platform_uid = "original", force_name = "player"}
	storage.async_job_results.export_1 = {status = "complete", complete = true, clone_import_job_id = "import_1"}
	storage.async_job_results.import_1 = {type = "import", platform_name = "fixture", status = "complete", complete = true,
		target_identity = identity}
	platforms = {{platform_index = 7, surface_index = 17, platform_uid = "original", force_name = "player"}}
end

reset()
local empty = query()
assert(empty.success and empty.active == false and empty.jobId == nil and not empty.identityMatched)
for _, status in ipairs({"failed", "interrupted"}) do
	storage.async_job_results.export_1 = {status = status, error = "export error"}
	assert(query().sourceError == "export error")
	storage.async_job_results.export_1.error = nil
	assert(query().sourceError == status)
end
for _, field in ipairs({"completion_interrupted", "setup_cleanup"}) do
	reset()
	storage.async_jobs.export_1 = {[field] = {error = "source cleanup"}}
	assert(query().sourceError == "source cleanup")
	reset()
	completed()
	storage.async_jobs.import_1 = {[field] = {error = "import cleanup"}}
	assert(query().active and query().error == "import cleanup")
end

reset()
completed()
local done = query()
assert(done.jobId == "import_1" and done.status == "complete" and done.complete and not done.active)
assert(done.index == 7 and done.identityMatched and done.identity.platform_uid == "original")
storage.async_jobs.unrelated = {type = "import", platform_name = "fixture"}
assert(query().jobId == "import_1" and not query().active)
storage.async_jobs.import_1 = {}
assert(query().active)
storage.async_jobs.import_1 = nil
storage.async_job_results.import_1.validation = {success = false}
assert(query().validationSuccess == false)
storage.async_job_results.import_1.status, storage.async_job_results.import_1.error = "failed", "import failed"
assert(query().status == "failed" and query().error == "import failed")

for key, replacement in pairs({platform_uid = "replacement", platform_index = 99, surface_index = 99, force_name = "enemy"}) do
	reset()
	completed()
	platforms[1][key] = replacement
	assert(not query().identityMatched and query().index == nil, "accepted replacement " .. key)
end
reset()
completed()
platforms[1].platform_name = "renamed"
assert(query().identityMatched, "name must not be identity")
platforms[2] = platforms[1]
local ok, err = pcall(query)
assert(not ok and err:find("Ambiguous clone identity", 1, true))

for _, missing in ipairs({"export", "association", "result", "identity", "uid", "platform"}) do
	reset()
	completed()
	if missing == "export" then storage.async_job_results.export_1 = nil
	elseif missing == "association" then storage.async_job_results.export_1.clone_import_job_id = nil
	elseif missing == "result" then storage.async_job_results.import_1 = nil
	elseif missing == "identity" then storage.async_job_results.import_1.target_identity = nil
	elseif missing == "uid" then storage.async_job_results.import_1.target_identity.platform_uid = nil
	else platforms = {} end
	assert(not query().identityMatched and query().index == nil, "accepted missing " .. missing)
end
reset()
storage.async_job_results.export_1 = {status = "complete", complete = true, clone_import_error = "admission refused"}
assert(query().sourceError == "admission refused")
print("clone fixture status: PASS")
