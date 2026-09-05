$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../windows/ProcessOwnership.ps1")
$script:checks = [System.Collections.Generic.List[string]]::new()

function Assert-Ownership($Condition, [string]$Name) {
    if (-not $Condition) { throw "Ownership assertion failed: $Name" }
    $script:checks.Add($Name)
}

function New-Row([int]$ProcessId, [int]$ParentId, $Created) {
    [pscustomobject]@{ ProcessId = $ProcessId; ParentProcessId = $ParentId; CreationDate = $Created }
}

function New-FakeProcess([int]$ProcessId, [DateTime]$Created, [bool]$DenyHandle = $false) {
    $fake = [pscustomobject]@{
        Id = $ProcessId; Birth = $Created; HasExited = $false; HandleOpened = $false
        DenyHandle = $DenyHandle; Disposed = $false; Kills = 0; Refreshes = 0
        CpuSeconds = 0.0
    }
    $fake | Add-Member ScriptProperty Handle {
        if ($this.DenyHandle) { throw "Access denied" }
        $this.HandleOpened = $true
        [IntPtr]1
    }
    $fake | Add-Member ScriptProperty StartTime {
        if (-not $this.HandleOpened) { throw "Identity read before handle capture" }
        $this.Birth
    }
    $fake | Add-Member ScriptProperty TotalProcessorTime {
        if (-not $this.HandleOpened) { throw "CPU read before handle capture" }
        [TimeSpan]::FromSeconds($this.CpuSeconds)
    }
    $fake | Add-Member ScriptMethod Refresh { $this.Refreshes++ }
    $fake | Add-Member ScriptMethod Dispose { $this.Disposed = $true }
    $fake | Add-Member ScriptMethod WaitForExit { param($Timeout) return $this.HasExited }
    $fake | Add-Member ScriptMethod Kill { $this.Kills++; $this.HasExited = $true }
    return $fake
}

$start = [DateTime]::Parse("2026-09-05T12:00:00Z").ToUniversalTime()
$rows = @(
    (New-Row 300 200 $start.AddSeconds(2)),
    (New-Row 401 400 $start.AddSeconds(5)),
    (New-Row 501 500 $start.AddSeconds(2)),
    (New-Row 502 501 $start.AddSeconds(9)),
    (New-Row 200 100 $start.AddSeconds(1)),
    (New-Row 400 100 $start.AddSeconds(-1)),
    (New-Row 500 100 $start.AddSeconds(8)),
    (New-Row 600 999 $start.AddSeconds(4)),
    (New-Row 700 100 $null),
    (New-Row 100 42 $start)
)
$selected = @(Get-OwnedProcessRows 100 $start $rows)
$selectedIds = ($selected | ForEach-Object { $_.ProcessId } | Sort-Object) -join ','
Assert-Ownership ($selectedIds -eq '100,200,300,500') 'tree requires every ancestor and rejects older orphan descendants'
Assert-Ownership (@(Get-OwnedProcessRows 100 $start ($rows | Where-Object ProcessId -ne 100)).Count -eq 0) 'missing root establishes no new ownership'
$reusedRoot = @($rows | Where-Object ProcessId -ne 100) + @(New-Row 100 42 $start.AddSeconds(10))
Assert-Ownership (@(Get-OwnedProcessRows 100 $start $reusedRoot).Count -eq 0) 'reused root PID rejects the whole tree'
Assert-Ownership (@(Get-OwnedProcessRows 100 $start ($rows + @(New-Row 100 42 $start))).Count -eq 0) 'ambiguous snapshot identity fails closed'
Assert-Ownership ((Get-ProcessBirthTicks $start.AddTicks(9)) -eq (Get-ProcessBirthTicks $start)) 'CIM microsecond truncation matches native creation time'
Assert-Ownership ((Get-ProcessBirthTicks $start.AddTicks(10)) -ne (Get-ProcessBirthTicks $start)) 'birth comparison does not admit a later microsecond'
Assert-Ownership ($null -eq (Get-ProcessBirthTicks 'invalid')) 'invalid creation time fails closed'

$root = New-FakeProcess 100 $start.AddTicks(7)
$child = New-FakeProcess 200 $start.AddSeconds(1)
$script:processFixtures = @{ 100 = $root; 200 = $child }
$resolver = { param($ProcessId) $script:processFixtures[$ProcessId] }
$registry = @{}
$currentRows = @($rows | Where-Object { $_.ProcessId -in @(100, 200) })
$samples = @(Get-VerifiedProcessSamples $currentRows $registry $resolver)
Assert-Ownership ($samples.Count -eq 2 -and $registry.Count -eq 2) 'only verified handles enter the sampling and cleanup registry'
Assert-Ownership ($root.HandleOpened -and $child.HandleOpened) 'handles are pinned before identity reads'
$null = @(Get-VerifiedProcessSamples $currentRows $registry { throw 'Known handles must not be re-resolved by PID' })
Assert-Ownership ($root.Refreshes -eq 2 -and $child.Refreshes -eq 2) 'retained handles refresh resource counters without PID lookup'

