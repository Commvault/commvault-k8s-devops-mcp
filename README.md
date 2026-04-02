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

The MCP server provides 25 tools organized into four functional categories:

### Deployment Tools
Deploy and configure Commvault components in your cluster.

| Tool | What It Does | Example Ask |
|---|---|---|
| **deploy_config** | Set up base configuration with cvcreds Secret (stores credentials) | *"Deploy the config with username admin and password Test123"* |
| **deploy_component** | Deploy individual components (requires config chart first) | *"Deploy CommServer with tag 11.42.1"* |
| **deploy_ring** | Deploy a complete Commvault ring in one command | *"Deploy ring version 11.42.1"* |
| **upgrade_component** | Upgrade components to a new version | *"Upgrade all components to 11.42.2"* |
| **rollback_deployment** | Rollback to a previous Helm revision with diff preview | *"Rollback the AccessNode to the previous version"* |
| **add_disk** | Add storage volumes for DDB/data | *"Add a 1TB disk to the MediaAgent"* |

> **⚠️ Deployment Order & Requirements**  
> **1. Deploy Config First:** `deploy_config` creates the `cvcreds` Secret with admin credentials
> - **REQUIRES**: `csHostname`, `user`, `password` (or `authcode`)
> - Example: *"Deploy config with hostname cs.commvault.svc.cluster.local, user admin, password Test123"*
>
> **2. Deploy Components:** `deploy_component` inherits credentials from the config chart
> - **REQUIRES**: Config chart must exist first for CommServer
> - Example: *"Deploy CommServer with tag 11.42.1"* (no credentials needed - inherits from cvcreds)
>
> **3. Deploy Full Ring:** `deploy_ring` deploys config + all components
> - **REQUIRES**: `tag`, `user`, `password` (or `authcode`)
> - Example: *"Deploy ring 11.42.1 with user admin, password Test123"*

### Monitoring & Observability Tools
Check status, view logs, and troubleshoot issues.

| Tool | What It Does | Example Ask |
|---|---|---|
| **list_namespaces** | List all available namespaces | *"What namespaces are available?"* |
| **check_kubectl_config** | Check kubectl configuration and connectivity | *"Is kubectl configured correctly?"* |
| **validate_deployment** | Pre-flight checks before deployment (quotas, RBAC, storage) | *"Can I deploy a ring in this namespace?"* |
| **get_status** | Complete overview of all deployments and pods | *"Show me the current status of everything"* |
| **get_pods** | List all pods with their status | *"Which pods are running in the commvault namespace?"* |
| **get_services** | List all Kubernetes services | *"What services are exposed?"* |
| **describe_pod** | Detailed information about a specific pod | *"Describe the CommServer pod"* |
| **get_pod_logs** | View container logs (stdout/stderr) | *"Show me the last 50 lines from the AccessNode logs"* |
| **tail_logs** | Stream logs in real-time with filtering (supports wildcards, level filters) | *"Tail all CommServer logs with ERROR level"* |
| **list_log_files** | List Commvault log files inside a pod | *"What log files are available in the CommServer?"* |
| **download_log_files** | Download log files (K8s mode: provides kubectl command to retrieve) | *"Download all logs from the failing MediaAgent pod"* |

### Management Tools
Scale, manage, and control your deployments.

| Tool | What It Does | Example Ask |
|---|---|---|
| **scale_components** | Adjust the number of replicas | *"Scale the AccessNode to 5 replicas"* |
| **uninstall_release** | Remove a Helm release | *"Uninstall the test deployment"* |
| **helm_list** | Show all Helm releases | *"List all Helm releases in the cluster"* |
| **get_current_namespace** | View your current session namespace | *"What namespace am I using?"* |
| **set_namespace** | Change the active namespace (session-scoped in HTTP mode) | *"Switch to the production namespace"* |
| **test_connectivity** | Test pod-to-pod connectivity using cvping | *"Can the MediaAgent reach the CommServer?"* |
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

## Namespace Management

The MCP server includes advanced namespace management features for multi-user and multi-tenant deployments.

### Session-Scoped Namespaces (HTTP Mode)

When running in HTTP mode (Kubernetes deployment), each user session has its own namespace context. Setting a namespace affects only your session and doesn't impact other users.

**New Tools:**
- **list_namespaces** - List all available namespaces (excluding system namespaces)
- **get_current_namespace** - View your current session namespace or kubectl context
- **set_namespace** - Set namespace for your session (or kubectl context in stdio mode)

**Example Usage:**
```
User: "List available namespaces"
AI: [Shows all non-system namespaces]

User: "Set namespace to dev-environment"
AI: Session namespace set to: dev-environment
    This change affects only your current session.

User: "Deploy a ring version 11.42.1"
AI: [Deploys to dev-environment namespace]
```

### Key Features

**Session Isolation** - In HTTP mode, namespace changes are scoped to your session. Multiple users can work in different namespaces simultaneously without conflicts.

**Namespace Validation** - All operations validate that namespaces exist before executing commands, providing clear error messages with actionable guidance.

