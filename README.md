# Commvault Kubernetes MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes Commvault Kubernetes operations as AI-callable tools. Works with VS Code Copilot, Claude Desktop, Cursor, and any MCP-compatible client.

---

## Quick Start

Run the onboarding wizard — it handles everything interactively:

```powershell
# Windows
.\setup.ps1

# Linux / macOS
chmod +x setup.sh && ./setup.sh
```

The wizard walks through 5 stages for a Kubernetes deployment:

| Stage | What it configures |
|---|---|
| 1 | MCP server image — registry, image name, tag, reachability check |
| 2 | Kubernetes namespaces (MCP server + Commvault workloads) |
| 3 | Commvault component image registry — where CV images are pulled from |
| 4 | Networking — external hostname + TLS (optional) |
| 5 | Authentication mode — static-bearer or oauth-auto |

After completing setup it writes ready-to-use client config files with the endpoint and token already filled in:
- `.vscode/mcp.json` — VS Code / GitHub Copilot
- `claude_desktop_config.json` — Claude Desktop

**Two deployment modes:**

| Mode | Use when | Requires |
|---|---|---|
| `local` | Single developer, server runs on your machine | Node.js, kubectl |
| `kubernetes` | Team / production, server runs in the cluster | Docker, kubectl, Helm |

---

## Non-interactive (CI / scripted)

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

---

## Parameters

### `setup.ps1`

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

### `setup.sh`

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

---

## Registry Format

The `-Registry` / `--registry` parameter is the prefix that appears before `/<image-name>:<tag>`.

| Registry type | What to enter | Resulting image |
|---|---|---|
| Docker Hub | `dyadav3214` | `dyadav3214/commvault-mcp:latest` |
| Azure ACR | `myacr.azurecr.io` | `myacr.azurecr.io/commvault-mcp:latest` |
| Azure ACR + namespace | `myacr.azurecr.io/myorg` | `myacr.azurecr.io/myorg/commvault-mcp:latest` |
| GitLab / other | `registry.example.com/grp` | `registry.example.com/grp/commvault-mcp:latest` |

The wizard also accepts full Docker Hub browser URLs (e.g. `hub.docker.com/repository/docker/dyadav3214/testmcp/`) and strips them to the correct push reference automatically.

---

## Two Registries

The setup distinguishes between two separate registries:

| Registry | Parameter | Purpose |
|---|---|---|
| **MCP image registry** | `-Registry` / `--registry` | Where `setup.ps1` **builds and pushes** the MCP server container |
| **CV components registry** | `-CvRegistry` / `--cv-registry` | Where the **running MCP server pulls** Commvault component images (CommServer, AccessNode, etc.) when deploying them into the cluster |

The CV registry defaults to `docker.io` with namespace `commvault` (https://hub.docker.com/u/commvault). Override if your cluster pulls from an internal mirror or a different registry.

---

## Auth Modes

| Mode | `MCP_AUTH_MODE` | Use case |
|---|---|---|
| **static-bearer** | `static-bearer` | **Production default.** One shared token stored in a K8s Secret. All clients use the same token. Survives pod restarts. |
| **oauth-auto** | `oauth-auto` | **Dev / internal only.** Full OAuth 2.0 + PKCE. Clients obtain tokens dynamically. No static token needed. |
| **none** | `none` | Local stdio testing only. Never use with HTTP. |

### static-bearer

The token is auto-generated (or provided via `-AuthToken`) and stored in a K8s Secret (`commvault-mcp-auth`). The generated config files have `Authorization: Bearer <token>` pre-filled.

Rotate the token at any time without rebuilding:
```powershell
.\setup.ps1 -Mode kubernetes -SkipBuild -AuthToken <new-token>
./setup.sh  --mode kubernetes --skip-build --token <new-token>
```

### oauth-auto

> **Security warning.** In this mode `/register` is open and `/authorize` auto-approves every request — any network-reachable caller gets a valid token. Only use inside a private cluster with no external access.

- The wizard shows a warning box and requires explicit confirmation before enabling this mode.
- The server also requires `MCP_OAUTH_ALLOW_INSECURE_AUTOREGISTER=true` to be set on the pod (set automatically by setup when confirmed).
- Tokens are **in-memory only** — all client sessions are lost on pod restart. Clients must re-authenticate after a restart or rollout.
- Generated config files contain no pre-filled token; clients complete the OAuth flow on first connect.

---

## CLI (without an AI agent)

```powershell
cd cli
.\cv.bat --help
.\cv.bat deploy ring 11.42.1 --user admin --password P@ss123
.\cv.bat status
```

See [SKILL.md](SKILL.md) → *CLI* section for the full command reference.

---

## Environment Variables

| Variable | Default | Description |
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

---

## MCP Tools

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

---

## Project Structure

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
