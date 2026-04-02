/**
 * tools/observe.mjs — MCP tools: get_pods, get_services, get_status,
 *                     describe_pod, get_pod_logs, list_log_files, download_log_files
 */

import { z } from "zod";
import { DEFAULT_NAMESPACE, IS_WINDOWS, DEFAULT_DOWNLOAD_DIR, PROTECTED_NAMESPACES, MCP_TRANSPORT } from "../config.mjs";
import { runCommand, formatResult, formatCommandForLog, assertNamespaceAllowed, resolvePodNameOrThrow } from "../exec.mjs";
import { tryCatchTool } from "../errors.mjs";
import path from "path";
import fs from "fs";
import os from "os";

export function registerObserveTools(server) {

  // ── list_namespaces ───────────────────────────────────────────────────────
  server.tool("list_namespaces",
    "List all available Kubernetes namespaces (excluding protected system namespaces).",
    {},
    () => tryCatchTool(() => {
      const res = runCommand(["kubectl", "get", "namespaces", "-o", "custom-columns=NAME:.metadata.name,STATUS:.status.phase,AGE:.metadata.creationTimestamp"]);
      if (res.exitCode !== 0) {
        return { content: [{ type: "text", text: formatResult(res) }] };
      }
      
      const lines = res.stdout.split("\n").filter(Boolean);
      if (lines.length === 0) {
        return { content: [{ type: "text", text: "No namespaces found" }] };
      }
      
      const header = lines[0];
      const filtered = lines.slice(1).filter(line => {
        const ns = line.split(/\s+/)[0]?.toLowerCase();
        return ns && !PROTECTED_NAMESPACES.has(ns);
      });
      
      const output = filtered.length > 0 ? [header, ...filtered].join("\n") : "No non-system namespaces found";
      return { content: [{ type: "text", text: output }] };
    })
  );

  // ── check_kubectl_config ──────────────────────────────────────────────────
  server.tool("check_kubectl_config",
    "Check kubectl configuration and troubleshoot connectivity issues. Shows current context, cluster info, and configuration status.",
    {},
    () => tryCatchTool(() => {
      const results = [];
      
      // Check kubectl version
      const versionRes = runCommand(["kubectl", "version", "--client", "--short"], 5000);
      results.push(`kubectl version:\n${formatResult(versionRes)}`);
      
      // Check current context
      const contextRes = runCommand(["kubectl", "config", "current-context"], 5000);
      if (contextRes.exitCode === 0 && contextRes.stdout.trim()) {
        results.push(`\nCurrent context: ${contextRes.stdout.trim()}`);
        
        // Check cluster connectivity
        const clusterRes = runCommand(["kubectl", "cluster-info"], 10000);
        results.push(`\nCluster connectivity:\n${formatResult(clusterRes)}`);
        
        // Get current namespace
        const nsRes = runCommand(["kubectl", "config", "view", "--minify", "--output", "jsonpath={.contexts[0].context.namespace}"], 5000);
        const currentNs = nsRes.stdout.trim() || "(default)";
        results.push(`\nCurrent namespace: ${currentNs}`);
      } else {
        results.push(`\n[FAIL] No current context is set`);
        
        // List available contexts
        const contextsRes = runCommand(["kubectl", "config", "get-contexts"], 5000);
        results.push(`\nAvailable contexts:\n${formatResult(contextsRes)}`);
        results.push(`\n\nTo fix: kubectl config use-context <context-name>`);
      }
      
      return { content: [{ type: "text", text: results.join("\n") }] };
    })
  );

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
    "Download Commvault log files from a pod. In Kubernetes mode, provides commands to retrieve files from the MCP server pod to your local machine.",
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
      
      // Get MCP server pod name if running in Kubernetes mode
      const isKubernetesMode = MCP_TRANSPORT === "http";
      let mcpPodName = "";
      let mcpNamespace = "";
      
      if (isKubernetesMode) {
        try {
          // Try to detect MCP server pod
          mcpPodName = os.hostname();  // In K8s, hostname is the pod name
          mcpNamespace = process.env.NAMESPACE || "commvault-mcp";
        } catch {
          mcpPodName = "commvault-mcp-xxxxx";  // Fallback if detection fails
          mcpNamespace = "commvault-mcp";
        }
      }

      if (args.specificFile) {
        fs.mkdirSync(resolvedDir, { recursive: true });
        const dest = IS_WINDOWS ? `./${args.specificFile}` : path.posix.join(resolvedDir.replace(/\\/g, "/"), args.specificFile);
        const cmd  = ["kubectl", "cp", `${args.namespace}/${pod}:/var/log/commvault/Log_Files/${args.specificFile}`, dest];
        results.push(`>> ${formatCommandForLog(cmd)}`);
        results.push(formatResult(runCommand(cmd, 300_000, IS_WINDOWS ? { cwd: resolvedDir } : {})));
        
        if (isKubernetesMode) {
          const localPath = `${resolvedDir}/${args.specificFile}`.replace(/\\\\/g, "/");
          results.push(`\n[INFO] File downloaded to MCP server pod at: ${localPath}`);
          results.push(`\nTo copy to your local machine, run:`);
          results.push(`kubectl cp ${mcpNamespace}/${mcpPodName}:${localPath} ./cv-logs/${args.specificFile}`);
        } else {
          results.push(`\nDownloaded to ${resolvedDir}/${args.specificFile}`);
        }
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
        
        if (isKubernetesMode) {
          const zipPath = zipFile.replace(/\\\\/g, "/");
          results.push(`\n${"=".repeat(70)}`);
          results.push(`[INFO] Logs packaged on MCP server pod`);
          results.push(`${"=".repeat(70)}`);
          results.push(`\nZip file location: ${zipPath}`);
          results.push(`MCP server pod: ${mcpPodName}`);
          results.push(`MCP namespace: ${mcpNamespace}`);
          results.push(`\nTo download the zip file to your local machine, run:`);
          results.push(`\nkubectl cp ${mcpNamespace}/${mcpPodName}:${zipPath} ./cv-logs/${pod}-logs.zip`);
          results.push(`\nOr create the directory and copy:`);
          results.push(`mkdir -p cv-logs`);
          results.push(`kubectl cp ${mcpNamespace}/${mcpPodName}:${zipPath} cv-logs/${pod}-logs.zip`);
          results.push(`\nAfter copying, you can clean up the MCP server:`);
          results.push(`kubectl exec ${mcpPodName} -n ${mcpNamespace} -- rm ${zipPath}`);
          results.push(`${"=".repeat(70)}`);
        } else {
          results.push(`\nZip created: ${zipFile}`);
        }
      }

      return { content: [{ type: "text", text: results.join("\n") }] };
    })
  );

  // ── validate_deployment ───────────────────────────────────────────────────
  server.tool("validate_deployment",
    "Pre-flight validation checks before deploying Commvault components. Verifies namespace, RBAC, storage classes, resource quotas, and DNS configuration.",
    {
      namespace:     z.string().default(DEFAULT_NAMESPACE).describe("Target namespace for deployment"),
      storageClass:  z.string().optional().describe("Storage class to validate (optional)"),
      checkDns:      z.boolean().default(true).describe("Whether to check DNS resolution"),
      minMemoryGb:   z.number().default(8).describe("Minimum memory required in GB"),
      minCpuCores:   z.number().default(4).describe("Minimum CPU cores required"),
    },
    (args) => tryCatchTool(() => {
      const { namespace, storageClass, checkDns, minMemoryGb, minCpuCores } = args;
      assertNamespaceAllowed(namespace);
      
      const checks = [];
      let allPassed = true;

      // 1. Check if namespace exists
      checks.push("\n=== Namespace Check ===");
      try {
        runCommand(["kubectl", "get", "namespace", namespace]);
        checks.push(`[OK] Namespace '${namespace}' exists`);
      } catch (e) {
        checks.push(`[FAIL] Namespace '${namespace}' does not exist`);
        checks.push(`   Fix: kubectl create namespace ${namespace}`);
        allPassed = false;
      }

      // 2. Check RBAC permissions
      checks.push("\n=== RBAC Permissions Check ===");
      const rbacTests = [
        { verb: "get", resource: "pods" },
        { verb: "create", resource: "pods" },
        { verb: "get", resource: "services" },
        { verb: "create", resource: "persistentvolumeclaims" },
      ];
      
      for (const test of rbacTests) {
        try {
          const result = runCommand([
            "kubectl", "auth", "can-i", test.verb, test.resource,
            "--namespace", namespace
          ]);
          if (result.stdout.trim().toLowerCase() === "yes") {
            checks.push(`[OK] Can ${test.verb} ${test.resource}`);
          } else {
            checks.push(`[FAIL] Cannot ${test.verb} ${test.resource}`);
            allPassed = false;
          }
        } catch {
          checks.push(`[FAIL] Cannot ${test.verb} ${test.resource}`);
          allPassed = false;
        }
      }

      // 3. Check storage classes
      checks.push("\n=== Storage Class Check ===");
      try {
        const result = runCommand(["kubectl", "get", "storageclass", "--output", "json"]);
        const storageClasses = JSON.parse(result.stdout);
        
        if (storageClasses.items.length === 0) {
          checks.push(`[FAIL] No storage classes available in the cluster`);
          allPassed = false;
        } else {
          checks.push(`[OK] Found ${storageClasses.items.length} storage class(es):`);
          storageClasses.items.forEach(sc => {
            const isDefault = sc.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true";
            checks.push(`   ${isDefault ? "[*]" : "   "} ${sc.metadata.name} (${sc.provisioner})`);
          });
          
          if (storageClass) {
            const exists = storageClasses.items.some(sc => sc.metadata.name === storageClass);
            if (exists) {
              checks.push(`[OK] Requested storage class '${storageClass}' exists`);
            } else {
              checks.push(`[FAIL] Requested storage class '${storageClass}' not found`);
              allPassed = false;
            }
          }
        }
      } catch (e) {
        checks.push(`[WARN] Could not check storage classes: ${e.message}`);
      }

      // 4. Check resource quotas
      checks.push("\n=== Resource Quota Check ===");
      try {
        const result = runCommand(["kubectl", "get", "resourcequota", "--namespace", namespace, "--output", "json"]);
        const quotas = JSON.parse(result.stdout);
        
        if (quotas.items.length === 0) {
          checks.push(`[INFO] No resource quotas set (unlimited resources)`);
        } else {
          checks.push(`[OK] Resource quotas configured:`);
          quotas.items.forEach(quota => {
            checks.push(`   Quota: ${quota.metadata.name}`);
            if (quota.status?.used && quota.status?.hard) {
              Object.keys(quota.status.hard).forEach(resource => {
                checks.push(`     ${resource}: ${quota.status.used[resource] || 0} / ${quota.status.hard[resource]}`);
              });
            }
          });
        }
      } catch {
        checks.push(`[INFO] No resource quotas found in namespace`);
      }

      // 5. Check DNS configuration
      if (checkDns) {
        checks.push("\n=== DNS Configuration Check ===");
        try {
          const result = runCommand(["kubectl", "get", "service", "kube-dns", "--namespace", "kube-system"]);
          checks.push(`[OK] CoreDNS/kube-dns service is running`);
          
          // Try to resolve a  service name
          try {
            runCommand(["kubectl", "run", "dns-test-" + Date.now(), "--image=busybox:1.28", "--restart=Never", 
                       "--namespace", namespace, "--command", "--", "nslookup", "kubernetes.default"], 5000);
            checks.push(`[OK] DNS resolution working`);
          } catch {
            checks.push(`[WARN] Could not verify DNS resolution (may need manual check)`);
          }
        } catch {
          checks.push(`[FAIL] DNS service not found - pods may not resolve service names`);
          allPassed = false;
        }
      }

      // 6. Check node resources
      checks.push("\n=== Cluster Resources Check ===");
      try {
        const result = runCommand(["kubectl", "top", "nodes"]);
        checks.push(`[OK] Node metrics available`);
        checks.push(`\nNode Resource Usage:`);
        checks.push(result.stdout);
      } catch {
        checks.push(`[WARN] Node metrics not available (metrics-server may not be installed)`);
        // Try to get node capacity instead
        try {
          const nodesResult = runCommand(["kubectl", "get", "nodes", "--output", "json"]);
          const nodes = JSON.parse(nodesResult.stdout);
          checks.push(`\nNode Capacity:`);
          nodes.items.forEach(node => {
            const capacity = node.status.capacity;
            checks.push(`   ${node.metadata.name}: ${capacity.cpu} CPUs, ${capacity.memory} Memory`);
          });
        } catch {
          checks.push(`[WARN] Could not retrieve node information`);
        }
      }

      // Summary
      checks.push("\n" + "=".repeat(60));
      if (allPassed) {
        checks.push("[OK] All critical checks PASSED - Ready for deployment");
      } else {
        checks.push("[FAIL] Some checks FAILED - Please fix issues before deploying");
      }
      checks.push("=".repeat(60));

      return { content: [{ type: "text", text: checks.join("\n") }] };
    })
  );

  // ── tail_logs ─────────────────────────────────────────────────────────────
  server.tool("tail_logs",
    "Stream pod logs in real-time (or collect logs over a specified duration). Supports filtering by log level and multiple pods.",
    {
      podName:     z.string().describe("Pod name or pattern (supports wildcards like 'accessnode*' for multi-pod aggregation)"),
      namespace:   z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
      container:   z.string().optional().describe("Container name (for multi-container pods)"),
      duration:    z.number().default(30).describe("Duration in seconds to collect logs (default 30s, max 300s)"),
      tail:        z.number().default(100).describe("Number of recent lines to start with"),
      levelFilter: z.enum(["ALL", "ERROR", "WARN", "INFO", "DEBUG"]).default("ALL").describe("Filter logs by level"),
      previous:    z.boolean().default(false).describe("Get logs from previous (crashed) container instance"),
    },
    (args) => tryCatchTool(() => {
      const { podName, namespace, container, duration, tail, levelFilter, previous } = args;
      assertNamespaceAllowed(namespace);
      validateNamespaceExists(namespace);

      // Limit duration to prevent long-running operations
      const maxDuration = 300; // 5 minutes
      const actualDuration = Math.min(duration, maxDuration);
      
      const results = [];
      results.push(`=== Tailing Logs: ${podName} (${actualDuration}s) ===`);
      results.push(`Namespace: ${namespace}`);
      results.push(`Filter: ${levelFilter}`);
      results.push(`Timestamp: ${new Date().toISOString()}`);
      results.push("\n" + "=".repeat(60) + "\n");

      // Get matching pods
      let pods = [];
      if (podName.includes("*") || podName.includes("?")) {
        // Wildcard support - get all matching pods
        const pattern = podName.replace(/\*/g, ".*").replace(/\?/g, ".");
        const regex = new RegExp(`^${pattern}$`);
        
        try {
          const podsResult = runCommand(["kubectl", "get", "pods", "--namespace", namespace, "--output", "json"]);
          const allPods = JSON.parse(podsResult.stdout);
          pods = allPods.items
            .filter(p => regex.test(p.metadata.name))
            .map(p => p.metadata.name);
          
          if (pods.length === 0) {
            return { content: [{ type: "text", text: `No pods found matching pattern '${podName}' in namespace '${namespace}'` }] };
          }
          
          results.push(`Found ${pods.length} matching pod(s): ${pods.join(", ")}\n`);
        } catch (e) {
          return { content: [{ type: "text", text: `Error finding pods: ${e.message}` }] };
        }
      } else {
        // Exact pod name
        pods = [podName];
      }

      // Collect logs from each pod
      for (const pod of pods) {
        if (pods.length > 1) {
          results.push(`\n${"=".repeat(60)}`);
          results.push(`POD: ${pod}`);
          results.push("=".repeat(60) + "\n");
        }

        const logCmd = ["kubectl", "logs", pod, "--namespace", namespace, "--tail", String(tail)];
        if (container) logCmd.push("--container", container);
        if (previous) logCmd.push("--previous");
        
        // Add follow flag with timeout
        logCmd.push("--follow");
        
        try {
          // Run with timeout = actualDuration in milliseconds
          const logResult = runCommand(logCmd, actualDuration * 1000 + 5000); // Add 5s buffer
          let logs = logResult.stdout || "";
          
          // Apply log level filter
          if (levelFilter !== "ALL" && logs) {
            const lines = logs.split("\n");
            const filtered = lines.filter(line => {
              const upperLine = line.toUpperCase();
              switch (levelFilter) {
                case "ERROR":
                  return upperLine.includes("ERROR") || upperLine.includes("FATAL") || upperLine.includes("CRITICAL");
                case "WARN":
                  return upperLine.includes("WARN") || upperLine.includes("WARNING");
                case "INFO":
                  return upperLine.includes("INFO");
                case "DEBUG":
                  return upperLine.includes("DEBUG") || upperLine.includes("TRACE");
                default:
                  return true;
              }
            });
            logs = filtered.join("\n");
          }

          if (!logs.trim()) {
            results.push(`(No logs matching filter '${levelFilter}')`);
          } else {
            results.push(logs);
          }
        } catch (e) {
          // Handle timeout gracefully (SIGTERM from runCommand timeout)
          if (e.message && e.message.includes("timeout") || e.message.includes("SIGTERM")) {
            results.push(`\n... (log collection stopped after ${actualDuration}s)`);
          } else {
            results.push(`\nError collecting logs from ${pod}: ${e.message}`);
          }
        }
      }

      results.push(`\n\n${"=".repeat(60)}`);
      results.push(`Log collection completed at ${new Date().toISOString()}`);
      results.push("=".repeat(60));

      return { content: [{ type: "text", text: results.join("\n") }] };
    })
  );
}
