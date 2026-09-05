# CIM Win32_Process truncates creation timestamps to microseconds. Compare that
# precision, without a time tolerance that could admit a reused process ID.
function Get-ProcessBirthTicks($CreationDate) {
    if ($null -eq $CreationDate) { return $null }
    try {
        $ticks = ([DateTime]$CreationDate).ToUniversalTime().Ticks
        if ($ticks -le 0) { return $null }
        return $ticks - ($ticks % 10)
    } catch { return $null }
}

function Get-OwnedProcessRows([int]$RootProcessId, [DateTime]$RootStartTime, $ProcessTable, [hashtable]$KnownProcesses = @{}) {
    $rootBirth = Get-ProcessBirthTicks $RootStartTime
    $rows = @{}
    $ambiguous = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($entry in $ProcessTable) {
        $entryId = [int]$entry.ProcessId
        if ($ambiguous.Contains($entryId)) { continue }
        if ($rows.ContainsKey($entryId)) {
            $rows.Remove($entryId)
            [void]$ambiguous.Add($entryId)
        } else { $rows[$entryId] = $entry }
    }
    $owned = @{}
    if ($rows.ContainsKey($RootProcessId) -and $null -ne $rootBirth -and
        (Get-ProcessBirthTicks $rows[$RootProcessId].CreationDate) -eq $rootBirth) {
        $owned[$RootProcessId] = $rootBirth
    }
    # Previously pinned identities remain owned when an intermediate parent
    # exits. Match the full identity; a reused PID is never an ownership anchor.
    foreach ($entry in $rows.Values) {
        $birth = Get-ProcessBirthTicks $entry.CreationDate
        if ($null -ne $birth -and $KnownProcesses.ContainsKey("$($entry.ProcessId):$birth")) {
            $owned[[int]$entry.ProcessId] = $birth
        }
    }
    if (-not $owned.Count) { return }
    do {
        $before = $owned.Count
        foreach ($entry in $rows.Values) {
            $entryId = [int]$entry.ProcessId
            $parentId = [int]$entry.ParentProcessId
            if ($owned.ContainsKey($entryId) -or -not $owned.ContainsKey($parentId)) { continue }
            $birth = Get-ProcessBirthTicks $entry.CreationDate
            if ($null -ne $birth -and $birth -ge $owned[$parentId]) { $owned[$entryId] = $birth }
        }
    } while ($owned.Count -gt $before)
    foreach ($entryId in $owned.Keys) { $rows[$entryId] }
}

function Get-VerifiedProcessSamples($Rows, [hashtable]$OwnedProcesses, [scriptblock]$ResolveProcess = {
    param($ProcessId)
    [System.Diagnostics.Process]::GetProcessById($ProcessId)
}) {
    foreach ($row in $Rows) {
        $birth = Get-ProcessBirthTicks $row.CreationDate
        if ($null -eq $birth) { continue }
        $key = "$($row.ProcessId):$birth"
        $known = $OwnedProcesses.ContainsKey($key)
        $candidate = $null
        try {
            $candidate = if ($known) { $OwnedProcesses[$key] } else { & $ResolveProcess ([int]$row.ProcessId) }
            if ($null -eq $candidate) { continue }
            # Pin the kernel process before reading its identity. A PID lookup
            # alone can race exit/reuse between the CIM snapshot and this call.
            if ($candidate.Handle -eq [IntPtr]::Zero) { throw "Process handle unavailable" }
            $candidate.Refresh()
            if ($candidate.HasExited -or $candidate.Id -ne [int]$row.ProcessId -or
                (Get-ProcessBirthTicks $candidate.StartTime) -ne $birth) {
                if (-not $known) { $candidate.Dispose() }
                continue
            }
            $OwnedProcesses[$key] = $candidate
            [pscustomobject]@{ Process = $candidate; Row = $row }
        } catch {
            if ($null -ne $candidate -and -not $known) { $candidate.Dispose() }
        }
    }
}

function Get-OwnedCpuSecondsDelta([hashtable]$OwnedProcesses, [hashtable]$PreviousCpu) {
    $delta = 0.0
    foreach ($entry in $OwnedProcesses.GetEnumerator()) {
        $previous = $PreviousCpu[$entry.Key]
        if ($null -ne $previous -and $previous.Exited) { continue }
        $process = $entry.Value
        $process.Refresh()
        $exited = $process.HasExited
        # Pinned handles retain process times after exit. Read that final total
        # once, including CPU used between the last live sample and termination.
        $seconds = [double]$process.TotalProcessorTime.TotalSeconds
        if ([double]::IsNaN($seconds) -or [double]::IsInfinity($seconds) -or $seconds -lt 0) {
            throw "Invalid CPU counter for owned process $($entry.Key)"
        }
        $before = if ($null -eq $previous) { 0.0 } else { $previous.Seconds }
        if ($seconds -lt $before) { throw "CPU counter moved backwards for owned process $($entry.Key)" }
        $delta += $seconds - $before
        $PreviousCpu[$entry.Key] = [pscustomobject]@{ Seconds = $seconds; Exited = $exited }
    }
    return $delta
}

function Stop-CapturedAuditProcesses([hashtable]$OwnedProcesses) {
    # Never resolve a PID here: only pinned, birth-verified kernel handles may
    # survive the root and be considered for forced cleanup.
    foreach ($owned in $OwnedProcesses.Values) {
        try {
            if (-not $owned.HasExited -and -not $owned.WaitForExit(500)) {
                $owned.Kill()
                [void]$owned.WaitForExit(3000)
            }
        } catch { if (-not $owned.HasExited) { throw } }
    }
}
