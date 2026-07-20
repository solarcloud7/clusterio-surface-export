<#
.SYNOPSIS
    Destination-hold primitive probe.

.DESCRIPTION
    Live proof for the Phase-2 destination hold primitive. This intentionally stays outside the normal
    transfer import path: it exercises the explicit destination_hold remote wrapper only.

    Invariants:
      * physical item/fluid totals match pre-stage, staged after time, restart-staged, and post-go-live
      * staged platform is paused, hidden, inactive, and behaviorally stable over ticks
      * hold identity survives platform rename (surface-index keyed)
      * discard succeeds and clears the hold when the platform was already externally deleted
      * go_live is not idempotent after success
      * an expired transfer lock respects an active destination hold: hidden, hold retained, lock cleared
#>
param(
    [string]$SourcePlatform = "test",
    [int]$SourceHost = 0,
    [double]$FluidEpsilon = 0.01,
    [int]$RestartTimeoutSec = 120,
    [string[]]$Sections = @("all")
)

$ErrorActionPreference = "Stop"
$ModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "lib\TestBase.psm1"
Import-Module $ModulePath -Force
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

Write-TestHeader "Destination Hold Primitive (not-live, fidelity, reversible)"

if ($SourceHost -eq 0) {
    $SourceHost = Resolve-PlatformHost -PlatformName $SourcePlatform
    if (-not $SourceHost) { Write-Status "Source platform '$SourcePlatform' not found on any host" -Type error; exit 1 }
}

