$ErrorActionPreference = 'Stop'
$host.UI.RawUI.WindowTitle = 'JainSheet Deploy'
Clear-Host
Write-Host ''
Write-Host '  ==============================' -ForegroundColor Cyan
Write-Host '   JainSheet Deploy' -ForegroundColor Cyan
Write-Host '  ==============================' -ForegroundColor Cyan
Write-Host ''
Set-Location 'D:\JainSheet'

# ── Step 0: Copy files from Downloads to D:\JainSheet ─────────────────────────
# Picks the file with the HIGHEST jainsheet-version stamp (for html/js files)
# Falls back to newest-by-date if no stamp found
Write-Host '  [0/5] Syncing files from Downloads...' -ForegroundColor Yellow
$dl   = 'C:\Users\Admin\Downloads'
$proj = 'D:\JainSheet'

function Get-JsVersion($path) {
    try {
        $text = Get-Content $path -Raw -ErrorAction Stop
        if ($text -match 'jainsheet-version.*?content="([^"]+)"') { return $Matches[1] }
        if ($text -match '//\s*JAINSHEET_VERSION:\s*(.+)') { return $Matches[1].Trim() }
        return ''
    } catch { return '' }
}

$syncFiles = @('index.html', 'renderer.js', 'main.js', 'package.json', 'sidebar.bmp')
foreach ($f in $syncFiles) {
    $base = [System.IO.Path]::GetFileNameWithoutExtension($f)
    $ext  = [System.IO.Path]::GetExtension($f)
    # Find all variants in Downloads (handles "index (1).html" etc)
    $candidates = Get-ChildItem -Path $dl -Filter "$base*$ext" -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -match "^$([regex]::Escape($base))(\s*\(\d+\))?$([regex]::Escape($ext))$" }
    if (-not $candidates) {
        Write-Host "    Not found: $f (keeping existing)" -ForegroundColor Gray
        continue
    }
    # Pick best candidate: highest version stamp, then newest date
    $best = $null
    $bestVer = ''
    foreach ($c in $candidates) {
        $ver = Get-JsVersion $c.FullName
        if (-not $best -or ($ver -and $ver -gt $bestVer) -or (-not $ver -and $c.LastWriteTime -gt $best.LastWriteTime)) {
            $best = $c; $bestVer = $ver
        }
    }
    # Always copy — never skip based on timestamp
    Copy-Item $best.FullName (Join-Path $proj $f) -Force
    Write-Host "    Copied: $($best.Name) -> $f$(if($bestVer){' [v'+$bestVer+']'})" -ForegroundColor Cyan
}
Write-Host '  [0/5] Sync done' -ForegroundColor Green
Write-Host ''

# Step 1 - Dependencies
if (-not (Test-Path 'node_modules')) {
    Write-Host '  [1/5] Installing dependencies...' -ForegroundColor Yellow
    npm install
} else {
    Write-Host '  [1/5] Dependencies OK' -ForegroundColor Green
}

# Step 2 - Syntax check
Write-Host '  [2/5] Checking syntax...' -ForegroundColor Yellow
node --check main.js
if ($LASTEXITCODE -ne 0) {
    Write-Host '  ERROR: main.js syntax error' -ForegroundColor Red
    Read-Host 'Press Enter to exit'; exit 1
}
node --check renderer.js
if ($LASTEXITCODE -ne 0) {
    Write-Host '  ERROR: renderer.js syntax error' -ForegroundColor Red
    Read-Host 'Press Enter to exit'; exit 1
}
Write-Host '  [2/5] Syntax OK' -ForegroundColor Green

# Step 3 - Stop running app
Write-Host '  [3/5] Stopping JainSheet if running...' -ForegroundColor Yellow
Stop-Process -Name 'JainSheet' -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Write-Host '  [3/5] Done' -ForegroundColor Green

# Step 4 - Build
Write-Host '  [4/5] Building installer (2-3 min)...' -ForegroundColor Yellow
npm run dist
if ($LASTEXITCODE -ne 0) {
    Write-Host '  BUILD FAILED' -ForegroundColor Red
    Read-Host 'Press Enter to exit'; exit 1
}
Write-Host '  [4/5] Build complete' -ForegroundColor Green

# Step 5 - Git push
Write-Host '  [5/5] Git push...' -ForegroundColor Yellow
git -C 'D:\JainSheet' add main.js renderer.js index.html package.json jainsheet_deploy.bat jainsheet_deploy.ps1
$staged = git -C 'D:\JainSheet' diff --cached --name-only
if (-not $staged) {
    Write-Host '  Nothing to commit.' -ForegroundColor Green
} else {
    $staged | ForEach-Object { Write-Host "    + $_" -ForegroundColor Cyan }
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm'
    git -C 'D:\JainSheet' commit -m "JainSheet update $ts"
    Write-Host ''
    $token = Read-Host '  Paste GitHub token'
    git -C 'D:\JainSheet' remote set-url origin "https://NuclearCentre:$token@github.com/NuclearCentre/JainSheet.git"
    git -C 'D:\JainSheet' push origin main
    git -C 'D:\JainSheet' remote set-url origin 'https://github.com/NuclearCentre/JainSheet.git'
    $token = ''
    Write-Host '  *** Push complete! ***' -ForegroundColor Green
}

# Step 6 - Install
Write-Host ''
Write-Host '  Installing new version...' -ForegroundColor Yellow
$installer = 'D:\JainSheet\dist\JainSheet-Setup.exe'
if (Test-Path $installer) {
    Start-Process $installer -Wait
    Write-Host '  Done!' -ForegroundColor Green
} else {
    Write-Host '  Installer not found.' -ForegroundColor Red
}

Write-Host ''
Read-Host 'Press Enter to close'
