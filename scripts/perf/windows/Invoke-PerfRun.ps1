[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ApplicationPath,
    [string]$FixturePath,
    [string]$ScenarioId = "startup-warm-b50-p1-light",
    [string]$Variant = "current",
    [string]$RunId,
    [ValidateSet("Online", "Offline")]
    [string]$NetworkMode = "Online",
    [ValidateRange(1, 86400)]
    [int]$DurationSeconds = 20,
    [ValidateRange(50, 10000)]
    [int]$SampleIntervalMilliseconds = 250,
    [string]$OutputDirectory = "perf-results/runs",
    [string]$ApplicationArguments = "",
    [string]$ReusableWebViewDataDirectory,
    [ValidateRange(0, 65535)]
    [int]$CdpPort = 0,
    [switch]$AllowUnverifiedExecutable,
    [switch]$AllowExistingInstance,
    [switch]$PreserveSandbox
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "ProcessOwnership.ps1")
$script:auditProcess = $null
$script:ownedAuditProcesses = @{}
$application = (Resolve-Path -LiteralPath $ApplicationPath).Path
if ([System.IO.Path]::GetExtension($application) -ne ".exe") {
    throw "ApplicationPath must identify a Windows .exe: $application"
}
$auditMarkerPath = Join-Path ([System.IO.Path]::GetDirectoryName($application)) ([System.IO.Path]::GetFileNameWithoutExtension($application) + ".perf-audit.json")
$verifiedAuditBuild = $false
if (Test-Path -LiteralPath $auditMarkerPath -PathType Leaf) {
    try {
        $auditMarker = Get-Content -LiteralPath $auditMarkerPath -Raw | ConvertFrom-Json
        $actualHash = (Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash.ToLowerInvariant()
        $verifiedAuditBuild = $auditMarker.feature -eq "perf-audit" -and $auditMarker.executable_sha256 -eq $actualHash
    } catch { throw "Could not verify audit executable marker: $($_.Exception.Message)" }
}
if (-not $verifiedAuditBuild -and -not $AllowUnverifiedExecutable) {
    throw "The executable does not have a matching perf-audit safety marker. Build it with Build-PerfAudit.ps1. Use -AllowUnverifiedExecutable only inside a disposable Windows user account or VM; production builds may ignore the audit app-data override."
}
$processName = [System.IO.Path]::GetFileNameWithoutExtension($application)
$existingInstances = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
if ($existingInstances.Count -gt 0 -and -not $AllowExistingInstance) {
    throw "An existing $processName process is running. Close it before auditing so Tauri's single-instance handoff cannot reach real app data. Pass -AllowExistingInstance only when the existing process is itself an isolated lab instance."
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "../../..")).Path
$outputRoot = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
    [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
    [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputDirectory))
}
[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$runId = if ([string]::IsNullOrWhiteSpace($RunId)) { [Guid]::NewGuid().ToString("N") } else { $RunId.Trim() }
if ($runId -notmatch '^[A-Za-z0-9._-]{1,80}$') { throw "RunId may contain only letters, numbers, dot, underscore, and hyphen (maximum 80 characters)." }
$runOutput = Join-Path $outputRoot $runId
[System.IO.Directory]::CreateDirectory($runOutput) | Out-Null

$sandboxParent = Join-Path ([System.IO.Path]::GetTempPath()) "MIDIMaster-perf"
[System.IO.Directory]::CreateDirectory($sandboxParent) | Out-Null
$sandboxRoot = Join-Path $sandboxParent $runId
[System.IO.Directory]::CreateDirectory($sandboxRoot) | Out-Null

function Assert-ChildPath([string]$Parent, [string]$Child) {
    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $childFull = [System.IO.Path]::GetFullPath($Child)
    if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing operation outside $Parent`: $Child"
    }
}

function Add-ResultRecord([hashtable]$Record) {
    $base = [ordered]@{
        schema_version = "1.0.0"
        run_id = $runId
        scenario_id = $ScenarioId
        variant = $Variant
        timestamp = [DateTime]::UtcNow.ToString("o")
        kind = $Record.kind
        metric = $Record.metric
        value = [double]$Record.value
        unit = $Record.unit
        commit = $script:commit
        build = [System.IO.Path]::GetFileName($application)
        dimensions = $Record.dimensions
        hardware = $script:hardware
    }
    $line = $base | ConvertTo-Json -Depth 8 -Compress
    [System.IO.File]::AppendAllText((Join-Path $runOutput "process.ndjson"), "$line`n", [System.Text.UTF8Encoding]::new($false))
}

function Get-NetworkByteTotal {
    try {
        $statistics = @(Get-NetAdapterStatistics -ErrorAction Stop)
        $received = [int64](($statistics | Measure-Object ReceivedBytes -Sum).Sum)
        $sent = [int64](($statistics | Measure-Object SentBytes -Sum).Sum)
        return $received + $sent
    }
    catch {
        return $null
    }
}

function Stop-OwnedAuditProcess {
    if (-not $script:auditProcess) { return }
    if (-not $script:auditProcess.HasExited) {
        try {
            $remainingTable = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate)
            $ownedRows = @(Get-OwnedProcessRows $script:auditProcess.Id $script:rootStartTime $remainingTable)
            Get-VerifiedProcessSamples $ownedRows $script:ownedAuditProcesses | Out-Null
        } catch { Write-Warning "Could not refresh audit process ownership; cleanup will use captured handles only." }
        [void]$script:auditProcess.CloseMainWindow()
        [void]$script:auditProcess.WaitForExit(3000)
    }
    # WebView children can outlive the main process briefly and still lock its data.
    Stop-CapturedAuditProcesses $script:ownedAuditProcesses
}

