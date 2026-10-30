param([ValidateSet('Monitor','AppliancePower')][string]$ReaderProfile='Monitor')
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This installation test is only for an ephemeral GitHub Windows runner' }
$folder=Join-Path $env:ProgramData 'FreeSleepBedroom'
$powerProfile=$ReaderProfile -eq 'AppliancePower'
$readerFolder=if ($powerProfile) { 'govee-appliance-power' } else { 'govee-readings' }
$readerTask=if ($powerProfile) { 'FreeSleep-GoveeAppliancePower' } else { 'FreeSleep-GoveeReadings' }
$remainingSource=if ($powerProfile) { 'govee-h712c-fanSpeed' } else { 'appliance-state' }
$fixtureRoot=Join-Path $env:RUNNER_TEMP 'govee-installer-fixture'
$homebridge=Join-Path $fixtureRoot 'homebridge'
$plugin=Join-Path $fixtureRoot 'plugin'
New-Item -ItemType Directory -Path $folder,(Join-Path $homebridge 'accessories'),$plugin -Force | Out-Null
$utf8=New-Object Text.UTF8Encoding($false)
$fixture=Join-Path $fixtureRoot 'govee-reader.mjs'
# An inert child exercises the real SYSTEM task without accessing a provider or owner credentials.
[IO.File]::WriteAllText($fixture,'setInterval(()=>{},1000)',$utf8)
[IO.File]::WriteAllText((Join-Path $plugin 'package.json'),' {"version":"11.39.1"}',$utf8)
[IO.File]::WriteAllText((Join-Path $homebridge 'accessories\cachedAccessories.fixture'),
    '[{"context":{"gvModel":"H712C","gvDeviceId":"test-purifier","awsTopic":"test/purifier"}},{"context":{"gvModel":"H5106","gvDeviceId":"test-monitor","awsTopic":"test/device"}},{"context":{"gvModel":"H7161","gvDeviceId":"test-diffuser","awsTopic":"test/diffuser"}}]',$utf8)
$known=Join-Path $folder 'known_hosts'
[IO.File]::WriteAllText($known,'test-only-host-pin',$utf8)
$cache=[ordered]@{podHost='127.0.0.1';podPort=9;podUser='root';knownHosts=$known;
    sshExecutable=(Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe');sources=@(
        @{sourceId='govee-h5106-temperature'},@{sourceId='govee-h5106-humidity'},
        @{sourceId='govee-h5106-pm25'},@{sourceId='govee-h5106-airQuality'},@{sourceId='appliance-state'})}
if ($powerProfile) { $cache.sources=@(@{sourceId='govee-h712c-power'},@{sourceId='govee-h7161-power'},@{sourceId='govee-h712c-fanSpeed'}) }
$cachePath=Join-Path $folder 'config.json'
[IO.File]::WriteAllText($cachePath,($cache | ConvertTo-Json),$utf8)
$cacheHash=(Get-FileHash $cachePath -Algorithm SHA256).Hash
function Invoke-WebRequest {
    param([switch]$UseBasicParsing,$Uri,$OutFile)
    $name=($Uri -split '/')[-1]
    if ($name -eq 'govee-reader.mjs') { Copy-Item $fixture $OutFile }
    elseif ($name -in @('govee-protocol.mjs','govee-read-loop.mjs','govee-power-protocol.mjs')) { Copy-Item (Join-Path $PSScriptRoot $name) $OutFile }
    else { throw 'Unexpected artifact request' }
}
$installer=Join-Path $PSScriptRoot 'Install-GoveeReader.ps1'
$arguments=@{Revision=('b'*40);ReaderSha256=(Get-FileHash $fixture -Algorithm SHA256).Hash.ToLower();
    ProtocolSha256=(Get-FileHash (Join-Path $PSScriptRoot 'govee-protocol.mjs') -Algorithm SHA256).Hash.ToLower();
    ReadLoopSha256=(Get-FileHash (Join-Path $PSScriptRoot 'govee-read-loop.mjs') -Algorithm SHA256).Hash.ToLower();
    PowerProtocolSha256=(Get-FileHash (Join-Path $PSScriptRoot 'govee-power-protocol.mjs') -Algorithm SHA256).Hash.ToLower();
    ReaderProfile=$ReaderProfile;HomebridgeRoot=$homebridge;PluginRoot=$plugin}
