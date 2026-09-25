$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules"))) {
  Write-Host "Installing dependencies..."
  & npm install --prefix $ProjectRoot
}

$EnvFile = Join-Path $ProjectRoot ".env"
if (-not (Test-Path -LiteralPath $EnvFile)) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot ".env.example") -Destination $EnvFile
  Write-Host "Created .env with the default PIN. Change ADMIN_PIN before the event."
}

& npm start --prefix $ProjectRoot