**Protected Namespaces** - System namespaces (kube-system, kube-public, kube-node-lease) are automatically protected from modifications.

**Smart Defaults** - Namespaces resolve in priority order:
1. Explicitly specified in command
2. Current session context (HTTP mode only)
3. Kubectl context namespace
4. Default namespace from configuration

**Better Error Messages** - When a namespace doesn't exist, you get helpful suggestions:
```
Namespace "staging" not found.

Available namespaces: Use the list_namespaces tool to see available options.
Create namespace: kubectl create namespace staging
```

---

## Troubleshooting

### "No current context is set" Error

If you see this error when using MCP tools, it means kubectl doesn't have a context configured.

**Diagnosis:**
Ask your AI assistant: *"Check kubectl configuration"*

The `check_kubectl_config` tool will show:
- Current kubectl context (if any)
- Available contexts
- Cluster connectivity status
- Current namespace

**Quick Fix:**
1. List available contexts: `kubectl config get-contexts`
2. Set a context: `kubectl config use-context <context-name>`
3. Verify: Ask *"Check kubectl configuration"* again

**For Kubernetes Deployment:**
The MCP server pod needs a valid kubeconfig with a configured context. The ServiceAccount and ClusterRole created by setup.ps1 provide this automatically. If you're getting context errors:

```bash
# Check if the MCP pod has proper RBAC
kubectl get serviceaccount commvault-mcp -n <namespace>
kubectl get clusterrolebinding | grep commvault-mcp

# Check pod logs for startup errors
kubectl logs -n <namespace> deployment/commvault-mcp
```

### Namespace Changes Not Reflected

**HTTP Mode (Kubernetes Deployment):**
- Namespaces are session-scoped
- Use `set_namespace` to change your session's namespace
- Other users are not affected

**Stdio Mode (Local):**
- `set_namespace` modifies the global kubectl context
- Changes affect all users sharing the kubeconfig

**Verification:**
Ask: *"What namespace am I currently using?"*

### Log Download Behavior

The `download_log_files` tool behaves differently depending on deployment mode:

**Kubernetes Mode (HTTP/SSE):**
- Logs are packaged on the MCP server pod's filesystem
- Tool provides a `kubectl cp` command to retrieve the zip file
- Example output:
  ```bash
  kubectl cp commvault-mcp/commvault-mcp-xxxxx:/path/to/logs.zip ./cv-logs/logs.zip
  ```
- Run this command from your **local terminal** to download the file

**Local Mode (Stdio):**
- Logs are downloaded directly to your local machine
- Default location: `$HOME/Downloads/`
- No additional steps needed

**Why?**
When the MCP server runs in Kubernetes, it can't directly write files to your local machine. The tool creates the archive on the server and provides the command to retrieve it.

---

## Configuration Reference

<details>
<summary><b>Automated Deployment (CI/CD)</b></summary>

For automated deployments, pass all parameters directly:

```powershell
# Windows — full build + deploy (Docker Hub)
.\setup.ps1 -Mode kubernetes `
    -Registry RegName `
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
| Docker Hub | `RegName` | `RegName/commvault-mcp:latest` |
| Azure ACR | `myacr.azurecr.io` | `myacr.azurecr.io/commvault-mcp:latest` |
| Azure ACR + namespace | `myacr.azurecr.io/myorg` | `myacr.azurecr.io/myorg/commvault-mcp:latest` |
| GitLab / other | `registry.example.com/grp` | `registry.example.com/grp/commvault-mcp:latest` |

The wizard also accepts full Docker Hub browser URLs (e.g. `hub.docker.com/repository/docker/RegName/testmcp/`) and strips them to the correct push reference automatically.

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
| `deploy_config` | Deploy base ConfigMap + cvcreds Secret (REQUIRES: csHostname, user, password) |
| `deploy_component` | Deploy a single component (REQUIRES: config chart exists for CommServer) |
| `deploy_ring` | Deploy a full ring in one shot (REQUIRES: tag, user, password or authcode) |
| `upgrade_component` | Upgrade one or all components to a new tag |
| `rollback_deployment` | Rollback Helm release to previous revision with diff |
| `add_disk` | Add a DDB/storage volume |
| `get_pods` | List pods |
| `get_services` | List services |
| `get_status` | Full status overview |
| `validate_deployment` | Pre-flight checks for namespace, RBAC, storage, quotas |
| `describe_pod` | kubectl describe pod |
| `get_pod_logs` | Container stdout logs |
| `tail_logs` | Stream logs in real-time with filtering and multi-pod support |
| `list_log_files` | List Commvault log files in a pod |
| `download_log_files` | Package and download log files (provides kubectl command in K8s mode) |
| `scale_components` | Scale deployments up or down |
| `uninstall_release` | Helm uninstall a release |
| `helm_list` | List Helm releases |
| `list_namespaces` | List available namespaces |
| `get_current_namespace` | Show current namespace context |
| `check_kubectl_config` | Diagnose kubectl configuration |
| `set_namespace` | Set kubectl context namespace |
| `test_connectivity` | Test pod-to-pod connectivity using cvping |
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
