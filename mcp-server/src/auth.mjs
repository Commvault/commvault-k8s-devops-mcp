/**
 * auth.mjs — authentication middleware.
 *
 * Supports three modes (set via MCP_AUTH_MODE):
 *   static-bearer  — validates against a static token from MCP_AUTH_TOKEN secret (production default)
 *   oauth-auto     — lightweight in-process OAuth 2.0 + PKCE with auto-approval (dev/internal)
 *   none           — no auth (local stdio / testing only)
 *
 * The OAuth implementation intentionally stores tokens in-memory only.
 * Tokens are lost on pod restart. Use static-bearer for production.
 */

import { randomUUID, randomBytes, createHash, timingSafeEqual } from "crypto";
import {
  MCP_AUTH_MODE,
  MCP_AUTH_TOKEN,
  OAUTH_ACCESS_TOKEN_TTL_SEC,
  OAUTH_REFRESH_TOKEN_TTL_SEC,
} from "./config.mjs";
import { logger } from "./logger.mjs";

// Authorization codes expire after 5 minutes (RFC 6749 §4.1.2).
// Not user-configurable — this is a security invariant.
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

const IS_OAUTH  = MCP_AUTH_MODE === "oauth-auto";
const IS_BEARER = MCP_AUTH_MODE === "static-bearer";
const IS_NONE   = MCP_AUTH_MODE === "none";

// ── In-memory OAuth stores (oauth-auto mode only) ────────────────────────────
const oauthClients      = new Map(); // clientId → client metadata
const oauthCodes        = new Map(); // code     → { clientId, redirectUri, codeChallenge, scopes, issuedAtMs }
const oauthAccessTokens = new Map(); // token    → { clientId, expiresAtMs }
const oauthRefreshTokens = new Map(); // token    → { clientId, expiresAtMs }

// ── Helpers ──────────────────────────────────────────────────────────────────

function constantTimeEquals(a, b) {
  const la = Buffer.from(a || "", "utf-8");
  const lb = Buffer.from(b || "", "utf-8");
  // Pad both buffers to the same length before comparing to avoid leaking the
  // correct token length via response-time side channel.
  const len = Math.max(la.length, lb.length);
  const padA = Buffer.concat([la, Buffer.alloc(len - la.length)]);
  const padB = Buffer.concat([lb, Buffer.alloc(len - lb.length)]);
  return timingSafeEqual(padA, padB) && la.length === lb.length;
}

function pkceS256(verifier) {
  return createHash("sha256").update(verifier || "", "utf-8").digest("base64url");
}

// ── Token validation ──────────────────────────────────────────────────────────

export function isValidToken(token) {
  if (IS_NONE)   return true;
  if (!token)    return false;

  // Always accept the static bearer token if it is configured.
  if (MCP_AUTH_TOKEN && constantTimeEquals(token, MCP_AUTH_TOKEN)) return true;

  if (!IS_OAUTH) return false;

  const entry = oauthAccessTokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAtMs) {
    oauthAccessTokens.delete(token);
    return false;
  }
  return true;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

export function parseBearerToken(authHeader) {
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  return (raw || "").startsWith("Bearer ") ? raw.slice(7) : "";
}

export function makeBaseUrl(req, port) {
  // Allowlist proto to prevent header-injection into OAuth metadata URLs.
  const rawProto = [req.headers["x-forwarded-proto"]].flat()[0] || "http";
  const proto = rawProto === "https" ? "https" : "http";
  return `${proto}://${req.headers.host || `localhost:${port}`}`;
}

// ── OAuth endpoint handlers (oauth-auto mode only) ───────────────────────────

export function handleOauthDiscovery(baseUrl) {
  return {
    issuer:              baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint:      `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported:            ["code"],
    grant_types_supported:               ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    code_challenge_methods_supported:    ["S256"],
  };
}

export function handleOauthResourceMetadata(baseUrl) {
  return {
    resource:              `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
  };
}

export function handleRegister(body) {
  const redirectUris = (body?.redirect_uris || []).filter(Boolean);
  if (!redirectUris.length) return { status: 400, body: { error: "invalid_client_metadata", error_description: "redirect_uris is required" } };

  const authMethod   = body.token_endpoint_auth_method || "none";
  const clientId     = randomUUID();
  const clientSecret = authMethod === "none" ? undefined : randomBytes(24).toString("base64url");
  const client       = { ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_secret: clientSecret, client_secret_expires_at: clientSecret ? 0 : undefined, redirect_uris: redirectUris, token_endpoint_auth_method: authMethod };
  oauthClients.set(clientId, client);
  logger.info("OAuth client registered", { clientId });
  return { status: 201, body: client };
}

