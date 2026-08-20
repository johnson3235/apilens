param(
  [switch]$SkipBuild,
  [switch]$OpenExtensionsPage
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$extensionPath = Join-Path $repoRoot 'apps\browser-extension\dist'
$manifestPath = Join-Path $extensionPath 'manifest.json'
$profilePath = Join-Path $repoRoot '.brave-extension-profile'

$braveCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\Application\brave.exe'),
  (Join-Path $env:ProgramFiles 'BraveSoftware\Brave-Browser\Application\brave.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'BraveSoftware\Brave-Browser\Application\brave.exe')
)
$bravePath = $braveCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $bravePath) {
  throw 'Brave Browser was not found in the standard Windows installation locations.'
}

if (-not $SkipBuild) {
  & pnpm --filter '@apilens/browser-extension' build
  if ($LASTEXITCODE -ne 0) { throw 'The ApiLens extension build failed.' }
}

if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "Extension manifest was not found: $manifestPath"
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.manifest_version -ne 3) {
  throw 'ApiLens must use Manifest V3 for current Brave versions.'
}

New-Item -ItemType Directory -Force -Path $profilePath | Out-Null

$startUrl = if ($OpenExtensionsPage) { 'brave://extensions/' } else { 'http://localhost:3000/' }
$arguments = @(
  "--user-data-dir=$profilePath",
  "--disable-extensions-except=$extensionPath",
  "--load-extension=$extensionPath",
  '--no-first-run',
  '--no-default-browser-check',
  $startUrl
)

Write-Host "Launching Brave with ApiLens $($manifest.version)"
Write-Host "Extension: $extensionPath"
Write-Host "Test profile: $profilePath"
Start-Process -FilePath $bravePath -ArgumentList $arguments
