<#
.SYNOPSIS
    Commvault Kubernetes Management CLI
    Direct kubectl/helm wrapper for use without an AI agent.

.NOTES
    Usage: cv <command> [subcommand] [parameters]
    Run "cv --help" for a full list of commands.

    Prerequisites:
    - kubectl configured with cluster access
    - helm v3 installed and commvault repo registered
      (helm repo add commvault https://commvault.github.io/helm-charts)
    - PowerShell 5.1+ (PowerShell 7+ recommended)
#>

# ============================================================================
# CONFIGURATION DEFAULTS
# ============================================================================
$script:HELM_REPO    = "commvault"
$script:DEFAULT_NAMESPACE = "commvault"

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

function Show-MainHelp {
    @"
Commvault Kubernetes Management Tool
=====================================

DEPLOYMENT & UPGRADE COMMANDS:
  cv deploy config    <csHostname> [options]          Deploy base config (configmap + secret)
  cv deploy cs        <tag> [options]                 Deploy CommServer
  cv deploy accessnode <tag> [options]                Deploy Access Node
  cv deploy ma        <tag> [options]                 Deploy Media Agent
  cv deploy webserver <tag> [options]                 Deploy Web Server
  cv deploy commandcenter <tag> [options]             Deploy Command Center
  cv deploy networkgateway <tag> [options]            Deploy Network Gateway
  cv deploy ring      <tag> [options]                 Deploy a full ring (CS + Access Nodes + MA)
  cv deploy ddbrole   [options]                       Deploy DDB backup cluster role

  cv upgrade cs       <tag> [releaseName] [namespace] Upgrade CommServer to new version
  cv upgrade accessnode <tag> [releaseName] [ns]      Upgrade Access Node
  cv upgrade ma       <tag> [releaseName] [namespace] Upgrade Media Agent
  cv upgrade all      <tag> [namespace]               Upgrade all Commvault components

  cv adddisk ma       <mountPath> [options]           Add a DDB disk volume to Media Agent
  cv uninstall        <releaseName> [namespace]       Uninstall a Helm release

KUBECTL OPERATIONAL COMMANDS:
  cv pods             [namepattern] [namespace]       List pods
  cv svc              [namepattern] [namespace]       List services
  cv describe         [namepattern] [namespace]       Describe a pod
  cv get all          [namepattern] [namespace]       Get all objects
  cv get logs         <pod> [namespace]               Download log files from pod
  cv get log          <logfile> <pod> [namespace]     Download specific log file
  cv get config                                       Export kubeconfig
  cv get reg          <pod> [namespace]               Get registry from pod
  cv get sqlpass      <pod>                           Get decrypted SQL password

  cv set ns           <namespace>                     Set default namespace
  cv set context      <context>                       Switch kubectl context
  cv set svc          <type> <svc> [namespace]        Change service type

  cv shell            <pod> [namespace]               Shell into pod (log dir)
  cv shell2           <pod> [namespace]               Shell into pod (root)
  cv livelogs         <pod> [namespace]               Stream pod logs (follow)
  cv logs             <pod> [namespace]               Get pod logs (no follow)
  cv listlogs         <pod> [namespace]               List log files in pod
  cv watch            [pod] [namespace]               Watch pods
  cv kill             <pod> [namespace]               Kill process in pod
  cv scale            <up|down> [pattern] [namespace] Scale deployments
  cv portforward      <pod> <port> [namespace]        Port forward to pod
  cv proxy            [cluster]                       Start ARC proxy
  cv config                                           View kubeconfig
  cv images           [pattern]                       List images (requires CV_REGISTRY_API env var)
  cv tags             <image> [pattern]               List tags for image (requires CV_REGISTRY_API env var)
  cv status           [namespace]                     Show deployment status

  cv --help                                           Show this help
"@
}

function Build-HelmSetArgs {
    param([hashtable]$Values)
    $setArgs = @()
    foreach ($key in $Values.Keys) {
        if ($null -ne $Values[$key] -And $Values[$key] -ne "") {
            $setArgs += "--set"
            $setArgs += "$key=$($Values[$key])"
        }
    }
    return $setArgs
}

function chart([string]$name) { return "$($script:HELM_REPO)/$name" }

# ============================================================================
# DEPLOYMENT FUNCTIONS
# ============================================================================

function Deploy-Config($params) {
    if ($params.Count -eq 0 -Or ($params.Count -eq 1 -And $params[0] -ieq "--help")) {
        @"
Usage: cv deploy config <csHostname> [options]

  csHostname              Required. CommServer or gateway hostname
  --name <name>           Helm release name (default: cvconfig)
  --namespace <ns>        Namespace (default: commvault)
  --user <user>           Admin username
  --password <pass>       Admin password
  --authcode <code>       Auth code (alternative to user/pass)

Example:
  cv deploy config cs.commvault.svc.cluster.local --user admin --password MyPass123
"@
        return
    }

    $csHostname  = $params[0]
    $releaseName = "cvconfig"
    $namespace   = $script:DEFAULT_NAMESPACE
    $user = ""; $password = ""; $authcode = ""

    for ($i = 1; $i -lt $params.Count; $i++) {
        switch ($params[$i].ToLower()) {
            "--name"      { $releaseName = $params[++$i] }
            "--namespace" { $namespace   = $params[++$i] }
            "--user"      { $user        = $params[++$i] }
            "--password"  { $password    = $params[++$i] }
            "--authcode"  { $authcode    = $params[++$i] }
        }
    }

    $helmValues = @{ "csOrGatewayHostName" = $csHostname }
    if ($user)     { $helmValues["secret.user"]     = $user }
    if ($password) { $helmValues["secret.password"] = $password }
    if ($authcode) { $helmValues["secret.authcode"] = $authcode }

    $setArgs = Build-HelmSetArgs -Values $helmValues
    $cmd = @("helm", "upgrade", "--install", $releaseName, (chart "config"), "--namespace", $namespace, "--create-namespace") + $setArgs
    ">> $($cmd -join ' ')"
    & $cmd[0] $cmd[1..($cmd.Count - 1)]
}

function Deploy-Component {
    param([string]$Component, [string]$ChartName, [string]$DefaultReleaseName, $params)

    if ($params.Count -eq 0 -Or ($params.Count -eq 1 -And $params[0] -ieq "--help")) {
        @"
Usage: cv deploy $($Component.ToLower()) <tag> [options]

  tag                     Required. Image tag, e.g. 11.42.1
  --name <name>           Helm release name (default: $DefaultReleaseName)
  --namespace <ns>        Namespace (default: commvault)
  --registry <reg>        Image registry
  --storageclass <sc>     Storage class
  --set <key=value>       Additional Helm set values (repeatable)
"@
        return
    }

    $tag         = $params[0]
    $releaseName = $DefaultReleaseName
    $namespace   = $script:DEFAULT_NAMESPACE
    $registry    = ""
    $storageClass = ""
    $extraSets   = @()

    for ($i = 1; $i -lt $params.Count; $i++) {
        switch ($params[$i].ToLower()) {
            "--name"         { $releaseName  = $params[++$i] }
            "--namespace"    { $namespace    = $params[++$i] }
            "--registry"     { $registry     = $params[++$i] }
            "--storageclass" { $storageClass = $params[++$i] }
            "--set"          { $extraSets   += $params[++$i] }
        }
    }

    $helmValues = @{ "global.image.tag" = $tag }
    if ($registry)     { $helmValues["global.image.registry"]            = $registry }
    if ($storageClass) { $helmValues["global.storageClass.certsandlogs"] = $storageClass }

    $setArgs = Build-HelmSetArgs -Values $helmValues
    $cmd = @("helm", "upgrade", "--install", $releaseName, (chart $ChartName), "--namespace", $namespace, "--create-namespace") + $setArgs
    foreach ($s in $extraSets) { $cmd += "--set"; $cmd += $s }

    ">> $($cmd -join ' ')"
    & $cmd[0] $cmd[1..($cmd.Count - 1)]
}

function Deploy-CS($params)             { Deploy-Component "CommServer"      "commserve"      "commserve"      $params }
function Deploy-AccessNode($params)     { Deploy-Component "AccessNode"      "accessnode"     "accessnode"     $params }
function Deploy-MediaAgent($params)     { Deploy-Component "MediaAgent"      "mediaagent"     "ma"             $params }
function Deploy-WebServer($params)      { Deploy-Component "WebServer"       "webserver"      "webserver"      $params }
function Deploy-CommandCenter($params)  { Deploy-Component "CommandCenter"   "commandcenter"  "commandcenter"  $params }
function Deploy-NetworkGateway($params) { Deploy-Component "NetworkGateway"  "networkgateway" "networkgateway" $params }

function Deploy-DDBRole($params) {
    $releaseName = "cv-ddb-role"
    $namespace   = $script:DEFAULT_NAMESPACE
    for ($i = 0; $i -lt $params.Count; $i++) {
        switch ($params[$i].ToLower()) {
            "--name"      { $releaseName = $params[++$i] }
            "--namespace" { $namespace   = $params[++$i] }
        }
    }
    $cmd = @("helm", "upgrade", "--install", $releaseName, (chart "cv-ddb-backup-role"), "--namespace", $namespace, "--create-namespace")
    ">> $($cmd -join ' ')"
    & $cmd[0] $cmd[1..($cmd.Count - 1)]
}

function Deploy-Ring($params) {
    if ($params.Count -eq 0 -Or ($params.Count -eq 1 -And $params[0] -ieq "--help")) {
        @"
Usage: cv deploy ring <tag> [options]

  tag                       Required. Image tag (e.g., 11.42.1)
  --namespace <ns>          Namespace (default: commvault)
  --registry <reg>          Image registry
  --user <user>             Admin username
  --password <pass>         Admin password
  --authcode <code>         Auth code
  --accessnodes <n>         Number of access nodes (default: 2)
  --mediaagents <n>         Number of media agents (default: 1)
  --webserver               Also deploy web server
  --commandcenter           Also deploy command center
  --networkgateway          Also deploy network gateway
  --storageclass <sc>       Storage class
  --ddbrole                 Also deploy DDB backup cluster role

Example:
  cv deploy ring 11.42.1 --user admin --password P@ss123 --accessnodes 2 --mediaagents 1
  cv deploy ring 11.42.1 --authcode ABCD1234 --webserver --commandcenter --namespace prod
"@
        return
    }

    $tag = $params[0]; $namespace = $script:DEFAULT_NAMESPACE; $registry = ""; $storageClass = ""
    $user = ""; $password = ""; $authcode = ""
    $accessNodeCount = 2; $mediaAgentCount = 1
    $deployWebServer = $false; $deployCommandCenter = $false
    $deployNetworkGateway = $false; $deployDdbRole = $false

    for ($i = 1; $i -lt $params.Count; $i++) {
        switch ($params[$i].ToLower()) {
            "--namespace"      { $namespace          = $params[++$i] }
            "--registry"       { $registry           = $params[++$i] }
            "--user"           { $user               = $params[++$i] }
            "--password"       { $password           = $params[++$i] }
            "--authcode"       { $authcode           = $params[++$i] }
            "--accessnodes"    { $accessNodeCount    = [int]$params[++$i] }
            "--mediaagents"    { $mediaAgentCount    = [int]$params[++$i] }
            "--webserver"      { $deployWebServer    = $true }
            "--commandcenter"  { $deployCommandCenter = $true }
            "--networkgateway" { $deployNetworkGateway = $true }
            "--storageclass"   { $storageClass       = $params[++$i] }
            "--ddbrole"        { $deployDdbRole      = $true }
        }
    }

    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host " Deploying Commvault Ring (tag: $tag)"   -ForegroundColor Cyan
    Write-Host "  Namespace   : $namespace"
    Write-Host "  Access Nodes: $accessNodeCount"
    Write-Host "  Media Agents: $mediaAgentCount"
    Write-Host "========================================`n" -ForegroundColor Cyan

    $configArgs = @("cs.$namespace.svc.cluster.local", "--namespace", $namespace)
    if ($user)     { $configArgs += "--user",     $user }
    if ($password) { $configArgs += "--password", $password }
    if ($authcode) { $configArgs += "--authcode", $authcode }
    Write-Host "[1] Deploying config..." -ForegroundColor Yellow
    Deploy-Config $configArgs

    if ($deployDdbRole) {
        Write-Host "`n[2] Deploying DDB role..." -ForegroundColor Yellow
        Deploy-DDBRole @("--namespace", $namespace)
    }

    $common = @("--namespace", $namespace)
    if ($registry)     { $common += "--registry",     $registry }
    if ($storageClass) { $common += "--storageclass", $storageClass }

    Write-Host "`n[3] Deploying CommServer..." -ForegroundColor Yellow
    Deploy-CS (@($tag, "--name", "commserve") + $common)

    for ($n = 1; $n -le $accessNodeCount; $n++) {
        Write-Host "`n[4.$n] Deploying Access Node $n..." -ForegroundColor Yellow
        Deploy-AccessNode (@($tag, "--name", "accessnode$n") + $common)
    }

    for ($n = 1; $n -le $mediaAgentCount; $n++) {
        Write-Host "`n[5.$n] Deploying Media Agent $n..." -ForegroundColor Yellow
        Deploy-MediaAgent (@($tag, "--name", "ma$n") + $common)
    }

    if ($deployWebServer) {
        Write-Host "`n[6] Deploying Web Server..." -ForegroundColor Yellow
        Deploy-WebServer (@($tag, "--name", "webserver") + $common)
    }

    if ($deployCommandCenter) {
        Write-Host "`n[7] Deploying Command Center..." -ForegroundColor Yellow
        Deploy-CommandCenter (@($tag, "--name", "commandcenter") + $common)
    }

    if ($deployNetworkGateway) {
        Write-Host "`n[8] Deploying Network Gateway..." -ForegroundColor Yellow
        Deploy-NetworkGateway (@($tag, "--name", "networkgateway") + $common)
    }

    Write-Host "`n========================================" -ForegroundColor Green
    Write-Host " Ring Deployment Complete!"               -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "Run 'cv status $namespace' to monitor pods"
}

# ============================================================================
# UPGRADE FUNCTIONS
# ============================================================================

function Upgrade-Component {
    param([string]$Component, [string]$ChartName, [string]$DefaultReleaseName, $params)

    if ($params.Count -eq 0 -Or ($params.Count -eq 1 -And $params[0] -ieq "--help")) {
        @"
Usage: cv upgrade $($Component.ToLower()) <tag> [releaseName] [namespace]

  tag           Required. New image tag (e.g., 11.42.1)
  releaseName   Helm release name (default: $DefaultReleaseName)
  namespace     Namespace (default: commvault)
"@
        return
    }

    $tag         = $params[0]
    $releaseName = if ($params.Count -gt 1) { $params[1] } else { $DefaultReleaseName }
    $namespace   = if ($params.Count -gt 2) { $params[2] } else { $script:DEFAULT_NAMESPACE }

    $cmd = @("helm", "upgrade", $releaseName, (chart $ChartName), "--namespace", $namespace, "--reuse-values", "--set", "global.image.tag=$tag")
    ">> $($cmd -join ' ')"
    & $cmd[0] $cmd[1..($cmd.Count - 1)]
}

function Upgrade-All($params) {
    if ($params.Count -eq 0 -Or ($params.Count -eq 1 -And $params[0] -ieq "--help")) {
        "Usage: cv upgrade all <tag> [namespace]"
        return
    }

    $tag       = $params[0]
    $namespace = if ($params.Count -gt 1) { $params[1] } else { $script:DEFAULT_NAMESPACE }

    Write-Host "Upgrading ALL Commvault components to $tag in namespace $namespace..." -ForegroundColor Yellow
    $releases = helm list --namespace $namespace --output json | ConvertFrom-Json
    if (-not $releases) { Write-Host "No releases found in $namespace" -ForegroundColor Red; return }

    $chartMap = @{
        commserve      = "commserve"
        accessnode     = "accessnode"
        mediaagent     = "mediaagent"
        webserver      = "webserver"
        commandcenter  = "commandcenter"
        networkgateway = "networkgateway"
    }

    foreach ($rel in $releases) {
        $base = $rel.chart -replace '-\d+\.\d+\.\d+.*$', ''
        if (-not $chartMap.ContainsKey($base)) { continue }
        Write-Host "`nUpgrading $($rel.name) ($base)..." -ForegroundColor Yellow
        $cmd = @("helm", "upgrade", $rel.name, (chart $chartMap[$base]), "--namespace", $namespace, "--reuse-values", "--set", "global.image.tag=$tag")
        ">> $($cmd -join ' ')"
        & $cmd[0] $cmd[1..($cmd.Count - 1)]
    }
    Write-Host "`nAll components upgraded to $tag" -ForegroundColor Green
}

# ============================================================================
# ADD DISK
# ============================================================================

function Add-DiskToMA($params) {
    if ($params.Count -lt 1 -Or ($params.Count -eq 1 -And $params[0] -ieq "--help")) {
        @"
Usage: cv adddisk ma <mountPath> [options]

  mountPath               Required. Container mount path (e.g., /var/ddb2)
  --size <size>           Volume size (default: 50Gi)
  --name <volName>        Volume name (default: derived from mountPath)
  --release <release>     Helm release name (default: ma)
  --namespace <ns>        Namespace (default: commvault)
  --storageclass <sc>     Storage class

Example:
  cv adddisk ma /var/ddb2 --size 100Gi --name ddb2 --release ma1
"@
        return
    }

    $mountPath   = $params[0]
    $size        = "50Gi"
    $volName     = ""
    $releaseName = "ma"
    $namespace   = $script:DEFAULT_NAMESPACE
    $storageClass = ""

    for ($i = 1; $i -lt $params.Count; $i++) {
        switch ($params[$i].ToLower()) {
            "--size"         { $size        = $params[++$i] }
            "--name"         { $volName     = $params[++$i] }
            "--release"      { $releaseName = $params[++$i] }
            "--namespace"    { $namespace   = $params[++$i] }
            "--storageclass" { $storageClass = $params[++$i] }
        }
    }

    if (-not $volName) { $volName = ($mountPath -replace '[/\\]', '-').Trim('-') -replace '^-+', '' }

    # Detect next volume index from existing helm values
    $nextIndex = 0
    try {
        $vals = helm get values $releaseName --namespace $namespace --output json | ConvertFrom-Json
        if ($vals.volumes -is [System.Array]) { $nextIndex = $vals.volumes.Count }
    } catch { }

    # Auto-detect chart from release
    $chartDir = "mediaagent"
    try {
        $rels = helm list --namespace $namespace --output json | ConvertFrom-Json
        $rel  = $rels | Where-Object { $_.name -eq $releaseName }
        if ($rel) { $chartDir = $rel.chart -replace '-\d+\.\d+\.\d+.*$', '' }
    } catch { }

    $cmd = @(
        "helm", "upgrade", $releaseName, (chart $chartDir),
        "--namespace", $namespace, "--reuse-values",
        "--set", "volumes[$nextIndex].name=$volName",
        "--set", "volumes[$nextIndex].mountPath=$mountPath",
        "--set", "volumes[$nextIndex].subPath=$volName",
        "--set", "volumes[$nextIndex].size=$size"
    )
    if ($storageClass) { $cmd += "--set"; $cmd += "volumes[$nextIndex].storageClass=$storageClass" }

    ">> $($cmd -join ' ')"
    & $cmd[0] $cmd[1..($cmd.Count - 1)]
    Write-Host "`nVolume added at index $nextIndex, mounted at $mountPath" -ForegroundColor Green
}

# ============================================================================
# UNINSTALL / STATUS
# ============================================================================

function Uninstall-Release($params) {
    if ($params.Count -eq 0 -Or ($params.Count -eq 1 -And $params[0] -ieq "--help")) {
        "Usage: cv uninstall <releaseName> [namespace]"; return
    }
    $releaseName = $params[0]
    $namespace   = if ($params.Count -gt 1) { $params[1] } else { $script:DEFAULT_NAMESPACE }
    ">> helm uninstall $releaseName --namespace $namespace"
    helm uninstall $releaseName --namespace $namespace
}

function Show-Status($params) {
    $namespace = if ($params.Count -gt 0 -And $params[0] -ne "--help") { $params[0] } else { $script:DEFAULT_NAMESPACE }
    if ($params.Count -eq 1 -And $params[0] -ieq "--help") { "Usage: cv status [namespace]"; return }

    Write-Host "`n=== Helm Releases ==="  -ForegroundColor Cyan; helm list --namespace $namespace
    Write-Host "`n=== Pods ==="           -ForegroundColor Cyan; kubectl get pods -o wide --namespace $namespace
    Write-Host "`n=== Services ==="       -ForegroundColor Cyan; kubectl get services -o wide --namespace $namespace
    Write-Host "`n=== PVCs ==="           -ForegroundColor Cyan; kubectl get pvc --namespace $namespace
    Write-Host "`n=== Deployments ==="    -ForegroundColor Cyan; kubectl get deployments --namespace $namespace
    Write-Host "`n=== StatefulSets ==="   -ForegroundColor Cyan; kubectl get statefulsets --namespace $namespace
}

# ============================================================================
# KUBECTL WRAPPERS
# ============================================================================

function printObjects($params, $operation, $objecttype) {
    $ns = if ($params.Count -gt 1) { "--namespace=" + $params[1] } else { "" }
    $cmd = "kubectl $operation $objecttype -o wide $ns"
    ">> $cmd"
    [array]$temp = & "powershell" $cmd
    if ($params.Count -eq 0 -Or $params[0] -eq "0") { $temp }
    elseif ($null -ne $temp) {
        $temp[0]
        $pat = $params[0].ToString().ToLower()
        for ($i = 1; $i -lt $temp.Count; $i++) { if ($temp[$i].ToLower().Contains($pat)) { $temp[$i] } }
    }
}

function getObjectName($params, $objecttype = "pod", $nsposition = 1) {
    $ns = if ($params.Count -gt $nsposition) { " --namespace=" + $params[$nsposition] } else { "" }
    if ($params.Count -eq 0) {
        $temp = Invoke-Expression ("kubectl get $objecttype$ns")
        return if ($temp) { ((($temp.Split([Environment]::NewLine))[1]).Split(" "))[0] }
    }
    $match = Invoke-Expression ("kubectl get $objecttype $($params[0])$ns") 2>$null
    if (-not $match) {
        [array]$all = & "powershell" "kubectl get $objecttype$ns"
        $pat = $params[0].ToString().ToLower()
        for ($i = 1; $i -lt $all.Count; $i++) { if ($all[$i].ToLower().Contains($pat)) { $match = $all[$i]; break } }
    }
    return if ($match) { ($match | Select-String $params[0]).ToString().Split(" ")[0] }
}

function getpods($params)     { printObjects $params "get" "pods" }
function getsvc($params)      { printObjects $params "get" "services" }
function getall($params)      { printObjects $params "get" "pods"; printObjects $params "get" "services"; printObjects $params "get" "deployments" }

function describepods($params) {
    $pod = getObjectName $params
    if ($pod) { kubectl describe pod $pod }
}

function watch($params) {
    $ns  = if ($params.Count -gt 1) { " --namespace=" + $params[1] } else { "" }
    $pod = if ($params.Count -gt 0 -And $params[0] -ne "0") { $params[0] } else { "" }
    ">> kubectl get pods $pod --watch -o wide$ns"
    Invoke-Expression ("kubectl get pods $pod --watch -o wide$ns")
}

function getlogs($params) {
    if ($params.Count -eq 0 -Or ($params.Count -eq 1 -And $params[0] -ieq "--help")) {
        "Usage: cv get logs <pod> [namespace]"; return
    }
    $ns  = if ($params.Count -gt 1) { " --namespace=" + $params[1] } else { "" }
    $pod = getObjectName $params
    if ($pod) {
        $dir = $pwd; Set-Location "$HOME\Downloads"
        ">> kubectl cp$ns $pod`:var/log/commvault/Log_Files/ $pod"
        Invoke-Expression ("kubectl cp$ns $pod`:var/log/commvault/Log_Files/ $pod")
        Compress-Archive -Path "$HOME\Downloads\$pod\*" -DestinationPath "$HOME\Downloads\$pod-logs.zip" -Force
        Remove-Item "$HOME\Downloads\$pod" -Recurse -Force -ErrorAction Ignore
        Set-Location $dir
        "Zip created: $HOME\Downloads\$pod-logs.zip"
    }
}

function listlogs($params) {
    $ns  = if ($params.Count -gt 1) { " --namespace=" + $params[1] } else { "" }
    $pod = getObjectName $params
    if ($pod) { Invoke-Expression ("kubectl exec$ns $pod -- ls /var/log/commvault/Log_Files/") | Sort-Object }
}

function getlog($params) {
    if ($params.Count -lt 2) { "Usage: cv get log <logfile> <pod> [namespace]"; return }
    $ns  = if ($params.Count -gt 2) { " --namespace=" + $params[2] } else { "" }
    $pod = getObjectName $params[1..($params.Length - 1)]
    if ($pod) {
        $logfile = $params[0]; $dir = $pwd; Set-Location "$HOME\Downloads"
        ">> kubectl cp$ns $pod`:var/log/commvault/Log_Files/$logfile ./$logfile"
        Invoke-Expression ("kubectl cp$ns $pod`:var/log/commvault/Log_Files/$logfile ./$logfile")
        Set-Location $dir
        "Downloaded: $HOME\Downloads\$logfile"
    }
}

function getreg($params) {
    $ns  = if ($params.Count -gt 1) { " --namespace=" + $params[1] } else { "" }
    $pod = getObjectName $params
    if ($pod) {
        $dir = $pwd; Set-Location "$HOME\Downloads"
        Invoke-Expression ("kubectl cp$ns $pod`:/etc/CommVaultRegistry/ $pod")
        Compress-Archive -Path "$HOME\Downloads\$pod\*" -DestinationPath "$HOME\Downloads\$pod-reg.zip" -Force
        Remove-Item "$HOME\Downloads\$pod" -Recurse -Force -ErrorAction Ignore
        Set-Location $dir
        "Zip created: $HOME\Downloads\$pod-reg.zip"
    }
}

function shell($params) {
    $ns  = if ($params.Count -gt 1) { " --namespace=" + $params[1] } else { "" }
    $pod = getObjectName $params
    if ($pod) { Invoke-Expression ("kubectl exec$ns --stdin --tty $pod -- /bin/bash -c `"cd /var/log/commvault/Log_Files/ && /bin/bash`"") }
}

function shell2($params) {
    $ns  = if ($params.Count -gt 1) { " --namespace=" + $params[1] } else { "" }
    $pod = getObjectName $params
    if ($pod) { Invoke-Expression ("kubectl exec$ns --stdin --tty $pod -- /bin/bash") }
}

function killpod($params) {
    $ns  = if ($params.Count -gt 1) { " --namespace=" + $params[1] } else { "" }
    $pod = getObjectName $params
    if ($pod) { Invoke-Expression ("kubectl exec$ns --stdin --tty $pod -- kill -9 7") }
}

function livelogs($params, $follow = $true) {
    $ns  = if ($params.Count -gt 1) { " --namespace=" + $params[1] } else { "" }
    $pod = getObjectName $params
    if ($pod) {
        $followFlag = if ($follow) { " --follow" } else { "" }
        Invoke-Expression ("kubectl logs $pod$followFlag$ns")
    }
}

function getconfig($params) {
    $dir = $pwd; Set-Location "$HOME\Downloads"
    Invoke-Expression "kubectl config view --flatten --minify > config"
    Set-Location $dir
    "kubeconfig exported to $HOME\Downloads\config"
}

function viewconfig($params) { kubectl config view }

function startproxy($params) {
    $cluster = if ($params.Count -ge 1) { $params[0] } else { "k8sdevtestcluster03" }
    Invoke-Expression ("az connectedk8s proxy -n $cluster -g AKS-HyBridEngg")
}

function getsqlpass($params) {
    $pod = getObjectName $params
    if ($pod) {
        $reg = kubectl exec --stdin --tty $pod -- cat /etc/CommVaultRegistry/Galaxy/Instance001/Database/.properties
        $line = $reg | Select-String "pACCESS"
        if (-not $line) { "No database password found"; return }
        $enc = $line.ToString().Split(' ')[1]
        $result = kubectl exec --stdin --tty $pod -- /opt/commvault/Base/SIMCallWrapper -opType 101 -enc $enc -output console
        ($result | Select-String "Output").ToString().Substring(7)
    }
}

function scale($params) {
    if ($params.Count -lt 1 -Or ($params.Count -eq 1 -And $params[0] -ieq "--help")) {
        "Usage: cv scale <up|down> [namepattern] [namespace]"; return
    }
    $op = $params[0]; $replicas = if ($op -ieq "up") { 1 } else { 0 }
    $ns = if ($params.Count -gt 2) { " --namespace=" + $params[2] } else { "" }

    if ($params.Count -eq 1 -Or $params[1] -eq "0") {
        Invoke-Expression ("kubectl scale deploy --replicas=$replicas --all$ns")
        Invoke-Expression ("kubectl scale statefulset --replicas=$replicas --all$ns")
    } else {
        [array]$items = & "powershell" "kubectl get deployments,statefulsets$ns"
        foreach ($item in $items[1..($items.Count - 1)]) {
            if ($item.ToLower().Contains($params[1].ToLower())) {
                $type = ($item.Split("."))[0]; $name = ($item.Split("/"))[1]
                Invoke-Expression ("kubectl scale $type --replicas=$replicas $name$ns")
            }
        }
    }
}

function setns($params)      { Invoke-Expression ("kubectl config set-context --current --namespace=" + $params[0]) }
function setcontext($params) { Invoke-Expression ("kubectl config use-context " + $params[0]) }

function setsvc($params) {
    if ($params.Count -lt 2) { "Usage: cv set svc <LoadBalancer|ClusterIP|NodePort> <svc> [namespace]"; return }
    $ns = if ($params.Count -gt 2) { "--namespace=" + $params[2] } else { $null }
    $svc = getObjectName $params[1..($params.Length - 1)] "service"
    if ($svc) {
        $type = switch ($params[0].ToLower()) { "loadbalancer" { "LoadBalancer" } "clusterip" { "ClusterIP" } "nodeport" { "NodePort" } default { $null } }
        if (-not $type) { "Invalid type. Use LoadBalancer, ClusterIP, or NodePort"; return }
        $spec = '{"spec":{"type":"' + $type + '"}}'
        kubectl patch svc $svc -p $spec $ns
    }
}

function portforward($params) {
    if ($params.Count -lt 2) { "Usage: cv portforward <pod> <port> [namespace]"; return }
    $ns  = if ($params.Count -gt 2) { " --namespace=" + $params[2] } else { "" }
    $pod = getObjectName $params "pod" 2
    if ($pod) { Invoke-Expression ("kubectl port-forward$ns $pod :" + $params[1]) }
}

# ── Registry browser helpers ───────────────────────────────────────────
# Set CV_REGISTRY_API to your GitLab project API base, e.g.:
#   https://mygitlab.com/api/v4/projects/123
# Optionally set CV_REGISTRY_TOKEN for private/authenticated registries.

function Get-RegistryApiBase {
    if ($script:_REGISTRY_API) { return $script:_REGISTRY_API }
    $url = $env:CV_REGISTRY_API
    if (-not $url) {
        Write-Host ""
        Write-Host "  Registry API not configured. Set CV_REGISTRY_API or enter it now:" -ForegroundColor Yellow
        Write-Host "    Format: https://<gitlab-host>/api/v4/projects/<project-id>" -ForegroundColor DarkGray
        $url = Read-Host "  GitLab project API URL"
    }
    if (-not $url) { Write-Error "CV_REGISTRY_API is required."; return $null }
    $script:_REGISTRY_API = $url.TrimEnd("/")
    return $script:_REGISTRY_API
}

function Get-RegistryHeaders {
    $h = @{}
    if ($env:CV_REGISTRY_TOKEN) { $h["PRIVATE-TOKEN"] = $env:CV_REGISTRY_TOKEN }
    return $h
}

function images($params) {
    $base = Get-RegistryApiBase; if (-not $base) { return }
    $temp = Invoke-RestMethod -Uri "$base/registry/repositories" -Headers (Get-RegistryHeaders)
    if ($params.Count -eq 0) { $temp | Format-Table -Property id, name, location }
    else { $temp | Where-Object { $_.name -like "*$($params[0])*" } | Format-Table -Property id, name, location }
}

function tags($params) {
    if ($params.Count -eq 0) { "Usage: cv tags <imagename> [pattern]"; return }
    $base = Get-RegistryApiBase; if (-not $base) { return }
    $hdr  = Get-RegistryHeaders
    $allRepos = Invoke-RestMethod -Uri "$base/registry/repositories" -Headers $hdr
    $image    = $allRepos | Where-Object { $_.name -like "*$($params[0])*" }
    if (-not $image) { "Image '$($params[0])' not found"; return }
    $tagList   = Invoke-RestMethod -Uri "$base/registry/repositories/$($image.id)/tags?per_page=1000" -Headers $hdr
    $finalList = @()
    foreach ($t in $tagList) {
        if ($params.Count -eq 2 -And $t.name -notlike "*$($params[1])*") { continue }
        $detail = Invoke-RestMethod -Uri "$base/registry/repositories/$($image.id)/tags/$($t.name)" -Headers $hdr
        $t | Add-Member -NotePropertyName created_at -NotePropertyValue $detail.created_at    -Force
        $t | Add-Member -NotePropertyName size_mb    -NotePropertyValue ([int]($detail.total_size / 1MB)) -Force
        $finalList += $t
    }
    $finalList | Sort-Object created_at | Format-Table -Property name, created_at, size_mb, location
}

# ============================================================================
# DISPATCHERS
# ============================================================================

function get($params) {
    if ($params.Count -eq 0) { "cv get [logs|log|config|reg|sqlpass|pods|all|svc]"; return }
    $p2 = if ($params.Count -gt 1) { $params[1..($params.Length - 1)] } else { @() }
    switch ($params[0].ToLower()) {
        "pods"    { getpods $p2 }
        "svc"     { getsvc $p2 }
        "services"{ getsvc $p2 }
        "logs"    { getlogs $p2 }
        "log"     { getlog $p2 }
        "reg"     { getreg $p2 }
        "config"  { getconfig $p2 }
        "sqlpass" { getsqlpass $p2 }
        "all"     { getall $p2 }
        default   { "cv get [logs|log|config|reg|sqlpass|pods|all|svc]" }
    }
}

function setfunc($params) {
    if ($params.Count -eq 0) { "cv set [ns|context|svc]"; return }
    $p2 = if ($params.Count -gt 1) { $params[1..($params.Length - 1)] } else { @() }
    switch ($params[0].ToLower()) {
        "ns"      { setns $p2 }
        "context" { setcontext $p2 }
        "svc"     { setsvc $params }  # svc needs full params to include type
    }
}

# ============================================================================
# MAIN ENTRY POINT
# ============================================================================

if ($args.Count -eq 0) { Show-MainHelp; exit }

$params = if ($args.Count -gt 1) { $args[1..($args.Length - 1)] } else { @() }

switch ($args[0].ToLower()) {
    "deploy"      { if ($params.Count -eq 0) { "cv deploy [config|cs|accessnode|ma|webserver|commandcenter|networkgateway|ring|ddbrole]"; break }
                    $p2 = if ($params.Count -gt 1) { $params[1..($params.Length-1)] } else { @() }
                    switch ($params[0].ToLower()) {
                        "config"         { Deploy-Config $p2 }
                        "cs"             { Deploy-CS $p2 }
                        "commserver"     { Deploy-CS $p2 }
                        "accessnode"     { Deploy-AccessNode $p2 }
                        "an"             { Deploy-AccessNode $p2 }
                        "ma"             { Deploy-MediaAgent $p2 }
                        "mediaagent"     { Deploy-MediaAgent $p2 }
                        "webserver"      { Deploy-WebServer $p2 }
                        "ws"             { Deploy-WebServer $p2 }
                        "commandcenter"  { Deploy-CommandCenter $p2 }
                        "cc"             { Deploy-CommandCenter $p2 }
                        "networkgateway" { Deploy-NetworkGateway $p2 }
                        "ng"             { Deploy-NetworkGateway $p2 }
                        "ring"           { Deploy-Ring $p2 }
                        "ddbrole"        { Deploy-DDBRole $p2 }
                        default          { "cv deploy [config|cs|accessnode|ma|webserver|commandcenter|networkgateway|ring|ddbrole]" }
                    }; break }
    "upgrade"     { if ($params.Count -eq 0) { "cv upgrade [cs|accessnode|ma|webserver|commandcenter|networkgateway|all]"; break }
                    $p2 = if ($params.Count -gt 1) { $params[1..($params.Length-1)] } else { @() }
                    switch ($params[0].ToLower()) {
                        "cs"             { Upgrade-Component "CommServer"      "commserve"      "commserve"      $p2 }
                        "commserver"     { Upgrade-Component "CommServer"      "commserve"      "commserve"      $p2 }
                        "accessnode"     { Upgrade-Component "AccessNode"      "accessnode"     "accessnode"     $p2 }
                        "an"             { Upgrade-Component "AccessNode"      "accessnode"     "accessnode"     $p2 }
                        "ma"             { Upgrade-Component "MediaAgent"      "mediaagent"     "ma"             $p2 }
                        "mediaagent"     { Upgrade-Component "MediaAgent"      "mediaagent"     "ma"             $p2 }
                        "webserver"      { Upgrade-Component "WebServer"       "webserver"      "webserver"      $p2 }
                        "ws"             { Upgrade-Component "WebServer"       "webserver"      "webserver"      $p2 }
                        "commandcenter"  { Upgrade-Component "CommandCenter"   "commandcenter"  "commandcenter"  $p2 }
                        "cc"             { Upgrade-Component "CommandCenter"   "commandcenter"  "commandcenter"  $p2 }
                        "networkgateway" { Upgrade-Component "NetworkGateway"  "networkgateway" "networkgateway" $p2 }
                        "ng"             { Upgrade-Component "NetworkGateway"  "networkgateway" "networkgateway" $p2 }
                        "all"            { Upgrade-All $p2 }
                        default          { "cv upgrade [cs|accessnode|ma|webserver|commandcenter|networkgateway|all]" }
                    }; break }
    "adddisk"     { if ($params.Count -eq 0) { "cv adddisk [ma|mediaagent]"; break }
                    $p2 = if ($params.Count -gt 1) { $params[1..($params.Length-1)] } else { @() }
                    switch ($params[0].ToLower()) {
                        { $_ -in "ma","mediaagent" } { Add-DiskToMA $p2 }
                        default { "cv adddisk [ma|mediaagent]" }
                    }; break }
    "uninstall"   { Uninstall-Release $params; break }
    "status"      { Show-Status $params; break }
    "pods"        { getpods $params; break }
    "describe"    { describepods $params; break }
    "services"    { getsvc $params; break }
    "svc"         { getsvc $params; break }
    "get"         { get $params; break }
    "set"         { setfunc $params; break }
    "config"      { viewconfig $params; break }
    "proxy"       { startproxy $params; break }
    "scale"       { scale $params; break }
    "watch"       { watch $params; break }
    "shell"       { shell $params; break }
    "shell2"      { shell2 $params; break }
    "livelogs"    { livelogs $params; break }
    "logs"        { livelogs $params $false; break }
    "listlogs"    { listlogs $params; break }
    "portforward" { portforward $params; break }
    "kill"        { killpod $params; break }
    "images"      { images $params; break }
    "tags"        { tags $params; break }
    { $_ -in "--help","-h","help" } { Show-MainHelp; break }
    default       { Show-MainHelp }
}
