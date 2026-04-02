#!/usr/bin/env bash
# =============================================================================
# Commvault MCP Server — One-Stop Customer Onboarding (Linux / macOS)
#
# Usage:
#   ./setup.sh                          # fully guided interactive
#   ./setup.sh --mode local             # local stdio (no cluster needed)
#   ./setup.sh --mode kubernetes \
#     --registry myregistry.io/cv \
#     --tag 1.0.0 \
#     --hostname mcp.company.com
#
# Options:
#   --mode           local | kubernetes  (prompted if omitted)
#   --registry       Container registry prefix
#   --tag            Image tag (default: latest)
#   --namespace      Namespace for MCP server pod (default: commvault-mcp)
#   --cv-namespace   Namespace containing Commvault workloads (default: commvault)
#   --hostname       External hostname for Ingress (blank = LoadBalancer IP)
#   --tls-secret     TLS cert secret name (default: tls-cert-secret)
#   --token          Bearer token (auto-generated if omitted)
#   --cv-registry    Commvault components registry (where CV images are pulled from)
#   --cv-image-ns    Commvault image namespace/sub-path (e.g. image-library)
#   --image-name     Image name to build (default: commvault-mcp)
#   --auth-mode      static-bearer (default) | oauth-auto (dev/internal only)
#   --builder        auto | docker | buildah  (default: auto)
#   --kubectl-ver    kubectl version in image (default: v1.31.0)
#   --helm-ver       Helm version in image (default: v3.16.0)
#   --skip-build     Skip image build/push
#   --skip-deploy    Skip Kubernetes deployment
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_DIR="$SCRIPT_DIR/mcp-server"

# ── Defaults ──────────────────────────────────────────────────────────────────
MODE=""
REGISTRY=""
TAG="latest"
NAMESPACE="commvault-mcp"
CV_NAMESPACE="commvault"
CV_REGISTRY=""
IMAGE_NAME="commvault-mcp"
MCP_HOSTNAME=""
TLS_SECRET="tls-cert-secret"
AUTH_TOKEN=""
BUILDER="auto"
KUBECTL_VER="v1.31.0"
HELM_VER="v3.16.0"
SKIP_BUILD=false
SKIP_DEPLOY=false
AUTH_MODE="static-bearer"
OAUTH_OPT_IN=false
CV_IMAGE_NAMESPACE=""

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode)           MODE="$2";         shift 2 ;;
        --registry)       REGISTRY="$2";     shift 2 ;;
        --tag)            TAG="$2";          shift 2 ;;
        --namespace)      NAMESPACE="$2";    shift 2 ;;
        --cv-namespace)   CV_NAMESPACE="$2"; shift 2 ;;
        --cv-registry)    CV_REGISTRY="$2";    shift 2 ;;
        --cv-image-ns)    CV_IMAGE_NAMESPACE="$2"; shift 2 ;;
        --image-name)     IMAGE_NAME="$2";        shift 2 ;;
        --hostname)       MCP_HOSTNAME="$2"; shift 2 ;;
        --tls-secret)     TLS_SECRET="$2";   shift 2 ;;
        --token)          AUTH_TOKEN="$2";   shift 2 ;;
        --builder)        BUILDER="$2";      shift 2 ;;
        --kubectl-ver)    KUBECTL_VER="$2";  shift 2 ;;
        --helm-ver)       HELM_VER="$2";     shift 2 ;;
        --skip-build)     SKIP_BUILD=true;   shift   ;;
        --skip-deploy)    SKIP_DEPLOY=true;  shift   ;;
        --auth-mode)      AUTH_MODE="$2";    shift 2 ;;
        --help|-h)
            sed -n '/^# Usage:/,/^# =====/p' "$0" | grep -v "^# =====" | sed 's/^# \?//'
            exit 0 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Normalize namespace parameters to lowercase (Kubernetes RFC 1123 requirement)
[[ -n "$NAMESPACE" ]] && NAMESPACE="${NAMESPACE,,}"
[[ -n "$CV_NAMESPACE" ]] && CV_NAMESPACE="${CV_NAMESPACE,,}"

# ── Colour helpers ────────────────────────────────────────────────────────────
CYAN='\033[0;36m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
RED='\033[0;31m'; GRAY='\033[0;90m'; NC='\033[0m'

banner()  { echo -e "\n${CYAN}$*${NC}"; }
step()    { echo -e "\n${YELLOW}$*${NC}"; }
ok()      { echo -e "  ${GREEN}[OK]${NC} $*"; }
err()     { echo -e "  ${RED}[!!]${NC} $*"; }
gray()    { echo -e "${GRAY}$*${NC}"; }

