---
name: commvault-kubernetes-management
description: Manage Commvault containerized deployments on Kubernetes using Helm charts from the `commvault` Helm repo. Deploy, upgrade, scale, and troubleshoot components like CommServer, Access Nodes, Media Agents, and more.
---

# commvault-kubernetes-management Skill

You are an expert at managing Commvault containerized deployments on Kubernetes using Helm charts served from the `commvault` Helm repo (`https://commvault.github.io/helm-charts`).

You have access to MCP tools that wrap `kubectl` and `helm`. Always prefer the specific MCP tools over `run_kubectl` where one exists. The default namespace is automatically read from the current `kubectl` context — you do not need to ask the user for it unless they mention a specific namespace.

---

## Architecture

Commvault is deployed as multiple containerized components on Kubernetes via Helm charts:

| Component | Chart | Default Release Name | Default Image Repo |
|---|---|---|---|
| Config | `commvault/config` | `cvconfig` | N/A — ConfigMap + Secret only |
| CommServer | `commvault/commserve` | `commserve` | `commserve` |
| Access Node | `commvault/accessnode` | `accessnode` / `accessnode1`, `accessnode2`… | `accessnode` |
| Media Agent | `commvault/mediaagent` | `ma` / `ma1`, `ma2`… | `mediaagent` |
| Web Server | `commvault/webserver` | `webserver` | `webserver` |
| Command Center | `commvault/commandcenter` | `commandcenter` | `commandcenter` |
| Network Gateway | `commvault/networkgateway` | `networkgateway` | `networkgateway` |
| DDB Backup Role | `commvault/cv-ddb-backup-role` | `cv-ddb-role` | N/A — ClusterRole only |

---

## Image Tag Format

Tags must be `11.XX.X` or `11.XX.XX.RevXXXX`, e.g. `11.42.1` or `11.42.82.Rev1409`.

---

## Image Location Override (`image.location`)

When a release was previously deployed with a custom `image.location` value (e.g. pointing to a private registry), `--reuse-values` will preserve it and it takes priority over `global.image.tag`. The upgrade tools handle this automatically:

- **Tag only + existing `image.location`** → the tag portion is swapped in-place, preserving the full registry/namespace/repo path.
- **`registry` + `imageNamespace` + `tag` supplied** → a full new `image.location` is built from scratch.
- **Tag only + no existing `image.location`** → `global.image.tag` is used as-is.

---

## MCP Tools Reference

### Deployment

| Tool | When to use |
|---|---|
| `deploy_config` | First step — deploy ConfigMap + Secret. Required before any component. |
| `deploy_component` | Deploy a single component (commserver, accessnode, mediaagent, etc.) |
| `deploy_ring` | Deploy a complete ring in one shot (config + cs + ANs + MAs + webserver + commandcenter) |

### Upgrades

| Tool | When to use |
|---|---|
| `upgrade_component` | Upgrade one component or `all` to a new tag. Uses `--reuse-values`. |

### Storage

| Tool | When to use |
|---|---|
| `add_disk` | Add an extra DDB/storage volume to any release. Auto-detects chart from `helm list`. |

### Observability

| Tool | When to use |
|---|---|
| `get_pods` | List pods, optionally filtered by name pattern |
| `get_services` | List services |
| `get_status` | Full status: Helm releases, pods, services, PVCs, deployments, statefulsets |
| `describe_pod` | `kubectl describe pod` — useful for troubleshooting |
| `get_pod_logs` | Container stdout logs (`kubectl logs`) |
| `list_log_files` | List Commvault app log files at `/var/log/commvault/Log_Files/` inside a pod |
| `download_log_files` | Download log files (all or specific) from a pod to local Downloads folder |

### Cluster Management

| Tool | When to use |
|---|---|
| `scale_components` | Scale deployments/statefulsets up (replicas=1) or down (replicas=0) |
| `uninstall_release` | `helm uninstall` a release |
| `helm_list` | List all Helm releases in the namespace |
| `set_namespace` | Change the default kubectl context namespace |
| `port_forward` | Returns the `kubectl port-forward` command to run in a terminal |
| `run_kubectl` | Escape hatch — run any `kubectl` or `helm` command directly |

---

## Common Task Recipes

### 1. Deploy a fresh ring

Use `deploy_ring`. It always deploys in the correct order: config → (optional ddb-role) → CommServer → access nodes → media agents → webserver → commandcenter.

Key parameters:
- `tag` — required, e.g. `11.42.1`
- `namespace` — defaults to current kubectl context namespace
- `repo` — full image path shorthand, e.g. `registry.foo.com/eng-public/image-library` (splits on last `/` into registry + imageNamespace)
- `registry` + `imageNamespace` — alternative to `repo`
- `accessNodeCount` — default 2
- `mediaAgentCount` — default 1
- `deployDdbRole` — default false
- `user` / `password` / `authcode` — credentials for the config chart

### 2. Upgrade a component

Use `upgrade_component`. Examples:
- Upgrade a single release by name: `component=webserver`, `releaseName=vul-webserver3`, `tag=11.42.82.Rev1409`
- Upgrade all Commvault releases in namespace: `component=all`, `tag=11.42.1`
- With a new private registry: add `registry` + `imageNamespace` — rebuilds `image.location` from scratch.

Always uses `--reuse-values` so existing PVC sizes, storage classes, and custom values are preserved.

### 3. Add a DDB disk

Use `add_disk`. The chart is auto-detected from `helm list` by matching the release name — you only need `releaseName`, `mountPath`, and `size`. The tool automatically appends at the next available volume index (never clobbers existing volumes).

Example: add 100Gi at `/var/ddb2` to release `ma1`.

### 4. Download log files

Use `download_log_files`. Accepts a partial pod name. Downloads all logs as a zip to the local Downloads folder, or a single file with `specificFile`.