try {
    $fixtureRoot = $null
    if ([string]::IsNullOrWhiteSpace($FixturePath)) {
        $generatedRoot = Join-Path $sandboxRoot "generated-fixture"
        & node (Join-Path $repoRoot "scripts/perf/generate-fixtures.mjs") --output $generatedRoot --bindings 50 --profiles 1 --shapes light --plugins all
        if ($LASTEXITCODE -ne 0) { throw "Fixture generator failed with exit code $LASTEXITCODE" }
        $fixtureRoot = Join-Path $generatedRoot "b50-p1-light-plugins-all"
    }
    else {
        $fixtureRoot = (Resolve-Path -LiteralPath $FixturePath).Path
    }
    $fixtureManifest = Join-Path $fixtureRoot "fixture.json"
    $fixtureAppData = Join-Path $fixtureRoot "app-data/MIDIMaster"
    if (-not (Test-Path -LiteralPath $fixtureManifest -PathType Leaf) -or -not (Test-Path -LiteralPath $fixtureAppData -PathType Container)) {
        throw "FixturePath must contain fixture.json and app-data/MIDIMaster: $fixtureRoot"
    }

    $isolatedAppData = Join-Path $sandboxRoot "app-data/MIDIMaster"
    $isolatedWebView = if ([string]::IsNullOrWhiteSpace($ReusableWebViewDataDirectory)) {
        Join-Path $sandboxRoot "webview2-data"
    } elseif ([System.IO.Path]::IsPathRooted($ReusableWebViewDataDirectory)) {
        [System.IO.Path]::GetFullPath($ReusableWebViewDataDirectory)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $ReusableWebViewDataDirectory))
    }
    $isolatedRoaming = Join-Path $sandboxRoot "roaming"
    $isolatedLocal = Join-Path $sandboxRoot "local"
    $isolatedTemp = Join-Path $sandboxRoot "temp"
    foreach ($directory in @($isolatedAppData, $isolatedWebView, $isolatedRoaming, $isolatedLocal, $isolatedTemp)) {
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    Get-ChildItem -LiteralPath $fixtureAppData -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $isolatedAppData -Recurse -Force
    }
    Copy-Item -LiteralPath $fixtureManifest -Destination (Join-Path $sandboxRoot 'fixture.json')

    $script:commit = $null
    try { $script:commit = (& git -C $repoRoot rev-parse HEAD 2>$null).Trim() } catch {}
    $os = [System.Environment]::OSVersion.VersionString
    $memoryBytes = $null
    try { $memoryBytes = [int64](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory } catch {}
    $script:hardware = [ordered]@{
        os = $os
        cpu_logical_count = [System.Environment]::ProcessorCount
        memory_bytes = $memoryBytes
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $application
    $startInfo.WorkingDirectory = [System.IO.Path]::GetDirectoryName($application)
    $startInfo.Arguments = $ApplicationArguments
    $startInfo.UseShellExecute = $false
    $startInfo.EnvironmentVariables["MIDIMASTER_PERF_APP_DATA_DIR"] = $isolatedAppData
    $startInfo.EnvironmentVariables["MIDIMASTER_PERF_WEBVIEW_DATA_DIR"] = $isolatedWebView
    $startInfo.EnvironmentVariables["MIDIMASTER_PERF_RESULTS_DIR"] = $runOutput
    $startInfo.EnvironmentVariables["MIDIMASTER_PERF_RUN_ID"] = $runId
    $startInfo.EnvironmentVariables["MIDIMASTER_PERF_SCENARIO_ID"] = $ScenarioId
    $startInfo.EnvironmentVariables["MIDIMASTER_PERF_VARIANT"] = $Variant
    $startInfo.EnvironmentVariables["MIDIMASTER_PERF_NETWORK_MODE"] = $NetworkMode.ToLowerInvariant()
    $startInfo.EnvironmentVariables["MIDIMASTER_PERF_SYNTHETIC_TARGETS"] = "1"
    $startInfo.EnvironmentVariables["APPDATA"] = $isolatedRoaming
    $startInfo.EnvironmentVariables["LOCALAPPDATA"] = $isolatedLocal
    $startInfo.EnvironmentVariables["TEMP"] = $isolatedTemp
    $startInfo.EnvironmentVariables["TMP"] = $isolatedTemp
    $startInfo.EnvironmentVariables["WEBVIEW2_USER_DATA_FOLDER"] = $isolatedWebView
    $browserArguments = "--disable-component-update --disable-background-networking --no-first-run"
    if ($CdpPort -gt 0) { $browserArguments += " --remote-debugging-port=$CdpPort" }
    $startInfo.EnvironmentVariables["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = $browserArguments

    $runManifest = [ordered]@{
        schema_version = "1.0.0"
        run_id = $runId
        scenario_id = $ScenarioId
        variant = $Variant
        network_mode = $NetworkMode.ToLowerInvariant()
        duration_seconds = $DurationSeconds
        sample_interval_ms = $SampleIntervalMilliseconds
        fixture = Get-Content -LiteralPath $fixtureManifest -Raw | ConvertFrom-Json
        created_at = [DateTime]::UtcNow.ToString("o")
        local_only = $true
        verified_audit_build = $verifiedAuditBuild
        process_identity_verified = $true
        process_sampling_method = "cim-parent-and-creation-time-pinned-handles-v2"
        process_cpu_method = "pinned-process-lifetime-deltas-v1"
    }
    $runManifestJson = $runManifest | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText((Join-Path $runOutput "run.json"), "$runManifestJson`n", [System.Text.UTF8Encoding]::new($false))

    $process = [System.Diagnostics.Process]::Start($startInfo)
    if (-not $process) { throw "Failed to start $application" }
    $script:auditProcess = $process
    $rootPid = $process.Id
    [void]$process.Handle
    $script:rootStartTime = $process.StartTime
    $rootBirth = Get-ProcessBirthTicks $script:rootStartTime
    $script:ownedAuditProcesses["${rootPid}:$rootBirth"] = $process
    Add-ResultRecord @{ kind = "milestone"; metric = "process.started"; value = 0; unit = "ms"; dimensions = @{ root_pid_recorded = $true; root_pid = $rootPid; root_created_at = $script:rootStartTime.ToUniversalTime().ToString("o") } }

    $previousCpu = @{}
    $previousNetworkBytes = Get-NetworkByteTotal
    $previousReadBytes = $null
    $previousWriteBytes = $null
    $previousTimestamp = [DateTime]::UtcNow
    $deadline = $previousTimestamp.AddSeconds($DurationSeconds)
    $stopRequest = Join-Path $runOutput 'stop.request'
    while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited -and -not (Test-Path -LiteralPath $stopRequest)) {
        Start-Sleep -Milliseconds $SampleIntervalMilliseconds
        $processTable = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate, ReadTransferCount, WriteTransferCount)
        $ownedRows = @(Get-OwnedProcessRows $rootPid $script:rootStartTime $processTable $script:ownedAuditProcesses)
        $samples = @(Get-VerifiedProcessSamples $ownedRows $script:ownedAuditProcesses)
        $live = @($samples | ForEach-Object { $_.Process })
        if (-not $live.Count) { break }
        $now = [DateTime]::UtcNow
        $cpuSecondsDelta = Get-OwnedCpuSecondsDelta $script:ownedAuditProcesses $previousCpu
        $wallSeconds = [Math]::Max(0.001, ($now - $previousTimestamp).TotalSeconds)
        $cpuPercent = $cpuSecondsDelta / $wallSeconds / [System.Environment]::ProcessorCount * 100
        $previousTimestamp = $now
        $workingSet = [int64](($live | Measure-Object WorkingSet64 -Sum).Sum)
        $handles = [int64](($live | Measure-Object Handles -Sum).Sum)
        $treeRows = @($samples | ForEach-Object { $_.Row })
        $readBytes = [int64](($treeRows | Measure-Object ReadTransferCount -Sum).Sum)
        $writeBytes = [int64](($treeRows | Measure-Object WriteTransferCount -Sum).Sum)
        $dimensions = @{ process_count = $live.Count; ownership = "creation-time-verified" }
        $ownershipRecord = @{ timestamp = $now.ToString("o"); processes = @($treeRows | ForEach-Object {
            @{ pid = [int]$_.ProcessId; parent_pid = [int]$_.ParentProcessId; created_at = ([DateTime]$_.CreationDate).ToUniversalTime().ToString("o") }
        }) } | ConvertTo-Json -Depth 4 -Compress
        [System.IO.File]::AppendAllText((Join-Path $runOutput "process-tree.cim"), "$ownershipRecord`n", [System.Text.UTF8Encoding]::new($false))
        Add-ResultRecord @{ kind = "resource"; metric = "process.cpu"; value = $cpuPercent; unit = "percent"; dimensions = $dimensions }
        Add-ResultRecord @{ kind = "resource"; metric = "process.working_set"; value = $workingSet; unit = "bytes"; dimensions = $dimensions }
        Add-ResultRecord @{ kind = "resource"; metric = "process.handles"; value = $handles; unit = "count"; dimensions = $dimensions }
        Add-ResultRecord @{ kind = "resource"; metric = "process.io_read"; value = $readBytes; unit = "bytes"; dimensions = $dimensions }
        Add-ResultRecord @{ kind = "resource"; metric = "process.io_write"; value = $writeBytes; unit = "bytes"; dimensions = $dimensions }
        if ($null -ne $previousReadBytes -and $readBytes -ge $previousReadBytes) {
            Add-ResultRecord @{ kind = "resource"; metric = "process.io_read_rate"; value = (($readBytes - $previousReadBytes) / $wallSeconds); unit = "bytes_per_second"; dimensions = $dimensions }
        }
        if ($null -ne $previousWriteBytes -and $writeBytes -ge $previousWriteBytes) {
            Add-ResultRecord @{ kind = "resource"; metric = "process.io_write_rate"; value = (($writeBytes - $previousWriteBytes) / $wallSeconds); unit = "bytes_per_second"; dimensions = $dimensions }
        }
        $previousReadBytes = $readBytes
        $previousWriteBytes = $writeBytes
        $networkBytes = Get-NetworkByteTotal
        if ($null -ne $networkBytes -and $null -ne $previousNetworkBytes) {
            $networkRate = [Math]::Max(0, ($networkBytes - $previousNetworkBytes) / $wallSeconds)
            Add-ResultRecord @{ kind = "resource"; metric = "system.network_io"; value = $networkRate; unit = "bytes_per_second"; dimensions = @{ scope = "all-network-adapters" } }
        }
        $previousNetworkBytes = $networkBytes
    }

    Stop-OwnedAuditProcess
    $exitCode = if ($process.HasExited) { $process.ExitCode } else { -1 }
    Add-ResultRecord @{ kind = "counter"; metric = "process.exit_code"; value = $exitCode; unit = "count"; dimensions = @{} }
    Write-Host "Performance run $runId completed. Results: $runOutput"
}
finally {
    Stop-OwnedAuditProcess
    if (-not $PreserveSandbox -and (Test-Path -LiteralPath $sandboxRoot)) {
        Assert-ChildPath $sandboxParent $sandboxRoot
        for ($cleanupAttempt = 0; $cleanupAttempt -lt 10; $cleanupAttempt++) {
            try {
                Remove-Item -LiteralPath $sandboxRoot -Recurse -Force
                break
            } catch {
                if ($cleanupAttempt -eq 9) {
                    # Windows services can retain a WebView temporary download
                    # after every owned process exits. Preserve that local residue.
                    $cleanupResult = @{ completed = $false; retained_path = $sandboxRoot; error = $_.Exception.Message }
                    $cleanupResult | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runOutput 'cleanup.json')
                    Write-Warning "A locked temporary audit file was retained. Details: $(Join-Path $runOutput 'cleanup.json')"
                    break
                }
                Start-Sleep -Milliseconds 250
            }
        }
    }
    elseif ($PreserveSandbox) {
        Write-Host "Preserved disposable sandbox: $sandboxRoot"
    }
    foreach ($owned in $script:ownedAuditProcesses.Values) { $owned.Dispose() }
}
