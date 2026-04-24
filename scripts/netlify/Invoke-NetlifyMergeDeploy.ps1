param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDir,
    [Parameter(Mandatory = $true)]
    [string]$SiteId,
    [string[]]$PreservePaths = @(),
    [switch]$RequirePreservedPaths
)

$ErrorActionPreference = "Stop"

function Get-EnvValue {
    param([string[]]$Names)
    foreach ($name in $Names) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value
        }
    }
    return $null
}

function Get-PosixRelativePath {
    param(
        [string]$BaseDir,
        [string]$FullPath
    )

    $relative = [System.IO.Path]::GetRelativePath($BaseDir, $FullPath)
    return ($relative -replace "\\", "/").TrimStart("/")
}

function Get-Sha1Hex {
    param([byte[]]$Bytes)
    return [System.BitConverter]::ToString(
        ([System.Security.Cryptography.SHA1]::Create().ComputeHash($Bytes))
    ).Replace("-", "").ToLowerInvariant()
}

function Normalize-PreservePath {
    param([string]$PathValue)
    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return $null
    }
    return "/" + ($PathValue.Trim() -replace "\\", "/").TrimStart("/")
}

if (-not (Test-Path -LiteralPath $SourceDir)) {
    throw "Source directory not found: $SourceDir"
}

$sourceRoot = (Resolve-Path -LiteralPath $SourceDir).Path
$token = Get-EnvValue -Names @("NETLIFY_AUTH_TOKEN", "NETLIFY_TOKEN")
if ([string]::IsNullOrWhiteSpace($token)) {
    throw "Missing NETLIFY_AUTH_TOKEN environment variable. Merge deploys use the Netlify API directly."
}

$apiBase = "https://api.netlify.com/api/v1"
$authHeaders = @{ Authorization = "Bearer $token" }
$jsonHeaders = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }

$preservePathSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($rawPath in $PreservePaths) {
    $normalizedPath = Normalize-PreservePath -PathValue $rawPath
    if ($null -ne $normalizedPath) {
        [void]$preservePathSet.Add($normalizedPath)
    }
}

$currentFiles = Invoke-RestMethod -Method Get -Uri "$apiBase/sites/$SiteId/files" -Headers $authHeaders
$remoteFiles = @{}
foreach ($file in $currentFiles) {
    if ($null -ne $file.path -and $null -ne $file.sha) {
        $remoteFiles[[string]$file.path] = [string]$file.sha
    }
}

$localFiles = @{}
$localBytesByPath = @{}
Get-ChildItem -LiteralPath $sourceRoot -File -Recurse | ForEach-Object {
    $relativePath = Get-PosixRelativePath -BaseDir $sourceRoot -FullPath $_.FullName
    $remotePath = "/" + $relativePath
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    $localBytesByPath[$remotePath] = $bytes
    $localFiles[$remotePath] = Get-Sha1Hex -Bytes $bytes
}

if ($RequirePreservedPaths) {
    $missingPreservedPaths = @()
    foreach ($preservePath in $preservePathSet) {
        if (-not $remoteFiles.ContainsKey($preservePath) -and -not $localFiles.ContainsKey($preservePath)) {
            $missingPreservedPaths += $preservePath
        }
    }
    if ($missingPreservedPaths.Count -gt 0) {
        throw "Required preserved path(s) are missing before deploy: $($missingPreservedPaths -join ', '). Restore updater metadata before publishing the store."
    }
}

$filesMap = @{}
foreach ($entry in $remoteFiles.GetEnumerator()) {
    $filesMap[$entry.Key] = $entry.Value
}
foreach ($entry in $localFiles.GetEnumerator()) {
    $filesMap[$entry.Key] = $entry.Value
}

$deployRequest = @{ files = $filesMap } | ConvertTo-Json -Depth 50 -Compress
$deploy = Invoke-RestMethod -Method Post -Uri "$apiBase/sites/$SiteId/deploys" -Headers $jsonHeaders -Body $deployRequest
if ($null -eq $deploy.id) {
    throw "Netlify deploy creation failed: missing deploy id."
}

$requiredShas = @($deploy.required)
$requiredLookup = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($sha in $requiredShas) {
    if (-not [string]::IsNullOrWhiteSpace($sha)) {
        [void]$requiredLookup.Add([string]$sha)
    }
}

$localShaLookup = @{}
foreach ($entry in $localFiles.GetEnumerator()) {
    $localShaLookup[$entry.Value] = $entry.Key
}

$missingLocalShas = @()
foreach ($sha in $requiredLookup) {
    if (-not $localShaLookup.ContainsKey($sha)) {
        $missingLocalShas += $sha
    }
}
if ($missingLocalShas.Count -gt 0) {
    throw "Netlify requested upload of blobs not present in the local payload (sha: $($missingLocalShas -join ', '))."
}

foreach ($sha in $requiredLookup) {
    $path = $localShaLookup[$sha]
    $bytes = $localBytesByPath[$path]
    $uploadPath = $path.TrimStart("/")
    $uploadUri = "$apiBase/deploys/$($deploy.id)/files/$uploadPath"
    Invoke-RestMethod -Method Put -Uri $uploadUri -Headers @{
        Authorization = "Bearer $token"
        "Content-Type" = "application/octet-stream"
    } -Body $bytes | Out-Null
}

$maxAttempts = 20
$deployReady = $false
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    Start-Sleep -Seconds 2
    $deployState = Invoke-RestMethod -Method Get -Uri "$apiBase/sites/$SiteId/deploys/$($deploy.id)" -Headers $authHeaders
    $state = [string]$deployState.state
    if ($state -eq "ready") {
        Write-Host "Netlify merge deploy is ready (deploy id: $($deploy.id))."
        $deployReady = $true
        break
    }
    if ($attempt -eq $maxAttempts) {
        throw "Netlify merge deploy did not reach 'ready' state. Last state: $state"
    }
}

if (-not $deployReady) {
    throw "Netlify merge deploy did not complete successfully."
}
