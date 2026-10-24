$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'password-setup-result.ps1')
$assertionCount = 0
function Assert-OfflineResult {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
  $script:assertionCount++
}
function New-OfflineReport {
  param([string]$Outcome, [bool]$Attempted, [bool]$Confirmed, [string]$Stage = 'commit')
  return @{ protocol = 'tea-password-setup-v1'; outcome = $Outcome; stage = $Stage; code = $(if ($Confirmed) { 'SETUP_COMMITTED' } else { 'SETUP_FAILED' }); commitAttempted = $Attempted; commitConfirmed = $Confirmed; cleanupWarnings = @(); error = @{ name = 'MongoServerError'; code = 91; labels = @('UnknownTransactionCommitResult') } }
}
$success = New-OfflineReport 'confirmed_success' $true $true
$result = Get-PasswordSetupResult ($success | ConvertTo-Json -Depth 8 -Compress) 0
Assert-OfflineResult ($result.Outcome -eq 'confirmed_success') 'Confirmed commit was not preserved.'
$success.cleanupWarnings = @(@{ stage = 'cleanup'; operation = 'disconnect'; error = @{ name = 'MongoNetworkError'; code = 'ECONNRESET'; labels = @() } })
$result = Get-PasswordSetupResult ($success | ConvertTo-Json -Depth 8 -Compress) 0
Assert-OfflineResult ($result.Outcome -eq 'confirmed_success') 'Cleanup error overwrote a confirmed commit.'
Assert-OfflineResult ($result.Warnings.Count -ge 1) 'Cleanup warning was not retained.'
$result = Get-PasswordSetupResult ($success | ConvertTo-Json -Depth 8 -Compress) 1
Assert-OfflineResult ($result.Outcome -eq 'confirmed_success') 'Child exit code overwrote explicit commit confirmation.'
Assert-OfflineResult ($result.ChildExitCode -eq 1) 'Child exit code was lost.'
$failed = New-OfflineReport 'confirmed_failure_before_commit' $false $false 'validation'
$failed.error.code = 'DATABASE_MISMATCH'
$result = Get-PasswordSetupResult ($failed | ConvertTo-Json -Depth 8 -Compress) 1
Assert-OfflineResult ($result.Outcome -eq 'confirmed_failure_before_commit') 'Pre-commit failure was misclassified.'
Assert-OfflineResult ($result.Message.Contains('DATABASE_MISMATCH')) 'Safe validation code was lost.'
$result = Get-PasswordSetupResult ($failed | ConvertTo-Json -Depth 8 -Compress) 0
Assert-OfflineResult ($result.Outcome -eq 'uncertain_commit') 'Inconsistent child result was accepted.'
$uncertain = New-OfflineReport 'uncertain_commit' $true $false
$result = Get-PasswordSetupResult ($uncertain | ConvertTo-Json -Depth 8 -Compress) 2
Assert-OfflineResult ($result.Outcome -eq 'uncertain_commit') 'Unknown commit was misclassified.'
Assert-OfflineResult ($result.Message.Contains('UnknownTransactionCommitResult')) 'Safe MongoDB label was lost.'
Assert-OfflineResult ($result.Message.Contains('Do not retry writes')) 'Uncertainty did not stop retries.'
foreach ($output in @('', 'private-marker', '{broken-json')) {
  $result = Get-PasswordSetupResult $output 1
  Assert-OfflineResult ($result.Outcome -eq 'uncertain_commit') 'Unstructured output was accepted.'
  Assert-OfflineResult (-not $result.Message.Contains('private-marker')) 'Raw child output leaked.'
}
$unsafe = New-OfflineReport 'uncertain_commit' $true $false
$unsafe.error = @{ name = 'private-marker'; code = 'private-marker'; labels = @('private-marker','UnknownTransactionCommitResult'); message = 'private-marker'; stack = 'private-marker' }
$unsafe.account = 'private-marker'
$result = Get-PasswordSetupResult ($unsafe | ConvertTo-Json -Depth 8 -Compress) 2
Assert-OfflineResult (-not ($result | ConvertTo-Json -Depth 8).Contains('private-marker')) 'Sensitive diagnostic field leaked.'
$unsafe.stage = 'private-marker'
$result = Get-PasswordSetupResult ($unsafe | ConvertTo-Json -Depth 8 -Compress) 2
Assert-OfflineResult ($result.Outcome -eq 'uncertain_commit') 'Invalid stage was accepted.'
Assert-OfflineResult (-not $result.Message.Contains('private-marker')) 'Invalid stage leaked.'
$duplicate = ($success | ConvertTo-Json -Depth 8 -Compress) + [Environment]::NewLine + ($failed | ConvertTo-Json -Depth 8 -Compress)
$result = Get-PasswordSetupResult $duplicate 1
Assert-OfflineResult ($result.Outcome -eq 'uncertain_commit') 'Conflicting reports were accepted.'
Write-Output ('Password setup result parser: ' + $assertionCount + ' offline assertions passed. No setup script or database access was used.')
