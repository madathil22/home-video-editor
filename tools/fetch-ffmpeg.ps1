# Downloads the pinned ffmpeg build and installs ffmpeg/ffprobe as Tauri
# sidecars in src-tauri/binaries/.
#
# The binaries are ~138 MB each, so they are not committed. Run this once
# after cloning, before `npm run tauri dev` or `npm run tauri build`.
#
# The version is PINNED deliberately. ffmpeg 9.0 and master require NVENC API
# 13.1 (NVIDIA driver >= 610.00) and fail to open h264_nvenc on older drivers.
# 8.1.2 is verified working. Do not bump without re-running the NVENC trial
# encode described in README.md.

$ErrorActionPreference = 'Stop'
# Progress rendering makes Invoke-WebRequest crawl, and throws outright in
# non-interactive hosts.
$ProgressPreference = 'SilentlyContinue'

$Tag   = 'autobuild-2026-09-03-13-17'
$Asset = 'ffmpeg-n8.1.2-50-g1a748fe2cd-win64-gpl-8.1.zip'
$Url   = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$Tag/$Asset"

$repoRoot = Split-Path -Parent $PSScriptRoot
$binDir   = Join-Path $repoRoot 'src-tauri\binaries'
$triple   = 'x86_64-pc-windows-msvc'

$targets = @{
    'ffmpeg.exe'  = Join-Path $binDir "ffmpeg-$triple.exe"
    'ffprobe.exe' = Join-Path $binDir "ffprobe-$triple.exe"
}

if (($targets.Values | Where-Object { Test-Path $_ }).Count -eq $targets.Count) {
    Write-Host 'Sidecars already present. Delete src-tauri\binaries to re-download.'
    exit 0
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "hve-ffmpeg-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    $zip = Join-Path $tmp $Asset
    Write-Host "Downloading $Asset (~160 MB)..."
    Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing

    Write-Host 'Extracting...'
    Expand-Archive -Path $zip -DestinationPath $tmp -Force

    foreach ($name in $targets.Keys) {
        $src = Get-ChildItem -Path $tmp -Recurse -Filter $name |
               Select-Object -First 1
        if (-not $src) { throw "$name not found in the downloaded archive" }
        Copy-Item $src.FullName $targets[$name] -Force
        Write-Host "  -> $($targets[$name])"
    }

    Write-Host ''
    & $targets['ffmpeg.exe'] -hide_banner -version | Select-Object -First 1
    Write-Host 'Sidecars installed.'
}
finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
