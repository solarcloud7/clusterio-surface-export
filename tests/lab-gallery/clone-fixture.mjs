import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

export function cloneStatusLua(name, exportJobId) {
	for (const value of [name, exportJobId]) assert.match(value, /^[A-Za-z0-9_-]+$/);
	return `local name='${name}'
local source=(storage.async_jobs or {})['${exportJobId}'] or (storage.async_job_results or {})['${exportJobId}']
local source_error=source and ((source.completion_interrupted or {}).error or (source.setup_cleanup or {}).error
  or source.clone_import_error or ((source.status=='failed' or source.status=='interrupted') and (source.error or source.status)))
local ids={}
for _,records in ipairs({storage.async_jobs or {},storage.async_job_results or {}}) do
  for id,job in pairs(records) do
    if job.type=='import' and job.platform_name==name then ids[id]=true end
  end
end
local job_id=source and source.clone_import_job_id
local active=job_id and (storage.async_jobs or {})[job_id]
local result=job_id and (storage.async_job_results or {})[job_id]
local identity=result and result.target_identity
local index,matched
if identity and identity.platform_uid and identity.force_name=='player' then
  for _,platform in pairs(remote.call('surface_export','list_platforms','player')) do
    if platform.platform_index==identity.platform_index and platform.surface_index==identity.surface_index
      and platform.platform_uid==identity.platform_uid and platform.force_name==identity.force_name then
      assert(not matched,'Ambiguous clone identity')
      index,matched=platform.platform_index,true
    end
  end
end
return {success=true,index=index,jobId=job_id,active=active~=nil and active~=false,
  existingJobId=next(ids),identity=identity,identityMatched=matched==true,
  sourceStatus=source and source.status,sourceComplete=source and source.complete,
  sourceError=source_error or nil,
  error=active and ((active.completion_interrupted or {}).error or (active.setup_cleanup or {}).error)
    or result and result.error,
  status=result and result.status,complete=result and result.complete,
  validationSuccess=result and result.validation and result.validation.success}`;
}

export function completedCloneIndex(observation) {
	assert.equal(observation?.success, true, "Clone status unavailable");
	if (observation.sourceError || observation.error || ["failed", "interrupted"].includes(observation.status)
		|| observation.validationSuccess === false) {
		throw new Error(`Clone failed: ${observation.sourceError || observation.error || observation.status}`);
	}
	if (observation.sourceStatus === "complete" && observation.sourceComplete === true && !observation.jobId) {
		throw new Error("Clone import unavailable after export completion. Check the instance log for "
			+ "[Clone Platform] FAILED to queue import; retained job status may also have expired.");
	}
	if (observation.active !== false || observation.complete !== true || observation.status !== "complete"
		|| typeof observation.jobId !== "string" || !observation.jobId) return null;
	assert.equal(observation.identityMatched, true, "Completed clone identity unavailable or changed; preserve platforms");
	assert.ok(Number.isSafeInteger(observation.index) && observation.index >= 0,
		"Completed clone has no valid platform");
	return observation.index;
}

export async function waitForFixtureClone({ read, timeoutMs, sleep,
	now = () => performance.now(), pollMs = 250 }) {
	assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "Clone timeout must be positive");
	assert.ok(Number.isFinite(pollMs) && pollMs > 0, "Clone poll interval must be positive");
	const deadline = now() + timeoutMs;
	let last;
	while (now() < deadline) {
		last = await read();
		const index = completedCloneIndex(last);
		if (index !== null) return index;
		await sleep(pollMs);
	}
	throw new Error(`Clone import did not complete within ${timeoutMs} ms: ${JSON.stringify(last)}`);
}
