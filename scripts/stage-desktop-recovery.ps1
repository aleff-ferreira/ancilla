param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Helicon'),
  [string]$DataDir = (Join-Path $env:APPDATA 'app.helicon.desktop'),
  [string]$Distro = 'Ubuntu',
  [Parameter(Mandatory = $true)][string]$WslHome
)
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$built = Join-Path $sourceRoot 'apps\desktop\src-tauri\resources'
$install = (Resolve-Path -LiteralPath $InstallRoot).Path
$resources = (Resolve-Path -LiteralPath (Join-Path $install 'resources')).Path
$server = Join-Path $resources 'server.cjs'
if (!(Test-Path -LiteralPath $server -PathType Leaf)) { throw 'The installed server was not found.' }
if (!(Test-Path -LiteralPath (Join-Path $built 'frontend\index.html'))) { throw 'Build the desktop resources first.' }
if (!$WslHome.StartsWith('/home/') -or $WslHome.Contains('..')) { throw 'Use the absolute WSL home directory.' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $install ('backups\muse-recovery-' + $stamp)
$staged = Join-Path $resources 'muse-recovery'
if (Test-Path -LiteralPath $staged) { throw 'A repair is already staged. Review its backup before replacing it.' }

# Preserve the current resource tree and machine settings before staging anything.
$null = New-Item -ItemType Directory -Path $backup -Force
Copy-Item -LiteralPath $resources -Destination (Join-Path $backup 'resources') -Recurse
$null = New-Item -ItemType Directory -Path $DataDir -Force
$runtimePath = Join-Path $DataDir 'runtime.json'
$config = @{}
if (Test-Path -LiteralPath $runtimePath) {
  Copy-Item -LiteralPath $runtimePath -Destination (Join-Path $backup 'runtime.json')
  $config = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json -AsHashtable
}
$config.runtime = 'wsl'
$config.distro = $Distro
$config.musePath = $WslHome + '/.local/bin/muse'
$config.syncSessionNames = $false
if (!$config.wslEnv) { $config.wslEnv = @{} }
$config.wslEnv.BASH_ENV = $WslHome + '/.config/muse/runtime-env.sh'
$config.wslEnv.TBH_CREDENTIAL_BACKEND = 'file'

$null = New-Item -ItemType Directory -Path $staged
Copy-Item -LiteralPath (Join-Path $built 'server.cjs') -Destination (Join-Path $staged 'server.cjs')
Copy-Item -LiteralPath (Join-Path $built 'frontend') -Destination (Join-Path $staged 'frontend') -Recurse
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $runtimePath -Encoding utf8
# Keep the current UI assets in place until the app starts its new backend.
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'recovery-bootstrap.cjs') -Destination ($server + '.next')
Move-Item -LiteralPath ($server + '.next') -Destination $server -Force
$receipt = [ordered]@{
  stagedAt = (Get-Date).ToUniversalTime().ToString('o')
  backup = $backup
  resources = $resources
  staged = $staged
  runtimeConfig = $runtimePath
  serverSha256 = (Get-FileHash -LiteralPath (Join-Path $staged 'server.cjs')).Hash
  bootstrapSha256 = (Get-FileHash -LiteralPath $server).Hash
  activates = 'On the next Helicon server start; existing work is not interrupted.'
}
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $staged 'deployment.json') -Encoding utf8
$receipt | ConvertTo-Json
