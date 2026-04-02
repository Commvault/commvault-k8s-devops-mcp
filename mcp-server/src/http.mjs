/**
 * http.mjs — Streamable HTTP transport with session management,
 *            OAuth endpoints, request size limiting, and graceful shutdown.
 */

import http from "http";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  HTTP_PORT, HTTP_HOST,
  HTTP_MAX_SESSIONS, HTTP_SESSION_IDLE_TTL_MS, HTTP_SESSION_SWEEP_MS,
  MAX_REQUEST_BODY_BYTES,
  MCP_AUTH_MODE,
} from "./config.mjs";
import {
  isValidToken, parseBearerToken, makeBaseUrl,
  handleOauthDiscovery, handleOauthResourceMetadata,
  handleRegister, handleAuthorize, handleToken,
  IS_OAUTH, IS_NONE, purgeExpiredOauthData,
} from "./auth.mjs";
import { createMcpServer } from "./server.mjs";
import { logger } from "./logger.mjs";
import { DEFAULT_NAMESPACE } from "./config.mjs";
import {
  getSession,
  getSessionContext,
  setSessionContext,
  touchSession,
  storeSession,
  getAllSessions,
  deleteSession,
  getSessionCount
} from "./session.mjs";

// Export session helpers for external use
export { getSessionContext, setSessionContext, touchSession };

async function closeSession(sessionId, reason = "") {
  const entry = getSession(sessionId);
  if (!entry) return;
  deleteSession(sessionId);
  try { await entry.server.close(); } catch { /* ignore */ }
if (reason) logger.info("Session closed", { sessionId, reason });
}

function startSessionSweep() {
  const timer = setInterval(async () => {
    const now     = Date.now();
    const expired = [];
    for (const [id, entry] of getAllSessions().entries()) {
      if (now - entry.lastSeenAt > HTTP_SESSION_IDLE_TTL_MS) expired.push(id);
    }
    for (const id of expired) await closeSession(id, "idle timeout");
    // Purge expired OAuth auth codes, access tokens, and refresh tokens
    // in the same sweep to prevent unbounded memory growth.
    if (IS_OAUTH) purgeExpiredOauthData();
  }, HTTP_SESSION_SWEEP_MS);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

async function createSession(req, res) {
  if (getSessionCount() >= HTTP_MAX_SESSIONS) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Session limit reached" }));
    return;
  }

  const sessionServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  let createdId = "";

  try {
    transport.onclose = () => { if (createdId) void closeSession(createdId, "transport closed"); };
  } catch { /* older SDK — TTL sweep handles cleanup */ }

  try {
    await sessionServer.connect(transport);
    await transport.handleRequest(req, res);
    const sessionId = `${transport.sessionId || ""}`;
    if (!sessionId) { try { await sessionServer.close(); } catch { /* ignore */ } return; }
    storeSession(sessionId, { 
      server: sessionServer, 
      transport, 
      context: { namespace: DEFAULT_NAMESPACE }
    });
    createdId = sessionId;
    logger.info("Session created", { sessionId, sessions: getSessionCount(), defaultNamespace: DEFAULT_NAMESPACE });
  } catch (err) {
    try { await sessionServer.close(); } catch { /* ignore */ }
    throw err;
  }
}

// ── Request body reader with size limit ───────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        req.destroy(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end",   () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── Request router ────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const baseUrl  = makeBaseUrl(req, HTTP_PORT);
  const reqUrl   = new URL(req.url || "/", baseUrl);
  const pathname = reqUrl.pathname;

  // Health check
  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", transport: "http", sessions: getSessionCount() }));
    return;
  }

  // ── OAuth endpoints (oauth-auto mode only) ──────────────────────────────────

  if (IS_OAUTH && req.method === "GET" && (
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname === "/.well-known/oauth-protected-resource/mcp"
  )) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(handleOauthResourceMetadata(baseUrl)));
    return;
  }

  if (IS_OAUTH && req.method === "GET" && (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/.well-known/oauth-authorization-server/mcp"
  )) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(handleOauthDiscovery(baseUrl)));
    return;
  }

  if (IS_OAUTH && req.method === "POST" && pathname === "/register") {
    const raw  = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const { status, body: respBody } = handleRegister(body);
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(respBody));
    return;
  }

  if (IS_OAUTH && (req.method === "GET" || req.method === "POST") && pathname === "/authorize") {
    const rawParams = req.method === "GET"
      ? reqUrl.searchParams
      : new URLSearchParams(await readBody(req));
    const params = Object.fromEntries(rawParams.entries());
    const result = handleAuthorize(params);
    if (result.location) {
      res.writeHead(result.status, { Location: result.location });
      res.end();
    } else {
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    }
    return;
  }

  if (IS_OAUTH && req.method === "POST" && pathname === "/token") {
    const params = new URLSearchParams(await readBody(req));
    const { status, body: respBody } = handleToken(Object.fromEntries(params.entries()));
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(respBody));
    return;
  }

  // ── MCP endpoint ────────────────────────────────────────────────────────────
  // Accept both /mcp (current standard) and /sse (legacy alias used by some
  // MCP clients and older generated config files).

  if (pathname === "/mcp" || pathname === "/sse") {
    if (!IS_NONE) {
      const token = parseBearerToken(req.headers["authorization"]);
      if (!isValidToken(token)) {
        const metaUrl   = `${baseUrl}/.well-known/oauth-protected-resource/mcp`;
        const wwwAuth   = IS_OAUTH
          ? `Bearer realm="commvault-mcp", resource_metadata="${metaUrl}"`
          : `Bearer realm="commvault-mcp"`;
        res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": wwwAuth });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    const rawSessionId = req.headers["mcp-session-id"];
    const sessionId    = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

    if (!sessionId) {
      await createSession(req, res);
    } else {
      const entry = getSession(String(sessionId));
      if (!entry) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Session not found or expired" }, id: null }));
        return;
      }
      touchSession(String(sessionId));
      await entry.transport.handleRequest(req, res);
      touchSession(String(sessionId));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found. Use POST /mcp for MCP or GET /health for health check.");
}

// ── Server factory ────────────────────────────────────────────────────────────

export function startHttpServer(onReady) {
  const sweepTimer = startSessionSweep();

  const httpServer = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      logger.error("Request error", { err: err?.stack || err?.message });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info("Shutting down", { signal, sessions: getSessionCount() });
    clearInterval(sweepTimer);
    httpServer.close(() => logger.info("HTTP server closed"));
    for (const id of getAllSessions().keys()) await closeSession(id, "shutdown");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
    logger.info("HTTP server started", {
      host: HTTP_HOST,
      port: HTTP_PORT,
      authMode: MCP_AUTH_MODE,
      endpoint: `http://<host>:${HTTP_PORT}/mcp`,
      health:   `http://<host>:${HTTP_PORT}/health`,
    });
    if (typeof onReady === "function") onReady();
  });

  return httpServer;
}