$instance = "clusterio-host-$SourceHost-instance-1"
$sel = "${SourceHost}1"
$container = "surface-export-host-$SourceHost"
$failed = 0
$total = 0
$script:SelectedSections = @($Sections | ForEach-Object { $_ -split "," } | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
if ($script:SelectedSections.Count -eq 0) { $script:SelectedSections = @("all") }
$validSections = @("all", "main", "restart", "lifecycle", "double", "discard", "ttl", "cleanup")
foreach ($section in $script:SelectedSections) {
    if ($validSections -notcontains $section) {
        throw "Unknown destination-hold section '$section'. Valid sections: $($validSections -join ', ')"
    }
}

function ConvertTo-TestLuaLiteral {
    param([Parameter(Mandatory=$true)][AllowEmptyString()][string]$Value)
    return $Value.Replace('\', '\\').Replace("'", "\'")
}

function Test-Section {
    param([Parameter(Mandatory=$true)][string]$Name)
    return (($script:SelectedSections -contains "all") -or ($script:SelectedSections -contains $Name.ToLowerInvariant()))
}

function Invoke-ScopedRcon {
    param(
        [Parameter(Mandatory=$true)][string]$Instance,
        [Parameter(Mandatory=$true)][string]$Command
    )

    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ("destination-hold-rcon-" + [guid]::NewGuid().ToString("N") + ".err")
    try {
        $stdout = docker exec surface-export-controller npx clusterioctl --log-level error instance send-rcon $Instance $Command --config /clusterio/tokens/config-control.json 2>$stderrPath
        $exit = $LASTEXITCODE
        $stderr = ""
        if (Test-Path -LiteralPath $stderrPath) {
            $stderr = (Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue | Out-String).Trim()
        }
        if ($exit -ne 0) {
            $stdoutText = ([string]($stdout | Out-String)).Trim()
            throw "surface-export scoped RCON failed exit=$exit stderr=$stderr stdout=$stdoutText"
        }
        return ([string]($stdout | Out-String)).Trim()
    } finally {
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-LastNonEmptyLine {
    param([AllowNull()][AllowEmptyString()][string]$Text)
    $line = (((( [string]$Text ) -split "`r?`n") | Where-Object { ([string]$_).Trim() -ne "" }) | Select-Object -Last 1)
    if ($null -eq $line) { return "" }
    return ([string]$line).Trim()
}

function Invoke-ProbeJson {
    param([Parameter(Mandatory=$true)][string]$Body)
    $lua = "local ok,result=pcall(function() $Body end); if not ok then rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) else rcon.print(helpers.table_to_json(result)) end"
    $raw = Get-LastNonEmptyLine (Invoke-ScopedRcon -Instance $instance -Command "/sc $lua")
    try { return $raw | ConvertFrom-Json } catch { throw "Invalid JSON from probe: $raw" }
}

function Invoke-HoldJson {
    param(
        [Parameter(Mandatory=$true)][string]$Action,
        [Parameter(Mandatory=$true)][string]$TransferId,
        [Nullable[int]]$PlatformIndex = $null
    )
    $tid = ConvertTo-TestLuaLiteral $TransferId
    $idxArg = if ($null -eq $PlatformIndex) { "nil" } else { [string]$PlatformIndex }
    $lua = "rcon.print(remote.call('surface_export', 'destination_hold_json', '$Action', '$tid', $idxArg, 'player'))"
    $raw = Get-LastNonEmptyLine (Invoke-ScopedRcon -Instance $instance -Command "/sc $lua")
    try { return $raw | ConvertFrom-Json } catch { throw "Invalid destination_hold_json for ${Action}: $raw" }
}

function Add-Result {
    param([string]$Id, [string]$Name, [bool]$Ok, [string]$Message = "")
    $script:total++
    if ($Ok) {
        Write-TestResult -TestId $Id -TestName $Name -Status passed
    } else {
        Write-TestResult -TestId $Id -TestName $Name -Status failed -Message $Message
        $script:failed++
    }
}

function Get-ClusterioInstanceStatus {
    param([Parameter(Mandatory=$true)][string]$Instance)

    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ("destination-hold-ctl-" + [guid]::NewGuid().ToString("N") + ".err")
    try {
        $stdout = docker exec surface-export-controller npx clusterioctl --log-level error instance list --config /clusterio/tokens/config-control.json 2>$stderrPath
        $exit = $LASTEXITCODE
        $stderr = (Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue | Out-String).Trim()
        if ($exit -ne 0) {
            $stdoutText = ([string]($stdout | Out-String)).Trim()
            throw "surface-export scoped instance list failed exit=$exit stderr=$stderr stdout=$stdoutText"
        }
        foreach ($line in ($stdout | Out-String) -split "`r?`n") {
            if ($line -match ('^\s*' + [regex]::Escape($Instance) + '\s*\|')) {
                $parts = $line -split '\|'
                if ($parts.Count -ge 5) { return ([string]$parts[4]).Trim() }
            }
        }
        return $null
    } finally {
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
}
function Wait-ForRconReady {
    param(
        [Parameter(Mandatory=$true)][string]$Instance,
        [int]$TimeoutSec = 120
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastError = ""
    while ((Get-Date) -lt $deadline) {
        try {
            $status = Get-ClusterioInstanceStatus -Instance $Instance
            if ($status -ne "running") {
                $lastError = "instance status=$status"
                Start-Sleep -Seconds 2
                continue
            }
            $ready = Invoke-ScopedRcon -Instance $Instance -Command "/sc rcon.print('READY '..game.tick)"
            if ($ready -match '^READY\s+\d+') { return $true }
            $lastError = $ready
        } catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Seconds 2
    }
    throw "RCON not ready on $Instance after ${TimeoutSec}s: $lastError"
}

function Get-SaveState {
    param(
        [Parameter(Mandatory=$true)][string]$Container,
        [Parameter(Mandatory=$true)][string]$Instance,
        [Parameter(Mandatory=$true)][string]$SaveName
    )
    $savePath = "/clusterio/data/instances/$Instance/saves/$SaveName"
    $tmpPath = $savePath -replace '\.zip$', '.tmp.zip'
    $stat = ([string](docker exec $Container stat -c '%Y|%s|%i' $savePath 2>$null | Out-String)).Trim()
    if ($LASTEXITCODE -ne 0 -or $stat -notmatch '^(\d+)\|(\d+)\|(\d+)$') {
        throw "Could not stat primary save $savePath in $Container"
    }
    $saved_at = [long]$Matches[1]
    $save_size = [long]$Matches[2]
    $save_inode = [long]$Matches[3]
    docker exec $Container sh -c "test -e '$tmpPath'" 2>$null | Out-Null
    return [pscustomobject]@{
        saved_at = $saved_at
        size = $save_size
        inode = $save_inode
        tmp_exists = ($LASTEXITCODE -eq 0)
        save_path = $savePath
        tmp_path = $tmpPath
    }
}

function Get-ActiveSaveName {
    param(
        [Parameter(Mandatory=$true)][string]$Container,
        [Parameter(Mandatory=$true)][string]$Instance
    )
    $logPath = "/clusterio/data/instances/$Instance/factorio-current.log"
    $argsLine = ([string](docker exec $Container grep -m 1 -- '--start-server' $logPath 2>$null | Out-String)).Trim()
    if ($LASTEXITCODE -ne 0 -or $argsLine -notmatch '/saves/([^\"]+\.zip)\"') {
        throw "Could not determine active save from $logPath"
    }
    return $Matches[1]
}

function Wait-ForCompletedSave {
    param(
        [Parameter(Mandatory=$true)][string]$Container,
        [Parameter(Mandatory=$true)][string]$Instance,
        [Parameter(Mandatory=$true)][string]$SaveName,
        [Parameter(Mandatory=$true)][long]$BeforeTimestamp,
        [Parameter(Mandatory=$true)][long]$BeforeInode,
        [int]$TimeoutSec = 60
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $last = $null
    while ((Get-Date) -lt $deadline) {
        $last = Get-SaveState -Container $Container -Instance $Instance -SaveName $SaveName
        if ((-not $last.tmp_exists) -and ($last.saved_at -gt $BeforeTimestamp) `
            -and ($last.inode -ne $BeforeInode) -and ($last.size -gt 0)) {
            return $last
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Save did not complete its atomic rename within ${TimeoutSec}s: $($last | ConvertTo-Json -Compress)"
}

function Invoke-ServerSave {
    param(
        [Parameter(Mandatory=$true)][string]$Instance,
        [Parameter(Mandatory=$true)][string]$Container
    )
    try {
        $SaveName = Get-ActiveSaveName -Container $Container -Instance $Instance
        $before = Get-SaveState -Container $Container -Instance $Instance -SaveName $SaveName
        $raw = Invoke-ScopedRcon -Instance $Instance -Command "/server-save"
        $ok = ($raw -match '(?i)Saving the map|saved') -and ($raw -notmatch '(?i)session closed|error sending request|failed|denied')
        if (-not $ok) { return [pscustomobject]@{ Ok = $false; Message = $raw } }
        $completed = Wait-ForCompletedSave -Container $Container -Instance $Instance -SaveName $SaveName `
            -BeforeTimestamp $before.saved_at -BeforeInode $before.inode
        return [pscustomobject]@{
            Ok = $true
            Message = "$raw; completed=$($completed.save_path) timestamp=$($completed.saved_at) size=$($completed.size)"
        }
    } catch {
        return [pscustomobject]@{ Ok = $false; Message = $_.Exception.Message }
    }
}

function Clear-DestinationHoldRecords {
    $body = @"
local ids = {}
if storage.destination_holds then
    for transfer_id, _ in pairs(storage.destination_holds) do
        if type(transfer_id) == 'string' and string.find(transfer_id, '^dh%-') then
            ids[#ids + 1] = transfer_id
        end
    end
end
local cleared = 0
local errors = {}
for _, transfer_id in ipairs(ids) do
    local ok, result = pcall(function()
        return remote.call('surface_export', 'destination_hold', 'discard', transfer_id)
    end)
    if ok and result and result.success then
        cleared = cleared + 1
    else
        errors[#errors + 1] = transfer_id .. ': ' .. tostring(ok and result and result.error or result)
        if storage.destination_holds then storage.destination_holds[transfer_id] = nil end
    end
end
return { success = true, cleared = cleared, errors = errors }
"@
    return Invoke-ProbeJson -Body $body
}

function Get-DestinationHoldLeftovers {
    $body = @"
local ids = {}
if storage.destination_holds then
    for transfer_id, _ in pairs(storage.destination_holds) do
        ids[#ids + 1] = tostring(transfer_id)
    end
end
return { success = true, count = #ids, ids = ids }
"@
    return Invoke-ProbeJson -Body $body
}

function Get-LockedPlatformLeftovers {
    $body = @"
local ids = {}
if storage.locked_platforms then
    for key, lock in pairs(storage.locked_platforms) do
        local label = tostring(key)
        if type(lock) == 'table' then
            label = label .. ':' .. tostring(lock.platform_name or lock.transfer_id or lock.transfer_job_id or lock.kind)
        end
        ids[#ids + 1] = label
    end
end
return { success = true, count = #ids, ids = ids }
"@
    return Invoke-ProbeJson -Body $body
}

function Get-GamePausedState {
    return Invoke-ProbeJson -Body "return { success = true, paused = game.tick_paused == true }"
}

function Set-GamePaused {
    param([bool]$Pause)
    $value = if ($Pause) { "true" } else { "false" }
    return Invoke-ProbeJson -Body "game.tick_paused = $value; return { success = true, paused = game.tick_paused == true }"
}

function Get-DestholdSurfaceLeftovers {
    $body = @"
local names = {}
for _, surface in pairs(game.surfaces) do
    local platform = surface.platform
    if platform and platform.valid and string.find(platform.name, 'desthold-', 1, true) then
        names[#names + 1] = platform.name
    end
end
return { success = true, count = #names, names = names }
"@
    return Invoke-ProbeJson -Body $body
}
function Clear-TestLockRecords {
    $body = @"
local cleared = 0
if storage.locked_platforms then
    for key, lock in pairs(storage.locked_platforms) do
        local should_clear = false
        if type(lock) == 'table' then
            local tid = lock.transfer_id or lock.transfer_job_id or lock.job_id
            local platform_name = lock.platform_name
            should_clear = (type(tid) == 'string' and string.find(tid, '^dh%-') ~= nil)
                or (type(platform_name) == 'string' and string.find(platform_name, 'desthold-', 1, true) ~= nil)
        end
        if should_clear then
            storage.locked_platforms[key] = nil
            cleared = cleared + 1
        end
    end
end
return { success = true, cleared = cleared }
"@
    return Invoke-ProbeJson -Body $body
}

function New-BareHoldPlatform {
    param([string]$Prefix)
    $name = "$Prefix-$(Get-Date -Format 'HHmmss')-$([int](Get-Random -Minimum 100 -Maximum 999))"
    $escaped = ConvertTo-TestLuaLiteral $name
    $body = @"
local force = game.forces['player']
local name = '$escaped'
local ok_create, platform = pcall(function()
    return force.create_space_platform({
        name = name,
        planet = 'nauvis',
        starter_pack = 'space-platform-starter-pack'
    })
end)
if not ok_create then return { success = false, error = tostring(platform) } end
if not (platform and platform.valid) then return { success = false, error = 'create returned invalid platform' } end
local ok_pack, pack_err = pcall(function() platform.apply_starter_pack() end)
if not ok_pack then
    pcall(function() if platform.surface and platform.surface.valid then game.delete_surface(platform.surface) end end)
    return { success = false, error = 'apply_starter_pack failed: ' .. tostring(pack_err) }
end
if not (platform.surface and platform.surface.valid) then
    pcall(function() game.delete_surface(platform.surface) end)
    return { success = false, error = 'starter pack left no valid surface' }
end
platform.paused = true
force.set_surface_hidden(platform.surface, false)
return { success = true, name = platform.name, index = platform.index, surface_index = platform.surface.index }
"@
    $created = Invoke-ProbeJson -Body $body
    if (-not $created.success) { throw "Bare platform failed: $($created.error)" }
    return [pscustomobject]@{ Name = [string]$created.name; Index = [int]$created.index; SurfaceIndex = [int]$created.surface_index }
}

function New-HoldClone {
    param([string]$Prefix)
    $clone = "$Prefix-$(Get-Date -Format 'HHmmss')-$([int](Get-Random -Minimum 100 -Maximum 999))"
    $cl = New-TestPlatform -Instance $instance -SourcePlatform $SourcePlatform -DestPlatform $clone
    if (-not $cl.success) { throw "Clone failed: $($cl.error)" }
    if ($cl.job_id) {
        Wait-ForJob -Instances @($instance) -MaxWaitSeconds 90 -CheckScript "local j=(storage.async_jobs or {})['$($cl.job_id)']; rcon.print(j == nil and 'true' or 'false')" | Out-Null
    }
    Start-Sleep -Seconds 1
    $idx = Get-PlatformIndex -Instance $instance -PlatformName $clone
    if (-not $idx) { throw "Clone '$clone' did not materialize" }
    return [pscustomobject]@{ Name = $clone; Index = [int]$idx }
}

function Get-Metrics {
    param([int]$PlatformIndex)
    $body = @"
local force = game.forces['player']
local p = force.platforms[$PlatformIndex]
if not (p and p.valid) then return {success=false,error='missing platform'} end
local s = p.surface
local tracked_items = {['uranium-235']=true, ['uranium-238']=true}
local tracked_fluids = {['crude-oil']=true, ['heavy-oil']=true}
local activatable_types = {['assembling-machine']=true, ['furnace']=true, ['mining-drill']=true, ['lab']=true, ['rocket-silo']=true, ['agricultural-tower']=true, ['reactor']=true, ['generator']=true, ['burner-generator']=true, ['boiler']=true, ['fusion-reactor']=true, ['fusion-generator']=true, ['inserter']=true, ['loader']=true, ['loader-1x1']=true, ['pump']=true, ['offshore-pump']=true, ['roboport']=true, ['beacon']=true, ['radar']=true, ['thruster']=true, ['asteroid-collector']=true, ['cargo-bay']=true, ['space-platform-hub']=true, ['cargo-landing-pad']=true}
local item_total = 0
local fluid_total = 0
local machine_fluid_total = 0
local machine_fluid_direct_total = 0
local machine_fluid_segment_total = 0
local machine_fluid_boxes = {}
local counted_segments = {}
local active, activatable = 0, 0
local belt_iron = 0
for _, e in ipairs(s.find_entities_filtered({})) do
    if e.valid then
        if e.type == 'item-entity' and e.stack and e.stack.valid_for_read and tracked_items[e.stack.name] then
            item_total = item_total + e.stack.count
        elseif e.get_item_count then
            for item_name, _ in pairs(tracked_items) do
                local ok_all, n_all = pcall(function() return e.get_item_count(item_name) end)
                if ok_all and n_all then item_total = item_total + n_all end
            end
        end
        if activatable_types[e.type] then
            local ok_active, is_active = pcall(function() return e.active end)
            if ok_active and type(is_active) == 'boolean' then
                activatable = activatable + 1
                if is_active then active = active + 1 end
            end
        end
        if e.type == 'transport-belt' or e.type == 'underground-belt' or e.type == 'splitter' then
            local ok_iron, n_iron = pcall(function() return e.get_item_count('uranium-235') end)
            if ok_iron and n_iron then belt_iron = belt_iron + n_iron end
        end
        if e.fluidbox then
            pcall(function()
                for i = 1, #e.fluidbox do
                    local f = e.fluidbox[i]
                    local seg_id = e.fluidbox.get_fluid_segment_id(i)
                    local seg_contents = nil
                    if seg_id then seg_contents = e.fluidbox.get_fluid_segment_contents(i) end
                    if e.type == 'assembling-machine' then
                        local machine_box = {entity=e.name, unit_number=e.unit_number, index=i, segment_id=seg_id}
                        if f and f.amount and tracked_fluids[f.name] then
                            machine_box.direct = {name=f.name, amount=f.amount, temperature=f.temperature}
                            machine_fluid_total = machine_fluid_total + f.amount
                            machine_fluid_direct_total = machine_fluid_direct_total + f.amount
                        end
                        if seg_contents then
                            machine_box.segment_contents = seg_contents
                            for fluid_name, amount in pairs(seg_contents) do if tracked_fluids[fluid_name] then machine_fluid_segment_total = machine_fluid_segment_total + amount end end
                        end
                        machine_fluid_boxes[#machine_fluid_boxes + 1] = machine_box
                    end
                    if seg_id and not counted_segments[seg_id] then
                        counted_segments[seg_id] = true
                        if seg_contents then
                            for fluid_name, amount in pairs(seg_contents) do if tracked_fluids[fluid_name] then fluid_total = fluid_total + amount end end
                        end
                    elseif not seg_id then
                        if f and f.amount and tracked_fluids[f.name] then fluid_total = fluid_total + f.amount end
                    end
                end
            end)
        end
    end
end
local distance = nil
pcall(function() distance = p.distance end)
local schedule_records = -1
pcall(function() local sch = p.get_schedule(); schedule_records = (sch and sch.records and #sch.records) or (sch and sch.stations and #sch.stations) or 0 end)
return {
    success=true,
    name=p.name,
    index=p.index,
    surface_index=s.index,
    tick=game.tick,
    game_paused=game.tick_paused == true,
    paused=p.paused == true,
    platform_paused=p.paused == true,
    hidden=force.get_surface_hidden(s) == true,
    item_total=item_total,
    fluid_total=fluid_total,
    machine_fluid_total=machine_fluid_total,
    machine_fluid_direct_total=machine_fluid_direct_total,
    machine_fluid_segment_total=machine_fluid_segment_total,
    machine_fluid_boxes=machine_fluid_boxes,
    active_count=active,
    activatable_count=activatable,
    belt_iron=belt_iron,
    cargo_pods=s.count_entities_filtered({name='cargo-pod'}),
    distance=distance,
    schedule_records=schedule_records
}
"@
    $metrics = Invoke-ProbeJson -Body $body
    if (-not $metrics.success) { throw "metrics failed for platform ${PlatformIndex}: $($metrics.error)" }
    return $metrics
}
function Assert-MetricsEqual {
    param($Expected, $Actual, [string]$Label)
    $itemOk = ([int]$Expected.item_total -eq [int]$Actual.item_total)
    $fluidDelta = [Math]::Abs([double]$Expected.fluid_total - [double]$Actual.fluid_total)
    $fluidOk = $fluidDelta -le $FluidEpsilon
    $machineFluidDelta = [Math]::Abs([double]$Expected.machine_fluid_total - [double]$Actual.machine_fluid_total)
    $machineFluidOk = $machineFluidDelta -le $FluidEpsilon
    $beltOk = ([int]$Expected.belt_iron -eq [int]$Actual.belt_iron)
    $podOk = ([int]$Expected.cargo_pods -eq [int]$Actual.cargo_pods)
    $posOk = ([string]$Expected.distance -eq [string]$Actual.distance)
    $schedOk = ([int]$Expected.schedule_records -eq [int]$Actual.schedule_records)
    return [pscustomobject]@{
        Ok = ($itemOk -and $fluidOk -and $machineFluidOk -and $beltOk -and $podOk -and $posOk -and $schedOk)
        Message = "${Label}: tick $($Expected.tick)->$($Actual.tick), game_paused $($Expected.game_paused)->$($Actual.game_paused), platform_paused $($Expected.platform_paused)->$($Actual.platform_paused), items $($Expected.item_total)->$($Actual.item_total), fluids $($Expected.fluid_total)->$($Actual.fluid_total) delta=$fluidDelta, machine_fluids $($Expected.machine_fluid_total)->$($Actual.machine_fluid_total) delta=$machineFluidDelta, machine_direct $($Expected.machine_fluid_direct_total)->$($Actual.machine_fluid_direct_total), machine_segment $($Expected.machine_fluid_segment_total)->$($Actual.machine_fluid_segment_total), belt_iron $($Expected.belt_iron)->$($Actual.belt_iron), pods $($Expected.cargo_pods)->$($Actual.cargo_pods), distance $($Expected.distance)->$($Actual.distance), schedule $($Expected.schedule_records)->$($Actual.schedule_records)"
    }
}

function Install-AdversarialFixture {
    param([int]$PlatformIndex)
    $body = @"
local force = game.forces['player']
local p = force.platforms[$PlatformIndex]
if not (p and p.valid) then return {success=false,error='missing platform'} end
local s = p.surface
p.paused = true
force.set_surface_hidden(s, false)
local ox = 320 + ($PlatformIndex * 40)
local oy = 320
local tiles = {}
for x = -4, 8 do for y = -4, 8 do tiles[#tiles + 1] = {name='space-platform-foundation', position={ox+x, oy+y}} end end
s.set_tiles(tiles, true, false, true, false)
local created = {}
local function ent(spec)
    local ok, e = pcall(function() return s.create_entity(spec) end)
    if ok and e and e.valid then created[#created + 1] = e.name; return e end
    return nil
end
local chest = ent{name='steel-chest', position={ox, oy}, force=force}
if chest then chest.insert{name='uranium-235', count=50} end
local furnace = ent{name='stone-furnace', position={ox+2, oy}, force=force}
if furnace then
    pcall(function() furnace.insert{name='iron-ore', count=20} end)
    pcall(function() furnace.insert{name='coal', count=10} end)
    furnace.active = true
end
local belt1 = ent{name='transport-belt', position={ox, oy+2}, direction=defines.direction.east, force=force}
local belt2 = ent{name='transport-belt', position={ox+1, oy+2}, direction=defines.direction.east, force=force}
if belt1 then pcall(function() belt1.insert{name='uranium-235', count=4} end) end
if belt2 then pcall(function() belt2.insert{name='uranium-235', count=4} end) end
local ins = ent{name='fast-inserter', position={ox+3, oy}, direction=defines.direction.west, force=force}
if ins and ins.held_stack then pcall(function() ins.held_stack.set_stack{name='uranium-238', count=1} end); ins.active = true end
local pipe = ent{name='pipe', position={ox, oy+4}, force=force}
local tank = ent{name='storage-tank', position={ox+2, oy+4}, force=force}
if tank and tank.fluidbox then pcall(function() tank.fluidbox[1] = {name='crude-oil', amount=1000, temperature=25} end) end
if pipe and pipe.fluidbox then pcall(function() pipe.fluidbox[1] = {name='crude-oil', amount=100, temperature=25} end) end
local plant = ent{name='chemical-plant', position={ox+5, oy+4}, force=force}
local plant_fluid_written = 0
if plant then
    if force.recipes['heavy-oil-cracking'] then
        force.recipes['heavy-oil-cracking'].enabled = true
    end
    local recipe_ok, recipe_err = pcall(function() plant.set_recipe('heavy-oil-cracking') end)
    if not recipe_ok then return {success=false,error='set_recipe heavy-oil-cracking failed: '..tostring(recipe_err)} end
    if plant.fluidbox then
        local write_errors = {}
        for i = 1, #plant.fluidbox do
            local write_ok, write_err = pcall(function() plant.fluidbox[i] = {name='heavy-oil', amount=40, temperature=25} end)
            if not write_ok then write_errors[#write_errors + 1] = tostring(i) .. ':' .. tostring(write_err) end
            local written = plant.fluidbox[i]
            if written and written.name == 'heavy-oil' and written.amount and written.amount > 0 then
                plant_fluid_written = plant_fluid_written + written.amount
            end
        end
        if plant_fluid_written <= 0 then return {success=false,error='chemical plant heavy-oil write was rejected: '..table.concat(write_errors, '; ')} end
    end
    plant.active = true
end
return {success=true, created=created, plant_fluid_written=plant_fluid_written}
"@
    return Invoke-ProbeJson -Body $body
}

try {
    $runMain = (Test-Section "main") -or (Test-Section "restart") -or (Test-Section "lifecycle")
    if ($runMain) {
        $main = New-HoldClone -Prefix "desthold-main"
        Write-Status "Main clone ready: $($main.Name) index=$($main.Index)" -Type success
        $fixture = Install-AdversarialFixture -PlatformIndex $main.Index
        if (-not $fixture.success) { throw "Fixture failed: $($fixture.error)" }
        $pre = Get-Metrics -PlatformIndex $main.Index
        Add-Result "dh-fixture-grounded" "fixture has physical items and fluids (items=$($pre.item_total), fluids=$($pre.fluid_total), machine_fluids=$($pre.machine_fluid_total))" (($pre.item_total -gt 0) -and ($pre.fluid_total -gt 0)) "fixture failed to produce positive physical totals"
        Add-Result "dh-fixture-machine-fluid-grounded" "fixture has heavy oil physically accepted inside the crafting machine" (([double]$fixture.plant_fluid_written -gt 0) -and ([double]$pre.machine_fluid_total -gt 0)) "fixture=$($fixture | ConvertTo-Json -Compress); metrics=$($pre | ConvertTo-Json -Compress)"

        $tid = "dh-main-$(Get-Date -Format 'HHmmss')"
        $stage = Invoke-HoldJson -Action stage -TransferId $tid -PlatformIndex $main.Index
        Add-Result "dh-stage-ok" "stage returns success" ($stage.success -eq $true) ($stage.error | Out-String)
        $stagedNow = Get-Metrics -PlatformIndex $main.Index
        Add-Result "dh-stage-not-live" "staged platform is paused, hidden, and inactive" (($stagedNow.paused -eq $true) -and ($stagedNow.hidden -eq $true) -and ([int]$stagedNow.active_count -eq 0)) "paused=$($stagedNow.paused) hidden=$($stagedNow.hidden) active=$($stagedNow.active_count)/$($stagedNow.activatable_count)"

        Step-Tick -Instance $instance -Ticks 600 -EnsurePaused | Out-Null
        $staged600 = Get-Metrics -PlatformIndex $main.Index
        $cmp600 = Assert-MetricsEqual -Expected $pre -Actual $staged600 -Label "staged+600"
        Add-Result "dh-staged-fidelity" "physical totals and behavior stay unchanged while held for 600 ticks" $cmp600.Ok $cmp600.Message

        if (Test-Section "restart") {
            $save = Invoke-ServerSave -Instance $instance -Container $container
            Add-Result "dh-server-save-ok" "server save atomic rename completed before restart" $save.Ok $save.Message
            if (-not $save.Ok) { throw "server save failed before restart: $($save.Message)" }
            Wait-ForRconReady -Instance $instance -TimeoutSec 30 | Out-Null
            # Instance stop/start (not docker restart): the hold-durability measurand is the Factorio
            # process dying — Lua VM teardown, real exit-save + reload, save-patching, on_load. The
            # container/host-process layers belong to the deploy pipeline's coverage, and stop/start
            # is ~3x faster. Owner-adjudicated 2026-07-19 (the suite no longer touches docker).
            Write-Status "Restarting instance $instance mid-hold (clusterioctl stop/start)..." -Type info
            docker exec surface-export-controller npx clusterioctl --log-level error instance stop $instance --config /clusterio/tokens/config-control.json | Out-Null
            docker exec surface-export-controller npx clusterioctl --log-level error instance start $instance --config /clusterio/tokens/config-control.json | Out-Null
            Wait-ForRconReady -Instance $instance -TimeoutSec $RestartTimeoutSec | Out-Null
            $afterRestart = Get-Metrics -PlatformIndex $main.Index
            $cmpRestart = Assert-MetricsEqual -Expected $pre -Actual $afterRestart -Label "after-restart"
            Add-Result "dh-restart-durable" "hold persists across restart with fidelity and not-live state" ($cmpRestart.Ok -and $afterRestart.paused -and $afterRestart.hidden -and ([int]$afterRestart.active_count -eq 0)) ($cmpRestart.Message + "; paused=$($afterRestart.paused) hidden=$($afterRestart.hidden) active=$($afterRestart.active_count)")
        }

        if (Test-Section "lifecycle") {
            $renamed = "$($main.Name)-renamed"
            $renameLua = "local p=game.forces['player'].platforms[$($main.Index)]; if p and p.valid then p.name='$(ConvertTo-TestLuaLiteral $renamed)'; rcon.print('renamed') else rcon.print('missing') end"
            Invoke-ScopedRcon -Instance $instance -Command "/sc $renameLua" | Out-Null
            $go = Invoke-HoldJson -Action go_live -TransferId $tid
            Add-Result "dh-rename-go-live" "go_live resolves a renamed held platform" ($go.success -eq $true) ($go.error | Out-String)
            Step-Tick -Instance $instance -Ticks 60 -EnsurePaused | Out-Null
            $post = Get-Metrics -PlatformIndex $main.Index
            $cmpPost = Assert-MetricsEqual -Expected $pre -Actual $post -Label "post-go-live+60"
            Add-Result "dh-go-live-fidelity" "post-go-live physical totals match pre-stage" $cmpPost.Ok $cmpPost.Message
            Add-Result "dh-active-restored" "go_live restores original active states" ([int]$post.active_count -eq [int]$pre.active_count) "active $($pre.active_count)->$($post.active_count)"
            $go2 = Invoke-HoldJson -Action go_live -TransferId $tid
            Add-Result "dh-go-live-twice-fails" "second go_live fails cleanly" ($go2.success -eq $false) "second go_live unexpectedly succeeded"
        }
    }

    if (Test-Section "double") {
        $double = New-BareHoldPlatform -Prefix "desthold-double"
        $firstTid = "dh-double-a-$(Get-Date -Format 'HHmmss')"
        $secondTid = "dh-double-b-$(Get-Date -Format 'HHmmss')"
        $firstStage = Invoke-HoldJson -Action stage -TransferId $firstTid -PlatformIndex $double.Index
        Add-Result "dh-double-stage-first-ok" "first hold on a platform succeeds" ($firstStage.success -eq $true) ($firstStage | ConvertTo-Json -Compress)
        $secondStage = Invoke-HoldJson -Action stage -TransferId $secondTid -PlatformIndex $double.Index
        Add-Result "dh-double-stage-refuses" "second hold on the same platform under another transfer id refuses" (($secondStage.success -eq $false) -and ([string]$secondStage.error -match 'already held')) ($secondStage | ConvertTo-Json -Compress)
        Invoke-HoldJson -Action discard -TransferId $firstTid | Out-Null
    }
    if (Test-Section "discard") {
        $missing = New-BareHoldPlatform -Prefix "desthold-missing"
        $missTid = "dh-missing-$(Get-Date -Format 'HHmmss')"
        $missingStage = Invoke-HoldJson -Action stage -TransferId $missTid -PlatformIndex $missing.Index
        Add-Result "dh-discard-stage-ok" "stage succeeds before missing-platform discard probe" ($missingStage.success -eq $true) ($missingStage.error | Out-String)
        $deleteBody = "local p=game.forces['player'].platforms[$($missing.Index)]; if not (p and p.valid and p.surface and p.surface.valid) then return {success=false,error='missing before delete'} end; local ok, err = pcall(function() game.delete_surface(p.surface) end); return {success=ok,error=tostring(err)}"
        $deleteResult = Invoke-ProbeJson -Body $deleteBody
        Add-Result "dh-discard-delete-ok" "test platform can be externally deleted before discard" ($deleteResult.success -eq $true) ($deleteResult.error | Out-String)
        Step-Tick -Instance $instance -Ticks 2 -EnsurePaused | Out-Null
        $discard = Invoke-HoldJson -Action discard -TransferId $missTid
        $getAfterDiscard = Invoke-HoldJson -Action get -TransferId $missTid
        Add-Result "dh-discard-missing-clears" "discard clears an already-missing held platform" (($discard.success -eq $true) -and ($null -eq $getAfterDiscard.hold)) "discard=$($discard | ConvertTo-Json -Compress) get=$($getAfterDiscard | ConvertTo-Json -Compress)"
    }

    if (Test-Section "ttl") {
        $ttl = New-BareHoldPlatform -Prefix "desthold-ttl"
        $ttlTid = "dh-ttl-$(Get-Date -Format 'HHmmss')"
        $lockBody = "local p=game.forces['player'].platforms[$($ttl.Index)]; if not (p and p.valid) then return {success=false,error='missing platform'} end; storage.locked_platforms = storage.locked_platforms or {}; storage.locked_platforms[p.index] = {kind='transfer', transfer_id='$ttlTid', transfer_job_id='$ttlTid', platform_name=p.name, platform_index=p.index, force_name='player', surface_index=p.surface.index, original_hidden=false, locked_tick=game.tick, expires_tick=game.tick + 3600, frozen_states={}}; game.forces['player'].set_surface_hidden(p.surface, true); return {success=true, hidden=game.forces['player'].get_surface_hidden(p.surface) == true}"
        $lockResult = Invoke-ProbeJson -Body $lockBody
        Add-Result "dh-ttl-lock-ok" "fresh transfer lock hides the bare held platform before staging" ($lockResult.success -eq $true -and $lockResult.hidden -eq $true) ($lockResult | ConvertTo-Json -Compress)
        $ttlStage = Invoke-HoldJson -Action stage -TransferId $ttlTid -PlatformIndex $ttl.Index
        Add-Result "dh-ttl-stage-ok" "stage succeeds before TTL hold-respect probe" ($ttlStage.success -eq $true) ($ttlStage.error | Out-String)
        $expireBody = "local p=game.forces['player'].platforms[$($ttl.Index)]; if not (p and p.valid) then return {success=false,error='missing platform'} end; local lock=(storage.locked_platforms or {})[p.index]; if not lock then return {success=false,error='lock missing'} end; lock.locked_tick=game.tick - 2; lock.expires_tick=game.tick - 1; return {success=true, expires_tick=lock.expires_tick}"
        $expireResult = Invoke-ProbeJson -Body $expireBody
        Add-Result "dh-ttl-expire-ok" "TTL probe forces the transfer lock into the expired window after staging" ($expireResult.success -eq $true) ($expireResult | ConvertTo-Json -Compress)
        Step-Tick -Instance $instance -Ticks 61 -EnsurePaused | Out-Null
        $ttlMetrics = Get-Metrics -PlatformIndex $ttl.Index
        $ttlHoldAfter = Invoke-HoldJson -Action get -TransferId $ttlTid
        $ttlLockAfter = Invoke-ProbeJson -Body "local p=game.forces['player'].platforms[$($ttl.Index)]; if not (p and p.valid) then return {success=false,error='missing platform'} end; return {success=true, locked=(storage.locked_platforms or {})[p.index] ~= nil}"
        Add-Result "dh-ttl-expiry-respects-hold" "expired transfer lock keeps the held destination hidden, retains the hold, and clears the lock" (($lockResult.success -eq $true) -and ($ttlStage.success -eq $true) -and ($expireResult.success -eq $true) -and ($ttlMetrics.hidden -eq $true) -and ($null -ne $ttlHoldAfter.hold) -and ($ttlLockAfter.success -eq $true) -and ($ttlLockAfter.locked -eq $false)) "hidden after expiry=$($ttlMetrics.hidden); hold=$($ttlHoldAfter | ConvertTo-Json -Compress); lock_after=$($ttlLockAfter | ConvertTo-Json -Compress); lock=$($lockResult | ConvertTo-Json -Compress); stage=$($ttlStage | ConvertTo-Json -Compress); expire=$($expireResult | ConvertTo-Json -Compress)"
        Invoke-HoldJson -Action discard -TransferId $ttlTid | Out-Null
    }
}
finally {
    try { Wait-ForRconReady -Instance $instance -TimeoutSec 60 | Out-Null } catch { Write-Status "RCON not ready during cleanup: $($_.Exception.Message)" -Type warning }
    try { Clear-DestinationHoldRecords | Out-Null } catch { Write-Status "Destination-hold cleanup failed: $($_.Exception.Message)" -Type warning }
    try { Clear-TestLockRecords | Out-Null } catch { Write-Status "Test lock cleanup failed: $($_.Exception.Message)" -Type warning }
    try { Remove-PlatformSurfacesWhere -Instance $instance -PredicateLua "string.find(p.name, 'desthold-', 1, true)" | Out-Null } catch { Write-Status "Surface cleanup failed: $($_.Exception.Message)" -Type warning }
    try { Step-Tick -Instance $instance -Ticks 2 -EnsurePaused | Out-Null } catch { Write-Status "Cleanup tick failed: $($_.Exception.Message)" -Type warning }
    try { Set-GamePaused -Pause $false | Out-Null } catch { Write-Status "Unpause cleanup failed: $($_.Exception.Message)" -Type warning }
}

try {
    $leftoverHolds = Get-DestinationHoldLeftovers
    Add-Result "dh-cleanup-no-hold-records" "cleanup leaves storage.destination_holds empty" ([int]$leftoverHolds.count -eq 0) ($leftoverHolds | ConvertTo-Json -Compress)
} catch {
    Add-Result "dh-cleanup-no-hold-records" "cleanup leaves storage.destination_holds empty" $false $_.Exception.Message
}
try {
    $leftoverLocks = Get-LockedPlatformLeftovers
    Add-Result "dh-cleanup-no-lock-records" "cleanup leaves storage.locked_platforms empty" ([int]$leftoverLocks.count -eq 0) ($leftoverLocks | ConvertTo-Json -Compress)
} catch {
    Add-Result "dh-cleanup-no-lock-records" "cleanup leaves storage.locked_platforms empty" $false $_.Exception.Message
}
try {
    $leftoverSurfaces = Get-DestholdSurfaceLeftovers
    Add-Result "dh-cleanup-no-surfaces" "cleanup leaves zero desthold-* platform surfaces" ([int]$leftoverSurfaces.count -eq 0) ($leftoverSurfaces | ConvertTo-Json -Compress)
} catch {
    Add-Result "dh-cleanup-no-surfaces" "cleanup leaves zero desthold-* platform surfaces" $false $_.Exception.Message
}
try {
    $paused = Get-GamePausedState
    Add-Result "dh-cleanup-game-unpaused" "cleanup leaves the game unpaused" ($paused.paused -eq $false) ($paused | ConvertTo-Json -Compress)
} catch {
    Add-Result "dh-cleanup-game-unpaused" "cleanup leaves the game unpaused" $false $_.Exception.Message
}

Write-TestSummary -Passed ($total - $failed) -Failed $failed
if ($failed -gt 0) { exit 1 }
exit 0
