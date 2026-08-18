[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path
)

$ErrorActionPreference = "Stop"
$requiredModuleVersion = "0.1.17"

$requiredEnvironment = @(
    "AZURE_ARTIFACT_SIGNING_ENDPOINT"
    "AZURE_ARTIFACT_SIGNING_ACCOUNT"
    "AZURE_ARTIFACT_SIGNING_PROFILE"
    "WINDOWS_SIGNING_PUBLISHER"
)
foreach ($name in $requiredEnvironment) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Missing required Artifact Signing environment variable: $name"
    }
}

$resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
$extension = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()
if ($extension -notin @(".dll", ".exe")) {
    throw "Refusing to Authenticode-sign unsupported file type '$extension': $resolved"
}

$module = Get-Module -ListAvailable -Name ArtifactSigning |
    Where-Object { $_.Version -eq [version]$requiredModuleVersion } |
    Select-Object -First 1
if ($null -eq $module) {
    throw "ArtifactSigning PowerShell module $requiredModuleVersion is not installed."
}
Import-Module -Name $module.Path -Force -ErrorAction Stop

$endpoint = $env:AZURE_ARTIFACT_SIGNING_ENDPOINT.TrimEnd("/")
$correlationId = if ([string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID)) {
    "MIDIMaster-Tauri-bundle"
} else {
    "MIDIMaster-GitHub-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"
}

Write-Host "Signing Tauri bundle component with Azure Artifact Signing: $resolved"
Invoke-ArtifactSigning `
    -Endpoint $endpoint `
    -CodeSigningAccountName $env:AZURE_ARTIFACT_SIGNING_ACCOUNT `
    -CertificateProfileName $env:AZURE_ARTIFACT_SIGNING_PROFILE `
    -Files $resolved `
    -FileDigest SHA256 `
    -TimestampRfc3161 "http://timestamp.acs.microsoft.com" `
    -TimestampDigest SHA256 `
    -Description "MIDIMaster" `
    -DescriptionUrl "https://midimaster.app/" `
    -CorrelationId $correlationId `
    -ExcludeEnvironmentCredential `
    -ExcludeWorkloadIdentityCredential `
    -ExcludeManagedIdentityCredential `
    -ExcludeSharedTokenCacheCredential `
    -ExcludeVisualStudioCredential `
    -ExcludeVisualStudioCodeCredential `
    -ExcludeAzurePowerShellCredential `
    -ExcludeAzureDeveloperCliCredential `
    -ExcludeInteractiveBrowserCredential | Out-Host

& (Join-Path $PSScriptRoot "Assert-Authenticode.ps1") `
    -Path $resolved `
    -ExpectedPublisher $env:WINDOWS_SIGNING_PUBLISHER `
    -RequireTimestamp | Out-Host
