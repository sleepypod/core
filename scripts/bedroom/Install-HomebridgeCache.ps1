param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$Revision,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$PublisherSha256,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9.]+$')][string]$PodAddress,
    [Parameter(Mandatory=$true)][string]$PinnedHostKeyBase64,
    [ValidateRange(1,65535)][int]$BridgePort = 40263,
    [ValidateRange(1,65535)][int]$PodPort = 8822,
    [switch]$ResumeIncomplete
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Use Administrator PowerShell' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$keygen = Join-Path $env:WINDIR 'System32\OpenSSH\ssh-keygen.exe'
if (!(Test-Path $ssh) -or !(Test-Path $keygen)) { throw 'Windows OpenSSH Client is required' }
$folder = Join-Path $env:ProgramData 'FreeSleepBedroom'
$taskName = 'FreeSleep-BedroomCache'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw 'Publisher already exists; preserve its key and inspect before updating'
}
$existingFolder = Test-Path $folder
if ($existingFolder -and !$ResumeIncomplete) { throw 'Publisher folder exists; inspect before using -ResumeIncomplete' }
if ($ResumeIncomplete) {
    if (!$existingFolder) { throw 'No incomplete publisher to resume' }
    $directory = Get-Item -LiteralPath $folder
    $expectedFiles = @('homebridge-cache.mjs','create-key.mjs','publisher_ed25519','publisher_ed25519.pub')
    $files = @(Get-ChildItem -LiteralPath $folder -Force)
    if (!$directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $files.Count -ne $expectedFiles.Count -or @($files | Where-Object {
            $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $_.Name -notin $expectedFiles
        }).Count -ne 0) { throw 'Incomplete publisher contents differ; preserve the folder for inspection' }
    if ((Get-FileHash (Join-Path $folder 'homebridge-cache.mjs') -Algorithm SHA256).Hash.ToLower() -ne $PublisherSha256) {
        throw 'Existing publisher checksum differs; preserve the folder for inspection'
    }
}
$hostKey = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PinnedHostKeyBase64)).Trim()
if ($hostKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+$') { throw 'Expected a pinned Ed25519 Pod host key' }
$bridge = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/accessories" -TimeoutSec 5
$definitions = @(
    @{model='H5106';metric='temperature';type='11'}, @{model='H5106';metric='humidity';type='10'},
    @{model='H5106';metric='pm25';type='C6'}, @{model='H5106';metric='airQuality';type='95'},
    @{model='H712C';metric='power';type='B0'}, @{model='H712C';metric='fanSpeed';type='29'},
    @{model='H7161';metric='power';type='B0'}
)
$sources = @()
foreach ($definition in $definitions) {
    $matches = @($bridge.accessories | Where-Object {
        @($_.services.characteristics | Where-Object {$_.type -eq '21' -and $_.value -eq $definition.model}).Count -eq 1
    })
    if ($matches.Count -ne 1) { throw "Expected exactly one $($definition.model); inspect the bridge mapping" }
    $accessory = $matches[0]
    $characteristics = @($accessory.services.characteristics | Where-Object {$_.type -eq $definition.type})
    if ($characteristics.Count -ne 1) { throw "Ambiguous $($definition.metric) characteristic" }
    $sources += @{sourceId="govee-$($definition.model.ToLower())-$($definition.metric)";
        aid=$accessory.aid;iid=$characteristics[0].iid;metric=$definition.metric}
}
if (!$existingFolder) { New-Item -ItemType Directory -Path $folder | Out-Null }
& icacls.exe $folder /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict publisher directory' }
$publisher = Join-Path $folder 'homebridge-cache.mjs'
Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/lucaandrea/sleepypod-core/$Revision/scripts/bedroom/homebridge-cache.mjs" -OutFile $publisher
if ((Get-FileHash $publisher -Algorithm SHA256).Hash.ToLower() -ne $PublisherSha256) { throw 'Publisher checksum mismatch' }
$key = Join-Path $folder 'publisher_ed25519'
# Node preserves the empty passphrase argument across Windows PowerShell 5.1.
$generator = @'
import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
const [keygen,key,mode] = process.argv.slice(2);
if (mode === "verify") {
    // Derive the public half without prompting or replacing the existing private key.
    const derived = spawnSync(keygen,["-y","-P","","-f",key],{encoding:"utf8",timeout:5000});
    const expected = readFileSync(key+".pub","utf8").trim().split(/\s+/);
    if (derived.status !== 0 || expected.length !== 3 || expected[0] !== "ssh-ed25519" ||
        expected[2] !== "sleepypod-bedroom-cache-only" ||
        derived.stdout.trim().split(/\s+/).slice(0,2).join(" ") !== expected.slice(0,2).join(" ")) process.exit(1);
} else {
    const generated = spawnSync(keygen,["-q","-t","ed25519","-N","","-C","sleepypod-bedroom-cache-only","-f",key],{stdio:"inherit"});
    process.exit(generated.status??1);
}
'@
$generatorPath = Join-Path $folder 'create-key.mjs'
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($generatorPath, $generator, $utf8)
if ($ResumeIncomplete) {
    & $node $generatorPath $keygen $key verify
    if ($LASTEXITCODE -ne 0) { throw 'Existing publisher key pair could not be verified; both files were preserved' }
} else {
    & $node $generatorPath $keygen $key
    if ($LASTEXITCODE -ne 0 -or !(Test-Path "$key.pub")) { throw 'Publisher key generation failed' }
}
& icacls.exe $key /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict publisher private key' }
& icacls.exe $key /setowner '*S-1-5-18' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not assign the private key to the SYSTEM task' }
if ($identity.User.Value -notin @('S-1-5-18','S-1-5-32-544')) {
    & icacls.exe $key /remove:g "*$($identity.User.Value)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove the creating user from the service key ACL' }
}
$knownHosts = Join-Path $folder 'known_hosts'
[IO.File]::WriteAllText($knownHosts, "[$PodAddress]:$PodPort $hostKey`n", $utf8)
$configPath = Join-Path $folder 'config.json'
$config = @{bridgeUrl="http://127.0.0.1:$BridgePort";sources=$sources;sshExecutable=$ssh;
    podHost=$PodAddress;podPort=$PodPort;podUser='root';keyFile=$key;knownHosts=$knownHosts;
    statusFile=(Join-Path $folder 'status.json')}
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 6), $utf8)
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$publisher`" `"$configPath`""
$startup = New-ScheduledTaskTrigger -AtStartup
$retry = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($startup,$retry) -Settings $settings `
    -User 'SYSTEM' -RunLevel Highest -Description 'Read-only Homebridge cache reports to the private Pod; no actuator access.' | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output 'Publisher installed. Send ONLY the following public key to authorize cached reports on the Pod:'
Get-Content "$key.pub"
Write-Output 'The private key stays on this Lenovo. Homebridge settings and Apple Home pairings were not changed.'
