[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ApplicationPath,
    [string]$FixturesDirectory,
    [string]$FixturePattern = "b50-p1-light-plugins-all",
    [ValidateRange(1, 100)]
    [int]$Iterations = 1,
    [ValidateSet("Clean", "Warm")]
    [string]$CacheMode = "Clean",
    [string]$Variant = "current",
    [ValidateRange(1, 600)]
    [int]$DurationSeconds = 20,
    [string]$OutputDirectory = "perf-results/runs"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "../../..")).Path
$temporaryFixtureRoot = $null
$warmWebViewRoot = $null
try {
    if ([string]::IsNullOrWhiteSpace($FixturesDirectory)) {
        $temporaryFixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("MIDIMaster-perf-fixtures-" + [Guid]::NewGuid().ToString("N"))
        & node (Join-Path $repoRoot "scripts/perf/generate-fixtures.mjs") --output $temporaryFixtureRoot
        if ($LASTEXITCODE -ne 0) { throw "Fixture generation failed" }
        $FixturesDirectory = $temporaryFixtureRoot
    }
    $fixturesRoot = (Resolve-Path -LiteralPath $FixturesDirectory).Path
    $fixtures = @(Get-ChildItem -LiteralPath $fixturesRoot -Directory | Where-Object { $_.Name -like $FixturePattern })
    if (-not $fixtures.Count) { throw "No fixtures matched '$FixturePattern' under $fixturesRoot" }

    if ($CacheMode -eq "Warm") {
        $warmWebViewRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("MIDIMaster-perf-warm-" + [Guid]::NewGuid().ToString("N"))
        [System.IO.Directory]::CreateDirectory($warmWebViewRoot) | Out-Null
    }
    foreach ($fixture in $fixtures) {
        for ($iteration = 1; $iteration -le $Iterations; $iteration += 1) {
            $scenario = "startup-$($CacheMode.ToLowerInvariant())-$($fixture.Name)"
            $arguments = @{
                ApplicationPath = $ApplicationPath
                FixturePath = $fixture.FullName
                ScenarioId = $scenario
                Variant = $Variant
                DurationSeconds = $DurationSeconds
                OutputDirectory = $OutputDirectory
            }
            if ($CacheMode -eq "Warm") {
                $arguments.ReusableWebViewDataDirectory = (Join-Path $warmWebViewRoot $fixture.Name)
            }
            & (Join-Path $PSScriptRoot "Invoke-PerfRun.ps1") @arguments
        }
    }
}
finally {
    foreach ($path in @($temporaryFixtureRoot, $warmWebViewRoot)) {
        if (-not [string]::IsNullOrWhiteSpace($path) -and (Test-Path -LiteralPath $path)) {
            $full = [System.IO.Path]::GetFullPath($path)
            $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
            if (-not $full.StartsWith($temp, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Refusing to remove non-temporary lab path: $full" }
            Remove-Item -LiteralPath $full -Recurse -Force
        }
    }
}
