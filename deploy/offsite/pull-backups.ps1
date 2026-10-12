<#
.SYNOPSIS
  Copie hors serveur des sauvegardes : rapatrie sur ce PC les dumps core-*.sql.gz du serveur.

.DESCRIPTION
  Pull depuis le serveur (alias SSH `ffhandball`, cf. ~/.ssh/config) vers un dossier local.
  - Ne télécharge que les fichiers absents ou de taille différente (idempotent).
  - Écrit en `.part` puis renomme : un téléchargement interrompu ne laisse pas de faux dump.
  - Rotation locale : garde les $Keep dumps les plus récents. Ne supprime JAMAIS rien sur le serveur.

.EXAMPLE
  .\pull-backups.ps1 -DryRun     # liste ce qui serait téléchargé / purgé
  .\pull-backups.ps1             # exécute
#>
[CmdletBinding()]
param(
  [string]$Server    = "ffhandball",
  [string]$RemoteDir = "/var/backups/ffhandball",
  [string]$Dest      = (Join-Path $env:USERPROFILE "Backups\ffhandball"),
  [int]$Keep         = 14,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ssh = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=15")

function Fail($msg) { Write-Host "ERREUR : $msg" -ForegroundColor Red; exit 1 }

if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $Dest | Out-Null }

# Nom + taille de chaque dump distant ("<octets> <nom>").
$listing = & ssh @ssh $Server "cd $RemoteDir && stat -c '%s %n' core-*.sql.gz" 2>&1
if ($LASTEXITCODE -ne 0) { Fail "impossible de lister $RemoteDir sur $Server :`n$listing" }

$remote = @($listing | Where-Object { $_ -match '^\d+ core-.+\.sql\.gz$' } | ForEach-Object {
  $size, $name = $_ -split ' ', 2
  [pscustomobject]@{ Name = $name; Size = [int64]$size }
})
if ($remote.Count -eq 0) { Fail "aucun dump trouvé dans $RemoteDir sur $Server" }

$downloaded = 0
foreach ($f in ($remote | Sort-Object Name)) {
  $local = Join-Path $Dest $f.Name
  if ((Test-Path $local) -and (Get-Item $local).Length -eq $f.Size) {
    Write-Host "= $($f.Name) déjà présent"
    continue
  }
  $mb = [math]::Round($f.Size / 1MB, 1)
  if ($DryRun) { Write-Host "+ $($f.Name) ($mb Mo) serait téléchargé"; $downloaded++; continue }

  Write-Host "+ $($f.Name) ($mb Mo)..."
  $part = "$local.part"
  & scp @ssh "${Server}:$RemoteDir/$($f.Name)" $part
  if ($LASTEXITCODE -ne 0) { Remove-Item $part -ErrorAction SilentlyContinue; Fail "échec du téléchargement de $($f.Name)" }
  if ((Get-Item $part).Length -ne $f.Size) { Remove-Item $part; Fail "taille incorrecte pour $($f.Name)" }
  Move-Item -Force $part $local
  $downloaded++
}

# Rotation locale (uniquement les dumps réguliers déjà complets).
$localDumps = @(Get-ChildItem $Dest -Filter "core-*.sql.gz" -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
$toPurge = $localDumps | Select-Object -Skip $Keep
foreach ($old in $toPurge) {
  if ($DryRun) { Write-Host "- $($old.Name) serait supprimé (rotation, > $Keep)"; continue }
  Remove-Item $old.FullName
  Write-Host "- $($old.Name) supprimé (rotation)"
}

Write-Host "Terminé : $downloaded nouveau(x), destination $Dest" -ForegroundColor Green