$replacement = New-FakeProcess 300 $start.AddSeconds(20)
$script:processFixtures[300] = $replacement
$raced = @(Get-VerifiedProcessSamples @($rows | Where-Object ProcessId -eq 300) $registry $resolver)
Assert-Ownership ($raced.Count -eq 0 -and $replacement.Disposed) 'PID reused between snapshot and handle acquisition is rejected and disposed'
$denied = New-FakeProcess 800 $start.AddSeconds(3) $true
$script:processFixtures[800] = $denied
Assert-Ownership (@(Get-VerifiedProcessSamples @(New-Row 800 100 $start.AddSeconds(3)) $registry $resolver).Count -eq 0) 'uncapturable handle is never sampled or owned'
Assert-Ownership $denied.Disposed 'failed handle acquisition disposes its wrapper'
$exited = New-FakeProcess 900 $start.AddSeconds(4)
$exited.HasExited = $true
$script:processFixtures[900] = $exited
Assert-Ownership (@(Get-VerifiedProcessSamples @(New-Row 900 100 $start.AddSeconds(4)) $registry $resolver).Count -eq 0) 'process exiting before capture is not sampled'

$root.HasExited = $true
$unrelatedReusedRoot = New-FakeProcess 100 $start.AddSeconds(30)
$script:processFixtures[100] = $unrelatedReusedRoot
$null = @(Get-VerifiedProcessSamples @() $registry $resolver)
Stop-CapturedAuditProcesses $registry
Assert-Ownership ($child.Kills -eq 1 -and $root.Kills -eq 0) 'root exit retains and cleans up previously captured children only'
Assert-Ownership ($unrelatedReusedRoot.Kills -eq 0 -and $replacement.Kills -eq 0 -and $denied.Kills -eq 0) 'cleanup never kills replacements or unverified processes'
Stop-CapturedAuditProcesses $registry
Assert-Ownership ($child.Kills -eq 1) 'captured-handle cleanup is idempotent'

# A live captured grandchild remains owned after its intermediate parent exits,
# and can establish ownership of children it creates later.
$orphanRoot = New-FakeProcess 100 $start
$orphanParent = New-FakeProcess 200 $start.AddSeconds(1)
$orphanChild = New-FakeProcess 300 $start.AddSeconds(2)
$orphanGrandchild = New-FakeProcess 350 $start.AddSeconds(3)
$script:orphanFixtures = @{ 100 = $orphanRoot; 200 = $orphanParent; 300 = $orphanChild; 350 = $orphanGrandchild }
$orphanResolver = { param($ProcessId) $script:orphanFixtures[$ProcessId] }
$orphanRegistry = @{}
$originalTree = @((New-Row 100 42 $start), (New-Row 200 100 $start.AddSeconds(1)), (New-Row 300 200 $start.AddSeconds(2)))
$captured = @(Get-VerifiedProcessSamples @(Get-OwnedProcessRows 100 $start $originalTree) $orphanRegistry $orphanResolver)
Assert-Ownership ($captured.Count -eq 3) 'complete original ancestry pins the eventual orphan identity'
$orphanParent.HasExited = $true
$orphanTree = @((New-Row 100 42 $start), (New-Row 300 200 $start.AddSeconds(2)), (New-Row 350 300 $start.AddSeconds(3)),
    (New-Row 200 999 $start.AddSeconds(20)), (New-Row 201 200 $start.AddSeconds(21)))
$retainedRows = @(Get-OwnedProcessRows 100 $start $orphanTree $orphanRegistry)
Assert-Ownership ((($retainedRows | ForEach-Object ProcessId | Sort-Object) -join ',') -eq '100,300,350') 'pinned orphan ancestry survives parent exit without admitting its reused PID'
$retained = @(Get-VerifiedProcessSamples $retainedRows $orphanRegistry $orphanResolver)
Assert-Ownership ($retained.Count -eq 3 -and @($retained | Where-Object { $_.Process -eq $orphanChild }).Count -eq 1) 'resource samples retain the live pinned orphan and its new child'
$reusedOrphan = @((New-Row 100 42 $start), (New-Row 300 999 $start.AddSeconds(40)), (New-Row 351 300 $start.AddSeconds(41)))
Assert-Ownership ((@(Get-OwnedProcessRows 100 $start $reusedOrphan $orphanRegistry) | ForEach-Object ProcessId) -eq 100) 'a reused orphan PID cannot establish ownership of unrelated descendants'
$withoutRoot = @($orphanTree | Where-Object ProcessId -ne 100)
Assert-Ownership (((@(Get-OwnedProcessRows 100 $start $withoutRoot $orphanRegistry) | ForEach-Object ProcessId | Sort-Object) -join ',') -eq '300,350') 'root exit does not erase previously pinned live resources'