ask() {
    local prompt="$1" default="${2:-}" answer
    local hint=""
    [[ -n "$default" ]] && hint=" [$default]"
    read -rp "$prompt$hint: " answer
    echo "${answer:-$default}"
}

ask_bool() {
    local prompt="$1" default="${2:-y}" answer hint
    [[ "$default" == "y" ]] && hint="[Y/n]" || hint="[y/N]"
    read -rp "$prompt $hint: " answer
    answer="${answer:-$default}"
    [[ "$answer" =~ ^[Yy] ]]
}

gen_token() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e "${CYAN}
╔══════════════════════════════════════════════════════╗
║    Commvault MCP Server — Customer Onboarding        ║
╚══════════════════════════════════════════════════════╝${NC}"

# ── Mode selection ────────────────────────────────────────────────────────────
if [[ -z "$MODE" ]]; then
    echo "Deployment Mode:"
    echo "  [1] local       — Run on this machine via stdio (no Docker/Kubernetes needed)"
    echo "  [2] kubernetes  — Deploy to a Kubernetes cluster (HTTP/SSE, multi-user)"
    choice=$(ask "Select mode" "1")
    [[ "$choice" == "2" || "$choice" == "kubernetes" ]] && MODE="kubernetes" || MODE="local"
fi
echo -e "  Mode: ${CYAN}${MODE}${NC}"

# ── Prereqs check ─────────────────────────────────────────────────────────────
step "Checking prerequisites..."

declare -A HINTS=(
    [node]="Install: https://nodejs.org  or  nvm install --lts"
    [kubectl]="Install: https://kubernetes.io/docs/tasks/tools"
    [helm]="Install: https://helm.sh/docs/intro/install"
    [docker]="Install: https://docs.docker.com/get-docker"
    [buildah]="Install: sudo apt install buildah  or  https://buildah.io"
    [openssl]="Install: sudo apt install openssl"
)

# Resolve builder
if [[ "$MODE" == "kubernetes" && "$SKIP_BUILD" == "false" ]]; then
    if [[ "$BUILDER" == "auto" ]]; then
        command -v buildah &>/dev/null && BUILDER="buildah" || BUILDER="docker"
    fi
    BUILDER_TOOL="$BUILDER"
else
    BUILDER_TOOL=""
fi

if [[ "$MODE" == "local" ]]; then
    REQUIRED=(node kubectl)
else
    REQUIRED=(kubectl helm openssl)
    [[ "$SKIP_BUILD" == "false" ]] && REQUIRED=("$BUILDER_TOOL" "${REQUIRED[@]}")
fi

MISSING=()
for tool in "${REQUIRED[@]}"; do
    if command -v "$tool" &>/dev/null; then
        ok "$tool"
    else
        err "$tool — not found.  ${HINTS[$tool]:-}"
        MISSING+=("$tool")
    fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
    echo -e "\n${RED}Install the tools listed above, then re-run setup.sh${NC}"
    exit 1
fi

# =============================================================================
# LOCAL MODE
# =============================================================================
if [[ "$MODE" == "local" ]]; then
    step "Installing Node.js dependencies..."
    cd "$MCP_DIR"
    npm install
    cd "$SCRIPT_DIR"
    ok "Node.js dependencies installed"

    INDEX_PATH="$MCP_DIR/index.mjs"
    VSCODE_DIR="$SCRIPT_DIR/.vscode"
    mkdir -p "$VSCODE_DIR"

    # VS Code / GitHub Copilot
    cat > "$VSCODE_DIR/mcp.json" <<EOF
{
  "servers": {
    "commvault-k8s": {
      "command": "node",
      "args": ["$INDEX_PATH"],
      "env": { "MCP_TRANSPORT": "stdio" }
    }
  }
}
EOF
    ok "VS Code config written → .vscode/mcp.json"

    # Claude Desktop
    cat > "$SCRIPT_DIR/claude_desktop_config.json" <<EOF
{
  "mcpServers": {
    "commvault-k8s": {
      "command": "node",
      "args": ["$INDEX_PATH"],
      "env": { "MCP_TRANSPORT": "stdio" }
    }
  }
}
EOF
    ok "Claude Desktop config written → claude_desktop_config.json"

    echo -e "${CYAN}
