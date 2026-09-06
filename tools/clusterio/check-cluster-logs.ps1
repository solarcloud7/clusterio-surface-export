param(
    [string]$Grep = 'error|transfer|import|export|validation',
    [ValidateRange(1, 200)][int]$Lines = 30
)
node "$PSScriptRoot/read-cluster-logs.mjs" $Grep $Lines
if ($LASTEXITCODE -ne 0) { throw 'Some cluster log sources could not be read. See the bounded diagnostics above.' }
