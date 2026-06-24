# ============================================================
# JainDocument — Sync source files to win-unpacked
# Run this every time you update any source file so that
# both the main folder AND the win-unpacked JainDocument.exe
# reflect the latest changes.
#
# Run as Administrator in PowerShell:
#   cd "D:\Jain Office Suite\Jain Office Suite\jaindocument"
#   .\sync-to-unpacked.ps1
# ============================================================

$SRC  = "D:\Jain Office Suite\Jain Office Suite\jaindocument"
$DEST = "D:\Jain Office Suite\Jain Office Suite\jaindocument\dist\win-unpacked\resources\app"

Write-Host ""
Write-Host "=== JainDocument Sync ===" -ForegroundColor Cyan
Write-Host "Source : $SRC"
Write-Host "Dest   : $DEST"
Write-Host ""

# ── Check source exists ────────────────────────────────────────────────────────
if (-not (Test-Path $SRC)) {
    Write-Host "ERROR: Source folder not found: $SRC" -ForegroundColor Red
    exit 1
}

# ── Check win-unpacked exists ──────────────────────────────────────────────────
$unpacked = "D:\Jain Office Suite\Jain Office Suite\jaindocument\dist\win-unpacked"
if (-not (Test-Path $unpacked)) {
    Write-Host "ERROR: win-unpacked folder not found." -ForegroundColor Red
    Write-Host "       Run 'npm run build-win' inside the jaindocument folder first." -ForegroundColor Yellow
    exit 1
}

# ── Create app\ folder if it doesn't exist ────────────────────────────────────
# Electron loads app\ folder in preference to app.asar when both exist.
if (-not (Test-Path $DEST)) {
    New-Item -ItemType Directory -Path $DEST -Force | Out-Null
    Write-Host "Created: $DEST" -ForegroundColor Green
}

# ── Create app\src\ folder ────────────────────────────────────────────────────
$DEST_SRC = Join-Path $DEST "src"
if (-not (Test-Path $DEST_SRC)) {
    New-Item -ItemType Directory -Path $DEST_SRC -Force | Out-Null
}

# ── Copy root-level files ──────────────────────────────────────────────────────
$rootFiles = @("main.js", "preload.js", "package.json")
Write-Host "Copying root files..." -ForegroundColor Yellow
foreach ($f in $rootFiles) {
    $from = Join-Path $SRC $f
    $to   = Join-Path $DEST $f
    if (Test-Path $from) {
        Copy-Item $from $to -Force
        Write-Host "  OK  $f" -ForegroundColor Green
    } else {
        Write-Host "  SKIP $f (not found in source)" -ForegroundColor Gray
    }
}

# ── Copy src\ files ───────────────────────────────────────────────────────────
$srcFiles = @(
    "app.js",
    "index.html",
    "style.css",
    "font-dialog.html",
    "text-effects-dialog.html"
)
Write-Host "Copying src files..." -ForegroundColor Yellow
foreach ($f in $srcFiles) {
    $from = Join-Path $SRC "src\$f"
    $to   = Join-Path $DEST_SRC $f
    if (Test-Path $from) {
        Copy-Item $from $to -Force
        Write-Host "  OK  src\$f" -ForegroundColor Green
    } else {
        Write-Host "  SKIP src\$f (not found in source)" -ForegroundColor Gray
    }
}

# ── Copy assets\ folder ───────────────────────────────────────────────────────
$assetsSrc  = Join-Path $SRC  "assets"
$assetsDest = Join-Path $DEST "assets"
if (Test-Path $assetsSrc) {
    Write-Host "Copying assets..." -ForegroundColor Yellow
    Copy-Item $assetsSrc $assetsDest -Recurse -Force
    Write-Host "  OK  assets\" -ForegroundColor Green
}

# ── Copy build\ folder (installer sidebar etc.) ───────────────────────────────
$buildSrc  = Join-Path $SRC  "build"
$buildDest = Join-Path $DEST "build"
if (Test-Path $buildSrc) {
    Copy-Item $buildSrc $buildDest -Recurse -Force
    Write-Host "  OK  build\" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Sync complete! ===" -ForegroundColor Cyan
Write-Host "Both locations are now up to date:" -ForegroundColor White
Write-Host "  1. $SRC" -ForegroundColor White
Write-Host "  2. $DEST" -ForegroundColor White
Write-Host ""
Write-Host "You can now open JainDocument from the launcher." -ForegroundColor Green
Write-Host ""
