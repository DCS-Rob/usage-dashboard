# bump-version.ps1
# Werkt alle versienummers in het project bij in één keer.
#
# Gebruik:
#   .\bump-version.ps1 -Version 0.7.0
#
# Daarna:
#   git add -A
#   git commit -m "Release v0.7.0"
#   git tag v0.7.0
#   git push && git push --tags
#   -> GitHub maakt automatisch een Release aan
#   -> chrome://extensions -> Reload

param(
    [Parameter(Mandatory=$true)]
    [string]$Version
)

# Valideer formaat
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Host "Fout: versie moet het formaat X.Y.Z hebben (bijv. 0.7.0)" -ForegroundColor Red
    exit 1
}

$root = $PSScriptRoot
Write-Host "Versie bijwerken naar $Version..." -ForegroundColor Cyan

# --- manifest.json ---
$file = Join-Path $root "manifest.json"
(Get-Content $file -Raw) -replace '"version":\s*"[^"]*"', "`"version`": `"$Version`"" |
    Set-Content $file -NoNewline
Write-Host "  [OK] manifest.json" -ForegroundColor Green

# --- app.js ---
$file = Join-Path $root "app.js"
(Get-Content $file -Raw) -replace 'const APP_VERSION = "[^"]*"', "const APP_VERSION = `"$Version`"" |
    Set-Content $file -NoNewline
Write-Host "  [OK] app.js (APP_VERSION)" -ForegroundColor Green

# --- sw.js ---
$file = Join-Path $root "sw.js"
$content = Get-Content $file -Raw
$content = $content -replace "const APP_BUILD = '[^']*'", "const APP_BUILD = '$Version'"
$content = $content -replace "const CACHE_NAME = 'usagedashboard-cache-v[^']*'", "const CACHE_NAME = 'usagedashboard-cache-v$Version'"
$content = $content -replace '\?v=[\d.]+', "?v=$Version"
$content | Set-Content $file -NoNewline
Write-Host "  [OK] sw.js (APP_BUILD, CACHE_NAME, ?v= query strings)" -ForegroundColor Green

# --- index.html ---
$file = Join-Path $root "index.html"
(Get-Content $file -Raw) -replace '\?v=[\d.]+', "?v=$Version" |
    Set-Content $file -NoNewline
Write-Host "  [OK] index.html (?v= query strings)" -ForegroundColor Green

Write-Host ""
Write-Host "Klaar! Alle versienummers staan nu op $Version." -ForegroundColor Cyan
Write-Host ""
Write-Host "Vergeet niet de CHANGELOG.md bij te werken, dan:" -ForegroundColor Yellow
Write-Host "  git add -A"
Write-Host "  git commit -m `"Release v$Version`""
Write-Host "  git tag v$Version"
Write-Host "  git push"
Write-Host "  git push --tags"
Write-Host ""
Write-Host "GitHub maakt automatisch een Release aan via de Action." -ForegroundColor Green
Write-Host "Daarna: chrome://extensions -> Reload knop." -ForegroundColor Green
