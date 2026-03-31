/**
 * tools/observe.mjs — MCP tools: get_pods, get_services, get_status,
 *                     describe_pod, get_pod_logs, list_log_files, download_log_files
 */

import { z } from "zod";
import { DEFAULT_NAMESPACE, IS_WINDOWS, DEFAULT_DOWNLOAD_DIR } from "../config.mjs";
import { runCommand, formatResult, formatCommandForLog, assertNamespaceAllowed, resolvePodNameOrThrow } from "../exec.mjs";
import { tryCatchTool } from "../errors.mjs";
import path from "path";
import fs from "fs";

export function registerObserveTools(server) {

  server.tool("get_pods",
    "List pods in the namespace, optionally filtered by name pattern.",
    {
      namespace:   z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
      namePattern: z.string().optional().describe("Filter pods by name pattern"),
    },
    (args) => tryCatchTool(() => {
      assertNamespaceAllowed(args.namespace);
      const res = runCommand(["kubectl", "get", "pods", "-o", "wide", "--namespace", args.namespace]);
      let output = res.stdout;
      if (args.namePattern && output) {
        const lines = output.split("\n");
        const filtered = lines.slice(1).filter(l => l.toLowerCase().includes(args.namePattern.toLowerCase()));
        output = [lines[0], ...filtered].join("\n");
      }
      return { content: [{ type: "text", text: output || "(no pods found)" }] };
    })
  );

  server.tool("get_services",
    "List services in the namespace.",
    { namespace: z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace") },
    (args) => tryCatchTool(() => {
      assertNamespaceAllowed(args.namespace);
      const res = runCommand(["kubectl", "get", "services", "-o", "wide", "--namespace", args.namespace]);
      return { content: [{ type: "text", text: formatResult(res) }] };
    })
  );

  server.tool("get_status",
    "Full status of the deployment: Helm releases, pods, services, PVCs, deployments, statefulsets.",
    { namespace: z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace") },
    (args) => tryCatchTool(() => {
      assertNamespaceAllowed(args.namespace);
      const sections = [
        ["Helm Releases", ["helm", "list", "--namespace", args.namespace]],
        ["Pods",          ["kubectl", "get", "pods", "-o", "wide", "--namespace", args.namespace]],
        ["Services",      ["kubectl", "get", "services", "-o", "wide", "--namespace", args.namespace]],
        ["PVCs",          ["kubectl", "get", "pvc", "--namespace", args.namespace]],
        ["Deployments",   ["kubectl", "get", "deployments", "--namespace", args.namespace]],
        ["StatefulSets",  ["kubectl", "get", "statefulsets", "--namespace", args.namespace]],
      ];
      const parts = [];
      for (const [label, cmd] of sections) {
        parts.push(`=== ${label} ===`);
        parts.push(formatResult(runCommand(cmd)));
        parts.push("");
      }
      return { content: [{ type: "text", text: parts.join("\n") }] };
    })
  );

  server.tool("describe_pod",
    "kubectl describe pod — useful for troubleshooting.",
    {
      podName:   z.string().describe("Pod name or partial name"),
      namespace: z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
    },
    (args) => tryCatchTool(() => {
      assertNamespaceAllowed(args.namespace);
      const pod = resolvePodNameOrThrow(args.podName, args.namespace);
      return { content: [{ type: "text", text: formatResult(runCommand(["kubectl", "describe", "pod", pod, "--namespace", args.namespace])) }] };
    })
  );

  server.tool("get_pod_logs",
    "Container stdout logs (kubectl logs). Not Commvault application logs.",
    {
      podName:   z.string().describe("Pod name or partial name"),
      namespace: z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
      tailLines: z.number().default(100).describe("Number of lines to tail"),
    },
    (args) => tryCatchTool(() => {
      assertNamespaceAllowed(args.namespace);
      const pod = resolvePodNameOrThrow(args.podName, args.namespace);
      return { content: [{ type: "text", text: formatResult(runCommand(["kubectl", "logs", pod, "--namespace", args.namespace, `--tail=${args.tailLines}`])) }] };
    })
  );

  server.tool("list_log_files",
    "List Commvault log files inside a pod at /var/log/commvault/Log_Files/",
    {
      podName:   z.string().describe("Pod name or partial name"),
      namespace: z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
    },
    (args) => tryCatchTool(() => {
      assertNamespaceAllowed(args.namespace);
      const pod = resolvePodNameOrThrow(args.podName, args.namespace);
      const res = runCommand(["kubectl", "exec", pod, "--namespace", args.namespace, "--", "ls", "-la", "/var/log/commvault/Log_Files/"]);
      return { content: [{ type: "text", text: `Log files in ${pod}:\n\n${formatResult(res)}` }] };
    })
  );

  server.tool("download_log_files",
    "Download Commvault log files from a pod to the local Downloads folder.",
    {
      podName:      z.string().describe("Pod name or partial name"),
      namespace:    z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
      specificFile: z.string().optional().describe("Specific log file to download — omit to download all"),
      downloadDir:  z.string().default(DEFAULT_DOWNLOAD_DIR).describe("Local destination directory"),
    },
    (args) => tryCatchTool(() => {
      assertNamespaceAllowed(args.namespace);
      // Validate specificFile before any exec call — guard against path traversal.
      if (args.specificFile && /[/\\]|\.\./u.test(args.specificFile)) {
        throw new Error(`Invalid log file name "${args.specificFile}": must not contain path separators or "..".`);
      }
      const pod = resolvePodNameOrThrow(args.podName, args.namespace);
      const resolvedDir = args.downloadDir.replace(/^\$HOME/i, process.env.USERPROFILE || process.env.HOME || ".");
      const results = [];

      if (args.specificFile) {
        fs.mkdirSync(resolvedDir, { recursive: true });
        const dest = IS_WINDOWS ? `./${args.specificFile}` : path.posix.join(resolvedDir.replace(/\\/g, "/"), args.specificFile);
        const cmd  = ["kubectl", "cp", `${args.namespace}/${pod}:/var/log/commvault/Log_Files/${args.specificFile}`, dest];
        results.push(`>> ${formatCommandForLog(cmd)}`);
        results.push(formatResult(runCommand(cmd, 300_000, IS_WINDOWS ? { cwd: resolvedDir } : {})));
        results.push(`\nDownloaded to ${resolvedDir}/${args.specificFile}`);
      } else {
        const localDir = `${resolvedDir}/${pod}`;
        const zipFile  = `${resolvedDir}/${pod}-logs.zip`;
        fs.mkdirSync(resolvedDir, { recursive: true });

        const cpCmd = ["kubectl", "cp", `${args.namespace}/${pod}:/var/log/commvault/Log_Files/`, IS_WINDOWS ? `./${pod}` : localDir];
        results.push(`>> ${formatCommandForLog(cpCmd)}`);
        results.push(formatResult(runCommand(cpCmd, 300_000, IS_WINDOWS ? { cwd: resolvedDir } : {})));

        if (IS_WINDOWS) {
          const zipCmd = ["powershell.exe", "-NoProfile", "-Command",
            `Compress-Archive -Path '${localDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipFile.replace(/'/g, "''")}' -Force`];
          results.push(`>> ${formatCommandForLog(zipCmd)}`);
          results.push(formatResult(runCommand(zipCmd, 300_000)));
        } else {
          const zipCmd = ["zip", "-r", `${pod}-logs.zip`, pod];
          results.push(`>> ${formatCommandForLog(zipCmd)}`);
          results.push(formatResult(runCommand(zipCmd, 300_000, { cwd: resolvedDir })));
        }

        try { fs.rmSync(localDir, { recursive: true, force: true }); } catch { /* ignore */ }
        results.push(`\nZip created: ${zipFile}`);
      }

      return { content: [{ type: "text", text: results.join("\n") }] };
    })
  );
}
