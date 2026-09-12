local status=dofile("docker/seed-data/external_plugins/surface_export/module/core/job-status.lua")
storage={source_recovery_epoch="runtime",async_jobs={},async_job_results={}}
game={tick=3000}
local job={type="import",job_id="import_1",operation_id="1:source",started_tick=1,
  setup_pending=true,section_decoder={next=1}}
storage.async_jobs.import_1=job
assert(status.read("import_1").state=="queued")
assert(status.read("import_1").elapsedTicks==2999)
job.last_step_tick=game.tick
local first=status.read("import_1")
game.tick=6000; job.last_step_tick=game.tick
assert(status.read("import_1").work.sectionsDecoded==first.work.sectionsDecoded,"visits are not progress")
job.section_decoder.next=2
assert(status.read("import_1").work.sectionsDecoded==1)
job.pending_beacon_tick=game.tick+1
assert(status.read("import_1").state=="waiting")
job.completion_interrupted={error="fault"}
assert(status.read("import_1").state=="interrupted")
job.setup_cleanup={next_tick=game.tick+60,error="remove failed"}
assert(status.read("import_1").state=="cleanup-pending")
storage.async_jobs.import_1=nil
assert(status.read("import_1").state=="unavailable")
storage.async_job_results.import_1={status="complete",validation={success=false}}
assert(status.read("import_1").state=="failed","completed processing is not a successful import")
print("PASS: job state uses persisted phases, work cursors and exact ticks")