╔══════════════════════════════════════════════════════╗
║  Local setup complete!                               ║
╚══════════════════════════════════════════════════════╝

  VS Code / GitHub Copilot
  ─────────────────────────────────────────────────────
  .vscode/mcp.json is ready.
  Open this folder in VS Code — the server is listed
  automatically under GitHub Copilot > MCP Servers.

  Claude Desktop
  ─────────────────────────────────────────────────────
  Merge claude_desktop_config.json into:
    Settings → Developer → Edit Config
  Then restart Claude.

  Cursor / Windsurf
  ─────────────────────────────────────────────────────
  command : node
  args    : [\"$INDEX_PATH\"]
  env     : MCP_TRANSPORT=stdio${NC}"
    exit 0
fi

# =============================================================================
# KUBERNETES MODE
# =============================================================================

echo -e "\n${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${CYAN}Kubernetes Deployment — 5 configuration stages${NC}"
echo -e "${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GRAY}  Press Enter to accept defaults shown in [brackets]${NC}"

# ═══════════════════════════════════════════════════════
# STAGE 1 — MCP image: where to build and push it
# ═══════════════════════════════════════════════════════
echo -e "\n  ${CYAN}[1/5] MCP Server Image — where to build and push${NC}"
echo -e "  ${GRAY}$(printf '%.0s─' {1..54})${NC}"
echo -e "${GRAY}     Registry type     What to enter                  Resulting image
     ────────────────  ─────────────────────────────  ─────────────────────────────────────
     Docker Hub        dyadav3214                     dyadav3214/<name>:<tag>
     Azure ACR         myacr.azurecr.io               myacr.azurecr.io/<name>:<tag>
     Azure ACR + ns    myacr.azurecr.io/myorg         myacr.azurecr.io/myorg/<name>:<tag>
     GitLab / other    registry.example.com/grp       registry.example.com/grp/<name>:<tag>
${NC}"

# Auto-detect logged-in registries from ~/.docker/config.json
DETECTED_REGISTRY=""
if [[ -z "$REGISTRY" ]]; then
    DOCKER_CFG="$HOME/.docker/config.json"
    if command -v docker &>/dev/null && [[ -f "$DOCKER_CFG" ]] && docker info &>/dev/null 2>&1; then
        KNOWN_REGS=$(python3 -c "
import json, sys
try:
    cfg = json.load(open('$DOCKER_CFG'))
    regs = set()
    for k in cfg.get('auths', {}):
        if 'docker.io' not in k: regs.add(k)
    for k in cfg.get('credHelpers', {}):
        if 'docker.io' not in k: regs.add(k)
    print('\\n'.join(sorted(regs)))
except: pass
" 2>/dev/null || true)
        REG_COUNT=$(echo "$KNOWN_REGS" | grep -c . 2>/dev/null || echo 0)
        if [[ "$REG_COUNT" -eq 1 ]]; then
            DETECTED_REGISTRY="$KNOWN_REGS"
            echo -e "${GRAY}     [i] Detected Docker login: $DETECTED_REGISTRY${NC}"
        elif [[ "$REG_COUNT" -gt 1 ]]; then
            echo -e "${GRAY}     [i] Multiple Docker logins detected:${NC}"
            i=1; while IFS= read -r r; do echo -e "${GRAY}         [$i] $r${NC}"; ((i++)); done <<< "$KNOWN_REGS"
            echo -e "${GRAY}         [0] Enter a different registry manually${NC}"
            PICK=$(ask "     Choose [0-$REG_COUNT]" "")
            if [[ "$PICK" =~ ^[1-9][0-9]*$ ]] && (( PICK >= 1 && PICK <= REG_COUNT )); then
                DETECTED_REGISTRY=$(echo "$KNOWN_REGS" | sed -n "${PICK}p")
            fi
        fi
    fi
    REGISTRY=$(ask "     Registry" "$DETECTED_REGISTRY")
fi

# ── Sanitize registry input ───────────────────────────────────────────────────
if [[ "$REGISTRY" =~ ^https?:// ]]; then
    REGISTRY="${REGISTRY#*://}"
    echo -e "${GRAY}     [i] Stripped scheme prefix — using: $REGISTRY${NC}"
fi
while [[ "$REGISTRY" == */ ]]; do REGISTRY="${REGISTRY%/}"; done
if [[ "$REGISTRY" =~ ^hub\.docker\.com/repository/docker/(.+)$ ]]; then
    captured="${BASH_REMATCH[1]}"
    while [[ "$captured" == */ ]]; do captured="${captured%/}"; done
    captured="$(echo "$captured" | sed 's|/\(general\|tags\|builds\|collaborators\|webhooks\|settings\)\(/.*\)\?$||')"
    REGISTRY="$captured"
    echo -e "${GRAY}     [i] Converted Docker Hub URL → push reference: $REGISTRY${NC}"
fi
if [[ -z "$REGISTRY" ]]; then echo -e "${RED}Registry cannot be empty.${NC}"; exit 1; fi

IMAGE_NAME=$(ask "     Image name" "$IMAGE_NAME")
TAG=$(ask        "     Image tag"  "$TAG")
IMAGE="${REGISTRY}/${IMAGE_NAME}:${TAG}"
echo -e "  ${CYAN}→ Will build and push: $IMAGE${NC}"

# ── Registry reachability probe ───────────────────────────────────────────────
REGISTRY_HOST="${REGISTRY%%/*}"
if [[ "$REGISTRY_HOST" == "hub.docker.com" || "$REGISTRY_HOST" == "docker.io" || \
      ( "$REGISTRY_HOST" != *.* && "$REGISTRY_HOST" != *:* ) ]]; then
    PROBE_HOST="registry-1.docker.io"
else
    PROBE_HOST="$REGISTRY_HOST"
fi
HTTP_STATUS=$(curl -o /dev/null -s -w "%{http_code}" --max-time 10 \
    "https://$PROBE_HOST/v2/" 2>/dev/null || true)
case "$HTTP_STATUS" in
    200)     ok "Registry reachable (HTTP 200)" ;;
    401|403) ok "Registry reachable (HTTP $HTTP_STATUS — login required, will authenticate at push)" ;;
    "")      echo -e "  ${YELLOW}[!] Could not reach https://$PROBE_HOST/v2/ — curl failed or timed out.${NC}"
             ask_bool "     Continue anyway?" "n" || exit 1 ;;
    *)       echo -e "  ${YELLOW}[!] Probe returned HTTP $HTTP_STATUS. Continuing anyway.${NC}" ;;
