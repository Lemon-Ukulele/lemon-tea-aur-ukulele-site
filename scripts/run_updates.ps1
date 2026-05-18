param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$Overwrite,
  [switch]$SkipDownload,
  [string]$RootFilter = "",
  [string]$TypeFilter = ""
)

$ErrorActionPreference = "Stop"

function Write-Section([string]$Text) {
  Write-Host "`n=== $Text ===" -ForegroundColor Cyan
}

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found in PATH: $Name"
  }
}

function Get-ChromePath {
  if ($env:CHROME_PATH -and (Test-Path $env:CHROME_PATH)) {
    return $env:CHROME_PATH
  }

  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe"
  )

  foreach ($p in $candidates) {
    if (Test-Path $p) { return $p }
  }

  return $null
}

function Ensure-PlaywrightCore([string]$Root) {
  $pkg = Join-Path $Root "node_modules\playwright-core"
  if (-not (Test-Path $pkg)) {
    Write-Section "Installing playwright-core"
    & npm i playwright-core --cache (Join-Path $Root ".npm-cache")
    if ($LASTEXITCODE -ne 0) { throw "npm install playwright-core failed" }
  }
}

function Download-BaseNotes([string]$Root) {
  $baseDir = Join-Path $Root "generated_audio_source\base_notes"
  New-Item -ItemType Directory -Force -Path $baseDir | Out-Null

  $notes = @(
    "D2","Ds2","E2","F2","Fs2","G2","Gs2","A2","As2","B2",
    "C3","Cs3","D3","Ds3","E3","F3","Fs3","G3","Gs3","A3","As3","B3",
    "C4","Cs4","D4","Ds4","E4","F4","Fs4","G4","Gs4","A4","As4","B4"
  )

  Write-Section "Downloading base notes (34 files)"
  foreach ($n in $notes) {
    $url = "https://ukebuddy.com/dist/mp3/$n.mp3"
    $out = Join-Path $baseDir "$n.mp3"
    Invoke-WebRequest -Uri $url -OutFile $out
    Write-Host "downloaded $n.mp3"
  }
}

function Run-NodeScript([string]$Root, [string]$ScriptRelPath, [string]$Label) {
  Write-Section "Generating $Label"
  Push-Location $Root
  try {
    & node $ScriptRelPath
    if ($LASTEXITCODE -ne 0) {
      throw "Node script failed: $ScriptRelPath"
    }
  }
  finally {
    Pop-Location
  }
}

function Split-FilterToSet([string]$Input) {
  $set = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  if ([string]::IsNullOrWhiteSpace($Input)) { return $set }
  $Input.Split(',') | ForEach-Object {
    $v = $_.Trim()
    if ($v) { [void]$set.Add($v) }
  }
  return $set
}

function Generate-Upstrokes([string]$ComboRoot, [bool]$OverwriteFlag, [string]$RootFilterText, [string]$TypeFilterText) {
  if (-not (Test-Path $ComboRoot)) {
    throw "Combinations path missing: $ComboRoot"
  }

  $rootSet = Split-FilterToSet $RootFilterText
  $typeSet = Split-FilterToSet $TypeFilterText

  $inputs = Get-ChildItem -Path $ComboRoot -Recurse -File | Where-Object {
    $_.Name -eq 'pos_01.mp3' -or $_.Name -eq 'play.mp3'
  }

  $generated = 0
  $skipped = 0
  $failed = 0

  foreach ($f in $inputs) {
    $comboType = Split-Path $f.DirectoryName -Leaf
    $rootName = Split-Path (Split-Path $f.DirectoryName -Parent) -Leaf

    if ($rootSet.Count -gt 0 -and -not $rootSet.Contains($rootName)) { continue }
    if ($typeSet.Count -gt 0 -and -not $typeSet.Contains($comboType)) { continue }

    $outName = if ($f.Name -eq 'pos_01.mp3') { 'up_01.mp3' } else { 'up_play.mp3' }
    $outPath = Join-Path $f.DirectoryName $outName

    if ((Test-Path $outPath) -and -not $OverwriteFlag) {
      $skipped++
      continue
    }

    & ffmpeg -hide_banner -loglevel error -y `
      -i $f.FullName `
      -af 'atrim=start=0.006,atempo=1.055,highpass=f=220,equalizer=f=3400:t=q:w=1.0:g=3.2,afade=t=in:st=0:d=0.008,acompressor=threshold=-22dB:ratio=2.2:attack=3:release=55,pan=stereo|c0=0.70*c0|c1=1.10*c1' `
      -codec:a libmp3lame -b:a 128k `
      $outPath

    if ($LASTEXITCODE -eq 0) {
      $generated++
    }
    else {
      $failed++
    }
  }

  return [pscustomobject]@{
    Generated = $generated
    Skipped   = $skipped
    Failed    = $failed
  }
}

