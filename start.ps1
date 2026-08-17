<#
.SYNOPSIS
  Starts ProCurve Cockpit locally.

.DESCRIPTION
  On first run this creates a virtual environment, installs the dependencies
  and starts the web server. By default the server listens on 127.0.0.1 only:
  the app holds switch credentials in memory and does not belong on a network.

.PARAMETER Port
  TCP port for the interface (default 8710).

.PARAMETER Listen
  Bind address. 0.0.0.0 exposes the interface on the LAN - use deliberately.

.PARAMETER NoBrowser
  Do not open a browser automatically.

.EXAMPLE
  .\start.ps1
  .\start.ps1 -Port 9000 -NoBrowser
#>
[CmdletBinding()]
param(
  [int]$Port = 8710,
  [string]$Listen = '127.0.0.1',
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$venv = Join-Path $PSScriptRoot '.venv'
$python = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path $python)) {
  Write-Host 'Creating virtual environment ...' -ForegroundColor Cyan
  $sys = (Get-Command python -ErrorAction SilentlyContinue)
  if (-not $sys) { throw 'Python was not found. Please install Python 3.11 or newer.' }
  & $sys.Source -m venv $venv
}

# requirements.txt rarely changes; the check costs about a second.
Write-Host 'Checking dependencies ...' -ForegroundColor Cyan
& $python -m pip install --quiet --disable-pip-version-check -r requirements.txt

$legacyCheck = & $python -c "from backend.transport import missing_legacy_support; print('|'.join(missing_legacy_support()))"
if ($legacyCheck) {
  Write-Warning "The installed paramiko version no longer supports: $legacyCheck"
  Write-Warning "SSH to a ProVision switch will fail. Fix: pip install 'paramiko>=3.4,<4'"
}

$url = "http://$(if ($Listen -eq '0.0.0.0') { 'localhost' } else { $Listen }):$Port/"
Write-Host ''
Write-Host "  ProCurve Cockpit is running at $url" -ForegroundColor Green
Write-Host '  Stop with Ctrl+C' -ForegroundColor DarkGray
Write-Host ''

if (-not $NoBrowser) {
  Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 2; Start-Process $u } -ArgumentList $url | Out-Null
}

& $python -m uvicorn backend.main:app --host $Listen --port $Port