function Assert-Rejected {
    param([string]$Expected)
    try { & $installer @arguments; throw 'Expected installation rejection' }
    catch { if ($_.Exception.Message -notlike "*$Expected*") { throw } }
}
try {
    & $installer @arguments
    Stop-ScheduledTask -TaskName $readerTask
    $readerRoot=Join-Path $folder $readerFolder
    $key=Join-Path $readerRoot 'sensor_ed25519'
    $keyHash=(Get-FileHash $key -Algorithm SHA256).Hash
    $configPath=Join-Path $readerRoot 'config.json'
    $configuration=Get-Content $configPath -Raw | ConvertFrom-Json
    if ($configuration.mode -ne 'observe' -or
        $configuration.homebridgeRoot -ne $homebridge) { throw 'Unexpected observation configuration' }
    if ($powerProfile) {
        if ($configuration.profile -ne 'appliance-power' -or $configuration.devices.Count -ne 2 -or
            $configuration.devices[0].model -ne 'H712C' -or $configuration.devices[0].deviceId -ne 'test-purifier' -or
            $configuration.devices[1].model -ne 'H7161' -or $configuration.devices[1].deviceId -ne 'test-diffuser') {
            throw 'Unexpected appliance identity mapping'
        }
    } elseif ($configuration.deviceId -isnot [string] -or $configuration.deviceId -ne 'test-monitor') {
        throw 'Unexpected monitor identity mapping'
    }
    if ((Get-FileHash $cachePath -Algorithm SHA256).Hash -ne $cacheHash) { throw 'Existing cache publisher changed' }
    $acl=Get-Acl $key
    if ($acl.Owner -notmatch 'SYSTEM') { throw 'The SYSTEM reader must own its key' }
    foreach ($entry in $acl.Access) {
        if ($entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')) {
            throw 'Unexpected sensor-key principal'
        }
    }
    & $installer @arguments
    Stop-ScheduledTask -TaskName $readerTask
    if ((Get-FileHash $key -Algorithm SHA256).Hash -ne $keyHash) { throw 'Idempotent installation replaced its key' }
    $task=Get-ScheduledTask -TaskName $readerTask
    if ($task.Principal.UserId -notin @('SYSTEM','S-1-5-18') -or $task.Triggers.Count -ne 2) { throw 'Incorrect persistent task' }
    Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false
    & $installer @arguments
    Stop-ScheduledTask -TaskName $readerTask
    if ((Get-FileHash $key -Algorithm SHA256).Hash -ne $keyHash) { throw 'Task recovery replaced its key' }
    $action=New-ScheduledTaskAction -Execute (Get-Command node.exe).Source -Argument "`"$fixture`""
    Register-ScheduledTask -TaskName 'FreeSleep-BedroomCache' -Action $action -User 'SYSTEM' -RunLevel Highest | Out-Null
    $status=@{receipt=@{observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();reading=@{temperatureC=21}}}
    if ($powerProfile) {
        $status=@{devices=@{}}
        foreach ($model in @('H712C','H7161')) {
            $status.devices[$model]=@{receipt=@{model=$model;observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();reading=@{power=0}}}
        }
    }
    [IO.File]::WriteAllText((Join-Path $readerRoot 'status.json'),($status | ConvertTo-Json -Depth 5),$utf8)
    $handoff=Join-Path $PSScriptRoot 'Set-GoveeReaderMode.ps1'
    if ($powerProfile) {
        $incomplete=@{devices=@{H712C=$status.devices.H712C}}
        [IO.File]::WriteAllText((Join-Path $readerRoot 'status.json'),($incomplete | ConvertTo-Json -Depth 6),$utf8)
        try { & $handoff -Mode Publish -ReaderProfile $ReaderProfile; throw 'Expected incomplete observation rejection' }
        catch { if ($_.Exception.Message -notlike '*Both qualified*') { throw } }
        if ((Get-FileHash $cachePath -Algorithm SHA256).Hash -ne $cacheHash) { throw 'Failed qualification changed source ownership' }
        [IO.File]::WriteAllText((Join-Path $readerRoot 'status.json'),($status | ConvertTo-Json -Depth 6),$utf8)
    }
    & $handoff -Mode Publish -ReaderProfile $ReaderProfile
    $publishedCache=Get-Content $cachePath -Raw | ConvertFrom-Json
    if ($publishedCache.sources.Count -ne 1 -or $publishedCache.sources[0].sourceId -ne $remainingSource -or
        (Get-Content $configPath -Raw | ConvertFrom-Json).mode -ne 'publish') { throw 'Source handoff failed' }
    & $handoff -Mode Publish -ReaderProfile $ReaderProfile
    & $handoff -Mode Observe -ReaderProfile $ReaderProfile
    if ((Get-FileHash $cachePath -Algorithm SHA256).Hash -ne $cacheHash -or
        (Get-Content $configPath -Raw | ConvertFrom-Json).mode -ne 'observe') { throw 'Exact rollback failed' }
    # Interrupted handoff with only one config replaced is resumed from its durable manifest.
    $manifest=Get-Content (Join-Path $readerRoot 'handoff.json') -Raw | ConvertFrom-Json
    [IO.File]::WriteAllText($cachePath,$manifest.cacheAfter,$utf8)
    & $handoff -Mode Publish -ReaderProfile $ReaderProfile
    & $handoff -Mode Observe -ReaderProfile $ReaderProfile
    [IO.File]::WriteAllText($cachePath,'{"unexpected":"preserve"}',$utf8)
    try { & $handoff -Mode Publish -ReaderProfile $ReaderProfile; throw 'Expected changed-config rejection' }
    catch { if ($_.Exception.Message -notlike '*changed outside*') { throw } }
    [IO.File]::WriteAllText($cachePath,$manifest.cacheBefore,$utf8)
    $configuration.mode='publish'
    [IO.File]::WriteAllText($configPath,($configuration | ConvertTo-Json),$utf8)
    Assert-Rejected 'configuration differs'
    if ((Get-Content $configPath -Raw | ConvertFrom-Json).mode -ne 'publish') { throw 'Existing reader mode was overwritten' }
    Write-Output 'Observation-only installation, preserved cache, key ACLs, idempotence, recovery, handoff, rollback and active-mode protection passed.'
} finally {
    $task=Get-ScheduledTask -TaskName $readerTask -ErrorAction SilentlyContinue
    if ($task) { Stop-ScheduledTask -TaskName $task.TaskName; Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false }
    $cacheTask=Get-ScheduledTask -TaskName 'FreeSleep-BedroomCache' -ErrorAction SilentlyContinue
    if ($cacheTask) { Stop-ScheduledTask -TaskName $cacheTask.TaskName; Unregister-ScheduledTask -TaskName $cacheTask.TaskName -Confirm:$false }
    if (Test-Path $folder) { Remove-Item $folder -Recurse -Force }
    if (Test-Path $fixtureRoot) { Remove-Item $fixtureRoot -Recurse -Force }
}
