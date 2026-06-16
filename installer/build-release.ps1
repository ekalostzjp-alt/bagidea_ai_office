# BagIdea Office — release packager (run by the OWNER).
# Bundles everything an end user needs into ONE zip, WITHOUT exposing source
# control: the project stays private, you ship only the built artifacts.
# The zip contains the committed tree (via git archive — runtime data and
# gitignored files are excluded) PLUS the prebuilt shell exe. End users run
# install.ps1 with -Zip <this file or its URL>; no git, no Rust needed.
#
#   .\installer\build-release.ps1            # → dist\BagIdeaOffice-<sha>.zip
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$sha = (git rev-parse --short HEAD).Trim()
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force $dist | Out-Null
$stage = Join-Path $env:TEMP ("bagidea_rel_" + $sha)
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null

Write-Host "  [1/4] เก็บไฟล์ที่ tracked (ไม่รวมข้อมูล runtime / gitignored)..." -ForegroundColor Cyan
# git archive = exactly the committed tree, so registry/sessions/journal/keys
# and any *.json runtime never leak. Write to a FILE (never pipe git's binary
# output through PowerShell — it corrupts it), then expand into the stage.
$base = Join-Path $env:TEMP ("bagidea_base_" + $sha + ".zip")
if (Test-Path $base) { Remove-Item $base }
git archive --format=zip --output="$base" HEAD
Expand-Archive -Path $base -DestinationPath $stage -Force
Remove-Item $base

Write-Host "  [2/4] ใส่ตัวโปรแกรมที่คอมไพล์แล้ว (shell exe)..." -ForegroundColor Cyan
$exe = Join-Path $root "shell\target\release\bagidea-office-shell.exe"
if (-not (Test-Path $exe)) { throw "ยังไม่ได้ build shell — รัน: cargo build --release ใน shell\ ก่อน" }
$exeDest = Join-Path $stage "shell\target\release"
New-Item -ItemType Directory -Force $exeDest | Out-Null
Copy-Item $exe $exeDest

Write-Host "  [3/4] เขียนเวอร์ชัน..." -ForegroundColor Cyan
@{ sha = $sha; built = (Get-Date).ToString("s") } | ConvertTo-Json |
  Set-Content (Join-Path $stage "VERSION.json") -Encoding utf8

Write-Host "  [4/4] บีบอัด..." -ForegroundColor Cyan
$zip = Join-Path $dist ("BagIdeaOffice-" + $sha + ".zip")
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
Copy-Item $zip (Join-Path $dist "BagIdeaOffice-latest.zip") -Force
Remove-Item -Recurse -Force $stage

$mb = [Math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ""
Write-Host "  เสร็จ → $zip ($mb MB)" -ForegroundColor Green
Write-Host "  อัปโหลดไฟล์นี้ไปที่ใดก็ได้ (เซิร์ฟเวอร์/ไดรฟ์/ release) แล้วให้ผู้ใช้ติดตั้งด้วย:" -ForegroundColor DarkGray
Write-Host "    irm <install.ps1 url> | iex   (ตั้ง `$env:BAGIDEA_RELEASE_URL = '<zip url>')" -ForegroundColor DarkGray
Write-Host "  หรือส่งทั้ง install.ps1 + zip ให้ผู้ใช้แล้วรัน:  .\install.ps1 -Zip .\BagIdeaOffice-latest.zip" -ForegroundColor DarkGray
