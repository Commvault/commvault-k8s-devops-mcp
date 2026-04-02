/**
 * session.mjs — Session context storage (HTTP mode only)
 * Extracted to avoid circular dependencies with exec.mjs and http.mjs
 */

import { DEFAULT_NAMESPACE } from "./config.mjs";

// Session store: sessionId → { server, transport, lastSeenAt, context: { namespace } }
const sessions = new Map();

/**
 * Get full session object (for http.mjs internal use)
 * @param {string} sessionId
 * @returns {object | undefined}
 */
export function getSession(sessionId) {
  return sessions.get(sessionId);
}

/**
 * Get session context
 * @param {string} sessionId
 * @returns {{ namespace: string } | null}
 */
export function getSessionContext(sessionId) {
  const session = sessions.get(sessionId);
  return session?.context || null;
}

/**
 * Update session context (also updates lastSeenAt)
 * @param {string} sessionId
 * @param {{ namespace?: string }} updates
 */
export function setSessionContext(sessionId, updates) {
  const session = sessions.get(sessionId);
  if (!session) return;
  
  session.context = { ...session.context, ...updates };
  session.lastSeenAt = Date.now();
}

/**
 * Touch session (update last seen timestamp)
 * @param {string} sessionId
 */
export function touchSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastSeenAt = Date.now();
  }
}

/**
 * Store a complete session object
 * @param {string} sessionId
 * @param {object} sessionData
 */
export function storeSession(sessionId, sessionData) {
  sessions.set(sessionId, {
    ...sessionData,
    context: sessionData.context || { namespace: DEFAULT_NAMESPACE },
    lastSeenAt: Date.now(),
  });
}

/**
 * Get all sessions Map (for cleanup/management)
 */
export function getAllSessions() {
  return sessions;
}

/**
 * Delete a session
 * @param {string} sessionId
 */
export function deleteSession(sessionId) {
  sessions.delete(sessionId);
}

/**
 * Get total number of sessions
 */
export function getSessionCount() {
  return sessions.size;
}
