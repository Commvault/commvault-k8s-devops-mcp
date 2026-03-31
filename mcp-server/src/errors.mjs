/**
 * errors.mjs — typed operational errors with structured fields.
 * Used throughout the application for consistent error handling.
 */

export class McpError extends Error {
  /** @param {string} message  User-safe message returned in tool response. */
  constructor(message, { code = "INTERNAL_ERROR", debugInfo = "" } = {}) {
    super(message);
    this.name  = "McpError";
    this.code  = code;
    this.debugInfo = debugInfo;
  }
}

export class NamespaceProtectedError extends McpError {
  constructor(ns, protectedSet) {
    super(
      `Operation refused: namespace "${ns}" is protected. Allowed: anything except [${[...protectedSet].join(", ")}].`,
      { code: "NAMESPACE_PROTECTED" }
    );
  }
}

export class CommandError extends McpError {
  constructor(message, exitCode) {
    super(message, { code: "COMMAND_FAILED", debugInfo: `exit ${exitCode}` });
  }
}

export class AuthError extends McpError {
  constructor(message = "Unauthorized") {
    super(message, { code: "UNAUTHORIZED" });
  }
}

/**
 * Wrap any thrown value into an MCP tool content response so the agent
 * sees useful text rather than an unhandled rejection.
 *
 * @param {unknown} err
 * @returns {{ content: Array<{type: "text", text: string}> }}
 */
export function toolError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }] };
}

/**
 * Wrap a promise inside a try/catch and return either the resolved value
 * or a toolError response. Avoids repetitive try/catch in every tool handler.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T | { content: Array<{type:"text",text:string}> }>}
 */
export async function tryCatchTool(fn) {
  try {
    return await fn();
  } catch (err) {
    return toolError(err);
  }
}
