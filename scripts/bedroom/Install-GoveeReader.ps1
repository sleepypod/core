param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$Revision,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ReaderSha256,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ProtocolSha256,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ReadLoopSha256,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$PowerProtocolSha256,
    [ValidateSet('Monitor','AppliancePower')][string]$ReaderProfile = 'Monitor',
    [string]$HomebridgeRoot = (Join-Path $env:USERPROFILE '.homebridge'),
    [string]$PluginRoot = (Join-Path $env:APPDATA 'npm\node_modules\@homebridge-plugins\homebridge-govee')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Use Administrator PowerShell' }
$parent = Join-Path $env:ProgramData 'FreeSleepBedroom'
$cacheConfig = Get-Content (Join-Path $parent 'config.json') -Raw | ConvertFrom-Json
if ($cacheConfig.podUser -ne 'root' -or !(Test-Path $cacheConfig.knownHosts) -or !(Test-Path $cacheConfig.sshExecutable)) {
    throw 'A working pinned cache publisher is required first'
}
$plugin = Get-Content (Join-Path $PluginRoot 'package.json') -Raw | ConvertFrom-Json
if ($plugin.version -ne '11.39.1') { throw 'This plugin version needs separate source qualification' }
$accessories = @(foreach ($file in Get-ChildItem (Join-Path $HomebridgeRoot 'accessories\cachedAccessories.*') -File) {
    # PowerShell 5.1 can preserve a JSON array as one pipeline item. Enumerate devices explicitly.
    foreach ($accessory in (Get-Content $file.FullName -Raw | ConvertFrom-Json)) { $accessory }
})
$powerProfile = $ReaderProfile -eq 'AppliancePower'
if ($powerProfile -and !$PowerProtocolSha256) { throw 'Appliance power requires its pinned decoder checksum' }
$models = if ($powerProfile) { @('H712C','H7161') } else { @('H5106') }
$devices = @(foreach ($model in $models) {
    $deviceMatches = @($accessories | Where-Object {$_.context.gvModel -eq $model})
    if ($deviceMatches.Count -ne 1 -or $deviceMatches[0].context.gvDeviceId -isnot [string] -or
        !$deviceMatches[0].context.gvDeviceId -or $deviceMatches[0].context.awsTopic -isnot [string] -or !$deviceMatches[0].context.awsTopic) {
        throw "Expected exactly one configured $model; inspect the physical-device mapping"
    }
    [ordered]@{model=$model;deviceId=$deviceMatches[0].context.gvDeviceId}
})
if (@($devices.deviceId | Select-Object -Unique).Count -ne $devices.Count) {
    throw 'Device identities must be distinct'
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$keygen = Join-Path $env:WINDIR 'System32\OpenSSH\ssh-keygen.exe'
if (!(Test-Path $keygen)) { throw 'Windows OpenSSH Client is required' }
$readerFolder = if ($powerProfile) { 'govee-appliance-power' } else { 'govee-readings' }
$folder = Join-Path $parent $readerFolder
if (Test-Path $folder) {
    if ((Get-Item $folder).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected reader directory link' }
} else { New-Item -ItemType Directory -Path $folder | Out-Null }
& icacls.exe $folder /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict reader directory' }
$release = Join-Path $folder "releases\$Revision"
New-Item -ItemType Directory -Path $release -Force | Out-Null
$hashes = @{'govee-reader.mjs'=$ReaderSha256;'govee-protocol.mjs'=$ProtocolSha256;'govee-read-loop.mjs'=$ReadLoopSha256}
if ($powerProfile) { $hashes['govee-power-protocol.mjs']=$PowerProtocolSha256 }
foreach ($filename in $hashes.Keys) {
    $target = Join-Path $release $filename
    if (!(Test-Path $target)) {
        $download = "$target.pending"
        Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/lucaandrea/sleepypod-core/$Revision/scripts/bedroom/$filename" -OutFile $download
        if ((Get-FileHash $download -Algorithm SHA256).Hash.ToLower() -ne $hashes[$filename]) { throw 'Reader checksum mismatch' }
        Move-Item -LiteralPath $download -Destination $target
    }
    if ((Get-FileHash $target -Algorithm SHA256).Hash.ToLower() -ne $hashes[$filename]) { throw 'Installed release differs; preserved for inspection' }
}
$key = Join-Path $folder 'sensor_ed25519'
if ((Test-Path $key) -ne (Test-Path "$key.pub")) { throw 'Incomplete identity; preserve and inspect both key paths' }
$generator = @'
import {spawnSync} from "node:child_process";
import {readFileSync,existsSync} from "node:fs";
const [keygen,key,comment] = process.argv.slice(2);
if (existsSync(key)) {
    const derived=spawnSync(keygen,["-y","-P","","-f",key],{encoding:"utf8",timeout:5000});
    const expected=readFileSync(key+".pub","utf8").trim().split(/\s+/);
    if(derived.status!==0 || expected.length!==3 || expected[0]!=="ssh-ed25519" || expected[2]!==comment ||
        derived.stdout.trim().split(/\s+/).slice(0,2).join(" ")!==expected.slice(0,2).join(" "))process.exit(1);
} else {
    const result=spawnSync(keygen,["-q","-t","ed25519","-N","","-C",comment,"-f",key],{stdio:"inherit"});
    process.exit(result.status??1);
}
'@
$utf8 = New-Object Text.UTF8Encoding($false)
$generatorPath = Join-Path $folder 'verify-identity.mjs'
[IO.File]::WriteAllText($generatorPath,$generator,$utf8)
$keyComment = if ($powerProfile) { 'sleepypod-govee-power-read-only' } else { 'sleepypod-govee-read-only' }
& $node $generatorPath $keygen $key $keyComment
if ($LASTEXITCODE -ne 0) { throw 'Reader identity verification failed; no existing key was replaced' }
& icacls.exe $key /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict sensor key' }
& icacls.exe $key /setowner '*S-1-5-18' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not assign sensor key to SYSTEM' }
if ($identity.User.Value -notin @('S-1-5-18','S-1-5-32-544')) {
    & icacls.exe $key /remove:g "*$($identity.User.Value)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict sensor-key principals' }
}
$configPath = Join-Path $folder 'config.json'
$configuration = [ordered]@{mode='observe';homebridgeRoot=$HomebridgeRoot;pluginRoot=$PluginRoot;
    statusFile=(Join-Path $folder 'status.json');
    sshExecutable=$cacheConfig.sshExecutable;podHost=$cacheConfig.podHost;podPort=$cacheConfig.podPort;
    podUser='root';keyFile=$key;knownHosts=$cacheConfig.knownHosts}
if ($powerProfile) { $configuration['profile']='appliance-power'; $configuration['devices']=$devices }
else { $configuration['deviceId']=$devices[0].deviceId }
if (Test-Path $configPath) {
    $existing = Get-Content $configPath -Raw | ConvertFrom-Json
    if (@($existing.PSObject.Properties).Count -ne $configuration.Count) { throw 'Existing reader configuration differs; preserve it' }
    foreach ($name in $configuration.Keys) {
        if ((ConvertTo-Json -InputObject $existing.$name -Depth 10 -Compress) -cne
            (ConvertTo-Json -InputObject $configuration[$name] -Depth 10 -Compress)) {
            throw 'Existing reader configuration differs; preserve it'
        }
    }
} else { [IO.File]::WriteAllText($configPath,($configuration | ConvertTo-Json -Depth 10),$utf8) }
$taskName = if ($powerProfile) { 'FreeSleep-GoveeAppliancePower' } else { 'FreeSleep-GoveeReadings' }
$arguments = "`"$(Join-Path $release 'govee-reader.mjs')`" `"$configPath`""
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    if ($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne $node -or $task.Actions[0].Arguments -ne $arguments -or
        $task.Principal.UserId -notin @('SYSTEM','S-1-5-18')) { throw 'Existing task differs; preserve it for an explicit update' }
} else {
    $action = New-ScheduledTaskAction -Execute $node -Argument $arguments
    $startup = New-ScheduledTaskTrigger -AtStartup
    $retry = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($startup,$retry) -Settings $settings `
        -User 'SYSTEM' -RunLevel Highest -Description "Status-only $ReaderProfile reads; initially observation-only, no Pod publication." | Out-Null
}
Start-ScheduledTask -TaskName $taskName
Write-Output 'Reader installed in observation-only mode. The existing cache publisher was not modified.'
Write-Output 'Authorize this separate PUBLIC key only for the Govee forced receiver before any publishing cutover:'
Get-Content "$key.pub"
