# WordJS Production Build Script
# Creates a clean 'release' folder ready for deployment

$ErrorActionPreference = "Stop"

Write-Host "🚀 Starting Production Build..." -ForegroundColor Cyan

# 1. Clean previous build
if (Test-Path "release") {
    Write-Host "🧹 Cleaning previous release..." -ForegroundColor Yellow
    Remove-Item "release" -Recurse -Force
}

New-Item -ItemType Directory -Path "release" | Out-Null

# 2. Build Frontend
Write-Host "🎨 Building Frontend (Next.js)..." -ForegroundColor Cyan
Push-Location "admin-next"
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "Frontend build failed!"
}
Pop-Location

# 3. Copy Backend
Write-Host "📦 Copying Backend..." -ForegroundColor Cyan
New-Item -ItemType Directory -Path "release/backend" | Out-Null

# Copy source code
Copy-Item "backend/src" -Destination "release/backend" -Recurse
Copy-Item "backend/config" -Destination "release/backend" -Recurse
Copy-Item "backend/package.json" -Destination "release/backend"
Copy-Item "backend/server.js" -Destination "release/backend"

# Copy Plugins & Themes (Code only)
Write-Host "🔌 Copying Plugins & Themes..." -ForegroundColor Cyan
Copy-Item "backend/plugins" -Destination "release/backend" -Recurse
Copy-Item "backend/themes" -Destination "release/backend" -Recurse

# Create empty data directories
New-Item -ItemType Directory -Path "release/backend/data" | Out-Null
New-Item -ItemType Directory -Path "release/backend/uploads" | Out-Null
New-Item -ItemType Directory -Path "release/backend/logs" | Out-Null

# IMPORTANT: Do NOT copy wordjs-config.json, database.sqlite, or node_modules
# This ensures "Zero Config" state on the new server.

# 4. Copy Frontend
Write-Host "🖥️  Copying Frontend..." -ForegroundColor Cyan
New-Item -ItemType Directory -Path "release/admin-next" | Out-Null

Copy-Item "admin-next/.next" -Destination "release/admin-next" -Recurse
Copy-Item "admin-next/public" -Destination "release/admin-next" -Recurse
Copy-Item "admin-next/package.json" -Destination "release/admin-next"
Copy-Item "admin-next/next.config.ts" -Destination "release/admin-next"
# Copy scripts if needed for post-install
Copy-Item "admin-next/scripts" -Destination "release/admin-next" -Recurse 

# 5. Copy Gateway & Root Config
Write-Host "🌐 Copying Gateway..." -ForegroundColor Cyan
Copy-Item "gateway.js" -Destination "release/"
Copy-Item "package.json" -Destination "release/"

# 6. Create Instructions
$readme = @"
# WordJS Production Build

## Installation on Server
1. Ensure Node.js (v18+) is installed.
2. Run install command:
   npm install --omit=dev

3. Start the server:
   npm start

## Zero Config
- The system will auto-generate 'wordjs-config.json' on first run.
- It will create a fresh database.
- Go to http://YOUR-SERVER-IP:3000 to see the Setup Wizard.
"@
Set-Content -Path "release/README.txt" -Value $readme

Write-Host "✅ Build Complete!" -ForegroundColor Green
Write-Host "📂 Output: ./release" -ForegroundColor Green
Write-Host "👉 Zip the 'release' folder and upload it to your server." -ForegroundColor Gray