esac

# ═══════════════════════════════════════════════════════
# STAGE 2 — Kubernetes namespaces
# ═══════════════════════════════════════════════════════
echo -e "\n  ${CYAN}[2/5] Kubernetes Namespaces${NC}"
echo -e "  ${GRAY}$(printf '%.0s─' {1..54})${NC}"
NAMESPACE=$(ask   "     MCP server pod namespace"      "$NAMESPACE")
CV_NAMESPACE=$(ask "     Commvault workloads namespace" "$CV_NAMESPACE")

# Kubernetes requires lowercase namespace names (RFC 1123 label)
ORIG_NAMESPACE="$NAMESPACE"
NAMESPACE="${NAMESPACE,,}"
[[ "$NAMESPACE" != "$ORIG_NAMESPACE" ]] && echo -e "${GRAY}     [i] Namespace converted to lowercase: $NAMESPACE${NC}"

ORIG_CV_NAMESPACE="$CV_NAMESPACE"
CV_NAMESPACE="${CV_NAMESPACE,,}"
[[ "$CV_NAMESPACE" != "$ORIG_CV_NAMESPACE" ]] && echo -e "${GRAY}     [i] CV namespace converted to lowercase: $CV_NAMESPACE${NC}"

# ═══════════════════════════════════════════════════════
# STAGE 3 — Commvault component image source registry
# ═══════════════════════════════════════════════════════
echo -e "\n  ${CYAN}[3/5] Commvault Component Images — where to pull from${NC}"
echo -e "  ${GRAY}$(printf '%.0s─' {1..54})${NC}"
echo -e "${GRAY}     This registry is used when the MCP server deploys CommServer,${NC}"
echo -e "${GRAY}     AccessNode, MediaAgent, etc. into your cluster.${NC}"
if [[ -z "$CV_REGISTRY" ]]; then
    CV_REGISTRY=$(ask "     Commvault components registry" "docker.io")
