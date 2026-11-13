<#
  remove-other-node.ps1 - uninstall extra Node.js versions on Windows.

  Lists every installed Node.js, keeps the one you choose, and removes the rest
  (after asking). It does NOT touch nvm / fnm / volta - it only warns about them.

  Usage (PowerShell):
    powershell -ExecutionPolicy Bypass -File .\remove-other-node.ps1            # asks which to keep
    powershell -ExecutionPolicy Bypass -File .\remove-other-node.ps1 -Keep 26   # keep major version 26
    powershell -ExecutionPolicy Bypass -File .\remove-other-node.ps1 -RemoveAll # remove every Node.js
    powershell -ExecutionPolicy Bypass -File .\remove-other-node.ps1 -WhatIf    # show what would happen

  Note: Freehand works fine on Node 22, 24 and 26. You only need ONE of them.
#>
[CmdletBinding()]
param(
  [int]$Keep = 0,
  [switch]$RemoveAll,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Self-elevate (uninstalling a machine-wide MSI needs admin).
if (-not (Test-Admin)) {
  Write-Host 'Needs administrator rights - relaunching elevated...' -ForegroundColor Yellow
  $argList = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
  if ($Keep -gt 0)  { $argList += @('-Keep', $Keep) }
  if ($RemoveAll)   { $argList += '-RemoveAll' }
  if ($WhatIf)      { $argList += '-WhatIf' }
  try { Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait } catch { Write-Host 'Elevation was cancelled.' -ForegroundColor Red }
  return
}

$keys = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$installs = foreach ($k in $keys) {
  Get-ItemProperty $k -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'Node.js*' -and $_.PSChildName -match '^\{[0-9A-Fa-f-]+\}$' } |
    ForEach-Object {
      [pscustomobject]@{
        Name    = $_.DisplayName
        Version = [string]$_.DisplayVersion
        Major   = [int](([string]$_.DisplayVersion).Split('.')[0])
        Guid    = $_.PSChildName
      }
    }
}
$installs = @($installs | Sort-Object Guid -Unique | Sort-Object Major)

Write-Host ''
Write-Host 'Node.js installs found (Windows installer):' -ForegroundColor Cyan
if ($installs.Count -eq 0) { Write-Host '  none' } else { $installs | ForEach-Object { Write-Host ("  v{0}   {1}" -f $_.Version, $_.Name) } }

# Version managers are separate and are never touched here.
$managers = @()
if ($env:NVM_HOME -or (Test-Path "$env:APPDATA\nvm")) { $managers += 'nvm-windows' }
if ((Test-Path "$env:LOCALAPPDATA\fnm") -or $env:FNM_DIR) { $managers += 'fnm' }
if ($env:VOLTA_HOME -or (Test-Path "$env:LOCALAPPDATA\Volta")) { $managers += 'volta' }
if ($managers.Count) {
  Write-Host ''
  Write-Host ("Also detected: {0}. Those keep their own Node versions - remove them with that tool (e.g. 'nvm uninstall <ver>')." -f ($managers -join ', ')) -ForegroundColor Yellow
}

if ($installs.Count -eq 0) { Write-Host "`nNothing to remove."; return }

if ($RemoveAll) {
  $toRemove = $installs
} else {
  if ($Keep -le 0) {
    $latest = ($installs | Select-Object -Last 1).Major
    $answer = Read-Host ("`nWhich major version do you want to KEEP? [default {0}]" -f $latest)
    $Keep = if ($answer) { [int]$answer } else { $latest }
  }
  if (-not ($installs | Where-Object { $_.Major -eq $Keep })) {
    Write-Host ("No installed Node.js has major version {0}. Nothing changed." -f $Keep) -ForegroundColor Red
    return
  }
  $toRemove = @($installs | Where-Object { $_.Major -ne $Keep })
}

if ($toRemove.Count -eq 0) { Write-Host "`nOnly the version you want to keep is installed. Nothing to remove."; return }

Write-Host "`nWill uninstall:" -ForegroundColor Cyan
$toRemove | ForEach-Object { Write-Host ("  v{0}" -f $_.Version) }
if ($WhatIf) { Write-Host "`n-WhatIf: no changes made."; return }

$ok = Read-Host "`nType YES to continue"
if ($ok -ne 'YES') { Write-Host 'Cancelled. Nothing changed.'; return }

foreach ($i in $toRemove) {
  Write-Host ("Removing v{0} ..." -f $i.Version) -NoNewline
  $p = Start-Process msiexec.exe -ArgumentList @('/x', $i.Guid, '/qb', '/norestart') -Wait -PassThru
  # 0 = ok, 3010 = ok but reboot suggested
  if ($p.ExitCode -in 0, 3010) { Write-Host ' done' -ForegroundColor Green }
  else { Write-Host (" failed (exit code {0})" -f $p.ExitCode) -ForegroundColor Red }
}

# Leftover folder only if nothing is installed any more.
$remaining = @(Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Node.js*' })
if ($remaining.Count -eq 0 -and (Test-Path "$env:ProgramFiles\nodejs")) {
  $r = Read-Host "`nDelete leftover folder '$env:ProgramFiles\nodejs'? (y/N)"
  if ($r -match '^[Yy]') { Remove-Item "$env:ProgramFiles\nodejs" -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host "`nDone. Open a NEW terminal window, then check with:  node -v" -ForegroundColor Cyan
Write-Host 'If you removed everything, install one version from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS).'
Write-Host "Then in the Freehand folder run:  start.bat"
