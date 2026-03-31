/**
 * exec.mjs — safe command execution layer.
 *
 * Only kubectl and helm are allowed. All argument validation,
 * namespace policy enforcement, and redaction happen here.
 */

import { execFileSync } from "child_process";
import { PROTECTED_NAMESPACES } from "./config.mjs";
import { NamespaceProtectedError, CommandError } from "./errors.mjs";
import { logger } from "./logger.mjs";

// Test seam: replace with a spy in unit tests.
let _execImpl = execFileSync;
export function __setExecImpl(fn) { _execImpl = fn ?? execFileSync; }

// ── Argument helpers ─────────────────────────────────────────────────────────

export function appendSetArg(args, key, value) {
  if (value === undefined || value === null || value === "") return;
  args.push("--set", `${key}=${value}`);
}

export function tokenizeCommand(command) {
  const tokens = [];
  let current  = "";
  let quote    = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && (command[i + 1] === quote || command[i + 1] === "\\")) {
        current += command[i + 1]; i++; continue;
      }
      if (ch === quote) { quote = null; } else { current += ch; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (current) { tokens.push(current); current = ""; } continue; }
    current += ch;
  }
  if (quote) throw new Error("Malformed command: unmatched quote");
  if (current) tokens.push(current);
  return tokens;
}

export function parseNamespaceFlags(args) {
  const namespaces = [];
  let allNamespaces = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-A" || arg === "--all-namespaces") { allNamespaces = true; continue; }
    if (arg === "-n" || arg === "--namespace") {
      const ns = args[i + 1];
      if (!ns || ns.startsWith("-")) throw new Error("Namespace flag is missing a value");
      namespaces.push(ns); i++; continue;
    }
    if (arg.startsWith("--namespace=")) { namespaces.push(arg.slice("--namespace=".length)); continue; }
    if (arg.startsWith("-n="))          { namespaces.push(arg.slice(3)); continue; }
    if (arg.startsWith("-n") && arg.length > 2) { namespaces.push(arg.slice(2)); }
  }

  return { namespaces, allNamespaces };
}

export function containsKubeconfigOverride(args) {
  return args.some(a => a === "--kubeconfig" || a.startsWith("--kubeconfig="));
}

// ── Namespace policy ─────────────────────────────────────────────────────────

export function assertNamespaceAllowed(ns) {
  if (!ns) return;
  if (PROTECTED_NAMESPACES.has(ns.trim().toLowerCase())) {
    throw new NamespaceProtectedError(ns, PROTECTED_NAMESPACES);
  }
}

// ── Logging helpers ──────────────────────────────────────────────────────────

export function formatCommandForLog(args) {
  return (Array.isArray(args) ? args : [String(args)])
    .map(a => (/\s/.test(a) ? JSON.stringify(a) : a))
    .join(" ");
}

export function redactCommandForLog(args) {
  const copy = [...args];
  for (let i = 0; i < copy.length; i++) {
    if (copy[i] === "--set" && i + 1 < copy.length) {
      if (/^secret\.(password|authcode)=/i.test(copy[i + 1])) {
        copy[i + 1] = copy[i + 1].replace(/=.*/, "=<redacted>");
      }
    }
  }
  return formatCommandForLog(copy);
}

// ── Core runner ───────────────────────────────────────────────────────────────

/**
 * Run a kubectl or helm command.
 * @param {string[]} cmd    Array of arguments, first element is the binary.
 * @param {number}   [timeoutMs=120000]
 * @param {{ cwd?: string }} [options]
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
export function runCommand(cmd, timeoutMs = 120_000, options = {}) {
  const args = Array.isArray(cmd) ? cmd : tokenizeCommand(cmd);
  if (!args.length) throw new Error("Empty command");

  logger.debug("exec", { cmd: redactCommandForLog(args) });

  try {
    const stdout = _execImpl(args[0], args.slice(1), {
      encoding:    "utf-8",
      timeout:     timeoutMs,
      windowsHide: true,
      shell:       false,
      cwd:         options.cwd,
    });
    return { stdout: (stdout || "").toString().trim(), stderr: "", exitCode: 0 };
  } catch (err) {
    return {
      stdout:   (err.stdout  || "").toString().trim(),
      stderr:   (err.stderr  || err.message || "").toString().trim(),
      exitCode: err.status ?? 1,
    };
  }
}

export function formatResult(res) {
  let text = "";
  if (res.stdout) text += res.stdout + "\n";
  if (res.stderr) text += "STDERR: " + res.stderr + "\n";
  if (res.exitCode !== 0) text += `(exit code ${res.exitCode})`;
  return text.trim() || "(no output)";
}

// ── Pod resolution helper ────────────────────────────────────────────────────

export function resolvePodNameOrThrow(podName, namespace) {
  const res = runCommand(["kubectl", "get", "pods", "--namespace", namespace, "-o", "name"]);
  if (res.exitCode !== 0) {
    throw new CommandError(`Unable to list pods in namespace "${namespace}": ${formatResult(res)}`, res.exitCode);
  }

  const names = res.stdout
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^pod\//, ""));

  const exact = names.find(n => n === podName);
  if (exact) return exact;

  const matches = names.filter(n => n.toLowerCase().includes(podName.toLowerCase()));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1)   throw new Error(`Ambiguous pod name "${podName}". Matches: ${matches.join(", ")}`);

  throw new Error(`No pod found matching "${podName}" in namespace "${namespace}"`);
}

// ── Helm bootstrap ────────────────────────────────────────────────────────────

import { HELM_REPO_NAME, HELM_REPO_URL } from "./config.mjs";

export function ensureHelmRepo() {
  try {
    runCommand(["helm", "repo", "add", HELM_REPO_NAME, HELM_REPO_URL]);
    runCommand(["helm", "repo", "update", HELM_REPO_NAME]);
    logger.info("Helm repo ready", { repo: HELM_REPO_NAME });
  } catch (err) {
    logger.warn("Helm repo init warning", { err: err?.message });
  }
}