fi
if [[ -n "$CV_REGISTRY" ]]; then
    if [[ "$CV_REGISTRY" =~ ^https?:// ]]; then
        CV_REGISTRY="${CV_REGISTRY#*://}"
    fi
    while [[ "$CV_REGISTRY" == */ ]]; do CV_REGISTRY="${CV_REGISTRY%/}"; done
    if [[ -z "$CV_IMAGE_NAMESPACE" ]]; then
        CV_IMAGE_NAMESPACE=$(ask "     Image namespace/sub-path" "commvault")
    fi
    CV_HOST="${CV_REGISTRY%%/*}"
    CV_STATUS=$(curl -o /dev/null -s -w "%{http_code}" --max-time 10 \
        "https://$CV_HOST/v2/" 2>/dev/null || true)
    case "$CV_STATUS" in
        200)     ok "Commvault registry reachable (HTTP 200)" ;;
        401|403) ok "Commvault registry reachable (HTTP $CV_STATUS — authentication required at pull)" ;;
        "")      echo -e "  ${YELLOW}[!] Could not reach https://$CV_HOST/v2/ — curl failed or timed out.${NC}"
                 echo -e "  ${YELLOW}     Component deploys may fail if the registry is unreachable from the cluster.${NC}" ;;
        *)       echo -e "  ${YELLOW}[!] Probe returned HTTP $CV_STATUS. Continuing anyway.${NC}" ;;
    esac
fi

# ═══════════════════════════════════════════════════════
# STAGE 4 — Networking / TLS (optional)
# ═══════════════════════════════════════════════════════
echo -e "\n  ${CYAN}[4/5] Networking (optional)${NC}"
echo -e "  ${GRAY}$(printf '%.0s─' {1..54})${NC}"
echo -e "${GRAY}     Leave hostname blank to expose via LoadBalancer IP instead of Ingress.${NC}"
MCP_HOSTNAME=$(ask "     External hostname for MCP" "$MCP_HOSTNAME")

USE_TLS=false
if [[ -n "$MCP_HOSTNAME" ]]; then
    ask_bool "     Enable TLS on Ingress" "y" && USE_TLS=true
    $USE_TLS && TLS_SECRET=$(ask "     TLS certificate Secret name" "$TLS_SECRET")
fi

# ═══════════════════════════════════════════════════════
# STAGE 5 — Authentication mode
# ═══════════════════════════════════════════════════════
echo -e "\n  ${CYAN}[5/5] Authentication Mode${NC}"
echo -e "  ${GRAY}$(printf '%.0s─' {1..54})${NC}"
echo -e "${GRAY}     [1] static-bearer  — One shared token stored in a K8s Secret. (Recommended)${NC}"
echo -e "${GRAY}     [2] oauth-auto     — OAuth 2.0 + PKCE, auto-approves every client. (Dev/internal only)${NC}"

if [[ "$AUTH_MODE" == "oauth-auto" ]]; then
    OAUTH_PICK="2"
else
    OAUTH_PICK=$(ask "     Select [1/2]" "1")
fi

if [[ "$OAUTH_PICK" == "2" ]]; then
    echo ""
    echo -e "${YELLOW}     ╔══════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}     ║  SECURITY WARNING — oauth-auto                                       ║${NC}"
    echo -e "${YELLOW}     ║                                                                      ║${NC}"
    echo -e "${YELLOW}     ║  In this mode the MCP server exposes an open /register endpoint      ║${NC}"
    echo -e "${YELLOW}     ║  and auto-approves every authorization request — no user consent,    ║${NC}"
    echo -e "${YELLOW}     ║  no allow-list.  ANY caller that can reach the server over the       ║${NC}"
    echo -e "${YELLOW}     ║  network receives a valid access token.                              ║${NC}"
    echo -e "${YELLOW}     ║                                                                      ║${NC}"
    echo -e "${YELLOW}     ║  Only use inside a private cluster with no external access.          ║${NC}"
    echo -e "${YELLOW}     ║  Use static-bearer for any internet-facing or shared deployment.     ║${NC}"
    echo -e "${YELLOW}     ╚══════════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    if ask_bool "     I understand the risk and confirm this is an internal-only deployment" "n"; then
        AUTH_MODE="oauth-auto"
        OAUTH_OPT_IN=true
        echo -e "${YELLOW}     [OK] oauth-auto confirmed${NC}"
    else
        echo -e "${GRAY}     [i] Reverting to static-bearer.${NC}"
        AUTH_MODE="static-bearer"
    fi
else
    AUTH_MODE="static-bearer"
fi

IMAGE="${REGISTRY}/${IMAGE_NAME}:${TAG}"
PROTOCOL=$( $USE_TLS && echo "https" || echo "http" )

