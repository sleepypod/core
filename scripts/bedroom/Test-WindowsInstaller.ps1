$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This installation test is only for an ephemeral GitHub Windows runner' }
$folder = Join-Path $env:ProgramData 'FreeSleepBedroom'
$fixture = Join-Path $PSScriptRoot 'homebridge-cache.mjs'
$fixtureHash = (Get-FileHash $fixture -Algorithm SHA256).Hash.ToLower()
function Invoke-RestMethod {
    param($Uri,$TimeoutSec)
    if ($Uri -ne 'http://127.0.0.1:40263/accessories') { throw 'Unexpected bridge request' }
    return @{accessories=@(
        @{aid=9;services=@(@{characteristics=@(@{type='21';value='H5106'},@{type='11';iid=10},@{type='10';iid=12},@{type='95';iid=14},@{type='C6';iid=15})})},
        @{aid=10;services=@(@{characteristics=@(@{type='21';value='H712C'},@{type='B0';iid=10},@{type='29';iid=13})})},
        @{aid=11;services=@(@{characteristics=@(@{type='21';value='H7161'},@{type='B0';iid=10})})}
    )}
}
function Invoke-WebRequest {
    param([switch]$UseBasicParsing,$Uri,$OutFile)
    Copy-Item $fixture $OutFile
}
try {
    $pin = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKz03wJatN9duVL1CYOYE9Lu8OY9TiFVCbTx6TdFKWdf'))
    & (Join-Path $PSScriptRoot 'Install-HomebridgeCache.ps1') -Revision ('a'*40) -PublisherSha256 $fixtureHash -PodAddress 127.0.0.1 -PodPort 9 -PinnedHostKeyBase64 $pin
    Stop-ScheduledTask -TaskName 'FreeSleep-BedroomCache'
    $config = Get-Content (Join-Path $folder 'config.json') -Raw | ConvertFrom-Json
    if ($config.sources.Count -ne 7 -or $config.podPort -ne 9) { throw 'Incorrect source or transport configuration' }
    $key = Join-Path $folder 'publisher_ed25519'
    $acl = Get-Acl $key
    if ($acl.Owner -notmatch 'SYSTEM') { throw 'The publishing task must own its key' }
    foreach ($entry in $acl.Access) {
        $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($sid -notin @('S-1-5-18','S-1-5-32-544')) { throw "Unexpected private-key principal: $sid" }
    }
    $task = Get-ScheduledTask -TaskName 'FreeSleep-BedroomCache'
    if ($task.Principal.UserId -notin @('SYSTEM','S-1-5-18') -or $task.Triggers.Count -ne 2) { throw 'Incorrect persistent task' }
    $keyHash = (Get-FileHash $key -Algorithm SHA256).Hash
    $publicKey = [IO.File]::ReadAllText("$key.pub")
    $installer = Join-Path $PSScriptRoot 'Install-HomebridgeCache.ps1'
    $arguments = @{Revision=('a'*40);PublisherSha256=$fixtureHash;PodAddress='127.0.0.1';PodPort=9;PinnedHostKeyBase64=$pin}
    function Assert-Rejected {
        param([string]$Expected)
        try { & $installer @arguments -ResumeIncomplete; throw 'Expected installation rejection' }
        catch { if ($_.Exception.Message -notlike "*$Expected*") { throw } }
    }
    Assert-Rejected 'Publisher already exists'
    # Reproduce the old ACL failure: a generated pair, but no config or task yet.
    Unregister-ScheduledTask -TaskName 'FreeSleep-BedroomCache' -Confirm:$false -ErrorAction SilentlyContinue
    foreach ($name in @('config.json','known_hosts','status.json')) {
        Remove-Item (Join-Path $folder $name) -Force -ErrorAction SilentlyContinue
    }
    [IO.File]::WriteAllText((Join-Path $folder 'unexpected.txt'),'preserve me')
    Assert-Rejected 'contents differ'
    Remove-Item (Join-Path $folder 'unexpected.txt') -Force
    [IO.File]::WriteAllText("$key.pub",$publicKey.Replace('ssh-ed25519 ','ssh-ed25519 B'))
    Assert-Rejected 'key pair could not be verified'
    [IO.File]::WriteAllText("$key.pub",$publicKey)
    & $installer @arguments -ResumeIncomplete
    Stop-ScheduledTask -TaskName 'FreeSleep-BedroomCache'
    if ((Get-FileHash $key -Algorithm SHA256).Hash -ne $keyHash -or [IO.File]::ReadAllText("$key.pub") -ne $publicKey) {
        throw 'Recovery must preserve both original key files'
    }
    $config = Get-Content (Join-Path $folder 'config.json') -Raw | ConvertFrom-Json
    if ($config.sources.Count -ne 7) { throw 'Recovery did not restore the source mapping' }
    $task = Get-ScheduledTask -TaskName 'FreeSleep-BedroomCache'
    if ($task.Triggers.Count -ne 2) { throw 'Recovery did not restore the persistent task' }
    $acl = Get-Acl $key
    if ($acl.Owner -notmatch 'SYSTEM') { throw 'Recovery did not retain SYSTEM ownership' }
    foreach ($entry in $acl.Access) {
        $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($sid -notin @('S-1-5-18','S-1-5-32-544')) { throw 'Recovery broadened private-key access' }
    }
    Write-Output 'Fresh installation, guarded recovery, key preservation, mapping, ownership, ACL and task checks passed.'
} finally {
    $task = Get-ScheduledTask -TaskName 'FreeSleep-BedroomCache' -ErrorAction SilentlyContinue
    if ($task) { Stop-ScheduledTask -TaskName $task.TaskName; Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false }
    if (Test-Path $folder) { Remove-Item $folder -Recurse -Force }
}