### 5. Check what's deployed

Use `get_status` for a full overview, or `helm_list` for just Helm releases.

### 6. Troubleshoot a failing pod

1. `get_pods` — check status/restarts
2. `describe_pod` — look at Events section
3. `get_pod_logs` — check container stdout
4. `list_log_files` + `download_log_files` — get Commvault application logs

---

## Important Notes

- The `config` chart (`deploy_config`) **must** be deployed before any component — it creates the `cvconfig` ConfigMap and `cvcreds` Secret that all components reference.
- CommServer hostname pattern: `cs.<namespace>.svc.cluster.local`
- CS gateway service is named `<releasename>gateway` and defaults to LoadBalancer type.
- Media Agent has a 6-hour termination grace period.
- Log files are at `/var/log/commvault/Log_Files/` inside containers.
- Registry files are at `/etc/CommVaultRegistry/` inside containers.
- Additional volumes added via `add_disk` auto-create PVCs and mounts.
- When the release name doesn't match the standard default (e.g. `vul-webserver3` instead of `webserver`), always pass `releaseName` explicitly to `upgrade_component` or `add_disk`.
- The default namespace is resolved at startup: `CV_NAMESPACE` env var → current kubectl context namespace → fallback `commvault`.

---

## CLI (`cv.bat` / `cv.ps1`)

A PowerShell CLI for direct cluster management without an AI agent. Run from `cmd` or PowerShell (must be in `K8s-Prod\` directory or have it on your PATH).

### Prerequisites

```powershell
helm repo add commvault https://commvault.github.io/helm-charts
helm repo update
```

### Command Reference

| Command | Description |
|---|---|
| `cv deploy config <csHost> [options]` | Deploy base ConfigMap + Secret |
| `cv deploy cs <tag> [options]` | Deploy CommServer |
| `cv deploy accessnode <tag> [options]` | Deploy Access Node |
| `cv deploy ma <tag> [options]` | Deploy Media Agent |
| `cv deploy webserver <tag> [options]` | Deploy Web Server |
| `cv deploy commandcenter <tag> [options]` | Deploy Command Center |
| `cv deploy networkgateway <tag> [options]` | Deploy Network Gateway |
| `cv deploy ring <tag> [options]` | Full ring deployment (CS + AN + MA + optional) |
| `cv deploy ddbrole` | Deploy DDB backup ClusterRole |
| `cv upgrade cs <tag> [release] [ns]` | Upgrade CommServer |
| `cv upgrade accessnode <tag> [release] [ns]` | Upgrade Access Node |
| `cv upgrade ma <tag> [release] [ns]` | Upgrade Media Agent |
| `cv upgrade all <tag> [ns]` | Upgrade all Commvault releases in namespace |
| `cv adddisk ma <mountPath> [options]` | Add DDB disk to Media Agent |
| `cv uninstall <release> [ns]` | Uninstall a Helm release |
| `cv status [ns]` | Show releases, pods, services, PVCs |
| `cv pods [pattern] [ns]` | List pods |
| `cv describe [pattern] [ns]` | Describe a pod |
| `cv svc [pattern] [ns]` | List services |
| `cv get all [pattern] [ns]` | Pods + services + deployments |
| `cv get logs <pod> [ns]` | Download all logs from pod (zip) |
| `cv get log <logfile> <pod> [ns]` | Download single log file |
| `cv get reg <pod> [ns]` | Download registry from pod (zip) |
| `cv get config` | Export kubeconfig to Downloads |
| `cv get sqlpass <pod>` | Decrypt and print SQL password |
| `cv set ns <namespace>` | Set default namespace |
| `cv set context <context>` | Switch kubectl context |
| `cv set svc <type> <svc> [ns]` | Change service type (LoadBalancer/ClusterIP/NodePort) |
| `cv shell <pod> [ns]` | Shell into pod (log dir) |
| `cv shell2 <pod> [ns]` | Shell into pod (root) |
| `cv livelogs <pod> [ns]` | Stream pod logs (`--follow`) |
| `cv logs <pod> [ns]` | Get pod logs (no follow) |
| `cv listlogs <pod> [ns]` | List log files in pod |
| `cv watch [pod] [ns]` | Watch pods |
| `cv kill <pod> [ns]` | Kill process in pod |
| `cv scale up\|down [pattern] [ns]` | Scale all (or matching) deployments |
| `cv portforward <pod> <port> [ns]` | Port-forward to pod |
| `cv proxy [cluster]` | Start ARC proxy |
| `cv config` | View kubeconfig |
| `cv images [pattern]` | List images in registry |
| `cv tags <image> [pattern]` | List tags for an image |
| `cv --help` | Full help |

Component aliases: `cs`=`commserver`, `an`=`accessnode`, `ma`=`mediaagent`, `ws`=`webserver`, `cc`=`commandcenter`, `ng`=`networkgateway`

### Common Recipes

```cmd
:: Full ring deployment
cv deploy ring 11.42.1 --user admin --password P@ss123 --accessnodes 2 --mediaagents 1

:: Ring with all components
cv deploy ring 11.42.1 --authcode ABCD1234 --accessnodes 2 --mediaagents 1 --webserver --commandcenter --networkgateway

:: Upgrade single component
cv upgrade cs 11.42.1
cv upgrade ma 11.42.1 ma1 commvault

:: Upgrade everything in a namespace
cv upgrade all 11.42.1 commvault

:: Add a 100Gi DDB disk to the second MA
cv adddisk ma /var/ddb2 --size 100Gi --name ddb2 --release ma2

:: Monitor a deployment
cv status commvault
cv pods commvault
cv watch

:: Grab logs from a pod matching "commserve"
cv get logs commserve

:: Shell into a pod
cv shell commserve
```
