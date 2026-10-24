$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'password-setup-result.ps1')
if ($env:AUTH_SETUP_ALLOW_WRITES -ne 'true') { throw 'Explicit AUTH_SETUP_ALLOW_WRITES=true authorization is required.' }
$passwordInput = Read-Host 'Password for the approved existing user (12-256 characters)' -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($passwordInput)
$authSetupProcess = $null
$authSetupResult = $null
$authSetupInputBytes = $null
try {
  $authSetupPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  $authSetupStart = New-Object System.Diagnostics.ProcessStartInfo
  $authSetupStart.FileName = 'node'
  $authSetupStart.Arguments = '"' + (Join-Path $PSScriptRoot 'set-user-password.js') + '"'
  $authSetupStart.UseShellExecute = $false
  $authSetupStart.CreateNoWindow = $true
  $authSetupStart.RedirectStandardInput = $true
  $authSetupStart.RedirectStandardOutput = $true
  $authSetupStart.RedirectStandardError = $true
  $authSetupProcess = [System.Diagnostics.Process]::Start($authSetupStart)
  $authSetupOutputTask = $authSetupProcess.StandardOutput.ReadToEndAsync()
  $authSetupErrorTask = $authSetupProcess.StandardError.ReadToEndAsync()
  $authSetupInputEncoding = New-Object System.Text.UTF8Encoding($false)
  $authSetupInputBytes = $authSetupInputEncoding.GetBytes($authSetupPassword + [Environment]::NewLine)
  $authSetupProcess.StandardInput.BaseStream.Write($authSetupInputBytes, 0, $authSetupInputBytes.Length)
  $authSetupProcess.StandardInput.BaseStream.Close()
  $authSetupProcess.WaitForExit()
  $authSetupResult = Get-PasswordSetupResult -OutputText $authSetupOutputTask.GetAwaiter().GetResult() -ChildExitCode $authSetupProcess.ExitCode
  $null = $authSetupErrorTask.GetAwaiter().GetResult()
  foreach ($warning in $authSetupResult.Warnings) { Write-Warning $warning -WarningAction Continue }
  if ($authSetupResult.Outcome -ne 'confirmed_success') { throw ($authSetupResult.Message + ' Child exit code=' + $authSetupResult.ChildExitCode) }
  Write-Output $authSetupResult.Message
} catch {
  if ($authSetupResult -and $authSetupResult.Outcome -eq 'confirmed_success') {
    Write-Warning 'Commit was confirmed, but wrapper reporting encountered an error. Do not rerun the password change.' -WarningAction Continue
  } elseif ($authSetupResult) { throw ($authSetupResult.Message + ' Child exit code=' + $authSetupResult.ChildExitCode) }
  else { throw 'Password setup could not be confirmed by the wrapper. Outcome is uncertain; do not retry writes. Verify the account read-only.' }
} finally {
  try { if ($authSetupProcess) { $authSetupProcess.Dispose() } } catch { Write-Warning 'Wrapper process cleanup failed; the reported commit outcome is unchanged.' -WarningAction Continue }
  try { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) } catch { Write-Warning 'Wrapper secure-buffer cleanup failed; the reported commit outcome is unchanged.' -WarningAction Continue }
  try { $passwordInput.Dispose() } catch { Write-Warning 'Wrapper input cleanup failed; the reported commit outcome is unchanged.' -WarningAction Continue }
  if ($authSetupInputBytes) { [Array]::Clear($authSetupInputBytes, 0, $authSetupInputBytes.Length) }
  Remove-Variable authSetupPassword -ErrorAction SilentlyContinue
}