function Generate-PercussionSample([string]$Root) {
  $percussionDir = Join-Path $Root 'ukulele_audio\percussion'
  New-Item -ItemType Directory -Force -Path $percussionDir | Out-Null
  $outPath = Join-Path $percussionDir 'palm_thump.wav'

  & ffmpeg -hide_banner -loglevel error -y `
    -f lavfi -i 'sine=frequency=105:duration=0.12' `
    -f lavfi -i 'anoisesrc=color=pink:duration=0.08:amplitude=0.22' `
    -filter_complex '[0:a]volume=0.70,afade=t=out:st=0.05:d=0.07[low];[1:a]highpass=f=700,lowpass=f=2500,afade=t=out:st=0.02:d=0.06[hit];[low][hit]amix=inputs=2:normalize=0,alimiter=limit=0.85[out]' `
    -map '[out]' -ar 44100 -ac 1 `
    $outPath

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to generate percussion sample: $outPath"
  }
}

function Copy-AudioLibraryToFrontend([string]$Root) {
  $sourceRoot = Join-Path $Root 'generated_audio_source'
  $targetRoot = Join-Path $Root 'ukulele_audio'
  New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null

  foreach ($category in @('chords', 'scales', 'arpeggios')) {
    $src = Join-Path $sourceRoot $category
    $dst = Join-Path $targetRoot $category
    if (-not (Test-Path $src)) {
      throw "Generated source folder missing: $src"
    }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $dst
    Copy-Item -Recurse -Force $src $dst
  }

  Generate-PercussionSample -Root $Root
}

Write-Section "Preflight"
Assert-Command node
Assert-Command npm
Assert-Command ffmpeg

$chrome = Get-ChromePath
if (-not $chrome) {
  throw "Could not find Chrome/Edge. Set CHROME_PATH manually and rerun."
}
$env:CHROME_PATH = $chrome
Write-Host "Using browser: $env:CHROME_PATH"

Ensure-PlaywrightCore -Root $ProjectRoot

if (-not $SkipDownload) {
  Download-BaseNotes -Root $ProjectRoot
}

# Clean output roots first for deterministic reruns
Write-Section "Cleaning output folders"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $ProjectRoot 'generated_audio_source\chords\combinations')
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $ProjectRoot 'generated_audio_source\scales\combinations')
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $ProjectRoot 'generated_audio_source\arpeggios\combinations')

Run-NodeScript -Root $ProjectRoot -ScriptRelPath 'scripts/generate_chord_combo_audio.js' -Label 'chords combinations'
Run-NodeScript -Root $ProjectRoot -ScriptRelPath 'scripts/generate_scales_combo_audio_fast.js' -Label 'scales combinations'
Run-NodeScript -Root $ProjectRoot -ScriptRelPath 'scripts/generate_arpeggios_combo_audio_fast.js' -Label 'arpeggios combinations'

Write-Section "Generating upstrokes"
$up1 = Generate-Upstrokes -ComboRoot (Join-Path $ProjectRoot 'generated_audio_source\chords\combinations') -OverwriteFlag $Overwrite.IsPresent -RootFilterText $RootFilter -TypeFilterText $TypeFilter
$up2 = Generate-Upstrokes -ComboRoot (Join-Path $ProjectRoot 'generated_audio_source\scales\combinations') -OverwriteFlag $Overwrite.IsPresent -RootFilterText $RootFilter -TypeFilterText $TypeFilter
$up3 = Generate-Upstrokes -ComboRoot (Join-Path $ProjectRoot 'generated_audio_source\arpeggios\combinations') -OverwriteFlag $Overwrite.IsPresent -RootFilterText $RootFilter -TypeFilterText $TypeFilter

Write-Section "Summary"
$chordsCount = (Get-ChildItem -Path (Join-Path $ProjectRoot 'generated_audio_source\chords\combinations') -Recurse -File -Filter 'pos_01.mp3' | Measure-Object).Count
$scalesCount = (Get-ChildItem -Path (Join-Path $ProjectRoot 'generated_audio_source\scales\combinations') -Recurse -File -Filter 'play.mp3' | Measure-Object).Count
$arpsCount   = (Get-ChildItem -Path (Join-Path $ProjectRoot 'generated_audio_source\arpeggios\combinations') -Recurse -File -Filter 'play.mp3' | Measure-Object).Count

$upChordCount = (Get-ChildItem -Path (Join-Path $ProjectRoot 'generated_audio_source\chords\combinations') -Recurse -File -Filter 'up_01.mp3' | Measure-Object).Count
$upScaleCount = (Get-ChildItem -Path (Join-Path $ProjectRoot 'generated_audio_source\scales\combinations') -Recurse -File -Filter 'up_play.mp3' | Measure-Object).Count
$upArpCount   = (Get-ChildItem -Path (Join-Path $ProjectRoot 'generated_audio_source\arpeggios\combinations') -Recurse -File -Filter 'up_play.mp3' | Measure-Object).Count

Write-Host "chords generated:     $chordsCount"
Write-Host "scales generated:     $scalesCount"
Write-Host "arpeggios generated:  $arpsCount"
Write-Host "chords upstroke:      $upChordCount  (gen=$($up1.Generated) skip=$($up1.Skipped) fail=$($up1.Failed))"
Write-Host "scales upstroke:      $upScaleCount  (gen=$($up2.Generated) skip=$($up2.Skipped) fail=$($up2.Failed))"
Write-Host "arpeggios upstroke:   $upArpCount    (gen=$($up3.Generated) skip=$($up3.Skipped) fail=$($up3.Failed))"

Write-Section "Copying library into frontend ukulele_audio"
Copy-AudioLibraryToFrontend -Root $ProjectRoot
$siteChordCount = (Get-ChildItem -Path (Join-Path $ProjectRoot 'ukulele_audio\chords\combinations') -Recurse -File -Filter 'pos_01.mp3' | Measure-Object).Count
$siteUpCount = (Get-ChildItem -Path (Join-Path $ProjectRoot 'ukulele_audio\chords\combinations') -Recurse -File -Filter 'up_01.mp3' | Measure-Object).Count
Write-Host "frontend chord downstroke files: $siteChordCount"
Write-Host "frontend chord upstroke files:   $siteUpCount"
Write-Host "frontend audio root:             $(Join-Path $ProjectRoot 'ukulele_audio')"

Write-Host "`nDone." -ForegroundColor Green
