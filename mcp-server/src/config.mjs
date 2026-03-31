/**
 * config.mjs — centralised env parsing with validation.
 * All env reads happen here. The rest of the application imports from this module.
 */

import { execSync } from "child_process";

function positiveInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Kubernetes / Helm ───────────────────────────────────────────────────────
export const HELM_REPO_NAME = "commvault";
export const HELM_REPO_URL  = "https://commvault.github.io/helm-charts";

/** chart("commserve")  →  "commvault/commserve" */
export function chart(name) { return `${HELM_REPO_NAME}/${name}`; }

/**
 * Default registry and image namespace for Commvault component images.
 * Set CV_IMAGE_REGISTRY / CV_IMAGE_NAMESPACE on the pod (via setup.ps1 / setup.sh)
 * so every deploy/upgrade call uses them without needing the params each time.
 */
export const CV_IMAGE_REGISTRY  = (process.env.CV_IMAGE_REGISTRY  || "docker.io").trim();
export const CV_IMAGE_NAMESPACE = (process.env.CV_IMAGE_NAMESPACE || "commvault").trim();

/** Default image repository name per Commvault component. */
export const REPO_MAP = {
  commserver:     "commserve",
  accessnode:     "accessnode",
  mediaagent:     "mediaagent",
  webserver:      "webserver",
  commandcenter:  "commandcenter",
  networkgateway: "networkgateway",
  hubserver:      "hubserver",
  gcmserver:      "gcmserver",
};

/** Component → Helm chart directory mapping. */
export const CHART_MAP = {
  commserver:     { dir: "commserve",      defaultName: "commserve" },
  accessnode:     { dir: "accessnode",     defaultName: "accessnode" },
  mediaagent:     { dir: "mediaagent",     defaultName: "mediaagent" },
  webserver:      { dir: "webserver",      defaultName: "webserver" },
  commandcenter:  { dir: "commandcenter",  defaultName: "commandcenter" },
  networkgateway: { dir: "networkgateway", defaultName: "networkgateway" },
  hubserver:      { dir: "hubserver",      defaultName: "hubserver" },
  gcmserver:      { dir: "gcmserver",      defaultName: "gcmserver" },
};

// ── Namespace policy ────────────────────────────────────────────────────────
export const DEFAULT_NAMESPACE = process.env.CV_NAMESPACE || (() => {
  try {
    const ns = execSync(
      "kubectl config view --minify --output jsonpath={.contexts[0].context.namespace}",
      { encoding: "utf-8", timeout: 5000, windowsHide: true }
    ).trim();
    return ns || "commvault";
  } catch {
    return "commvault";
  }
})();

export const PROTECTED_NAMESPACES = new Set(
  (process.env.PROTECTED_NAMESPACES || "kube-system,kube-public,kube-node-lease")
    .split(",")
    .map(ns => ns.trim().toLowerCase())
    .filter(Boolean)
);

// ── Transport ───────────────────────────────────────────────────────────────
/** "http" | "stdio" */
export const MCP_TRANSPORT = (process.env.MCP_TRANSPORT || "http").toLowerCase();
export const HTTP_PORT     = positiveInt(process.env.PORT, 8403);
export const HTTP_HOST     = process.env.HOST || "0.0.0.0";

// ── Auth ─────────────────────────────────────────────────────────────────────
// Production default is static-bearer.
// Set MCP_AUTH_MODE=oauth-auto only for dev/internal environments.
// Set MCP_AUTH_MODE=none only for local stdio testing.
const _rawMode = (process.env.MCP_AUTH_MODE || "").trim().toLowerCase();
const _legacyNone   = (process.env.MCP_ALLOW_UNAUTHENTICATED_HTTP || "false").toLowerCase() === "true";
const _legacyOauth  = (process.env.MCP_ENABLE_INSECURE_OAUTH_AUTOREG || "").trim().toLowerCase();

