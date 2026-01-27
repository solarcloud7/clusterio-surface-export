# Decode a Factorio blueprint string to JSON
# Usage: .\decode-blueprint.ps1 -BlueprintString "0eNqVkd..." -OutputFile "blueprint.json"

param(
    [Parameter(Mandatory=$true)]
    [string]$BlueprintString,
    
    [Parameter(Mandatory=$false)]
    [string]$OutputFile
)

# Strip version byte (first character, usually "0")
$versionByte = $BlueprintString.Substring(0, 1)
$encoded = $BlueprintString.Substring(1)

Write-Host "Blueprint version byte: $versionByte"
Write-Host "Encoded length: $($encoded.Length) characters"

# Base64 decode
$compressedBytes = [System.Convert]::FromBase64String($encoded)
Write-Host "Compressed size: $($compressedBytes.Length) bytes"

# Zlib decompress (skip 2-byte zlib header, use DeflateStream)
$inputStream = New-Object System.IO.MemoryStream(,$compressedBytes)
$inputStream.Position = 2  # Skip zlib header
$outputStream = New-Object System.IO.MemoryStream
$deflateStream = New-Object System.IO.Compression.DeflateStream($inputStream, [System.IO.Compression.CompressionMode]::Decompress)

try {
    $deflateStream.CopyTo($outputStream)
    $decompressedBytes = $outputStream.ToArray()
    Write-Host "Decompressed size: $($decompressedBytes.Length) bytes"
    
    # Convert to JSON string
    $jsonString = [System.Text.Encoding]::UTF8.GetString($decompressedBytes)
    
    # Pretty print JSON
    $jsonObject = $jsonString | ConvertFrom-Json
    $prettyJson = $jsonObject | ConvertTo-Json -Depth 100
    
    if ($OutputFile) {
        $prettyJson | Out-File -FilePath $OutputFile -Encoding UTF8
        Write-Host "`nBlueprint decoded and saved to: $OutputFile" -ForegroundColor Green
    } else {
        Write-Host "`n--- Blueprint JSON ---" -ForegroundColor Cyan
        Write-Host $prettyJson
    }
    
    # Show summary
    Write-Host "`n--- Summary ---" -ForegroundColor Yellow
    Write-Host "Blueprint name: $($jsonObject.blueprint.label)"
    if ($jsonObject.blueprint.entities) {
        Write-Host "Entity count: $($jsonObject.blueprint.entities.Count)"
        Write-Host "Entity types: $($jsonObject.blueprint.entities | Select-Object -ExpandProperty name -Unique | Sort-Object)"
    }
    if ($jsonObject.blueprint.tiles) {
        Write-Host "Tile count: $($jsonObject.blueprint.tiles.Count)"
    }
    
} catch {
    Write-Error "Failed to decode blueprint: $_"
} finally {
    $deflateStream.Close()
    $inputStream.Close()
    $outputStream.Close()
}
