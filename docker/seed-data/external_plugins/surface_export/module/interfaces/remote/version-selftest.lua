-- FactorioSurfaceExport - Version-compat self-test (remote)
-- Pure-function assertions for utils/version-compat.lua. `require` does not resolve module paths from
-- the /sc sandbox, so this runs the unit checks IN the module context and returns a structured result
-- that an integration test (or RCON) can assert on. A permanent drift-detector for the dispatch layer.

local VersionCompat = require("modules/surface_export/utils/version-compat")

--- Run the version-compat self-test.
--- @return table: { passed, failed, total, details = { {name, ok, msg}, ... } }
local function version_selftest()
  local details = {}
  local passed, failed = 0, 0

  local function check(name, cond, msg)
    if cond then
      passed = passed + 1
      details[#details + 1] = { name = name, ok = true }
    else
      failed = failed + 1
      details[#details + 1] = { name = name, ok = false, msg = msg or "assertion failed" }
    end
  end

  -- parse(): components + major.minor bucket
  local p = VersionCompat.parse("2.0.76")
  check("parse_2_0_76_bucket", p and p.bucket == "2.0", "expected bucket 2.0, got " .. tostring(p and p.bucket))
  check("parse_2_0_76_components", p and p.major == 2 and p.minor == 0 and p.patch == 76,
    "expected 2/0/76, got " .. tostring(p and p.major) .. "/" .. tostring(p and p.minor) .. "/" .. tostring(p and p.patch))
  local p21 = VersionCompat.parse("2.1.10")
  check("parse_2_1_10_bucket", p21 and p21.bucket == "2.1", "expected 2.1, got " .. tostring(p21 and p21.bucket))
  local pnp = VersionCompat.parse("2.0")
  check("parse_no_patch", pnp and pnp.bucket == "2.0" and pnp.patch == nil, "patch should be nil when absent")
  check("parse_garbage_nil", VersionCompat.parse("not-a-version") == nil, "garbage should parse to nil")
  check("parse_nil_nil", VersionCompat.parse(nil) == nil, "nil should parse to nil")

  -- runtime_bucket(): this engine is 2.1.x (cluster + CI on Factorio 2.1.11 since 2026-07-21)
  check("runtime_bucket_2_1", VersionCompat.runtime_bucket() == "2.1",
    "expected runtime 2.1, got " .. tostring(VersionCompat.runtime_bucket()))

  -- has_profile(): both dispatch profiles exist (2.0 retained for source-data-shape dispatch)
  check("has_profile_2_0", VersionCompat.has_profile("2.0") == true, "2.0 profile must exist")
  check("has_profile_2_1", VersionCompat.has_profile("2.1") == true, "2.1 profile must exist")

  -- resolve_for(): known bucket resolves itself; unknown/nil falls back loudly to newest known (2.1)
  local used20, fb20 = VersionCompat.resolve_for("2.0")
  check("resolve_2_0", used20 == "2.0" and fb20 == false, "2.0 should resolve to 2.0 without fallback")
  local used21, fb21 = VersionCompat.resolve_for("2.1")
  check("resolve_2_1", used21 == "2.1" and fb21 == false, "2.1 should resolve to 2.1 without fallback")
  local used99, fb99 = VersionCompat.resolve_for("9.9")
  check("resolve_unknown_fallback", used99 == "2.1" and fb99 == true, "unknown bucket should fall back to newest known (2.1)")
  local usednil, fbnil = VersionCompat.resolve_for(nil)
  check("resolve_nil_fallback", usednil == "2.1" and fbnil == true, "nil bucket should fall back to newest known (2.1)")

  -- migrate(): identity when source == runtime; best-effort (non-nil) on a mismatch
  local payload = { factorio_version = "2.0.76", marker = 1 }
  check("migrate_identity", VersionCompat.migrate(payload, "2.0", "2.0") == payload, "same-bucket migrate must return the same table")
  check("migrate_mismatch_nonnil", VersionCompat.migrate(payload, "2.0", "2.1") ~= nil, "cross-bucket migrate must return a payload (best-effort)")

  return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return version_selftest
