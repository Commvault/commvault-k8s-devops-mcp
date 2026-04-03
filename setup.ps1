<#
.SYNOPSIS
    Commvault MCP Server — One-Stop Customer Onboarding.

.DESCRIPTION
    Interactive wizard that handles everything: prerequisites, deployment, and AI client
    configuration. Run with no parameters for fully guided setup.

    Two deployment modes:
      local      — MCP server runs as a local process on this machine (stdio).
                   Requires Node.js. Uses your local kubeconfig.
      kubernetes — MCP server runs as a pod in your cluster (HTTP/SSE, multi-user).
                   Requires Docker + kubectl + helm.

.PARAMETER Mode
    "local" or "kubernetes". Prompted interactively if not provided.

.PARAMETER Registry
    [kubernetes] Container registry, e.g. "myregistry.azurecr.io/commvault"

.PARAMETER Tag
    [kubernetes] Image tag. Default: "latest"

.PARAMETER Namespace
    [kubernetes] Namespace the MCP server pod runs in. Default: "commvault-mcp"

.PARAMETER CvNamespace
    [kubernetes] Namespace containing Commvault workloads MCP will manage. Default: "commvault"

.PARAMETER McpHostname
    [kubernetes] External hostname for the Ingress (e.g. "mcp.company.com").
                 Leave blank to expose via LoadBalancer IP.

.PARAMETER TlsSecret
    [kubernetes] TLS certificate secret name in the namespace. Default: "tls-cert-secret"

.PARAMETER McpPort
    [kubernetes] Service port exposed by the MCP endpoint. Default: 8403.

.PARAMETER AuthToken
    [kubernetes] Bearer token for AI clients. Auto-generated if not provided.

.PARAMETER AuthMode
    [kubernetes] Auth mode: "static-bearer" (default, production) or "oauth-auto" (dev/internal only).
    oauth-auto exposes an open /register endpoint and auto-approves every authorization request —
    any network-reachable caller gets a valid token. Requires explicit confirmation when selected.

.PARAMETER SkipBuild
    [kubernetes] Skip image build/push (use when image is already in registry).

.PARAMETER SkipDeploy
    [kubernetes] Skip Kubernetes deployment (build and push only).

.PARAMETER Builder
    [kubernetes] Image builder: "auto" (default), "docker", or "buildah".
    "auto" uses buildah if available, falls back to docker.

.PARAMETER KubectlVersion
    kubectl version baked into the image. Default: v1.31.0

.PARAMETER HelmVersion
    Helm version baked into the image. Default: v3.16.0

.EXAMPLE
    # Fully guided interactive setup (recommended for first-time customers)
    .\setup.ps1

    # Non-interactive local setup
    .\setup.ps1 -Mode local

    # Non-interactive Kubernetes deployment
    .\setup.ps1 -Mode kubernetes -Registry myregistry.azurecr.io/commvault -Tag 1.0.0 -McpHostname mcp.company.com

    # Build with buildah instead of docker
    .\setup.ps1 -Mode kubernetes -Registry myregistry.azurecr.io/commvault -Builder buildah

    # Specify the Commvault source registry explicitly
    .\setup.ps1 -Mode kubernetes -Registry myregistry.azurecr.io/commvault `
               -CvRegistry gitlab.testlab.commvault.com/eng-public/image-library/container_registry `
               -CvImageNamespace image-library
#>

param(
    [ValidateSet("local", "kubernetes")]
    [string]$Mode,

    [string]$Registry,
    [string]$Tag             = "latest",
    [string]$Namespace       = "commvault-mcp",
    [string]$CvNamespace     = "commvault",
    # Registry where Commvault component images are pulled FROM (separate from the MCP image registry).
    [string]$CvRegistry,
    [string]$CvImageNamespace,
    # Name of the image to build and push (default: commvault-mcp).
    [string]$ImageName       = "commvault-mcp",
    [string]$McpHostname,
    [string]$TlsSecret       = "tls-cert-secret",
    [ValidateRange(1, 65535)]
    [int]$McpPort            = 8403,
    [string]$AuthToken,
    [ValidateSet("static-bearer", "oauth-auto")]
    [string]$AuthMode        = "static-bearer",
    [switch]$SkipBuild,
    [switch]$SkipDeploy,
    [ValidateSet("auto", "docker", "buildah")]
    [string]$Builder         = "auto",
    [string]$KubectlVersion  = "v1.31.0",
    [string]$HelmVersion     = "v3.16.0"
)

$ErrorActionPreference = "Stop"
$Root   = $PSScriptRoot
$McpDir = Join-Path $Root "mcp-server"

# Some VS Code terminals keep an old PATH after new tools are installed.
# Refresh current process PATH from machine + user scopes before prereq checks.
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
if ($machinePath -or $userPath) {
    $env:Path = @($machinePath, $userPath) -join ";"
}

