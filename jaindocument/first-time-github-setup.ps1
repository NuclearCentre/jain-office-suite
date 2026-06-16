# WordPad Pro — First Time GitHub Setup
# Run this ONCE to connect your project to GitHub

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  WordPad Pro — GitHub First Setup" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

# Check git
try { git --version | Out-Null }
catch {
    Write-Host "Git not found. Installing via winget..." -ForegroundColor Yellow
    winget install --id Git.Git -e --source winget
    Write-Host "Please restart PowerShell after Git installs, then run this script again." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Git found." -ForegroundColor Green

# Get token
Write-Host ""
Write-Host "Enter your GitHub Personal Access Token:" -ForegroundColor Yellow
Write-Host "(Create one at https://github.com/settings/tokens with 'repo' permission)" -ForegroundColor Gray
$token = Read-Host "Token"

if ($token -eq "") {
    Write-Host "No token entered. Exiting." -ForegroundColor Red
    exit 1
}

# Save token to .env file (not committed to GitHub)
"GH_TOKEN=$token" | Out-File -FilePath ".env.local" -Encoding utf8
Write-Host "Token saved locally." -ForegroundColor Green

# Set git config
git config user.name "NuclearCentre"
git config user.email "petjamnagar@gmail.com"

# Init repo
if (-not (Test-Path ".git")) {
    git init
    git branch -M main
}

# Create .gitignore
@"
node_modules/
dist/
*.log
.env
.env.local
"@ | Out-File -FilePath ".gitignore" -Encoding utf8

# Create README
@"
# WordPad Pro
A full-featured Windows word processor built with Electron.

## Features
- Save as .docx, .doc, .html, .txt
- Open .docx, .html, .txt files
- Full formatting: bold, italic, underline, font, size, color
- Tables, images, links, special characters
- Find & Replace, spell check
- Page layout, margins, orientation
- Auto-updater

## Build
npm install
npm run build-win
"@ | Out-File -FilePath "README.md" -Encoding utf8

# First commit
git add -A
git commit -m "Initial backup — WordPad Pro v1.0.0"

# Set remote
git remote remove origin 2>$null
git remote add origin "https://NuclearCentre:$token@github.com/NuclearCentre/wordpad-pro-releases.git"

# Push
Write-Host ""
Write-Host "Pushing to GitHub..." -ForegroundColor Yellow
git push -u origin main 2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Green
    Write-Host "  SUCCESS! Project backed up to GitHub." -ForegroundColor Green
    Write-Host "  URL: https://github.com/NuclearCentre/wordpad-pro-releases" -ForegroundColor Green
    Write-Host "  From now on, run backup-to-github.ps1" -ForegroundColor Green
    Write-Host "  after every task to save your progress." -ForegroundColor Green
    Write-Host "=============================================" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Push failed. Make sure:" -ForegroundColor Red
    Write-Host "1. You created the repo 'wordpad-pro-releases' on GitHub" -ForegroundColor Yellow
    Write-Host "   Go to: https://github.com/new" -ForegroundColor Yellow
    Write-Host "2. Your token has 'repo' permissions" -ForegroundColor Yellow
    Write-Host "3. Your internet is connected" -ForegroundColor Yellow
}

Write-Host ""
Read-Host "Press Enter to exit"
