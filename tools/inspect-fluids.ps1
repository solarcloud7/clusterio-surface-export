<#
.SYNOPSIS
    Inspects live fluid state on a platform via RCON.
.PARAMETER Instance
    Instance number (1 or 2). Default: 2.
#>
param(
    [ValidateSet("1","2")]
    [string]$Instance = "2"
)

. "$PSScriptRoot\cluster-utils.ps1"

$InstInfo = Get-InstanceByHostNumber $Instance
if (-not $InstInfo) {
    Write-Error "Could not discover instance $Instance. Is the cluster running?"
    exit 1
}

Write-Host "=== Live Fluid State (Instance $Instance — $($InstInfo.Name)) ===" -ForegroundColor Cyan

$LuaScript = @'
/sc local total=0; local counts={}; local plat_name="none"
for _,surf in pairs(game.surfaces) do
  if surf.platform then
    plat_name = surf.platform.name
    for _,e in pairs(surf.find_entities_filtered({})) do
      if e.fluidbox then
        for i=1,#e.fluidbox do
          local f=e.fluidbox[i]
          if f then
            total=total+f.amount
            local key=string.format("%s@%.1fC", f.name, f.temperature)
            counts[key]=(counts[key] or 0)+f.amount
          end
        end
      end
    end
  end
end
rcon.print(string.format("Platform: %s", plat_name))
rcon.print(string.format("Total fluids: %.1f", total))
rcon.print("---")
local sorted={}; for k,v in pairs(counts) do table.insert(sorted,{k,v}) end
table.sort(sorted, function(a,b) return a[2]>b[2] end)
for _,entry in ipairs(sorted) do
  rcon.print(string.format("  %-40s %10.1f", entry[1], entry[2]))
end
'@

Send-RCON -InstanceName $InstInfo.Name -Command $LuaScript
