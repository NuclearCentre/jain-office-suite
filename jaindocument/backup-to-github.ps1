# WordPad Pro — GitHub Backup Script
# Run this after every task to back up your project to GitHub
# Usage: Right-click → "Run with PowerShell" OR run in PowerShell terminal

param(
    [string]$Message = ""
)

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  WordPad Pro — GitHub Backup" -ForegroundColor Cyan  
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Check if git is installed
try {
    git --version | Out-Null
} catch {
    Write-Host "ERROR: Git is not installed." -ForegroundColor Red
    Write-Host "Download from: https://git-scm.com/download/win" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# Initialize git if not already done
if (-not (Test-Path ".git")) {
    Write-Host "Setting up Git for first time..." -ForegroundColor Yellow
    git init
    git remote add origin "https://NuclearCentre:$env:GH_TOKEN@github.com/NuclearCentre/wordpad-pro-releases.git"
    Write-Host "Git initialized." -ForegroundColor Green
}

# Create .gitignore if not present
if (-not (Test-Path ".gitignore")) {
    @"
node_modules/
dist/
*.log
.env
"@ | Out-File -FilePath ".gitignore" -Encoding utf8
}

# Ask for backup message if not provided
if ($Message -eq "") {
    $Message = Read-Host "Enter backup description (e.g. 'Added save fix')"
    if ($Message -eq "") {
        $Message = "Backup - $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
    }
}

# Stage all changes
Write-Host ""
Write-Host "Staging files..." -ForegroundColor Yellow
git add -A

# Check if there's anything to commit
$status = git status --porcelain
if ($status -eq "") {
    Write-Host "No changes to backup — everything is already up to date." -ForegroundColor Green
    Read-Host "Press Enter to exit"
    exit 0
}

# Commit
Write-Host "Creating backup: $Message" -ForegroundColor Yellow
git commit -m $Message

# Push to GitHub
Write-Host "Pushing to GitHub..." -ForegroundColor Yellow

# Use token from environment or prompt
if ($env:GH_TOKEN -eq "" -or $null -eq $env:GH_TOKEN) {
    $token = Read-Host "Enter your GitHub token"
    $env:GH_TOKEN = $token
}

git remote set-url origin "https://NuclearCentre:$env:GH_TOKEN@github.com/NuclearCentre/wordpad-pro-releases.git"
git push -u origin main 2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "======================================" -ForegroundColor Green
    Write-Host "  Backup successful!" -ForegroundColor Green
    Write-Host "  View at: https://github.com/NuclearCentre/wordpad-pro-releases" -ForegroundColor Green
    Write-Host "======================================" -ForegroundColor Green
} else {
    # Try master branch if main fails
    git push -u origin master 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Backup successful!" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "ERROR: Push failed. Check your token and internet connection." -ForegroundColor Red
    }
}

Write-Host ""
Read-Host "Press Enter to exit"
