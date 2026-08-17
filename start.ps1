<#
.SYNOPSIS
  Startet ProCurve Cockpit lokal.

.DESCRIPTION
  Legt beim ersten Start eine virtuelle Umgebung an, installiert die
  Abhaengigkeiten und startet den Webserver. Standardmaessig lauscht der Server
  nur auf 127.0.0.1 - die App haelt Switch-Zugangsdaten im Speicher und gehoert
  nicht ins Netz.

.PARAMETER Port
  TCP-Port fuer die Oberflaeche (Standard 8710).

.PARAMETER Listen
  Bind-Adresse. 0.0.0.0 macht die Oberflaeche im LAN erreichbar - nur bewusst
  verwenden.

.PARAMETER NoBrowser
  Browser nicht automatisch oeffnen.

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
  Write-Host 'Erstelle virtuelle Umgebung ...' -ForegroundColor Cyan
  $sys = (Get-Command python -ErrorAction SilentlyContinue)
  if (-not $sys) { throw 'Python wurde nicht gefunden. Bitte Python 3.11+ installieren.' }
  & $sys.Source -m venv $venv
}

# requirements.txt aendert sich selten; der Abgleich kostet nur eine Sekunde.
Write-Host 'Pruefe Abhaengigkeiten ...' -ForegroundColor Cyan
& $python -m pip install --quiet --disable-pip-version-check -r requirements.txt

$legacyCheck = & $python -c "from backend.transport import missing_legacy_support; print('|'.join(missing_legacy_support()))"
if ($legacyCheck) {
  Write-Warning "Die installierte paramiko-Version unterstuetzt nicht mehr: $legacyCheck"
  Write-Warning "SSH zu einem ProVision-Switch wird fehlschlagen. Abhilfe: pip install 'paramiko>=3.4,<4'"
}

$url = "http://$(if ($Listen -eq '0.0.0.0') { 'localhost' } else { $Listen }):$Port/"
Write-Host ''
Write-Host "  ProCurve Cockpit laeuft auf $url" -ForegroundColor Green
Write-Host '  Beenden mit Strg+C' -ForegroundColor DarkGray
Write-Host ''

if (-not $NoBrowser) {
  Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 2; Start-Process $u } -ArgumentList $url | Out-Null
}

& $python -m uvicorn backend.main:app --host $Listen --port $Port