// oauth-auto requires an explicit opt-in flag because /register is open and
// /authorize auto-approves — any network-reachable caller gets a valid token.
// setup.ps1/setup.sh set this flag only after the operator acknowledges the warning.
const _oauthExplicitOptIn = (process.env.MCP_OAUTH_ALLOW_INSECURE_AUTOREGISTER || "").trim().toLowerCase() === "true";

function resolveAuthMode() {
  if (_rawMode === "static-bearer" || _rawMode === "none") return _rawMode;
  if (_rawMode === "oauth-auto") {
    if (_oauthExplicitOptIn) return "oauth-auto";
    console.error(
      "[mcp] WARN: MCP_AUTH_MODE=oauth-auto requires MCP_OAUTH_ALLOW_INSECURE_AUTOREGISTER=true.\n" +
      "      oauth-auto has no real gate: /register is open and /authorize auto-approves, so any\n" +
      "      network-reachable caller can obtain a valid token. Use static-bearer for production.\n" +
      "      Falling back to static-bearer."
    );
    return "static-bearer";
  }
  if (_rawMode) console.error(`[mcp] Unknown MCP_AUTH_MODE="${_rawMode}". Defaulting to static-bearer.`);
  if (_legacyNone) return "none";
  if (_legacyOauth === "true") return _oauthExplicitOptIn ? "oauth-auto" : "static-bearer";
  if (_legacyOauth === "false") return "static-bearer";
  return "static-bearer";   // safe production default
}

/** "static-bearer" | "oauth-auto" | "none" */
export const MCP_AUTH_MODE      = resolveAuthMode();
export const MCP_AUTH_TOKEN     = (process.env.MCP_AUTH_TOKEN || "").trim();

// Auth startup diagnostics — only relevant for HTTP transport.
// In stdio mode auth is never invoked, so suppress these to avoid noise
// in the VS Code MCP Servers panel.
if (MCP_TRANSPORT !== "stdio") {
  if (MCP_AUTH_MODE === "static-bearer" && !MCP_AUTH_TOKEN) {
    console.error("[mcp] WARN: MCP_AUTH_MODE=static-bearer requires MCP_AUTH_TOKEN. Server will reject all requests.");
  }
  if (MCP_AUTH_MODE === "none") {
    console.error("[mcp] WARN: MCP_AUTH_MODE=none — HTTP endpoint is unauthenticated. Use only for local testing.");
  }
  if (MCP_AUTH_MODE === "oauth-auto") {
    console.error("[mcp] WARN: MCP_AUTH_MODE=oauth-auto — auto-approval OAuth is active. " +
      "Do not expose this cluster endpoint to untrusted networks.");
  }
}

export const OAUTH_ACCESS_TOKEN_TTL_SEC  = positiveInt(process.env.MCP_OAUTH_ACCESS_TOKEN_TTL_SEC,  3600);          // 1 hour
export const OAUTH_REFRESH_TOKEN_TTL_SEC = positiveInt(process.env.MCP_OAUTH_REFRESH_TOKEN_TTL_SEC, 7 * 24 * 3600); // 7 days

// ── Session management ───────────────────────────────────────────────────────
export const HTTP_MAX_SESSIONS        = positiveInt(process.env.MCP_MAX_SESSIONS, 20);
export const HTTP_SESSION_IDLE_TTL_MS = positiveInt(process.env.MCP_SESSION_IDLE_TTL_MS, 10 * 60 * 1000);
export const HTTP_SESSION_SWEEP_MS    = positiveInt(process.env.MCP_SESSION_SWEEP_MS, 60_000);

// ── Request limits ───────────────────────────────────────────────────────────
export const MAX_REQUEST_BODY_BYTES = positiveInt(process.env.MCP_MAX_REQUEST_BODY_BYTES, 1024 * 512); // 512 KB

// ── Platform ─────────────────────────────────────────────────────────────────
export const IS_WINDOWS = process.platform === "win32";
export const DEFAULT_DOWNLOAD_DIR = IS_WINDOWS ? "$HOME\\Downloads" : "$HOME/Downloads";
