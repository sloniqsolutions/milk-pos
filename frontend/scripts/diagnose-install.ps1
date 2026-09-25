# Pure Milk POS - install / update health check. Read-only: changes nothing.
#
# Run on the till (no admin needed), from any folder:
#   powershell -ExecutionPolicy Bypass -File diagnose-install.ps1
# It prints a report and saves the same report to the Desktop as
# PureMilkPOS-diagnose-<time>.txt - send that file back.

$ErrorActionPreference = 'SilentlyContinue'
$out = New-Object System.Collections.Generic.List[string]
function Say($s) { $out.Add([string]$s); Write-Host $s }
function Check($ok, $what) { Say ((@('FAIL', ' OK ')[[int][bool]$ok]) + '  ' + $what) }

$inst    = Join-Path $env:LOCALAPPDATA 'Programs\Pure Milk POS'
$res     = Join-Path $inst 'resources'
$backend = Join-Path $res 'backend'
$sqlite  = Join-Path $backend 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
$user    = Join-Path $env:APPDATA 'pure-milk-pos'
$updater = Join-Path $env:LOCALAPPDATA 'pure-milk-pos-updater'

Say "Pure Milk POS diagnose - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - user $env:USERNAME on $env:COMPUTERNAME"
Say ''
Say '== 1. Is an update installer running right now? (if yes: WAIT, do not reboot or reinstall)'
$setup = Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'Pure-Milk-POS-Setup*' -or $_.CommandLine -like '*pure-milk-pos-updater*' }
if ($setup) {
  foreach ($s in $setup) { Say "   RUNNING since $($s.CreationDate): $($s.CommandLine)" }
} else { Say '   none' }
$app = Get-Process -Name 'Pure Milk POS'
Say "   'Pure Milk POS.exe' processes running: $(@($app).Count)"

Say ''
Say "== 2. Install folder: $inst"
Check (Test-Path (Join-Path $inst 'Pure Milk POS.exe')) 'Pure Milk POS.exe present'
Check (Test-Path (Join-Path $res 'app\dist\index.html')) 'resources\app\dist\index.html present'
Check (Test-Path (Join-Path $res 'app\electron\main.js')) 'resources\app\electron\main.js present'
Check (Test-Path (Join-Path $res 'app\node_modules\electron-updater\package.json')) 'resources\app\node_modules\electron-updater present'
Check (Test-Path (Join-Path $backend 'server.js')) 'resources\backend\server.js present (extraResources copy)'
Check (Test-Path (Join-Path $backend 'node_modules')) 'resources\backend\node_modules present (extraFiles copy)'
$so = Get-Item $sqlite
Check ($so -and $so.Length -gt 0) "better_sqlite3.node present and non-empty (size: $(if ($so) { $so.Length } else { 'missing' }) bytes)"
$pkg = Get-Content (Join-Path $res 'app\package.json') -Raw | ConvertFrom-Json
Say "   installed app version (resources\app\package.json): $(if ($pkg) { $pkg.version } else { 'unknown' })"
foreach ($d in 'app', 'app\node_modules', 'backend', 'backend\node_modules') {
  $n = (Get-ChildItem (Join-Path $res $d) -Recurse -File -Force | Measure-Object).Count
  Say ("   file count {0,-22} {1}" -f "resources\$d", $n)
}
Say '   (a complete 1.1.2 install has about 26,000 files under resources; far fewer = a copy was cut short)'
Say '   better-sqlite3 folder contents:'
Get-ChildItem (Join-Path $backend 'node_modules\better-sqlite3') -Recurse -File -Force |
  ForEach-Object { Say ("     {0,10}  {1}" -f $_.Length, $_.FullName.Substring($backend.Length + 1)) }

Say ''
Say '== 3. Windows install record and shortcuts'
$reg = Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall, HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall, HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall |
  ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like '*Milk*' }
if ($reg) { foreach ($r in $reg) { Say "   $($r.PSPath -replace '^.*::','') -> $($r.DisplayName) $($r.DisplayVersion) at $($r.InstallLocation)" } }
else { Say '   FAIL  no uninstall entry (the app is not registered as installed)' }
foreach ($p in 'C:\Program Files\Pure Milk POS', 'C:\Program Files (x86)\Pure Milk POS') {
  if (Test-Path $p) { Say "   NOTE  a second install exists at $p" }
}
$sh = New-Object -ComObject WScript.Shell
foreach ($lnk in (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Pure Milk POS.lnk'),
                 (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Pure Milk POS.lnk')) {
  if (Test-Path $lnk) {
    $t = $sh.CreateShortcut($lnk).TargetPath
    Check (Test-Path $t) "shortcut $lnk -> $t"
  } else { Say "   missing shortcut $lnk" }
}

Say ''
Say "== 4. Updater cache: $updater"
Get-ChildItem $updater -Recurse -Force | ForEach-Object { Say ("   {0:yyyy-MM-dd HH:mm}  {1,12}  {2}" -f $_.LastWriteTime, $_.Length, $_.FullName.Substring($updater.Length)) }
Say '   leftover installer temp folders (an unfinished update leaves 7z-out behind):'
Get-ChildItem $env:TEMP -Directory -Filter 'ns*.tmp' | Where-Object { Test-Path (Join-Path $_.FullName '7z-out') } |
  ForEach-Object { Say "   $($_.FullName)  modified $($_.LastWriteTime)  files: $((Get-ChildItem (Join-Path $_.FullName '7z-out') -Recurse -File -Force | Measure-Object).Count)" }

Say ''
Say '== 5. App logs (last 60 lines each)'
foreach ($f in (Join-Path $user 'logs\main.log'), (Join-Path $user 'backend-debug.log')) {
  if (Test-Path $f) {
    Say "--- $f (modified $((Get-Item $f).LastWriteTime))"
    Get-Content $f -Tail 60 | ForEach-Object { Say "   $_" }
  } else { Say "--- $f : not present" }
}

$file = Join-Path ([Environment]::GetFolderPath('Desktop')) ("PureMilkPOS-diagnose-{0:yyyyMMdd-HHmmss}.txt" -f (Get-Date))
$out | Set-Content -Path $file -Encoding UTF8
Write-Host ''
Write-Host "Saved to $file"
