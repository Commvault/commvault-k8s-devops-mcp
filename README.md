# Commvault Kubernetes MCP Server

**Manage your Commvault Kubernetes deployments using natural language with AI.**

## Overview

This [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server enables natural language management of Kubernetes clusters through AI assistants like GitHub Copilot, Claude, and Cursor. Deploy Commvault components, troubleshoot issues, check logs, and manage infrastructure using conversational commands.

---

## Capabilities

Instead of memorizing kubectl commands and Helm charts, interact with your infrastructure using natural language:

**Deployment & Configuration**
- *"Deploy a Commvault ring version 11.42.1 with admin credentials"*
- *"Set up a new AccessNode with 4 replicas"*
- *"Add a 500GB storage disk to the MediaAgent"*

**Monitoring & Troubleshooting**
- *"Show me all running Commvault pods"*
- *"Why is the CommServer pod failing?"*
- *"Get the last 100 lines of logs from the AccessNode"*
- *"What's the status of my entire Commvault deployment?"*

**Management & Operations**
- *"Scale the MediaAgent to 3 replicas"*
- *"Upgrade all components to version 11.42.2"*
- *"Download the debug logs from the failing pod"*
- *"Port-forward to the CommServer so I can access the Web Console"*

---

## Installation

Run the interactive setup wizard (approximately 5 minutes):

```powershell
# Windows
.\setup.ps1

# Linux / macOS
chmod +x setup.sh && ./setup.sh
```

The wizard will:
1. Check prerequisites (Docker/Node.js, kubectl, Helm)
2. Prompt for deployment target (local machine or Kubernetes cluster)
3. Configure registry, networking, and authentication
4. Build and deploy the MCP server
5. Generate ready-to-use configuration files for your AI client

**After setup completes**, configuration files will be generated with all necessary settings:
- `.vscode/mcp.json` — for VS Code / GitHub Copilot
- `claude_desktop_config.json` — for Claude Desktop

**Deployment Modes:**

| Mode | Best For | Requirements |
|---|---|---|
| **Local** | Individual developers, quick testing | Node.js, kubectl |
| **Kubernetes** | Teams, production use, multi-user access | Docker, kubectl, Helm |

---

## Client Configuration

After running setup, connect your preferred AI client using the generated configuration files.

### GitHub Copilot (VS Code)

1. Copy the generated `.vscode/mcp.json` to your workspace `.vscode/` folder
2. Open the folder in VS Code
3. The "commvault-k8s" server appears automatically under **GitHub Copilot → MCP Servers**
4. Start chatting with Copilot to manage your Kubernetes cluster

### Claude Desktop

1. Open **Settings → Developer → Edit Config**
2. Merge the contents of `claude_desktop_config.json` into your config
3. Restart Claude Desktop
4. Start a conversation and ask Claude to help with your Commvault deployment

### Cursor / Windsurf

Configure the server manually in your client settings:
- **Type**: `sse` (for Kubernetes deployment) or `stdio` (for local deployment)
- **URL**: Provided in the setup output (e.g., `https://mcp.company.com/sse`)
- **Authorization**: Bearer token (provided by setup)

---

## Tool Reference

The MCP server provides 18 tools organized into four functional categories:

### Deployment Tools
Deploy and configure Commvault components in your cluster.

| Tool | What It Does | Example Ask |
|---|---|---|
| **deploy_config** | Set up base configuration (ConfigMaps, Secrets) | *"Deploy the initial Commvault configuration"* |
| **deploy_component** | Deploy individual components (CommServer, AccessNode, etc.) | *"Deploy an AccessNode with 2 replicas"* |
| **deploy_ring** | Deploy a complete Commvault ring in one command | *"Deploy ring version 11.42.1"* |
| **upgrade_component** | Upgrade components to a new version | *"Upgrade all components to 11.42.2"* |
| **add_disk** | Add storage volumes for DDB/data | *"Add a 1TB disk to the MediaAgent"* |

### Monitoring & Observability Tools
Check status, view logs, and troubleshoot issues.

| Tool | What It Does | Example Ask |
|---|---|---|
| **get_status** | Complete overview of all deployments and pods | *"Show me the current status of everything"* |
| **get_pods** | List all pods with their status | *"Which pods are running in the commvault namespace?"* |
| **get_services** | List all Kubernetes services | *"What services are exposed?"* |
| **describe_pod** | Detailed information about a specific pod | *"Describe the CommServer pod"* |
| **get_pod_logs** | View container logs (stdout/stderr) | *"Show me the last 50 lines from the AccessNode logs"* |
| **list_log_files** | List Commvault log files inside a pod | *"What log files are available in the CommServer?"* |
| **download_log_files** | Download log files to your machine | *"Download all logs from the failing MediaAgent pod"* |

### Management Tools
Scale, manage, and control your deployments.

| Tool | What It Does | Example Ask |
|---|---|---|
| **scale_components** | Adjust the number of replicas | *"Scale the AccessNode to 5 replicas"* |
| **uninstall_release** | Remove a Helm release | *"Uninstall the test deployment"* |
| **helm_list** | Show all Helm releases | *"List all Helm releases in the cluster"* |
| **set_namespace** | Change the active Kubernetes namespace | *"Switch to the production namespace"* |
| **port_forward** | Get port-forward command for local access | *"How do I access the CommServer Web Console?"* |

### Advanced Tools
For power users who need direct cluster access.

| Tool | What It Does | Example Ask |
|---|---|---|
| **run_kubectl** | Execute any kubectl or helm command | *"Run helm status commvault-ring"* |

---

## Usage Examples

The following scenarios demonstrate typical interactions with the MCP server.

### Scenario 1: Initial Deployment
```
User: "I need to deploy Commvault version 11.42.1 with admin/P@ss123"

AI: I'll deploy a complete Commvault ring for you. First, I'll set up 
    the configuration, then deploy all components.
    
    [OK] Configuration deployed
    [OK] CommServer deployed
    [OK] AccessNode deployed
    [OK] MediaAgent deployed
    
    All components are running. The CommServer is accessible at 
    <service-IP>:8160
```

### Scenario 2: Troubleshooting
```
User: "The MediaAgent pod keeps crashing, can you help?"

AI: Let me check the pod status and logs.
    
    The MediaAgent pod is in CrashLoopBackOff. Looking at the logs, 
    I see "insufficient disk space" errors. The pod is trying to 
    allocate DDB storage but there's no DDB volume configured.
    
    Would you like me to add a DDB disk?

User: "Yes, add a 500GB disk"

AI: [OK] DDB disk added and mounted. The MediaAgent pod is now running 
    successfully.
```

### Scenario 3: Maintenance Operations
```
User: "Upgrade everything to version 11.42.2"

AI: I'll upgrade all Commvault components to 11.42.2.
    
    [OK] CommServer upgraded
    [OK] AccessNode upgraded
    [OK] MediaAgent upgraded
    
    All components are now running version 11.42.2
```

---

## Configuration Reference

<details>
<summary><b>Automated Deployment (CI/CD)</b></summary>

For automated deployments, pass all parameters directly:

```powershell
# Windows — full build + deploy (Docker Hub)
.\setup.ps1 -Mode kubernetes `
    -Registry dyadav3214 `
    -ImageName commvault-mcp `
    -Tag 1.0.0

# Windows — full build + deploy (Azure ACR with Ingress + TLS)
.\setup.ps1 -Mode kubernetes `
    -Registry myacr.azurecr.io/commvault `
    -Tag 1.0.0 `
    -McpHostname mcp.company.com `
    -TlsSecret tls-cert-secret

# Linux / macOS — full build + deploy
./setup.sh --mode kubernetes \
    --registry myacr.azurecr.io/commvault \
    --tag 1.0.0 \
    --hostname mcp.company.com

# Specify a separate Commvault components registry (where CV images are pulled from)
.\setup.ps1 -Mode kubernetes -Registry myacr.azurecr.io/mcp `
    -CvRegistry docker.io -CvImageNamespace commvault

./setup.sh --mode kubernetes --registry myacr.azurecr.io/mcp \
    --cv-registry docker.io --cv-image-ns commvault

# Use oauth-auto auth (dev/internal clusters only — see Auth Modes below)
.\setup.ps1 -Mode kubernetes -Registry myacr.azurecr.io/mcp -AuthMode oauth-auto
./setup.sh  --mode kubernetes --registry myacr.azurecr.io/mcp --auth-mode oauth-auto

# Build with buildah instead of docker
.\setup.ps1 -Mode kubernetes -Registry myacr.azurecr.io/mcp -Builder buildah
./setup.sh  --mode kubernetes --registry myacr.azurecr.io/mcp --builder buildah

# Build/push only — skip cluster deploy
.\setup.ps1 -Mode kubernetes -Registry myacr.azurecr.io/mcp -Tag 1.0.0 -SkipDeploy
./setup.sh  --mode kubernetes --registry myacr.azurecr.io/mcp --tag 1.0.0 --skip-deploy

# Rotate the auth token without rebuilding
.\setup.ps1 -Mode kubernetes -SkipBuild -AuthToken <new-token>
./setup.sh  --mode kubernetes --skip-build --token <new-token>
```

</details>

<details>
<summary><b>Setup Parameters Reference</b></summary>

### setup.ps1 (Windows)

| Parameter | Default | Description |
|---|---|---|
| `-Mode` | prompted | `local` or `kubernetes` |
| `-Registry` | prompted | Registry prefix for the MCP image (Docker Hub username, ACR hostname, etc.) |
| `-ImageName` | `commvault-mcp` | Image name (appended to registry: `<registry>/<name>:<tag>`) |
| `-Tag` | `latest` | Image tag |
| `-Namespace` | `commvault-mcp` | Namespace the MCP server pod runs in |
| `-CvNamespace` | `commvault` | Namespace containing Commvault workloads |
| `-CvRegistry` | prompted | Registry where Commvault component images are **pulled from** |
| `-CvImageNamespace` | `commvault` | Image namespace/sub-path within the CV registry |
| `-McpHostname` | blank | External hostname for Ingress; blank = expose via LoadBalancer IP |
| `-TlsSecret` | `tls-cert-secret` | TLS certificate secret name (used when `-McpHostname` is set) |
| `-AuthToken` | auto-generated | Static bearer token; only used with `static-bearer` auth mode |
| `-AuthMode` | `static-bearer` | `static-bearer` (production) or `oauth-auto` (dev/internal — see below) |
| `-Builder` | `auto` | `auto`, `docker`, or `buildah` |
| `-SkipBuild` | `false` | Skip image build/push (image already in registry) |
| `-SkipDeploy` | `false` | Skip Kubernetes deployment (build and push only) |
| `-KubectlVersion` | `v1.31.0` | kubectl version baked into the image |
| `-HelmVersion` | `v3.16.0` | Helm version baked into the image |

### setup.sh (Linux/macOS)

| Flag | Default | Description |
|---|---|---|
| `--mode` | prompted | `local` or `kubernetes` |
| `--registry` | prompted | Registry prefix for the MCP image |
| `--image-name` | `commvault-mcp` | Image name |
| `--tag` | `latest` | Image tag |
| `--namespace` | `commvault-mcp` | Namespace for the MCP server pod |
| `--cv-namespace` | `commvault` | Namespace containing Commvault workloads |
| `--cv-registry` | prompted | Registry where Commvault component images are pulled from |
| `--cv-image-ns` | `commvault` | Image namespace/sub-path within the CV registry |
| `--hostname` | blank | External hostname for Ingress; blank = LoadBalancer IP |
| `--tls-secret` | `tls-cert-secret` | TLS certificate secret name |
| `--token` | auto-generated | Static bearer token |
| `--auth-mode` | `static-bearer` | `static-bearer` or `oauth-auto` |
| `--builder` | `auto` | `auto`, `docker`, or `buildah` |
| `--skip-build` | — | Skip image build/push |
| `--skip-deploy` | — | Skip Kubernetes deployment |
| `--kubectl-ver` | `v1.31.0` | kubectl version in the image |
| `--helm-ver` | `v3.16.0` | Helm version in the image |

</details>

<details>
<summary><b>Registry Configuration</b></summary>

### Registry Format

The `-Registry` / `--registry` parameter is the prefix that appears before `/<image-name>:<tag>`.

| Registry type | What to enter | Resulting image |
|---|---|---|
| Docker Hub | `dyadav3214` | `dyadav3214/commvault-mcp:latest` |
| Azure ACR | `myacr.azurecr.io` | `myacr.azurecr.io/commvault-mcp:latest` |
| Azure ACR + namespace | `myacr.azurecr.io/myorg` | `myacr.azurecr.io/myorg/commvault-mcp:latest` |
| GitLab / other | `registry.example.com/grp` | `registry.example.com/grp/commvault-mcp:latest` |

The wizard also accepts full Docker Hub browser URLs (e.g. `hub.docker.com/repository/docker/dyadav3214/testmcp/`) and strips them to the correct push reference automatically.

---

### Two Registry Configuration Options

The setup distinguishes between two separate registries:

| Registry | Parameter | Purpose |
|---|---|---|
| **MCP image registry** | `-Registry` / `--registry` | Where `setup.ps1` **builds and pushes** the MCP server container |
| **CV components registry** | `-CvRegistry` / `--cv-registry` | Where the **running MCP server pulls** Commvault component images (CommServer, AccessNode, etc.) when deploying them into the cluster |

The CV registry defaults to `docker.io` with namespace `commvault` (https://hub.docker.com/u/commvault). Override if your cluster pulls from an internal mirror or a different registry.

</details>

<details>
<summary><b>Authentication Modes</b></summary>

### Available Authentication Modes

| Mode | `MCP_AUTH_MODE` | Use case |
|---|---|---|
| **static-bearer** | `static-bearer` | **Production default.** One shared token stored in a K8s Secret. All clients use the same token. Survives pod restarts. |
| **oauth-auto** | `oauth-auto` | **Dev / internal only.** Full OAuth 2.0 + PKCE. Clients obtain tokens dynamically. No static token needed. |
| **none** | `none` | Local stdio testing only. Never use with HTTP. |

### Static Bearer Authentication

The token is auto-generated (or provided via `-AuthToken`) and stored in a K8s Secret (`commvault-mcp-auth`). The generated config files have `Authorization: Bearer <token>` pre-filled.

Rotate the token at any time without rebuilding:
```powershell
.\setup.ps1 -Mode kubernetes -SkipBuild -AuthToken <new-token>
./setup.sh  --mode kubernetes --skip-build --token <new-token>
```

### OAuth Auto-Approval Mode

> **Security warning.** In this mode `/register` is open and `/authorize` auto-approves every request — any network-reachable caller gets a valid token. Only use inside a private cluster with no external access.

- The wizard shows a warning box and requires explicit confirmation before enabling this mode.
- The server also requires `MCP_OAUTH_ALLOW_INSECURE_AUTOREGISTER=true` to be set on the pod (set automatically by setup when confirmed).
- Tokens are **in-memory only** — all client sessions are lost on pod restart. Clients must re-authenticate after a restart or rollout.
- Generated config files contain no pre-filled token; clients complete the OAuth flow on first connect.

</details>

---

## Technical Documentation

<details>
<summary><b>Environment Variables</b></summary>

### Configuration Variables

### Configuration Variables
|---|---|---|
| `MCP_TRANSPORT` | `http` | `http` (Docker/K8s) or `stdio` (local) |
| `PORT` | `8403` | HTTP listen port |
| `HOST` | `0.0.0.0` | HTTP bind address |
| `MCP_AUTH_MODE` | `static-bearer` | `static-bearer` · `oauth-auto` · `none` |
| `MCP_AUTH_TOKEN` | — | Required when `MCP_AUTH_MODE=static-bearer` |
| `MCP_OAUTH_ALLOW_INSECURE_AUTOREGISTER` | — | Must be `true` to activate `oauth-auto` mode |
| `CV_NAMESPACE` | from kubectl context | Default namespace for Commvault workloads |
| `CV_IMAGE_REGISTRY` | `docker.io` | Default registry for Commvault component images |
| `CV_IMAGE_NAMESPACE` | `commvault` | Default image namespace within `CV_IMAGE_REGISTRY` |
| `PROTECTED_NAMESPACES` | `kube-system,kube-public,kube-node-lease` | Namespaces the server will never touch |
| `MCP_MAX_SESSIONS` | `20` | Max concurrent HTTP sessions |
| `MCP_SESSION_IDLE_TTL_MS` | `600000` | Session idle timeout (ms) |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SEC` | `3600` | OAuth access token TTL (seconds) |
| `MCP_OAUTH_REFRESH_TOKEN_TTL_SEC` | `604800` | OAuth refresh token TTL (seconds, default 7 days) |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |

</details>

<details>
<summary><b>Complete Tool Reference</b></summary>

### MCP Tools

| Tool | Description |
|---|---|
| `deploy_config` | Deploy base ConfigMap + Secret (run first) |
| `deploy_component` | Deploy a single Commvault component |
| `deploy_ring` | Deploy a full ring in one shot |
| `upgrade_component` | Upgrade one or all components to a new tag |
| `add_disk` | Add a DDB/storage volume |
| `get_pods` | List pods |
| `get_services` | List services |
| `get_status` | Full status overview |
| `describe_pod` | kubectl describe pod |
| `get_pod_logs` | Container stdout logs |
| `list_log_files` | List Commvault log files in a pod |
| `download_log_files` | Download log files to local machine |
| `scale_components` | Scale deployments up or down |
| `uninstall_release` | Helm uninstall a release |
| `helm_list` | List Helm releases |
| `set_namespace` | Set kubectl context namespace |
| `port_forward` | Get the kubectl port-forward command |
| `run_kubectl` | Run any kubectl/helm command |

</details>

<details>
<summary><b>Project Structure</b></summary>

### Directory Layout

```
mcp-server/
  index.mjs                 Entry point (transport selection)
  src/
    config.mjs              All env vars and constants
    logger.mjs              Structured JSON logger
    errors.mjs              Typed errors + tool error helpers
    exec.mjs                Safe command runner, namespace policy, pod resolver
    image.mjs               Helm image.location computation helpers
    auth.mjs                Auth middleware (static-bearer + oauth-auto)
    server.mjs              MCP server factory (assembles all tools)
    http.mjs                HTTP transport, session management, graceful shutdown
    tools/
      deploy.mjs            deploy_config, deploy_component, deploy_ring
      upgrade.mjs           upgrade_component
      observe.mjs           get_pods, get_services, get_status, describe_pod,
                            get_pod_logs, list_log_files, download_log_files
      manage.mjs            add_disk, scale_components, uninstall_release,
                            helm_list, set_namespace, port_forward, run_kubectl

deploy/
  base/                     Namespace-agnostic K8s resources (Deployment, RBAC, NetworkPolicy)
  overlays/
    dev/                    Dev overlay: LoadBalancer service, oauth-auto auth
    prod/                   Prod overlay: ClusterIP + TLS Ingress, static-bearer auth

setup.ps1                   Onboarding wizard — Windows (build, deploy, generate client configs)
setup.sh                    Onboarding wizard — Linux / macOS
SKILL.md                    AI agent skill context (used by the MCP server at runtime)
cli/
  cv.bat                    Windows CLI wrapper
  cv.ps1                    PowerShell CLI implementation
```

</details>

---

## Support & Resources

- **Getting Started**: Run `.\setup.ps1` (Windows) or `./setup.sh` (Linux/macOS) to begin the interactive setup process
- **Advanced Usage**: Refer to [SKILL.md](SKILL.md) for detailed tool documentation and examples
- **MCP Protocol**: Learn more at [modelcontextprotocol.io](https://modelcontextprotocol.io/)
- **Troubleshooting**: Leverage your AI assistant to diagnose deployment issues
