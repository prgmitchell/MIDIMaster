[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Path,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedPublisher,

    [switch]$RequireTimestamp
)

$ErrorActionPreference = "Stop"

foreach ($candidate in $Path) {
    $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
    $signature = Get-AuthenticodeSignature -LiteralPath $resolved
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Authenticode signature is not valid for '$resolved': $($signature.Status) ($($signature.StatusMessage))"
    }
    if ($null -eq $signature.SignerCertificate) {
        throw "Authenticode signature for '$resolved' does not contain a signer certificate."
    }

    $publisher = $signature.SignerCertificate.GetNameInfo(
        [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
        $false
    )
    if ($publisher -cne $ExpectedPublisher) {
        throw "Unexpected Authenticode publisher for '$resolved': expected '$ExpectedPublisher', got '$publisher'."
    }
    if ($RequireTimestamp -and $null -eq $signature.TimeStamperCertificate) {
        throw "Authenticode signature for '$resolved' is missing an RFC3161 timestamp."
    }

    [pscustomobject]@{
        path = $resolved
        publisher = $publisher
        status = [string]$signature.Status
        timestamped = $null -ne $signature.TimeStamperCertificate
        sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
