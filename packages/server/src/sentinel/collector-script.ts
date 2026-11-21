/**
 * The collector: a PowerShell script (Windows PowerShell 5.1, which every Windows 10 and 11 has) that the server starts as a
 * child process. It is read-only. It reads the Wi-Fi and power events from the Windows event logs (the history it asks for
 * first, then new events as they are written, through EventLogWatcher) and takes a reading of the adapter with
 * `netsh wlan show interfaces` every few seconds, and prints one JSON object per line on stdout. It changes nothing on the
 * machine, opens no network connection and writes no file. It ends when the server that started it is gone.
 *
 * Parsing of `netsh` output never depends on the display language: the signal is the one value that ends in a percent sign, the
 * two numbers before it are the rates, the RSSI is the negative number after it, and the channel is the number after the band
 * ("5 GHz"). Names of networks are not read from `netsh` at all (it prints them in the console code page, which garbles some);
 * they come from the event log, where they are Unicode.
 *
 * The text has no backtick and no dollar-brace, so it can sit in a template literal unchanged.
 */
export const COLLECTOR_VERSION = 1;

export const COLLECTOR_SCRIPT = String.raw`# Ancilla Sentinel collector v1. Read-only: reads Windows event logs and runs "netsh wlan show interfaces".
param(
  [int]$ParentPid = 0,
  [int]$SampleSeconds = 30,
  [string]$Since = '',
  [switch]$BackfillOnly,
  [switch]$NoSignal
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$stdout = [Console]::Out

function Emit($o) {
  $stdout.WriteLine((ConvertTo-Json -InputObject $o -Compress -Depth 4))
  $stdout.Flush()
}

function Millis($dt) { [long]([DateTimeOffset]$dt).ToUnixTimeMilliseconds() }

function Field($xml, $name) {
  foreach ($d in $xml.Event.EventData.Data) { if ($d.Name -eq $name) { return [string]$d.'#text' } }
  return ''
}

function WlanObject($rec, $backfill) {
  $x = [xml]$rec.ToXml()
  $o = [ordered]@{
    t = 'wlan'; b = $backfill; at = (Millis $rec.TimeCreated); rid = [long]$rec.RecordId; id = [int]$rec.Id
    cid = (Field $x 'ConnectionId'); profile = (Field $x 'ProfileName'); ssid = (Field $x 'SSID')
  }
  $rc = Field $x 'ReasonCode'
  if ($rc -match '^\d+$') { $o['rc'] = [long]$rc }
  $reason = Field $x 'Reason'
  if ($reason -eq '') { $reason = Field $x 'FailureReason' }
  $o['reason'] = $reason
  return $o
}

function PowerObject($rec, $backfill) {
  $change = 'resume'
  if ($rec.Id -eq 42 -or $rec.Id -eq 506) { $change = 'sleep' }
  return [ordered]@{ t = 'power'; b = $backfill; at = (Millis $rec.TimeCreated); rid = [long]$rec.RecordId; change = $change; src = [string]$rec.ProviderName }
}

function Source($name, $ok, $err) {
  $o = [ordered]@{ t = 'source'; name = $name; ok = $ok }
  if ($err) { $o['err'] = $err }
  Emit $o
}

function Backfill($since) {
  try {
    $found = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-WLAN-AutoConfig/Operational'; Id = 8000, 8001, 8002, 8003; StartTime = $since } -ErrorAction SilentlyContinue)
    foreach ($r in ($found | Sort-Object TimeCreated, RecordId)) { Emit (WlanObject $r 1) }
    Source 'wlan' $true $null
  } catch { Source 'wlan' $false $_.Exception.Message }
  try {
    $found = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 42, 107, 506, 507; StartTime = $since } -ErrorAction SilentlyContinue)
    $found += @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Power-Troubleshooter'; Id = 1; StartTime = $since } -ErrorAction SilentlyContinue)
    foreach ($r in ($found | Sort-Object TimeCreated, RecordId)) { Emit (PowerObject $r 1) }
    Source 'power' $true $null
  } catch { Source 'power' $false $_.Exception.Message }
}

function Watch($log, $xpath, $name) {
  $q = New-Object System.Diagnostics.Eventing.Reader.EventLogQuery($log, [System.Diagnostics.Eventing.Reader.PathType]::LogName, $xpath)
  $w = New-Object System.Diagnostics.Eventing.Reader.EventLogWatcher($q)
  Register-ObjectEvent -InputObject $w -EventName EventRecordWritten -SourceIdentifier $name | Out-Null
  $w.Enabled = $true
  return $w
}

# Returns the number of readable rows, so that a machine with no Wi-Fi is noticed.
function Sample() {
  $ErrorActionPreference = 'SilentlyContinue'
  $o = [ordered]@{ t = 'signal'; at = (Millis ([DateTime]::UtcNow)); connected = $false }
  $rows = New-Object System.Collections.ArrayList
  $lines = & (Join-Path $env:SystemRoot 'System32\netsh.exe') wlan show interfaces 2>$null
  foreach ($line in $lines) {
    if ($line -match '^\s*(.+?)\s+:\s(.*)$') { [void]$rows.Add($Matches[2].Trim()) }
  }
  $si = -1
  for ($i = 0; $i -lt $rows.Count; $i++) {
    if ($rows[$i] -match '^(\d{1,3})%$') { $si = $i; $o['signal'] = [int]$Matches[1]; break }
  }
  $bi = -1
  for ($i = 0; $i -lt $rows.Count; $i++) {
    if ($rows[$i] -match '^\d(\.\d+)? GHz$') { $bi = $i; $o['band'] = $rows[$i]; break }
  }
  if ($si -ge 0) {
    $o['connected'] = $true
    if ($si -ge 2) {
      if ($rows[$si - 1] -match '^\d+(\.\d+)?$') { $o['tx'] = [int][double]$rows[$si - 1] }
      if ($rows[$si - 2] -match '^\d+(\.\d+)?$') { $o['rx'] = [int][double]$rows[$si - 2] }
    }
    # The row after the signal is the RSSI in dBm on current Windows 11.
    if (($si + 1) -lt $rows.Count -and $rows[$si + 1] -match '^-\d{1,3}$') { $o['rssi'] = [int]$rows[$si + 1] }
    # The channel follows the band on current Windows 11, and is three rows before the signal on older builds.
    if ($bi -ge 0 -and ($bi + 1) -lt $rows.Count -and $rows[$bi + 1] -match '^\d+$') { $o['channel'] = [int]$rows[$bi + 1] }
    elseif ($bi -lt 0 -and $si -ge 3 -and $rows[$si - 3] -match '^\d+$') { $o['channel'] = [int]$rows[$si - 3] }
  }
  foreach ($v in $rows) { if ($v -match '^802\.11[a-z0-9]+') { $o['radio'] = $Matches[0]; break } }
  if ($rows.Count -gt 0) { Emit $o }
  return $rows.Count
}

Emit ([ordered]@{ t = 'hello'; v = 1; ps = $PSVersionTable.PSVersion.ToString() })
$sinceDate = (Get-Date).AddDays(-45)
if ($Since -ne '') {
  try { $sinceDate = [DateTimeOffset]::Parse($Since, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime } catch { }
}
Backfill $sinceDate
Emit ([ordered]@{ t = 'ready' })
if ($BackfillOnly) { Emit ([ordered]@{ t = 'bye' }); exit 0 }

$watchers = @()
try {
  $watchers += (Watch 'Microsoft-Windows-WLAN-AutoConfig/Operational' '*[System[(EventID=8000 or EventID=8001 or EventID=8002 or EventID=8003)]]' 'sentinel-wlan')
  Source 'wlan' $true $null
} catch { Source 'wlan' $false $_.Exception.Message }
try {
  $watchers += (Watch 'System' "*[System[(Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=42 or EventID=107 or EventID=506 or EventID=507)) or (Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1)]]" 'sentinel-power')
  Source 'power' $true $null
} catch { Source 'power' $false $_.Exception.Message }

$interval = [Math]::Max(5, $SampleSeconds)
$next = [DateTime]::UtcNow
$empty = 0
try {
  while ($true) {
    $null = Wait-Event -Timeout 2
    foreach ($ev in @(Get-Event)) {
      try {
        $rec = $ev.SourceEventArgs.EventRecord
        if ($null -ne $rec) {
          if ($ev.SourceIdentifier -eq 'sentinel-wlan') { Emit (WlanObject $rec 0) }
          elseif ($ev.SourceIdentifier -eq 'sentinel-power') { Emit (PowerObject $rec 0) }
        }
      } catch { }
      Remove-Event -EventIdentifier $ev.EventIdentifier -ErrorAction SilentlyContinue
    }
    if ($ParentPid -gt 0) {
      $alive = $true
      try { $null = [System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { $alive = $false }
      if (-not $alive) { break }
    }
    if (-not $NoSignal -and [DateTime]::UtcNow -ge $next) {
      $rows = Sample
      if ($rows -eq 0) {
        $empty++
        if ($empty -eq 3) { Source 'signal' $false 'no wireless adapter answered' }
      } else {
        if ($empty -ge 3) { Source 'signal' $true $null }
        $empty = 0
      }
      $wait = $interval
      if ($empty -ge 3) { $wait = 300 }
      $next = [DateTime]::UtcNow.AddSeconds($wait)
    }
  }
} finally {
  foreach ($w in $watchers) { try { $w.Enabled = $false; $w.Dispose() } catch { } }
  Emit ([ordered]@{ t = 'bye' })
}
`;