# Normalize namespace parameters to lowercase (Kubernetes RFC 1123 requirement)
if ($Namespace) {
    $Namespace = $Namespace.ToLower()
}
if ($CvNamespace) {
    $CvNamespace = $CvNamespace.ToLower()
}

# ─── Helpers ──────────────────────────────────────────────────────────────────

function Ask([string]$Prompt, [string]$Default = "") {
    $hint   = if ($Default) { " [$Default]" } else { "" }
    $answer = Read-Host "$Prompt$hint"
    if ([string]::IsNullOrWhiteSpace($answer)) { $Default } else { $answer.Trim() }
}

function AskBool([string]$Prompt, [bool]$Default = $true) {
    $hint   = if ($Default) { "[Y/n]" } else { "[y/N]" }
    $answer = Read-Host "$Prompt $hint"
    if ([string]::IsNullOrWhiteSpace($answer)) { $Default } else { $answer.Trim() -imatch "^y" }
}

function New-StrongToken {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Write-Step([string]$Msg)  { Write-Host "`n$Msg" -ForegroundColor Yellow }
function Write-Stage([int]$N, [int]$Total, [string]$Msg) {
    Write-Host "`n  [$N/$Total] $Msg" -ForegroundColor Cyan
    Write-Host "  $('─' * 54)" -ForegroundColor DarkGray
}
function Write-Ok([string]$Msg)   { Write-Host "       [OK] $Msg" -ForegroundColor Green }
function Write-Err([string]$Msg)  { Write-Host "       [!!] $Msg" -ForegroundColor Red }

# ─── Banner ───────────────────────────────────────────────────────────────────

Write-Host @"

╔══════════════════════════════════════════════════════╗
║    Commvault MCP Server — Customer Onboarding        ║
╚══════════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan

# ─── Mode Selection ───────────────────────────────────────────────────────────

if (-not $Mode) {
    Write-Host "Deployment Mode:"
    Write-Host "  [1] local       — Run on this machine via stdio (no Docker/Kubernetes needed)"
    Write-Host "  [2] kubernetes  — Deploy to a Kubernetes cluster (HTTP/SSE, multi-user)"
    $choice = Ask "Select mode" "1"
    $Mode   = if ($choice -eq "2" -or $choice -ieq "kubernetes") { "kubernetes" } else { "local" }
}
Write-Host "  Mode: $Mode`n" -ForegroundColor Cyan

# ─── Prerequisites Check ──────────────────────────────────────────────────────

Write-Step "Checking prerequisites..."

$toolHints = @{
    node    = "Install: winget install OpenJS.NodeJS.LTS  or  https://nodejs.org"
    kubectl = "Install: winget install Kubernetes.kubectl or  https://kubernetes.io/docs/tasks/tools"
    helm    = "Install: winget install Helm.Helm          or  https://helm.sh/docs/intro/install"
    docker  = "Install: https://www.docker.com/products/docker-desktop"
    buildah = "Install: https://buildah.io/  (or via WSL: sudo apt install buildah)"
}

# Resolve builder for kubernetes mode
if ($Mode -eq "kubernetes" -and -not $SkipBuild) {
    if ($Builder -eq "auto") {
        $Builder = if (Get-Command buildah -ErrorAction SilentlyContinue) { "buildah" } else { "docker" }
    }
}
$builderTool = if ($Builder -eq "buildah") { "buildah" } else { "docker" }

[string[]]$required = if ($Mode -eq "local") {
    @("node", "kubectl")
} elseif ($SkipBuild) {
    @("kubectl", "helm")
} else {
    @($builderTool, "kubectl", "helm")
}
$missing  = @()

foreach ($tool in $required) {
    if (Get-Command $tool -ErrorAction SilentlyContinue) {
        Write-Ok $tool
    } else {
        Write-Err "$tool — not found."
        if ($toolHints.ContainsKey($tool)) {
            Write-Host "       $($toolHints[$tool])" -ForegroundColor DarkYellow
        }
        $missing += $tool
    }
}

if ($missing.Count -gt 0) {
    Write-Host "`nInstall the tools listed above, then re-run setup.ps1" -ForegroundColor Red
    exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
# LOCAL MODE
# ─────────────────────────────────────────────────────────────────────────────

if ($Mode -eq "local") {

    Write-Step "Installing Node.js dependencies..."
    Push-Location $McpDir
    try { npm install; if ($LASTEXITCODE -ne 0) { throw "npm install failed" } }
    finally { Pop-Location }
    Write-Ok "Node.js dependencies installed"

    $indexPath = (Resolve-Path (Join-Path $McpDir "index.mjs")).Path

    # VS Code / GitHub Copilot
    $vscodeDir   = Join-Path $Root ".vscode"
    $mcpJsonPath = Join-Path $vscodeDir "mcp.json"
    New-Item -ItemType Directory -Path $vscodeDir -Force | Out-Null
    @{
        servers = @{
            "commvault-k8s" = @{
                command = "node"
                args    = @($indexPath)
                env     = @{ MCP_TRANSPORT = "stdio" }
            }
        }
    } | ConvertTo-Json -Depth 5 | Set-Content $mcpJsonPath -Encoding UTF8
    Write-Ok "VS Code config written → .vscode/mcp.json"

    # Claude Desktop
    $escapedPath = $indexPath.Replace("\", "\\")
    @"
{
  "mcpServers": {
    "commvault-k8s": {
      "command": "node",
      "args": ["$escapedPath"],
      "env": { "MCP_TRANSPORT": "stdio" }
    }
  }
}
"@ | Set-Content (Join-Path $Root "claude_desktop_config.json") -Encoding UTF8
    Write-Ok "Claude Desktop config written → claude_desktop_config.json"

    Write-Host @"

╔══════════════════════════════════════════════════════╗
║  Local setup complete!                               ║
╚══════════════════════════════════════════════════════╝

  VS Code / GitHub Copilot
  ─────────────────────────────────────────────────────
  .vscode/mcp.json is ready.
  Open this folder in VS Code — the "commvault-k8s" MCP server
  is listed automatically under GitHub Copilot > MCP Servers.

  Claude Desktop
  ─────────────────────────────────────────────────────
  Merge claude_desktop_config.json into:
    Settings → Developer → Edit Config
  Then restart Claude.

  Cursor / Windsurf
  ─────────────────────────────────────────────────────
  command : node
  args    : ["$indexPath"]
  env     : MCP_TRANSPORT=stdio

  Note: The server runs as a local process and uses your machine's
  kubeconfig to reach the cluster.
"@ -ForegroundColor Cyan
    exit 0
}

# ─────────────────────────────────────────────────────────────────────────────
# KUBERNETES MODE
# ─────────────────────────────────────────────────────────────────────────────

Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "  Kubernetes Deployment — 5 configuration stages" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "  Press Enter to accept defaults shown in [brackets]" -ForegroundColor DarkGray

# ═══════════════════════════════════════════════════════
# STAGE 1 — MCP image: where to build and push it
# ═══════════════════════════════════════════════════════
Write-Stage 1 5 "MCP Server Image — where to build and push"
Write-Host @"
     Registry type     What to enter                  Resulting image
     ────────────────  ─────────────────────────────  ─────────────────────────────────────
     Docker Hub        RepoName                       RepoName/<name>:<tag>
     Azure ACR         myacr.azurecr.io               myacr.azurecr.io/<name>:<tag>
     Azure ACR + ns    myacr.azurecr.io/myorg         myacr.azurecr.io/myorg/<name>:<tag>
     GitLab / other    registry.example.com/grp       registry.example.com/grp/<name>:<tag>
"@ -ForegroundColor DarkGray

$detectedRegistry = ""
if (-not $Registry) {
    $dockerConfigPath = Join-Path $env:USERPROFILE ".docker\config.json"
    if ((Get-Command docker -ErrorAction SilentlyContinue) -and (Test-Path $dockerConfigPath)) {
        $dockerRunning = $false
        try { docker info 2>$null | Out-Null; $dockerRunning = ($LASTEXITCODE -eq 0) } catch {}
        if ($dockerRunning) {
            try {
                $cfg = Get-Content $dockerConfigPath -Raw | ConvertFrom-Json
                $knownRegs = @()
                if ($cfg.auths) {
                    $knownRegs += $cfg.auths.PSObject.Properties.Name |
                        Where-Object { $_ -notmatch 'docker\.io|index\.docker\.io' }
                }
                if ($cfg.credHelpers) {
                    $knownRegs += $cfg.credHelpers.PSObject.Properties.Name |
                        Where-Object { $_ -notmatch 'docker\.io|index\.docker\.io' }
                }
                $knownRegs = $knownRegs | Sort-Object -Unique
                if ($knownRegs.Count -eq 1) {
                    $detectedRegistry = $knownRegs[0]
                    Write-Host "     [i] Detected Docker login: $detectedRegistry" -ForegroundColor DarkGray
                } elseif ($knownRegs.Count -gt 1) {
                    Write-Host "     [i] Multiple Docker logins detected:" -ForegroundColor DarkGray
                    for ($i = 0; $i -lt $knownRegs.Count; $i++) {
                        Write-Host "         [$($i+1)] $($knownRegs[$i])" -ForegroundColor DarkGray
                    }
                    Write-Host "         [0] Enter a different registry manually" -ForegroundColor DarkGray
                    $pick = Ask "     Choose [0-$($knownRegs.Count)]" ""
                    if ($pick -match '^[1-9][0-9]*$' -and [int]$pick -ge 1 -and [int]$pick -le $knownRegs.Count) {
                        $detectedRegistry = $knownRegs[[int]$pick - 1]
                    }
                }
            } catch {}
        }
    }
    $Registry = Ask "     Registry" $detectedRegistry
}

if ($Registry -match '^https?://') {
    $Registry = ($Registry -replace '^https?://', '').TrimEnd('/')
    Write-Host "     [i] Stripped scheme prefix — using: $Registry" -ForegroundColor DarkGray
}
$Registry = $Registry.TrimEnd('/')
if ($Registry -match '^hub\.docker\.com/repository/docker/(.+)$') {
    $Registry = ($Matches[1].TrimEnd('/')) -replace '/(general|tags|builds|collaborators|webhooks|settings)(/.*)?$', ''
    Write-Host "     [i] Converted Docker Hub URL → push reference: $Registry" -ForegroundColor DarkGray
}
if ([string]::IsNullOrWhiteSpace($Registry)) { Write-Error "Registry cannot be empty."; exit 1 }

$ImageName = Ask "     Image name" $ImageName
$Tag       = Ask "     Image tag"  $Tag
$Image     = "${Registry}/${ImageName}:${Tag}"
Write-Host "     → Will build and push: $Image" -ForegroundColor Cyan

$registryHost = ($Registry -split '/')[0]
$probeHost = if ($registryHost -eq 'hub.docker.com' -or $registryHost -eq 'docker.io' -or
                 ($registryHost -notmatch '\.' -and $registryHost -notmatch ':')) {
    'registry-1.docker.io'
} else { $registryHost }
try {
    $probe  = Invoke-WebRequest -Uri "https://$probeHost/v2/" `
                                -UseBasicParsing -TimeoutSec 10 `
                                -SkipHttpErrorCheck -ErrorAction Stop
    $status = [int]$probe.StatusCode
    if ($status -eq 200) {
        Write-Ok "Registry reachable (HTTP 200)"
    } elseif ($status -eq 401 -or $status -eq 403) {
        Write-Ok "Registry reachable (HTTP $status — login required, will authenticate at push)"
    } else {
        Write-Host "     [!] Probe returned HTTP $status. Continuing anyway." -ForegroundColor Yellow
    }
} catch {
    Write-Host "     [!] Could not reach https://$probeHost/v2/ — $($_.Exception.Message)" -ForegroundColor Yellow
    if (-not (AskBool "     Continue anyway?" $false)) { exit 1 }
}

# ═══════════════════════════════════════════════════════
# STAGE 2 — Kubernetes namespaces
# ═══════════════════════════════════════════════════════
Write-Stage 2 5 "Kubernetes Namespaces"
$Namespace   = Ask "     MCP server pod namespace"       $Namespace
$CvNamespace = Ask "     Commvault workloads namespace"  $CvNamespace

# Kubernetes requires lowercase namespace names (RFC 1123 label)
$originalNamespace = $Namespace
$Namespace = $Namespace.ToLower()
if ($Namespace -ne $originalNamespace) {
    Write-Host "     [i] Namespace converted to lowercase: $Namespace" -ForegroundColor DarkGray
}

$originalCvNamespace = $CvNamespace
$CvNamespace = $CvNamespace.ToLower()
if ($CvNamespace -ne $originalCvNamespace) {
    Write-Host "     [i] CV namespace converted to lowercase: $CvNamespace" -ForegroundColor DarkGray
}

# ═══════════════════════════════════════════════════════
# STAGE 3 — Commvault component image source registry
# ═══════════════════════════════════════════════════════
Write-Stage 3 5 "Commvault Component Images — where to pull from"
Write-Host "     This registry is used when the MCP server deploys CommServer," -ForegroundColor DarkGray
Write-Host "     AccessNode, MediaAgent, etc. into your cluster." -ForegroundColor DarkGray
if (-not $CvRegistry) {
    $CvRegistry = Ask "     Commvault components registry" "docker.io"
}
if (-not [string]::IsNullOrWhiteSpace($CvRegistry)) {
    if ($CvRegistry -match '^https?://') {
        $CvRegistry = ($CvRegistry -replace '^https?://', '').TrimEnd('/')
    } else {
        $CvRegistry = $CvRegistry.TrimEnd('/')
    }
    if (-not $CvImageNamespace) {
        $CvImageNamespace = Ask "     Image namespace/sub-path" "commvault"
    }
    $cvHost = ($CvRegistry -split '/')[0]
    try {
        $cvProbe  = Invoke-WebRequest -Uri "https://$cvHost/v2/" `
                                      -UseBasicParsing -TimeoutSec 10 `
                                      -SkipHttpErrorCheck -ErrorAction Stop
        $cvStatus = [int]$cvProbe.StatusCode
        if ($cvStatus -eq 200) {
            Write-Ok "Commvault registry reachable (HTTP 200)"
        } elseif ($cvStatus -eq 401 -or $cvStatus -eq 403) {
            Write-Ok "Commvault registry reachable (HTTP $cvStatus — authentication required at pull)"
        } else {
            Write-Host "     [!] Probe returned HTTP $cvStatus. Continuing anyway." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "     [!] Could not reach https://$cvHost/v2/ — $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "         Component deploys may fail if the registry is unreachable from the cluster." -ForegroundColor Yellow
    }
}

# ═══════════════════════════════════════════════════════
# STAGE 4 — Networking / TLS (optional)
# ═══════════════════════════════════════════════════════
Write-Stage 4 5 "Networking (optional)"
Write-Host "     Leave hostname blank to expose via LoadBalancer IP instead of Ingress." -ForegroundColor DarkGray
$McpHostname = Ask "     External hostname for MCP" $McpHostname
$McpPortInput = Ask "     MCP service port to expose" "$McpPort"
if ($McpPortInput -notmatch '^[0-9]+$' -or [int]$McpPortInput -lt 1 -or [int]$McpPortInput -gt 65535) {
    Write-Error "Invalid MCP port '$McpPortInput'. Must be an integer between 1 and 65535."
    exit 1
}
$McpPort = [int]$McpPortInput

$useTls = $false
if ($McpHostname) {
    $useTls = AskBool "     Enable TLS on Ingress" $true
    if ($useTls) { $TlsSecret = Ask "     TLS certificate Secret name" $TlsSecret }
}

# ═══════════════════════════════════════════════════════
# STAGE 5 — Authentication mode
# ═══════════════════════════════════════════════════════
Write-Stage 5 5 "Authentication Mode"
Write-Host "     [1] static-bearer  — One shared token stored in a K8s Secret. (Recommended)" -ForegroundColor DarkGray
Write-Host "     [2] oauth-auto     — OAuth 2.0 + PKCE, auto-approves every client. (Dev/internal only)" -ForegroundColor DarkGray

if ($AuthMode -eq "oauth-auto") {
    # Non-interactive path: param was set explicitly. Still enforce the warning.
    $oauthPick = "2"
} else {
    $oauthPick = Ask "     Select [1/2]" "1"
}

$oauthOptIn = $false
if ($oauthPick -eq "2") {
    Write-Host @"

     ╔══════════════════════════════════════════════════════════════════════╗
     ║  SECURITY WARNING — oauth-auto                                       ║
     ║                                                                      ║
     ║  In this mode the MCP server exposes an open /register endpoint      ║
     ║  and auto-approves every authorization request — no user consent,    ║
     ║  no allow-list.  ANY caller that can reach the server over the        ║
     ║  network receives a valid access token.                              ║
     ║                                                                      ║
     ║  Only use inside a private cluster with no external access.          ║
     ║  Use static-bearer for any internet-facing or shared deployment.     ║
     ╚══════════════════════════════════════════════════════════════════════╝
"@ -ForegroundColor Yellow
    if (AskBool "     I understand the risk and confirm this is an internal-only deployment" $false) {
        $AuthMode  = "oauth-auto"
        $oauthOptIn = $true
        Write-Host "     [OK] oauth-auto confirmed" -ForegroundColor Yellow
    } else {
        Write-Host "     [i] Reverting to static-bearer." -ForegroundColor DarkGray
        $AuthMode = "static-bearer"
    }
} else {
    $AuthMode = "static-bearer"
}

$Image    = "${Registry}/${ImageName}:${Tag}"
$protocol = if ($useTls -and $McpHostname) { "https" } else { "http" }

Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "  Configuration Summary" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "  Image to build/push  : $Image"
Write-Host "  MCP namespace        : $Namespace"
Write-Host "  Commvault namespace  : $CvNamespace"
if ($CvRegistry) {
    Write-Host "  CV image registry    : $CvRegistry"
    if ($CvImageNamespace) { Write-Host "  CV image namespace   : $CvImageNamespace" }
}
$hostnameDisplay = if ($McpHostname) { "${protocol}://${McpHostname}" } else { "LoadBalancer IP (resolved after deploy)" }
Write-Host "  External hostname    : $hostnameDisplay"
Write-Host "  MCP service port     : $McpPort"
Write-Host "  TLS                  : $useTls"
Write-Host "  Auth mode            : $AuthMode"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray

if (-not (AskBool "`n  Proceed with this configuration" $true)) { Write-Host "Aborted."; exit 0 }

# ── Build & Push ──────────────────────────────────────────────────────────────

if (-not $SkipBuild) {
    Write-Step "[1/3] Building image with $builderTool..."
    $skillSrc = Join-Path $Root "SKILL.md"
    $skillDst = Join-Path $McpDir "SKILL.md"
    if (Test-Path $skillSrc) { Copy-Item $skillSrc $skillDst -Force }

    if ($Builder -eq "buildah") {
        buildah bud `
            --build-arg KUBECTL_VERSION=$KubectlVersion `
            --build-arg HELM_VERSION=$HelmVersion `
            -t $Image "$McpDir"
        if ($LASTEXITCODE -ne 0) { Write-Error "buildah bud failed"; exit 1 }
        Write-Ok "Build succeeded: $Image"

        Write-Step "[2/3] Pushing image..."
        buildah push $Image
        if ($LASTEXITCODE -ne 0) { Write-Error "buildah push failed"; exit 1 }
    } else {
        docker build `
            --build-arg KUBECTL_VERSION=$KubectlVersion `
            --build-arg HELM_VERSION=$HelmVersion `
            -t $Image "$McpDir"
        if ($LASTEXITCODE -ne 0) { Write-Error "docker build failed"; exit 1 }
        Write-Ok "Build succeeded: $Image"

        Write-Step "[2/3] Pushing image..."
        docker push $Image
        if ($LASTEXITCODE -ne 0) { Write-Error "docker push failed"; exit 1 }
    }
    Write-Ok "Push succeeded"

    if (Test-Path $skillDst) { Remove-Item $skillDst -Force }
}

# ── Deploy to Kubernetes ──────────────────────────────────────────────────────

if (-not $SkipDeploy) {
    Write-Step "[3/3] Deploying to Kubernetes..."
    $BaseDir = Join-Path $Root "deploy\base"
    $TmpDir  = [System.IO.Path]::GetTempPath()

    # 1. Namespace
    if (-not (kubectl get namespace $Namespace --ignore-not-found -o name 2>$null)) {
        kubectl create namespace $Namespace 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to create namespace '$Namespace'. Ensure the name is lowercase and follows Kubernetes naming rules."
            exit 1
        }
    }
    Write-Ok "Namespace: $Namespace"

    # 2. Auth secret
    # Note: Even in oauth-auto mode, the base deployment.yaml references this secret,
    # so we create a dummy secret to prevent CreateContainerConfigError
    $effectiveToken = $AuthToken
    if ($AuthMode -eq "static-bearer") {
        if (-not $effectiveToken) {
            if (-not (kubectl get secret commvault-mcp-auth -n $Namespace --ignore-not-found -o name 2>$null)) {
                $effectiveToken = New-StrongToken
            }
        }
        if ($effectiveToken) {
            kubectl create secret generic commvault-mcp-auth `
                --namespace $Namespace `
                --from-literal=MCP_AUTH_TOKEN=$effectiveToken `
                --dry-run=client -o yaml | kubectl apply -f - | Out-Null
            Write-Ok "Auth secret: commvault-mcp-auth (static bearer token)"
        }
    } else {
        # oauth-auto mode: create dummy secret since deployment.yaml references it
        if (-not (kubectl get secret commvault-mcp-auth -n $Namespace --ignore-not-found -o name 2>$null)) {
            kubectl create secret generic commvault-mcp-auth `
                --namespace $Namespace `
                --from-literal=MCP_AUTH_TOKEN=unused-oauth-mode `
                --dry-run=client -o yaml | kubectl apply -f - | Out-Null
        }
        Write-Ok "Auth secret: commvault-mcp-auth (dummy for oauth-auto mode)"
    }

    # 3. Helm repo (needed by the MCP server at runtime to deploy Commvault charts)
    if (-not (helm repo list 2>$null | Select-String "commvault")) {
        helm repo add commvault https://commvault.github.io/helm-charts | Out-Null
        helm repo update | Out-Null
        Write-Ok "Helm repo added: commvault"
    }

    # 4. Base manifests (ServiceAccount, ClusterRole, Deployment, Service)
    kubectl apply -f (Join-Path $BaseDir "deployment.yaml") --namespace $Namespace | Out-Null
    Write-Ok "Base manifests applied"

    # Configure the externally exposed MCP service port.
    kubectl patch svc commvault-mcp -n $Namespace `
        -p ('{"spec":{"ports":[{"name":"http","port":' + $McpPort + ',"targetPort":8403,"protocol":"TCP"}]}}') | Out-Null
    Write-Ok "Service port set: $McpPort -> 8403"

    # Ensure the service is exposed appropriately.
    # The base Service has no type (ClusterIP default). When no Ingress hostname
    # is configured we need a LoadBalancer; when an Ingress is used ClusterIP is correct.
    if (-not $McpHostname) {
        kubectl patch svc commvault-mcp -n $Namespace `
            -p '{"spec":{"type":"LoadBalancer"}}' | Out-Null
        Write-Ok "Service type set to LoadBalancer"
    }

    # 5. ClusterRoleBinding (substitute namespace placeholder)
    $rbacTmp = Join-Path $TmpDir "mcp-rbac.yaml"
    (Get-Content (Join-Path $BaseDir "rbac.yaml") -Raw) -replace "NAMESPACE_PLACEHOLDER", $Namespace |
        Set-Content $rbacTmp -Encoding UTF8
    kubectl apply -f $rbacTmp | Out-Null
    Remove-Item $rbacTmp -Force
    Write-Ok "RBAC applied"

    # 6. NetworkPolicy
    $npFile = Join-Path $BaseDir "networkpolicy.yaml"
    if (Test-Path $npFile) { kubectl apply -f $npFile --namespace $Namespace | Out-Null; Write-Ok "NetworkPolicy applied" }

    # 7. Configure environment + set image
    $envArgs = @(
        "MCP_AUTH_MODE=$AuthMode",
        "CV_NAMESPACE=$CvNamespace",
        "PROTECTED_NAMESPACES=kube-system,kube-public,kube-node-lease,$Namespace"
    )
    if ($oauthOptIn)      { $envArgs += "MCP_OAUTH_ALLOW_INSECURE_AUTOREGISTER=true" }
    if ($CvRegistry)      { $envArgs += "CV_IMAGE_REGISTRY=$CvRegistry" }
    if ($CvImageNamespace){ $envArgs += "CV_IMAGE_NAMESPACE=$CvImageNamespace" }
    kubectl set env deployment/commvault-mcp -n $Namespace @envArgs | Out-Null

    kubectl set image deployment/commvault-mcp mcp-server=$Image -n $Namespace | Out-Null
    Write-Ok "Image set: $Image"

    # 8. Ingress (optional)
    if ($McpHostname) {
        $tlsBlock = if ($useTls) {
            "`n  tls:`n    - hosts: [`"$McpHostname`"]`n      secretName: $TlsSecret"
        } else { "" }

        $ingressTmp = Join-Path $TmpDir "mcp-ingress.yaml"
        @"
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: commvault-mcp
  namespace: $Namespace
  labels:
    app.kubernetes.io/name: commvault-mcp
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
spec:$tlsBlock
  rules:
    - host: $McpHostname
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: commvault-mcp
                port:
                  number: $McpPort
"@ | Set-Content $ingressTmp -Encoding UTF8
        kubectl apply -f $ingressTmp | Out-Null
        Remove-Item $ingressTmp -Force
        Write-Ok "Ingress: $McpHostname"
    }

    # 9. Wait for rollout
    Write-Step "Waiting for rollout..."
    kubectl rollout status deployment/commvault-mcp -n $Namespace --timeout=180s
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Rollout timeout. Check: kubectl get pods -n $Namespace" -ForegroundColor Yellow
    }

    # 10. Resolve endpoint
    if ($McpHostname) {
        $endpoint = "${protocol}://${McpHostname}"
    } else {
        Write-Host "  Waiting for LoadBalancer IP (up to 10 minutes)..." -ForegroundColor DarkGray
        $ep = ""
        for ($i = 0; $i -lt 120; $i++) {
            Start-Sleep -Seconds 5
            $ip   = kubectl get svc commvault-mcp -n $Namespace -o jsonpath='{.status.loadBalancer.ingress[0].ip}'       2>$null
            $lbHost = kubectl get svc commvault-mcp -n $Namespace -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>$null
            $ep   = if ($ip) { $ip } elseif ($lbHost) { $lbHost } else { "" }
            if ($ep) { break }
        }
        $endpoint = if ($ep) { "http://${ep}:$McpPort" } else { "http://<PENDING-IP>:$McpPort" }
    }

    # 11. Retrieve token (static-bearer only — read back pre-existing secret if not generated this run)
    if ($AuthMode -eq "static-bearer" -and -not $effectiveToken) {
        $b64 = kubectl get secret commvault-mcp-auth -n $Namespace -o jsonpath='{.data.MCP_AUTH_TOKEN}' 2>$null
        if ($b64) { $effectiveToken = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }
    }

    # 12. Generate client config files
    $vscodeDir   = Join-Path $Root ".vscode"
    $mcpJsonPath = Join-Path $vscodeDir "mcp.json"
    New-Item -ItemType Directory -Path $vscodeDir -Force | Out-Null

    if ($AuthMode -eq "oauth-auto") {
        @{
            servers = @{
                "commvault-k8s" = @{
                    type = "sse"
                    url  = "$endpoint/sse"
                }
            }
        } | ConvertTo-Json -Depth 5 | Set-Content $mcpJsonPath -Encoding UTF8
        Write-Ok "VS Code config written → .vscode/mcp.json"

        @"
{
  "mcpServers": {
    "commvault-k8s": {
      "url": "$endpoint/sse"
    }
  }
}
"@ | Set-Content (Join-Path $Root "claude_desktop_config.json") -Encoding UTF8
        Write-Ok "Claude Desktop config written → claude_desktop_config.json"
    } else {
        @{
            servers = @{
                "commvault-k8s" = @{
                    type    = "sse"
                    url     = "$endpoint/sse"
                    headers = @{ Authorization = "Bearer $effectiveToken" }
                }
            }
        } | ConvertTo-Json -Depth 5 | Set-Content $mcpJsonPath -Encoding UTF8
        Write-Ok "VS Code config written → .vscode/mcp.json"

        @"
{
  "mcpServers": {
    "commvault-k8s": {
      "url": "$endpoint/sse",
      "headers": { "Authorization": "Bearer $effectiveToken" }
    }
  }
}
"@ | Set-Content (Join-Path $Root "claude_desktop_config.json") -Encoding UTF8
        Write-Ok "Claude Desktop config written → claude_desktop_config.json"
    }

    # 13. Final summary
    if ($AuthMode -eq "oauth-auto") {
        Write-Host @"

╔══════════════════════════════════════════════════════════════════╗
║  Kubernetes deployment complete!  (oauth-auto)                   ║
╚══════════════════════════════════════════════════════════════════╝

  MCP Endpoint : $endpoint/sse
  Auth mode    : oauth-auto — clients obtain tokens dynamically via OAuth 2.0 + PKCE
  Namespace    : $Namespace

  ─── Connect an AI client ──────────────────────────────────────────

  VS Code / GitHub Copilot
    Copy .vscode/mcp.json to the workspace .vscode/ folder.
    The client will complete the OAuth flow automatically on first use.

  Claude Desktop
    Merge claude_desktop_config.json into:
      Settings → Developer → Edit Config  →  restart Claude.
    Claude will be redirected through OAuth on first use.

  Cursor / Windsurf
    type : sse
    url  : $endpoint/sse
    (No manual token needed — the client completes OAuth automatically)

  ─── CLI ───────────────────────────────────────────────────────────

    cd cli
    .\cv.bat --help
    .\cv.bat deploy ring 11.42.1 --user admin --password P@ss

  ─── Verify deployment ─────────────────────────────────────────────

    kubectl get pods -n $Namespace
    kubectl get svc  -n $Namespace
    curl $endpoint/health

  !! NOTE — oauth-auto tokens are in-memory only.
     All client sessions are lost on pod restart. Clients must re-authenticate
     after a restart or rollout. Switch to static-bearer for persistent access:
     .\setup.ps1 -Mode kubernetes -SkipBuild -AuthMode static-bearer
"@ -ForegroundColor Cyan
    } else {
        Write-Host @"

╔══════════════════════════════════════════════════════════════════╗
║  Kubernetes deployment complete!                                 ║
╚══════════════════════════════════════════════════════════════════╝

  MCP Endpoint : $endpoint/sse
  Auth Token   : $effectiveToken
  Namespace    : $Namespace

  !! Save the token above — it will not be shown again.

  ─── Connect an AI client ──────────────────────────────────────────

  VS Code / GitHub Copilot
    Copy .vscode/mcp.json to the workspace .vscode/ folder.
    The "commvault-k8s" server appears under GitHub Copilot > MCP Servers.

  Claude Desktop
    Merge claude_desktop_config.json into:
      Settings → Developer → Edit Config  →  restart Claude.

  Cursor / Windsurf
    type   : sse
    url    : $endpoint/sse
    header : Authorization: Bearer $effectiveToken

  ─── Share with other users ────────────────────────────────────────

    URL   : $endpoint/sse
    Token : $effectiveToken
    (all users share the same token)

  ─── CLI (no AI agent needed) ──────────────────────────────────────

    cd cli
    .\cv.bat --help
    .\cv.bat deploy ring 11.42.1 --user admin --password P@ss

  ─── Verify deployment ─────────────────────────────────────────────

    kubectl get pods    -n $Namespace
    kubectl get svc     -n $Namespace
    curl $endpoint/health

  ─── Rotate token ──────────────────────────────────────────────────

    .\setup.ps1 -Mode kubernetes -SkipBuild -AuthToken <new-token>
"@ -ForegroundColor Cyan
    }
}

