function Format-PasswordSetupSafeError {
  param($Diagnostic)
  $safeNames = @('Error','TypeError','RangeError','ValidationError','CastError','MongoServerError','MongoServerSelectionError','MongoNetworkError','MongoNetworkTimeoutError','MongoOperationTimeoutError','MongoParseError','MongooseError','PasswordSetupError')
  $safeCodes = @('WRITE_AUTH_REQUIRED','DATABASE_MISMATCH','INVALID_SHOP_ID','INVALID_USER_EMAIL','PASSWORD_INPUT_REQUIRED','PASSWORD_POLICY_FAILED','TARGET_NOT_FOUND','TARGET_CHANGED','SESSION_INTERFACE_INVALID','COMMIT_NOT_CONFIRMED','MONGODB_URI_REQUIRED','JWT_SECRET_REQUIRED','JWT_SECRET_INVALID','CLIENT_ORIGIN_INVALID','COOKIE_POLICY_INVALID','DNS_POLICY_INVALID','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','ECONNRESET','EACCES','EPERM','ENOENT','EIO','UNCLASSIFIED')
  $safeLabels = @('TransientTransactionError','UnknownTransactionCommitResult','RetryableWriteError','NoWritesPerformed')
  $safeName = if ($Diagnostic.name -is [string] -and $Diagnostic.name -cin $safeNames) { $Diagnostic.name } else { 'Error' }
  $safeCode = 'UNCLASSIFIED'
  if ($Diagnostic.code -is [ValueType] -and $Diagnostic.code -isnot [bool]) {
    $number = [double]$Diagnostic.code
    if ($number -ge 0 -and $number -le 2147483647 -and $number -eq [Math]::Truncate($number)) { $safeCode = [string][long]$number }
  } elseif ($Diagnostic.code -is [string] -and $Diagnostic.code -cin $safeCodes) { $safeCode = $Diagnostic.code }
  $labels = @($safeLabels | Where-Object { $_ -cin @($Diagnostic.labels) })
  return ('name=' + $safeName + '; code=' + $safeCode + '; labels=' + ($labels -join ','))
}

function Get-PasswordSetupResult {
  param([string]$OutputText, [int]$ChildExitCode)
  $unknown = [pscustomobject]@{ Outcome = 'uncertain_commit'; Message = 'Password setup outcome is uncertain: no consistent sanitized report was received. Do not retry writes; verify the account read-only.'; Warnings = @(); ChildExitCode = $ChildExitCode }
  $reports = @()
  foreach ($line in ($OutputText -split '\r?\n')) {
    try { $candidate = ConvertFrom-Json -InputObject $line -ErrorAction Stop } catch { continue }
    if ($candidate.protocol -ceq 'tea-password-setup-v1') { $reports += $candidate }
  }
  if ($reports.Count -ne 1) { return $unknown }
  $report = $reports[0]
  if ($report.stage -cnotin @('validation','connection','transaction_read','transaction_write','commit','cleanup')) { return $unknown }
  if ($report.code -cnotin @('SETUP_COMMITTED','SETUP_FAILED')) { return $unknown }
  $warnings = @()
  foreach ($warning in @($report.cleanupWarnings)) {
    if ($warning.stage -ceq 'cleanup' -and $warning.operation -cin @('end_session','disconnect','restore_commit')) {
      $warnings += ('Cleanup warning (' + $warning.operation + '): ' + (Format-PasswordSetupSafeError $warning.error))
    }
  }
  if ($report.outcome -ceq 'confirmed_success' -and $report.code -ceq 'SETUP_COMMITTED' -and $report.commitConfirmed -is [bool] -and $report.commitConfirmed -and $report.commitAttempted -is [bool] -and $report.commitAttempted) {
    if ($report.error) { $warnings += ('Post-commit reporting warning: ' + (Format-PasswordSetupSafeError $report.error)) }
    if ($ChildExitCode -ne 0) { $warnings += 'The child exited unexpectedly after reporting a confirmed commit. Do not rerun the password change.' }
    return [pscustomobject]@{ Outcome = 'confirmed_success'; Message = 'Password change commit confirmed. Existing user sessions were revoked.'; Warnings = $warnings; ChildExitCode = $ChildExitCode }
  }
  if ($report.code -cne 'SETUP_FAILED' -or $report.commitConfirmed -isnot [bool] -or $report.commitConfirmed) { return $unknown }
  $detail = Format-PasswordSetupSafeError $report.error
  if ($report.commitError) { $detail += '; commit diagnostic: ' + (Format-PasswordSetupSafeError $report.commitError) }
  if ($report.outcome -ceq 'confirmed_failure_before_commit' -and $report.commitAttempted -is [bool] -and -not $report.commitAttempted -and $ChildExitCode -eq 1) {
    return [pscustomobject]@{ Outcome = 'confirmed_failure_before_commit'; Message = ('Password setup failed before commit. Stage=' + $report.stage + '; ' + $detail); Warnings = $warnings; ChildExitCode = $ChildExitCode }
  }
  if ($report.outcome -ceq 'uncertain_commit') {
    return [pscustomobject]@{ Outcome = 'uncertain_commit'; Message = ('Password setup commit outcome is uncertain. Stage=' + $report.stage + '; ' + $detail + '. Do not retry writes; verify the account read-only.'); Warnings = $warnings; ChildExitCode = $ChildExitCode }
  }
  return $unknown
}