echo -e "\n${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${CYAN}Configuration Summary${NC}"
echo -e "${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "  Image to build/push  : $IMAGE"
echo "  MCP namespace        : $NAMESPACE"
echo "  Commvault namespace  : $CV_NAMESPACE"
[[ -n "$CV_REGISTRY" ]]        && echo "  CV image registry    : $CV_REGISTRY"
[[ -n "$CV_IMAGE_NAMESPACE" ]] && echo "  CV image namespace   : $CV_IMAGE_NAMESPACE"
HOSTNAME_DISPLAY=$( [[ -n "$MCP_HOSTNAME" ]] && echo "${PROTOCOL}://${MCP_HOSTNAME}" || echo "LoadBalancer IP (resolved after deploy)" )
echo "  External hostname    : $HOSTNAME_DISPLAY"
echo "  TLS                  : $USE_TLS"
echo "  Auth mode            : $AUTH_MODE"
echo -e "${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if ! ask_bool "Proceed with this configuration" "y"; then echo "Aborted."; exit 0; fi

# ── Build & Push ──────────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == "false" ]]; then
    step "[1/3] Building image with $BUILDER_TOOL..."
    [[ -f "$SCRIPT_DIR/SKILL.md" ]] && cp "$SCRIPT_DIR/SKILL.md" "$MCP_DIR/SKILL.md"

    if [[ "$BUILDER_TOOL" == "buildah" ]]; then
        buildah bud \
            --build-arg KUBECTL_VERSION="$KUBECTL_VER" \
            --build-arg HELM_VERSION="$HELM_VER" \
            -t "$IMAGE" "$MCP_DIR"
        ok "Build succeeded: $IMAGE"
        step "[2/3] Pushing image..."
        buildah push "$IMAGE"
    else
        docker build \
            --build-arg KUBECTL_VERSION="$KUBECTL_VER" \
            --build-arg HELM_VERSION="$HELM_VER" \
            -t "$IMAGE" "$MCP_DIR"
        ok "Build succeeded: $IMAGE"
        step "[2/3] Pushing image..."
        docker push "$IMAGE"
    fi
    ok "Push succeeded"
    rm -f "$MCP_DIR/SKILL.md"
fi

# ── Deploy to Kubernetes ──────────────────────────────────────────────────────
if [[ "$SKIP_DEPLOY" == "false" ]]; then
    step "[3/3] Deploying to Kubernetes..."
    BASE_DIR="$SCRIPT_DIR/deploy/base"
    TMP_DIR=$(mktemp -d)
    trap "rm -rf $TMP_DIR" EXIT

    # 1. Namespace
    if ! kubectl get namespace "$NAMESPACE" --ignore-not-found -o name 2>/dev/null | grep -q .; then
        if ! kubectl create namespace "$NAMESPACE" 2>/dev/null; then
            echo -e "${RED}Failed to create namespace '$NAMESPACE'. Ensure the name is lowercase and follows Kubernetes naming rules.${NC}" >&2
            exit 1
        fi
    fi
    ok "Namespace: $NAMESPACE"

    # 2. Auth secret (static-bearer only — oauth-auto issues tokens dynamically)
    EFFECTIVE_TOKEN="$AUTH_TOKEN"
    if [[ "$AUTH_MODE" == "static-bearer" ]]; then
        if [[ -z "$EFFECTIVE_TOKEN" ]]; then
            if ! kubectl get secret commvault-mcp-auth -n "$NAMESPACE" --ignore-not-found -o name | grep -q .; then
                EFFECTIVE_TOKEN=$(gen_token)
            fi
        fi
        if [[ -n "$EFFECTIVE_TOKEN" ]]; then
            kubectl create secret generic commvault-mcp-auth \
                --namespace "$NAMESPACE" \
                --from-literal=MCP_AUTH_TOKEN="$EFFECTIVE_TOKEN" \
                --dry-run=client -o yaml | kubectl apply -f -
            ok "Auth secret: commvault-mcp-auth"
        fi
    fi

    # 3. Helm repo
    if ! helm repo list 2>/dev/null | grep -q commvault; then
        helm repo add commvault https://commvault.github.io/helm-charts
        helm repo update
        ok "Helm repo added: commvault"
    fi

    # 4. Base manifests
    kubectl apply -f "$BASE_DIR/deployment.yaml" --namespace "$NAMESPACE"
    ok "Base manifests applied"

    # Patch service to LoadBalancer when no Ingress hostname configured.
    if [[ -z "$MCP_HOSTNAME" ]]; then
        kubectl patch svc commvault-mcp -n "$NAMESPACE" \
            -p '{"spec":{"type":"LoadBalancer"}}' || true
        ok "Service type set to LoadBalancer"
    fi

    # 5. RBAC (substitute namespace placeholder)
    sed "s/NAMESPACE_PLACEHOLDER/$NAMESPACE/g" "$BASE_DIR/rbac.yaml" > "$TMP_DIR/rbac.yaml"
    kubectl apply -f "$TMP_DIR/rbac.yaml"
    ok "RBAC applied"

    # 6. NetworkPolicy
    [[ -f "$BASE_DIR/networkpolicy.yaml" ]] && \
        kubectl apply -f "$BASE_DIR/networkpolicy.yaml" --namespace "$NAMESPACE" && \
        ok "NetworkPolicy applied"

    # 7. Configure env + image
    ENV_ARGS=(
        MCP_AUTH_MODE="$AUTH_MODE"
        CV_NAMESPACE="$CV_NAMESPACE"
        PROTECTED_NAMESPACES="kube-system,kube-public,kube-node-lease,$NAMESPACE"
    )
    [[ "$OAUTH_OPT_IN" == "true" ]]  && ENV_ARGS+=("MCP_OAUTH_ALLOW_INSECURE_AUTOREGISTER=true")
    [[ -n "$CV_REGISTRY" ]]          && ENV_ARGS+=("CV_IMAGE_REGISTRY=$CV_REGISTRY")
    [[ -n "$CV_IMAGE_NAMESPACE" ]]   && ENV_ARGS+=("CV_IMAGE_NAMESPACE=$CV_IMAGE_NAMESPACE")
    kubectl set env deployment/commvault-mcp -n "$NAMESPACE" "${ENV_ARGS[@]}"
    kubectl set image deployment/commvault-mcp mcp-server="$IMAGE" -n "$NAMESPACE"
    ok "Image set: $IMAGE"

    # 8. Ingress (optional)
    if [[ -n "$MCP_HOSTNAME" ]]; then
        TLS_BLOCK=""
        $USE_TLS && TLS_BLOCK="$(printf '\n  tls:\n    - hosts: ["%s"]\n      secretName: %s' "$MCP_HOSTNAME" "$TLS_SECRET")"
        cat > "$TMP_DIR/ingress.yaml" <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: commvault-mcp
  namespace: $NAMESPACE
  labels:
    app.kubernetes.io/name: commvault-mcp
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
spec:${TLS_BLOCK}
  rules:
    - host: $MCP_HOSTNAME
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: commvault-mcp
                port:
                  number: 8403
