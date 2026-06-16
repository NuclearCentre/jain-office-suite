# ── Jain Office Suite — GitHub Backup Script ─────────────────────────────────
# Run each line separately in PowerShell as Administrator
# Repo: https://github.com/NuclearCentre/jain-office-suite

$SuiteRoot = "D:\Jain Office Suite\Jain Office Suite"

Write-Host "=== Jain Office Suite — GitHub Backup ===" -ForegroundColor Cyan

# ── Step 0: Check git is installed ───────────────────────────────────────────
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: git is not installed. Please install git and try again." -ForegroundColor Red
    exit 1
}

# ── Step 1: Init git repo if not already done ─────────────────────────────────
if (-not (Test-Path "$SuiteRoot\.git")) {
    Write-Host "Initialising git repo..." -ForegroundColor Yellow
    Set-Location $SuiteRoot
    git init
    git remote add origin https://github.com/NuclearCentre/jain-office-suite.git
    Write-Host "Git repo initialised." -ForegroundColor Green
} else {
    Set-Location $SuiteRoot
    Write-Host "Git repo already initialised." -ForegroundColor Green
}

# ── Step 2: Create .gitignore if not present ──────────────────────────────────
$gitignore = "$SuiteRoot\.gitignore"
if (-not (Test-Path $gitignore)) {
    Write-Host "Creating .gitignore..." -ForegroundColor Yellow
    @"
# Node modules — never commit
launcher/node_modules/
jaindocument/node_modules/
jainsheet/node_modules/

# Build output — never commit
launcher/dist/
jaindocument/dist/
jainsheet/dist/

# Locks
launcher/package-lock.json
jaindocument/package-lock.json
jainsheet/package-lock.json

# Junk files
Thumbs.db
.DS_Store
*.bak
"@ | Set-Content $gitignore
    Write-Host ".gitignore created." -ForegroundColor Green
} else {
    Write-Host ".gitignore already exists." -ForegroundColor Green
}

# ── Step 3: Stage all changes ─────────────────────────────────────────────────
Write-Host "Staging files..." -ForegroundColor Yellow
git add -A
Write-Host "Files staged." -ForegroundColor Green

# ── Step 4: Commit ────────────────────────────────────────────────────────────
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
$commitMsg = "Backup: $timestamp"
Write-Host "Committing: $commitMsg" -ForegroundColor Yellow
git commit -m $commitMsg

# ── Step 5: Push to GitHub ────────────────────────────────────────────────────
Write-Host "Pushing to GitHub..." -ForegroundColor Yellow
git push -u origin main
Write-Host "=== Backup complete! ===" -ForegroundColor Green
Write-Host "Repo: https://github.com/NuclearCentre/jain-office-suite" -ForegroundColor Cyan
