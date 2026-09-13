[CmdletBinding()]
param(
  [string]$WrapperRoot = 'D:\CHICK\CHICK2',
  [switch]$SkipAndroidBuild
)

$ErrorActionPreference = 'Stop'

$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$wrapperRoot = (Resolve-Path -LiteralPath $WrapperRoot).Path
$sourceDist = Join-Path $sourceRoot 'dist'
$targetDist = Join-Path $wrapperRoot 'dist'

if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'node_modules\vite\bin\vite.js'))) {
  throw 'Source dependencies are missing. Run npm/pnpm install in the SullyOS source first.'
}

Write-Host '[1/4] Building the private Capacitor web bundle...'
Push-Location $sourceRoot
try {
  & node 'node_modules\vite\bin\vite.js' build --mode capacitor
  if ($LASTEXITCODE -ne 0) { throw "Vite build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $targetDist)) {
  New-Item -ItemType Directory -Path $targetDist | Out-Null
}

$sourceDist = (Resolve-Path -LiteralPath $sourceDist).Path
$targetDist = (Resolve-Path -LiteralPath $targetDist).Path
$expectedTarget = [IO.Path]::GetFullPath((Join-Path $wrapperRoot 'dist'))
if ($targetDist -ne $expectedTarget -or -not $targetDist.StartsWith($wrapperRoot + '\')) {
  throw "Refusing to replace an unexpected directory: $targetDist"
}

Write-Host '[2/4] Replacing only CHICK2/dist...'
Get-ChildItem -LiteralPath $targetDist -Force | Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $sourceDist -Force | Copy-Item -Destination $targetDist -Recurse -Force

$nativeBridgeCount = @(Get-ChildItem -LiteralPath (Join-Path $targetDist 'assets') -Filter 'nativeAmsgPush-*.js').Count
if ($nativeBridgeCount -ne 1) {
  throw "Expected one native AMSG bridge bundle, found $nativeBridgeCount"
}

Write-Host '[3/4] Syncing Capacitor Android plugins and assets...'
& node (Join-Path $PSScriptRoot 'sync-native-app-name.mjs') $wrapperRoot
if ($LASTEXITCODE -ne 0) { throw "App display name sync failed with exit code $LASTEXITCODE" }
Push-Location $wrapperRoot
try {
  & npx.cmd cap sync android
  if ($LASTEXITCODE -ne 0) { throw "Capacitor sync failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

if ($SkipAndroidBuild) {
  Write-Host 'Capacitor sync complete (Android build skipped).'
  exit 0
}

Write-Host '[4/4] Building the debug APK...'
$gradleDistRoot = Join-Path $env:USERPROFILE '.gradle\wrapper\dists\gradle-8.2.1-all'
$gradleExecutable = Get-ChildItem -LiteralPath $gradleDistRoot -Filter 'gradle.bat' -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -like '*\gradle-8.2.1\bin\gradle.bat' } |
  Select-Object -First 1 -ExpandProperty FullName

$androidRoot = Join-Path $wrapperRoot 'android'
Push-Location $androidRoot
try {
  if ($gradleExecutable) {
    $env:GRADLE_USER_HOME = Join-Path $sourceRoot '.gradle-user-home'
    & $gradleExecutable assembleDebug
  } else {
    & (Join-Path $androidRoot 'gradlew.bat') assembleDebug
  }
  if ($LASTEXITCODE -ne 0) { throw "Android build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$apk = Join-Path $androidRoot 'app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path -LiteralPath $apk)) { throw "APK was not generated: $apk" }

$hash = Get-FileHash -LiteralPath $apk -Algorithm SHA256
Write-Host "APK: $apk"
Write-Host "SHA256: $($hash.Hash)"