$cpuRoot = New-FakeProcess 100 $start
$cpuChild = New-FakeProcess 200 $start.AddSeconds(1)
$cpuRoot.CpuSeconds = 2.0
$cpuChild.CpuSeconds = 1.0
$script:cpuFixtures = @{ 100 = $cpuRoot; 200 = $cpuChild }
$cpuRegistry = @{}
$cpuLedger = @{}
$null = @(Get-VerifiedProcessSamples $currentRows $cpuRegistry { param($ProcessId) $script:cpuFixtures[$ProcessId] })
Assert-Ownership ((Get-OwnedCpuSecondsDelta $cpuRegistry $cpuLedger) -eq 3.0) 'initial CPU sample includes each captured lifetime once'
$cpuRoot.CpuSeconds = 2.5
$cpuChild.CpuSeconds = 1.25
Assert-Ownership ((Get-OwnedCpuSecondsDelta $cpuRegistry $cpuLedger) -eq 0.75) 'live CPU samples sum per-identity increments'
$cpuRoot.CpuSeconds = 3.0
$cpuChild.CpuSeconds = 1.5
$cpuChild.HasExited = $true
Assert-Ownership ((Get-OwnedCpuSecondsDelta $cpuRegistry $cpuLedger) -eq 0.75) 'final exited-child CPU is counted instead of subtracting its lifetime'
$cpuReplacement = New-FakeProcess 200 $start.AddSeconds(30)
$cpuReplacement.CpuSeconds = 0.4
$script:cpuFixtures[200] = $cpuReplacement
$null = @(Get-VerifiedProcessSamples @(New-Row 200 100 $start.AddSeconds(30)) $cpuRegistry { param($ProcessId) $script:cpuFixtures[$ProcessId] })
$cpuRoot.CpuSeconds = 3.5
Assert-Ownership ([Math]::Abs((Get-OwnedCpuSecondsDelta $cpuRegistry $cpuLedger) - 0.9) -lt 0.000001) 'replacement PID starts a separate CPU lifetime without hiding other work'
$refreshesAtExit = $cpuChild.Refreshes
Assert-Ownership ((Get-OwnedCpuSecondsDelta $cpuRegistry $cpuLedger) -eq 0 -and $cpuChild.Refreshes -eq $refreshesAtExit) 'completed CPU lifetimes are not queried or counted again'
$cpuReplacement.CpuSeconds = 0.1
$backwardsRejected = $false
try { Get-OwnedCpuSecondsDelta $cpuRegistry $cpuLedger | Out-Null } catch { $backwardsRejected = $true }
Assert-Ownership $backwardsRejected 'invalid decreasing lifetime counters fail instead of fabricating zero CPU'

# Read-only live check of the timestamp representation on this Windows host.
$self = [System.Diagnostics.Process]::GetCurrentProcess()
$selfRow = Get-CimInstance Win32_Process -Filter "ProcessId=$($self.Id)"
$selfRegistry = @{}
$selfSamples = @(Get-VerifiedProcessSamples @(Get-OwnedProcessRows $self.Id $self.StartTime @($selfRow)) $selfRegistry)
Assert-Ownership ($selfSamples.Count -eq 1) 'actual CIM and Process.StartTime identities match'
$sampledProcess = $selfSamples[0].Process
Assert-Ownership ($null -ne $sampledProcess.CPU -and $sampledProcess.CPU -ge 0 -and $sampledProcess.WorkingSet64 -gt 0 -and $sampledProcess.Handles -gt 0) 'captured Process handles expose the resource counters used by the launcher'
foreach ($captured in $selfRegistry.Values) { $captured.Dispose() }
$self.Dispose()

# A process created by this test supplies a pinned handle even after termination.
$helperInfo = [System.Diagnostics.ProcessStartInfo]::new()
$helperInfo.FileName = $env:ComSpec
$helperInfo.Arguments = '/c exit 0'
$helperInfo.UseShellExecute = $false
$helperInfo.CreateNoWindow = $true
$helper = [System.Diagnostics.Process]::Start($helperInfo)
try {
    [void]$helper.Handle
    $helperKey = "$($helper.Id):$(Get-ProcessBirthTicks $helper.StartTime)"
    [void]$helper.WaitForExit(5000)
    $helperLedger = @{}
    $helperDelta = Get-OwnedCpuSecondsDelta @{ $helperKey = $helper } $helperLedger
    Assert-Ownership ($helperDelta -ge 0 -and $helperLedger[$helperKey].Exited) 'actual pinned Windows handle exposes final CPU time after process exit'
} finally { $helper.Dispose() }

@{ checks = @($script:checks); count = $script:checks.Count } | ConvertTo-Json -Depth 3 -Compress
