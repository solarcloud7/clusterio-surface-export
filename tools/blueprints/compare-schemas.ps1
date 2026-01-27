param (
    [Parameter(Mandatory=$false)]
    [string]$BlueprintFile = ".\tools\decoded_blueprint.json",
    
    [Parameter(Mandatory=$false)]
    [string]$ExportFile = ".\tools\export_test_138006_export_5.json"
)

$ErrorActionPreference = "Stop"

Write-Host "Schema Comparison Tool" -ForegroundColor Cyan
Write-Host "=====================" -ForegroundColor Cyan
Write-Host ""

# Load both files
Write-Host "Loading files..." -ForegroundColor Yellow
$blueprint = Get-Content $BlueprintFile -Raw | ConvertFrom-Json
$export = Get-Content $ExportFile -Raw | ConvertFrom-Json

$bpEntities = $blueprint.blueprint.entities
$expEntities = $export.entities

Write-Host "Blueprint entities: $($bpEntities.Count)" -ForegroundColor Green
Write-Host "Export entities: $($expEntities.Count)" -ForegroundColor Green
Write-Host ""

# Function to get all properties recursively
function Get-PropertyPaths {
    param($obj, $prefix = "")
    
    $paths = @()
    
    if ($null -eq $obj) {
        return @($prefix)
    }
    
    if ($obj -is [System.Collections.IEnumerable] -and $obj -isnot [string]) {
        if ($obj.Count -gt 0) {
            $paths += Get-PropertyPaths -obj $obj[0] -prefix "$prefix[0]"
        } else {
            $paths += "$prefix[]"
        }
    } elseif ($obj -is [PSCustomObject]) {
        $obj.PSObject.Properties | ForEach-Object {
            $propName = $_.Name
            $propValue = $_.Value
            $newPrefix = if ($prefix) { "$prefix.$propName" } else { $propName }
            $paths += Get-PropertyPaths -obj $propValue -prefix $newPrefix
        }
        if ($paths.Count -eq 0) {
            $paths += $prefix
        }
    } else {
        $paths += $prefix
    }
    
    return $paths
}

# Group entities by type
Write-Host "Analyzing entity types..." -ForegroundColor Yellow
$bpByType = $bpEntities | Group-Object -Property name
$expByType = $expEntities | Group-Object -Property name

Write-Host "Blueprint entity types: $($bpByType.Count)" -ForegroundColor Gray
Write-Host "Export entity types: $($expByType.Count)" -ForegroundColor Gray
Write-Host ""

# Compare a few entity types
$entitiesToCheck = @("laser-turret", "railgun-turret", "inserter", "asteroid-collector", "cargo-bay")

foreach ($entityType in $entitiesToCheck) {
    $bpEntity = $bpEntities | Where-Object { $_.name -eq $entityType } | Select-Object -First 1
    $expEntity = $expEntities | Where-Object { $_.name -eq $entityType } | Select-Object -First 1
    
    if (-not $bpEntity -and -not $expEntity) {
        continue
    }
    
    Write-Host "=== $entityType ===" -ForegroundColor Cyan
    
    if (-not $bpEntity) {
        Write-Host "  ⚠ Not found in blueprint" -ForegroundColor Yellow
        continue
    }
    if (-not $expEntity) {
        Write-Host "  ⚠ Not found in export" -ForegroundColor Yellow
        continue
    }
    
    # Get all properties from both
    $bpProps = Get-PropertyPaths -obj $bpEntity | Sort-Object -Unique
    $expProps = Get-PropertyPaths -obj $expEntity | Sort-Object -Unique
    
    # Filter out array indices and normalize
    $bpProps = $bpProps | ForEach-Object { $_ -replace '\[\d+\]', '[]' } | Sort-Object -Unique
    $expProps = $expProps | ForEach-Object { $_ -replace '\[\d+\]', '[]' } | Sort-Object -Unique
    
    # Find missing properties
    $missingInExport = $bpProps | Where-Object { $_ -notin $expProps }
    $extraInExport = $expProps | Where-Object { $_ -notin $bpProps }
    
    if ($missingInExport.Count -gt 0) {
        Write-Host "  ❌ Missing in export:" -ForegroundColor Red
        $missingInExport | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }
    }
    
    if ($extraInExport.Count -gt 0) {
        Write-Host "  ℹ️  Extra in export (not in blueprint):" -ForegroundColor DarkGray
        $extraInExport | ForEach-Object { Write-Host "    - $_" -ForegroundColor DarkGray }
    }
    
    if ($missingInExport.Count -eq 0 -and $extraInExport.Count -eq 0) {
        Write-Host "  ✅ Schemas match!" -ForegroundColor Green
    }
    
    Write-Host ""
}

# Summary comparison
Write-Host "=== Overall Property Analysis ===" -ForegroundColor Cyan
Write-Host ""

# Sample multiple entities of each type and aggregate all properties
$allBpProps = @{}
$allExpProps = @{}

foreach ($group in $bpByType) {
    $entityType = $group.Name
    $entities = $group.Group | Select-Object -First 3
    
    $props = @()
    foreach ($entity in $entities) {
        $props += Get-PropertyPaths -obj $entity
    }
    $props = $props | ForEach-Object { $_ -replace '\[\d+\]', '[]' } | Sort-Object -Unique
    $allBpProps[$entityType] = $props
}

foreach ($group in $expByType) {
    $entityType = $group.Name
    $entities = $group.Group | Select-Object -First 3
    
    $props = @()
    foreach ($entity in $entities) {
        $props += Get-PropertyPaths -obj $entity
    }
    $props = $props | ForEach-Object { $_ -replace '\[\d+\]', '[]' } | Sort-Object -Unique
    $allExpProps[$entityType] = $props
}

# Find entity types with missing properties
$entityTypesWithIssues = @()

foreach ($entityType in $allBpProps.Keys) {
    if ($allExpProps.ContainsKey($entityType)) {
        $bpProps = $allBpProps[$entityType]
        $expProps = $allExpProps[$entityType]
        
        $missing = $bpProps | Where-Object { $_ -notin $expProps }
        
        if ($missing.Count -gt 0) {
            $entityTypesWithIssues += [PSCustomObject]@{
                EntityType = $entityType
                MissingCount = $missing.Count
                MissingProps = $missing
            }
        }
    }
}

if ($entityTypesWithIssues.Count -gt 0) {
    Write-Host "Entity types with missing properties:" -ForegroundColor Yellow
    Write-Host ""
    
    $entityTypesWithIssues | Sort-Object MissingCount -Descending | ForEach-Object {
        Write-Host "  $($_.EntityType) - Missing $($_.MissingCount) properties:" -ForegroundColor Yellow
        $_.MissingProps | ForEach-Object {
            Write-Host "    - $_" -ForegroundColor Red
        }
        Write-Host ""
    }
} else {
    Write-Host "✅ All blueprint properties are present in export!" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Key Differences ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Blueprint format: Compact, structure-only (no inventories/fluids)" -ForegroundColor Gray
Write-Host "Export format: Complete, includes inventories, fluids, train schedules" -ForegroundColor Gray
Write-Host ""
Write-Host "Properties that SHOULD be different:" -ForegroundColor Yellow
Write-Host "  - Export has 'inventories' (blueprint doesn't)" -ForegroundColor Gray
Write-Host "  - Export has 'specific_data' (entity-specific runtime data)" -ForegroundColor Gray
Write-Host "  - Blueprint has 'entity_number' (export doesn't need sequential IDs)" -ForegroundColor Gray
Write-Host ""