EOF
        kubectl apply -f "$TMP_DIR/ingress.yaml"
        ok "Ingress: $MCP_HOSTNAME"
    fi

    # 9. Wait for rollout
    step "Waiting for rollout..."
    kubectl rollout status deployment/commvault-mcp -n "$NAMESPACE" --timeout=180s \
        || echo -e "${YELLOW}  Rollout timeout. Check: kubectl get pods -n $NAMESPACE${NC}"

    # 10. Resolve endpoint
    if [[ -n "$MCP_HOSTNAME" ]]; then
        ENDPOINT="${PROTOCOL}://${MCP_HOSTNAME}"
    else
        echo -e "${GRAY}  Waiting for LoadBalancer IP (up to 10 minutes)...${NC}"
        EP=""
        for i in $(seq 1 120); do
            sleep 5
            IP=$(kubectl get svc commvault-mcp -n "$NAMESPACE" \
                -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
            HOST=$(kubectl get svc commvault-mcp -n "$NAMESPACE" \
                -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
            EP="${IP:-$HOST}"
            [[ -n "$EP" ]] && break
        done
        ENDPOINT=$( [[ -n "$EP" ]] && echo "http://${EP}:8403" || echo "http://<PENDING-IP>:8403" )
    fi

    # 11. Retrieve token (static-bearer only — read back pre-existing secret if not generated this run)
    if [[ "$AUTH_MODE" == "static-bearer" && -z "$EFFECTIVE_TOKEN" ]]; then
        B64=$(kubectl get secret commvault-mcp-auth -n "$NAMESPACE" \
            -o jsonpath='{.data.MCP_AUTH_TOKEN}' 2>/dev/null || true)
        [[ -n "$B64" ]] && EFFECTIVE_TOKEN=$(echo "$B64" | base64 -d)
    fi

    # 12. Generate client configs
    VSCODE_DIR="$SCRIPT_DIR/.vscode"
    mkdir -p "$VSCODE_DIR"

    if [[ "$AUTH_MODE" == "oauth-auto" ]]; then
        cat > "$VSCODE_DIR/mcp.json" <<EOF
{
  "servers": {
    "commvault-k8s": {
      "type": "sse",
      "url": "${ENDPOINT}/sse"
    }
  }
}
EOF
        ok "VS Code config written → .vscode/mcp.json"

        cat > "$SCRIPT_DIR/claude_desktop_config.json" <<EOF
{
  "mcpServers": {
    "commvault-k8s": {
      "url": "${ENDPOINT}/sse"
    }
  }
}
EOF
        ok "Claude Desktop config written → claude_desktop_config.json"
    else
        cat > "$VSCODE_DIR/mcp.json" <<EOF
{
  "servers": {
    "commvault-k8s": {
      "type": "sse",
      "url": "${ENDPOINT}/sse",
      "headers": { "Authorization": "Bearer ${EFFECTIVE_TOKEN}" }
    }
  }
}
EOF
        ok "VS Code config written → .vscode/mcp.json"

        cat > "$SCRIPT_DIR/claude_desktop_config.json" <<EOF
{
  "mcpServers": {
    "commvault-k8s": {
      "url": "${ENDPOINT}/sse",
      "headers": { "Authorization": "Bearer ${EFFECTIVE_TOKEN}" }
    }
  }
}
EOF
        ok "Claude Desktop config written → claude_desktop_config.json"
    fi

    # 13. Final summary
    if [[ "$AUTH_MODE" == "oauth-auto" ]]; then
        echo -e "${CYAN}
╔══════════════════════════════════════════════════════════════════╗
║  Kubernetes deployment complete!  (oauth-auto)                   ║
╚══════════════════════════════════════════════════════════════════╝

  MCP Endpoint : ${ENDPOINT}/sse
  Auth mode    : oauth-auto — clients obtain tokens dynamically via OAuth 2.0 + PKCE
  Namespace    : ${NAMESPACE}

  ─── Connect an AI client ──────────────────────────────────────────

  VS Code / GitHub Copilot
    .vscode/mcp.json is ready — open this folder in VS Code.
    The client will complete the OAuth flow automatically on first use.

  Claude Desktop
    Merge claude_desktop_config.json into:
      Settings → Developer → Edit Config  →  restart Claude.
    Claude will be redirected through OAuth on first use.

  Cursor / Windsurf
    type : sse
    url  : ${ENDPOINT}/sse
    (No manual token needed — the client completes OAuth automatically)

  ─── CLI ───────────────────────────────────────────────────────────

    cd cli
    pwsh cv.ps1 --help
    pwsh cv.ps1 deploy ring 11.42.1 --user admin --password P@ss

  ─── Verify deployment ─────────────────────────────────────────────

    kubectl get pods -n ${NAMESPACE}
    kubectl get svc  -n ${NAMESPACE}
    curl ${ENDPOINT}/health

  !! NOTE — oauth-auto tokens are in-memory only.
     All client sessions are lost on pod restart. Clients must re-authenticate
     after a restart or rollout. Switch to static-bearer for persistent access:
     ./setup.sh --mode kubernetes --skip-build --auth-mode static-bearer
${NC}"
    else
        echo -e "${CYAN}
╔══════════════════════════════════════════════════════════════════╗
║  Kubernetes deployment complete!                                 ║
╚══════════════════════════════════════════════════════════════════╝

  MCP Endpoint : ${ENDPOINT}/sse
  Auth Token   : ${EFFECTIVE_TOKEN}
  Namespace    : ${NAMESPACE}

  !! Save the token above — it will not be shown again.

  ─── Connect an AI client ──────────────────────────────────────────

  VS Code / GitHub Copilot
    .vscode/mcp.json is ready — open this folder in VS Code.
    The "commvault-k8s" server appears under GitHub Copilot > MCP Servers.

  Claude Desktop
    Merge claude_desktop_config.json into:
      Settings → Developer → Edit Config  →  restart Claude.

  Cursor / Windsurf
    type   : sse
    url    : ${ENDPOINT}/sse
    header : Authorization: Bearer ${EFFECTIVE_TOKEN}

  ─── Share with other users ────────────────────────────────────────

    URL   : ${ENDPOINT}/sse
    Token : ${EFFECTIVE_TOKEN}
    (all users share the same token)

  ─── CLI (no AI agent needed) ──────────────────────────────────────

    cd cli
    pwsh cv.ps1 --help
    pwsh cv.ps1 deploy ring 11.42.1 --user admin --password P@ss

  ─── Verify deployment ─────────────────────────────────────────────

    kubectl get pods  -n ${NAMESPACE}
    kubectl get svc   -n ${NAMESPACE}
    curl ${ENDPOINT}/health

  ─── Rotate token ──────────────────────────────────────────────────

    ./setup.sh --mode kubernetes --skip-build --token <new-token>
${NC}"
    fi
fi
