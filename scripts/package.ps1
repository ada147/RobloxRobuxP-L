# Builds dist\robux-pnl-v<version>.zip locally – the same files the GitHub release workflow ships.
# Use it to attach a ZIP to a release by hand:  powershell -File scripts\package.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version

$files = @(
  'manifest.json', 'background.js', 'api.js', 'db.js', 'pnl.js', 'popup.html', 'popup.css', 'popup.js',
  'share.js', 'pricechart.js', 'content.js', 'content.css', 'lib', 'README.md',
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses'
) | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ }
$icons = Get-ChildItem (Join-Path $root 'icons') -Filter 'icon*.png' | Where-Object Name -ne 'icon512.png'

# Copy into a staging folder first so icons/ keeps its folder inside the ZIP.
$stage = Join-Path ([IO.Path]::GetTempPath()) "robux-pnl-$version"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $stage 'icons') | Out-Null
Copy-Item $files $stage -Recurse
Copy-Item $icons.FullName (Join-Path $stage 'icons')

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$zip = Join-Path $dist "robux-pnl-v$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
# Build the ZIP with forward-slash entry names (Compress-Archive in Windows PowerShell 5.1
# writes backslashes, which turn into broken file names when unzipped on macOS/Linux).
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
try {
  Get-ChildItem $stage -Recurse -File | ForEach-Object {
    $entry = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entry, 'Optimal') | Out-Null
  }
} finally {
  $archive.Dispose()
}
Remove-Item $stage -Recurse -Force
Write-Host "Built $zip"
