[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedPublisher
)

$ErrorActionPreference = "Stop"
$installer = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path
$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$installRoot = Join-Path $temporaryRoot ("MIDIMaster-signature-test-" + [guid]::NewGuid().ToString("N"))
$installRoot = [System.IO.Path]::GetFullPath($installRoot)
if (-not $installRoot.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a test installation path outside the temporary directory: $installRoot"
}
if ($installRoot.Contains(" ")) {
    throw "The NSIS /D argument requires a temporary path without spaces: $installRoot"
}

$uninstaller = Join-Path $installRoot "uninstall.exe"
try {
    $install = Start-Process -FilePath $installer -ArgumentList @("/S", "/P", "/D=$installRoot") -Wait -PassThru
    if ($install.ExitCode -ne 0) {
        throw "Silent NSIS installation failed with exit code $($install.ExitCode)."
    }

    $ownedExecutables = @(
        (Join-Path $installRoot "midimaster.exe")
        (Join-Path $installRoot "virtual-audio\midimaster-virtual-audio-service.exe")
        (Join-Path $installRoot "virtual-audio\midimaster-virtual-audio-setup.exe")
        $uninstaller
    )
    & (Join-Path $PSScriptRoot "Assert-Authenticode.ps1") `
        -Path $ownedExecutables `
        -ExpectedPublisher $ExpectedPublisher `
        -RequireTimestamp | Out-Host

    & (Join-Path $PSScriptRoot "Assert-Authenticode.ps1") `
        -Path (Join-Path $installRoot "virtual-audio\USBip-0.9.7.7-x64.exe") `
        -ExpectedPublisher "Cloudyne Systems (Scheibling Consulting AB)" `
        -RequireTimestamp | Out-Host

    $virtualAudioStatus = & (Join-Path $installRoot "virtual-audio\midimaster-virtual-audio-setup.exe") status
    if ($LASTEXITCODE -ne 0) {
        throw "The installed Virtual Audio setup helper status check failed with exit code $LASTEXITCODE."
    }
    $null = $virtualAudioStatus | ConvertFrom-Json -ErrorAction Stop
    Write-Host "Clean NSIS install, installed signatures, and Virtual Audio status check passed."
}
finally {
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
        $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @("/S", "/P") -Wait -PassThru
        if ($uninstall.ExitCode -ne 0) {
            Write-Warning "Silent NSIS cleanup returned exit code $($uninstall.ExitCode)."
        }
    }
    for ($attempt = 1; $attempt -le 10 -and (Test-Path -LiteralPath $installRoot); $attempt++) {
        try {
            Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction Stop
        }
        catch {
            if ($attempt -eq 10) {
                Write-Warning "Could not remove the temporary NSIS test directory '$installRoot': $_"
            }
            else {
                Start-Sleep -Milliseconds 500
            }
        }
    }
}