export function handleAuthorize(params) {
  const { client_id, response_type, redirect_uri, code_challenge, code_challenge_method, state, scope, resource } = params;
  const client = oauthClients.get(client_id);
  if (!client || !client.redirect_uris?.includes(redirect_uri)) {
    return { status: 400, body: { error: "invalid_request", error_description: "Invalid client or redirect_uri" } };
  }
  if (response_type !== "code" || !code_challenge || code_challenge_method !== "S256") {
    const url = new URL(redirect_uri);
    url.searchParams.set("error", "invalid_request");
    if (state) url.searchParams.set("state", state);
    return { status: 302, location: url.toString() };
  }
  const code = randomBytes(24).toString("base64url");
  oauthCodes.set(code, { clientId: client_id, redirectUri: redirect_uri, codeChallenge: code_challenge, scopes: scope ? scope.split(" ").filter(Boolean) : [], resource, issuedAtMs: Date.now() });
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return { status: 302, location: url.toString() };
}

export function handleToken(params) {
  const { grant_type, client_id, client_secret, code, code_verifier, redirect_uri, refresh_token } = params;
  const client = oauthClients.get(client_id);
  if (!client) return { status: 401, body: { error: "invalid_client" } };

  if ((client.token_endpoint_auth_method || "none") !== "none") {
    if (!client.client_secret || !constantTimeEquals(client_secret || "", client.client_secret)) {
      return { status: 401, body: { error: "invalid_client" } };
    }
  }

  if (grant_type === "authorization_code") {
    const authCode = oauthCodes.get(code || "");
    if (!authCode || authCode.clientId !== client_id || authCode.redirectUri !== redirect_uri) {
      return { status: 400, body: { error: "invalid_grant" } };
    }
    // Reject expired authorization codes before doing any further work.
    if (Date.now() - authCode.issuedAtMs > AUTH_CODE_TTL_MS) {
      oauthCodes.delete(code);
      return { status: 400, body: { error: "invalid_grant", error_description: "authorization code expired" } };
    }
    if (!code_verifier || pkceS256(code_verifier) !== authCode.codeChallenge) {
      return { status: 400, body: { error: "invalid_grant", error_description: "code_verifier mismatch" } };
    }
    oauthCodes.delete(code);
    const accessToken  = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    const expiresIn    = OAUTH_ACCESS_TOKEN_TTL_SEC;
    oauthAccessTokens.set(accessToken,  { clientId: client_id, expiresAtMs: Date.now() + expiresIn * 1000 });
    oauthRefreshTokens.set(refreshToken, { clientId: client_id, expiresAtMs: Date.now() + OAUTH_REFRESH_TOKEN_TTL_SEC * 1000 });
    logger.info("OAuth token issued", { clientId: client_id, grant: "authorization_code" });
    return { status: 200, body: { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, refresh_token: refreshToken } };
  }

  if (grant_type === "refresh_token") {
    const refresh = oauthRefreshTokens.get(refresh_token || "");
    if (!refresh || refresh.clientId !== client_id) return { status: 400, body: { error: "invalid_grant" } };
    // Reject expired refresh tokens.
    if (Date.now() > refresh.expiresAtMs) {
      oauthRefreshTokens.delete(refresh_token);
      return { status: 400, body: { error: "invalid_grant", error_description: "refresh token expired" } };
    }
    // Token rotation: invalidate the consumed refresh token and issue a brand-new one.
    oauthRefreshTokens.delete(refresh_token);
    const accessToken     = randomBytes(32).toString("base64url");
    const newRefreshToken = randomBytes(32).toString("base64url");
    const expiresIn       = OAUTH_ACCESS_TOKEN_TTL_SEC;
    oauthAccessTokens.set(accessToken,      { clientId: client_id, expiresAtMs: Date.now() + expiresIn * 1000 });
    oauthRefreshTokens.set(newRefreshToken, { clientId: client_id, expiresAtMs: Date.now() + OAUTH_REFRESH_TOKEN_TTL_SEC * 1000 });
    logger.info("OAuth token refreshed", { clientId: client_id, grant: "refresh_token" });
    return { status: 200, body: { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, refresh_token: newRefreshToken } };
  }

  return { status: 400, body: { error: "unsupported_grant_type" } };
}

/**
 * Sweep all in-memory OAuth stores and remove expired entries.
 * Called periodically by the HTTP session sweep timer.
 */
export function purgeExpiredOauthData() {
  const now = Date.now();
  for (const [code, entry] of oauthCodes.entries()) {
    if (now - entry.issuedAtMs > AUTH_CODE_TTL_MS) oauthCodes.delete(code);
  }
  for (const [token, entry] of oauthAccessTokens.entries()) {
    if (now > entry.expiresAtMs) oauthAccessTokens.delete(token);
  }
  for (const [token, entry] of oauthRefreshTokens.entries()) {
    if (now > entry.expiresAtMs) oauthRefreshTokens.delete(token);
  }
}

export { IS_OAUTH, IS_BEARER, IS_NONE };
