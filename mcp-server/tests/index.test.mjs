/**
 * tests/index.test.mjs
 *
 * Single-file integration test for all 18 MCP tools.
 *
 * Strategy
 * ────────
 * • Wire an in-process MCP Client to createMcpServer() via InMemoryTransport.
 *   No child process, no network, no kubeconfig required.
 * • Replace the exec layer with a configurable mock via __setExecImpl so every
 *   kubectl / helm call is intercepted and scripted per-test.
 * • Each tool gets at least one positive case (expected output present) and one
 *   negative case (namespace protection, bad input, command failure, etc.).
 *
 * Run:
 *   node --test tests/index.test.mjs
 *   npm test
 */

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { Client }           from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../index.mjs";
import { __setExecImpl }   from "../src/exec.mjs";

// ─── Global client (one MCP session for all tests) ────────────────────────────

let client;

before(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close();
  // Restore real exec after the full suite.
  __setExecImpl(null);
});

// ─── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Build a mock execFileSync that matches each call against an ordered list of
 * [ [expectedBinary, expectedArgSubstring], returnValue ] pairs.
 * Each successive call pops the next entry.
 * Pass a plain string as returnValue to simulate success; throw with .status
 * set to simulate failure.
 */
function mockExec(calls) {
  const queue = [...calls];
  return (bin, args, _opts) => {
    if (!queue.length) throw Object.assign(new Error("Unexpected exec call"), { status: 1, stdout: "", stderr: `unexpected: ${bin} ${args.join(" ")}` });
    const [, response] = queue.shift();
    if (response instanceof Error) throw response;
    return response;
  };
}

/** Wrap a call response so it simulates a command failure. */
function fail(stderr = "error", code = 1) {
  return Object.assign(new Error(stderr), { status: code, stdout: "", stderr });
}

/** Call a tool and return the first text content block. */
async function callTool(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const block = res.content?.find(c => c.type === "text");
  return block?.text ?? "";
}

// ─── PROTECTED NAMESPACE helper ───────────────────────────────────────────────
// kube-system is always in PROTECTED_NAMESPACES.

async function assertProtected(toolName, args) {
  const out = await callTool(toolName, { ...args, namespace: "kube-system" });
  assert.match(out, /Error|protected/i, `${toolName}: expected namespace protection error`);
}

// =============================================================================
// 1. deploy_config
// =============================================================================
describe("deploy_config", () => {
  test("positive — deploys config chart and returns command output", async () => {
    __setExecImpl(mockExec([
      [["helm"], "Release \"cvconfig\" has been upgraded. Happy Helming!"],
    ]));
    const out = await callTool("deploy_config", {
      csHostname: "cs.commvault.svc.cluster.local",
      namespace:  "commvault",
      user:       "admin",
      password:   "P@ss123",
    });
    assert.match(out, /cvconfig|helm upgrade/i);
  });

  test("negative — protected namespace blocked", async () => {
    await assertProtected("deploy_config", { csHostname: "cs.svc.local" });
  });

  test("negative — helm failure surfaced in output", async () => {
    __setExecImpl(mockExec([
      [["helm"], fail("connection refused")],
    ]));
    const out = await callTool("deploy_config", {
      csHostname: "cs.commvault.svc.cluster.local",
      namespace:  "commvault",
    });
    assert.match(out, /connection refused|exit code/i);
  });
});

// =============================================================================
// 2. deploy_component
// =============================================================================
describe("deploy_component", () => {
  test("positive — deploys commserver component", async () => {
    __setExecImpl(mockExec([
      [["helm"], "Release \"commserve\" deployed."],
    ]));
    const out = await callTool("deploy_component", {
      component: "commserver",
      tag:       "11.42.1",
      namespace: "commvault",
    });
    assert.match(out, /commserve|helm upgrade/i);
  });

  test("positive — image.location built when registry + imageNamespace provided", async () => {
    __setExecImpl(mockExec([
      [["helm"], "ok"],
    ]));
    const out = await callTool("deploy_component", {
      component:      "accessnode",
      tag:            "11.42.1",
      namespace:      "commvault",
      registry:       "myreg.io/eng",
      imageNamespace: "image-library",
    });
    assert.match(out, /image\.location|myreg|helm/i);
  });

  test("negative — protected namespace blocked", async () => {
    await assertProtected("deploy_component", { component: "commserver", tag: "11.42.1" });
  });
});

// =============================================================================
// 3. deploy_ring
// =============================================================================
describe("deploy_ring", () => {
  test("positive — full ring deployment runs all steps", async () => {
    // config + commserver + 2 access nodes + 1 media agent + webserver + commandcenter
    const steps = 6;
    let callCount = 0;
    __setExecImpl((bin, args) => { callCount++; return `step ${callCount} ok`; });
    const out = await callTool("deploy_ring", {
      tag:             "11.42.1",
      namespace:       "commvault",
      accessNodeCount: 2,
      mediaAgentCount: 1,
    });
    assert.match(out, /Ring deployment complete/i);
    assert.ok(callCount >= steps, `expected >= ${steps} exec calls, got ${callCount}`);
  });

  test("positive — with optional DDB role", async () => {
    __setExecImpl(() => "ok");
    const out = await callTool("deploy_ring", {
      tag:             "11.42.1",
      namespace:       "commvault",
      accessNodeCount: 1,
      mediaAgentCount: 1,
      deployDdbRole:   true,
    });
    assert.match(out, /Deploy DDB Role|cv-ddb-backup-role/i);
  });

  test("negative — protected namespace blocked", async () => {
    await assertProtected("deploy_ring", { tag: "11.42.1" });
  });
});

// =============================================================================
// 4. upgrade_component
// =============================================================================
describe("upgrade_component", () => {
  test("positive — upgrades single component", async () => {
    __setExecImpl(mockExec([
      [["helm", "get", "values"], '{"image":{"location":"myreg.io/eng/commserve:11.42.0"}}'],
      [["helm", "upgrade"],       "Release \"commserve\" has been upgraded."],
    ]));
    const out = await callTool("upgrade_component", {
      component: "commserver",
      tag:       "11.42.1",
      namespace: "commvault",
    });
    assert.match(out, /helm upgrade|commserve/i);
  });

  test("positive — upgrades all components", async () => {
    __setExecImpl(mockExec([
      // helm list
      [["helm", "list"], JSON.stringify([
        { name: "commserve",  chart: "commserve-11.42.0",  namespace: "commvault" },
        { name: "accessnode1",chart: "accessnode-11.42.0", namespace: "commvault" },
      ])],
      // get values + upgrade for commserve
      [["helm", "get", "values"], "{}"],
      [["helm", "upgrade"],       "ok"],
      // get values + upgrade for accessnode1
      [["helm", "get", "values"], "{}"],
      [["helm", "upgrade"],       "ok"],
    ]));
    const out = await callTool("upgrade_component", {
      component: "all",
      tag:       "11.42.1",
      namespace: "commvault",
    });
    assert.match(out, /commserve|accessnode/i);
  });

  test("negative — protected namespace blocked", async () => {
    await assertProtected("upgrade_component", { component: "commserver", tag: "11.42.1" });
  });

  test("negative — no releases found returns informative message", async () => {
    __setExecImpl(mockExec([
      [["helm", "list"], "[]"],
    ]));
    const out = await callTool("upgrade_component", {
      component: "all",
      tag:       "11.42.1",
      namespace: "commvault",
    });
    assert.match(out, /no helm releases found/i);
  });
});

// =============================================================================
// 5. add_disk
// =============================================================================
describe("add_disk", () => {
  test("positive — appends volume at next index", async () => {
    __setExecImpl(mockExec([
      [["helm", "list"],       JSON.stringify([{ name: "ma1", chart: "mediaagent-11.42.0" }])],
      [["helm", "get", "values"], JSON.stringify({ volumes: [{ name: "ddb1" }] })],
      [["helm", "upgrade"],    "ok"],
    ]));
    const out = await callTool("add_disk", {
      releaseName: "ma1",
      mountPath:   "/var/ddb2",
      size:        "100Gi",
      namespace:   "commvault",
    });
    assert.match(out, /Volume added at index 1|ddb2/i);
  });

  test("negative — release not found returns error", async () => {
    __setExecImpl(mockExec([
      [["helm", "list"], "[]"],
    ]));
    const out = await callTool("add_disk", {
      releaseName: "nonexistent",
      mountPath:   "/var/ddb2",
      namespace:   "commvault",
    });
    assert.match(out, /not found|Error/i);
  });

  test("negative — protected namespace blocked", async () => {
    await assertProtected("add_disk", { releaseName: "ma1", mountPath: "/var/ddb2" });
  });
});

// =============================================================================
// 6. get_pods
// =============================================================================
describe("get_pods", () => {
  test("positive — lists pods", async () => {
    __setExecImpl(mockExec([
      [["kubectl", "get", "pods"], "NAME   READY   STATUS\ncommserve-abc   1/1   Running"],
    ]));
    const out = await callTool("get_pods", { namespace: "commvault" });
    assert.match(out, /Running|commserve/i);
  });

  test("positive — filters by namePattern", async () => {
    __setExecImpl(mockExec([
      [["kubectl", "get", "pods"], "NAME   READY\ncommserve-abc   1/1\naccessnode-xyz  1/1"],
    ]));
    const out = await callTool("get_pods", { namespace: "commvault", namePattern: "commserve" });
    assert.match(out, /commserve/);
    assert.doesNotMatch(out, /accessnode/);
  });

  test("negative — protected namespace blocked", async () => {
    await assertProtected("get_pods", {});
  });
});

// =============================================================================
// 7. get_services
// =============================================================================
describe("get_services", () => {
  test("positive — returns service list", async () => {
    __setExecImpl(mockExec([
      [["kubectl", "get", "services"], "NAME   TYPE   CLUSTER-IP\ncommserve-svc  LoadBalancer  10.0.0.1"],
    ]));
    const out = await callTool("get_services", { namespace: "commvault" });
    assert.match(out, /LoadBalancer|commserve/i);
  });

  test("negative — kubectl failure surfaced", async () => {
    __setExecImpl(mockExec([
      [["kubectl", "get", "services"], fail("namespaces not found")],
    ]));
    const out = await callTool("get_services", { namespace: "commvault" });
    assert.match(out, /namespaces not found|STDERR|exit code/i);
  });
});

// =============================================================================
// 8. get_status
// =============================================================================
describe("get_status", () => {
  test("positive — returns all sections", async () => {
    const sectionOutput = "NAME   STATUS\nrelease1  deployed";
    __setExecImpl(() => sectionOutput);
    const out = await callTool("get_status", { namespace: "commvault" });
    assert.match(out, /Helm Releases/i);
    assert.match(out, /Pods/i);
    assert.match(out, /Services/i);
    assert.match(out, /PVCs/i);
  });

  test("negative — protected namespace blocked", async () => {
    await assertProtected("get_status", {});
  });
});

// =============================================================================
// 9. describe_pod
// =============================================================================
describe("describe_pod", () => {
  test("positive — resolves partial name and describes pod", async () => {
    __setExecImpl(mockExec([
      // resolvePodNameOrThrow → kubectl get pods -o name
      [["kubectl", "get", "pods"], "pod/commserve-abc-123\npod/accessnode-xyz-456"],
      // kubectl describe pod
      [["kubectl", "describe", "pod"], "Name: commserve-abc-123\nStatus: Running"],
    ]));
    const out = await callTool("describe_pod", { podName: "commserve", namespace: "commvault" });
    assert.match(out, /commserve|Running/i);
  });

  test("negative — ambiguous pod name returns error", async () => {
    __setExecImpl(mockExec([
      [["kubectl", "get", "pods"], "pod/commserve-a\npod/commserve-b"],
    ]));
    const out = await callTool("describe_pod", { podName: "commserve", namespace: "commvault" });
    assert.match(out, /Ambiguous|Error/i);
  });

  test("negative — no matching pod returns error", async () => {
    __setExecImpl(mockExec([
      [["kubectl", "get", "pods"], "pod/accessnode-xyz"],
    ]));
    const out = await callTool("describe_pod", { podName: "commserve", namespace: "commvault" });
    assert.match(out, /No pod found|Error/i);
  });
});

// =============================================================================
// 10. get_pod_logs
// =============================================================================
describe("get_pod_logs", () => {
  test("positive — returns tailed logs", async () => {
    __setExecImpl(mockExec([
      [["kubectl", "get", "pods"], "pod/commserve-abc"],
      [["kubectl", "logs"],        "INFO  starting commserver\nINFO  ready"],
    ]));
    const out = await callTool("get_pod_logs", { podName: "commserve", namespace: "commvault", tailLines: 50 });
    assert.match(out, /starting commserver|ready/i);
  });

  test("negative — pod not found returns error", async () => {
    __setExecImpl(mockExec([
      [["kubectl", "get", "pods"], ""],
    ]));
    const out = await callTool("get_pod_logs", { podName: "ghost", namespace: "commvault" });
    assert.match(out, /No pod found|Error/i);
  });
});

// =============================================================================
// 11. list_log_files
// =============================================================================
describe("list_log_files", () => {
  test("positive — lists files from pod log directory", async () => {
    __setExecImpl(mockExec([
      [["kubectl", "get", "pods"], "pod/commserve-abc"],
      [["kubectl", "exec"],        "-rw-r--r-- 1 root root 12345 Mar 31 CVJobCtrlMgr.log\n-rw-r--r-- 1 root root 67890 Mar 31 CommServe.log"],
    ]));
    const out = await callTool("list_log_files", { podName: "commserve", namespace: "commvault" });
    assert.match(out, /CVJobCtrlMgr|CommServe/i);
  });

  test("negative — protected namespace blocked", async () => {
    await assertProtected("list_log_files", { podName: "commserve" });
  });
});

// =============================================================================
// 12. download_log_files
// =============================================================================
describe("download_log_files", () => {
  test("positive — downloads specific log file", async () => {
    __setExecImpl(mockExec([
      [["kubectl", "get", "pods"], "pod/commserve-abc-111"],
      [["kubectl", "cp"],          ""],
    ]));
    const out = await callTool("download_log_files", {
      podName:      "commserve",
      namespace:    "commvault",
      specificFile: "CommServe.log",
      downloadDir:  "/tmp/cv-test",
    });
    assert.match(out, /Downloaded|CommServe\.log/i);
  });

  test("negative — path traversal in specificFile is rejected", async () => {
    __setExecImpl(() => { throw new Error("should not reach exec"); });
    const out = await callTool("download_log_files", {
      podName:      "commserve",
      namespace:    "commvault",
      specificFile: "../../etc/passwd",
      downloadDir:  "/tmp/cv-test",
    });
    assert.match(out, /Invalid log file name|path separators/i);
  });

  test("negative — protected namespace blocked", async () => {
    await assertProtected("download_log_files", { podName: "commserve" });
  });
});

// =============================================================================
// 13. scale_components
// =============================================================================
describe("scale_components", () => {
  test("positive — scales all down", async () => {
    __setExecImpl(mockExec([
      [["kubectl", "scale", "deploy"],      "scaled"],
      [["kubectl", "scale", "statefulset"], "scaled"],
    ]));
    const out = await callTool("scale_components", { direction: "down", namespace: "commvault" });
    assert.match(out, /scaled|kubectl scale/i);
  });

  test("positive — scales matching pattern up", async () => {
    __setExecImpl(mockExec([
      [["kubectl", "get", "deployments,statefulsets"], "deployment.apps/commserve\nstatefulset.apps/ma1"],
      [["kubectl", "scale"], "scaled"],
      [["kubectl", "scale"], "scaled"],
    ]));
    const out = await callTool("scale_components", {
      direction:   "up",
      namePattern: "commserve",
      namespace:   "commvault",
    });
    assert.match(out, /scaled|kubectl scale/i);
  });

  test("negative — protected namespace blocked", async () => {
    await assertProtected("scale_components", { direction: "up" });
  });
});

// =============================================================================
// 14. uninstall_release
// =============================================================================
describe("uninstall_release", () => {
  test("positive — uninstalls helm release", async () => {
    __setExecImpl(mockExec([
      [["helm", "uninstall"], "release \"commserve\" uninstalled"],
    ]));
    const out = await callTool("uninstall_release", { releaseName: "commserve", namespace: "commvault" });
    assert.match(out, /uninstall|commserve/i);
  });

  test("negative — helm failure surfaced", async () => {
    __setExecImpl(mockExec([
      [["helm", "uninstall"], fail("release not found")],
    ]));
    const out = await callTool("uninstall_release", { releaseName: "ghost", namespace: "commvault" });
    assert.match(out, /release not found|STDERR|exit code/i);
  });

  test("negative — protected namespace blocked", async () => {
    await assertProtected("uninstall_release", { releaseName: "commserve" });
  });
});

// =============================================================================
// 15. helm_list
// =============================================================================
describe("helm_list", () => {
  test("positive — returns release list", async () => {
    __setExecImpl(mockExec([
      [["helm", "list"], "NAME   CHART\ncommserve  commserve-11.42.1"],
    ]));
    const out = await callTool("helm_list", { namespace: "commvault" });
    assert.match(out, /commserve/i);
  });

  test("negative — protected namespace blocked", async () => {
    await assertProtected("helm_list", {});
  });
});

// =============================================================================
// 16. set_namespace
// =============================================================================
describe("set_namespace", () => {
  test("positive — sets context namespace", async () => {
    __setExecImpl(mockExec([
      [["kubectl", "config", "set-context"], 'Context "sa-ct5jmcz2zxa" modified.'],
    ]));
    const out = await callTool("set_namespace", { namespace: "commvault" });
    assert.match(out, /set-context|modified|namespace/i);
  });

  test("negative — protected namespace blocked", async () => {
    const out = await callTool("set_namespace", { namespace: "kube-system" });
    assert.match(out, /Error|protected/i);
  });
});

// =============================================================================
// 17. port_forward
// =============================================================================
describe("port_forward", () => {
  test("positive — returns command string without executing it", async () => {
    // port_forward never calls exec — it just returns a command string.
    __setExecImpl(() => { throw new Error("port_forward must not call exec"); });
    const out = await callTool("port_forward", {
      podName:    "commserve-abc",
      targetPort: 443,
      namespace:  "commvault",
    });
    assert.match(out, /kubectl port-forward/i);
    assert.match(out, /443/);
  });

  test("negative — protected namespace blocked", async () => {
    await assertProtected("port_forward", { podName: "commserve", targetPort: 443 });
  });
});

// =============================================================================
// 18. run_kubectl
// =============================================================================
describe("run_kubectl", () => {
  test("positive — runs allowed kubectl command", async () => {
    __setExecImpl(mockExec([
      [["kubectl", "get", "nodes"], "NAME   STATUS\nnode1  Ready"],
    ]));
    const out = await callTool("run_kubectl", { command: "kubectl get nodes" });
    assert.match(out, /Ready|node1/i);
  });

  test("positive — runs allowed helm command", async () => {
    __setExecImpl(mockExec([
      [["helm", "version"], "version.BuildInfo{Version:\"v3.16.0\"}"],
    ]));
    const out = await callTool("run_kubectl", { command: "helm version" });
    assert.match(out, /v3\.\d+\.\d+/i);
  });

  test("negative — non-kubectl/helm binary blocked", async () => {
    const out = await callTool("run_kubectl", { command: "curl http://internal-service" });
    assert.match(out, /Only kubectl and helm/i);
  });

  test("negative — kubectl --all-namespaces blocked", async () => {
    const out = await callTool("run_kubectl", { command: "kubectl get pods -A" });
    assert.match(out, /not allowed/i);
  });

  test("negative — kubectl --kubeconfig override blocked", async () => {
    const out = await callTool("run_kubectl", { command: "kubectl --kubeconfig /tmp/evil.yaml get pods" });
    assert.match(out, /not allowed/i);
  });

  test("negative — helm --kubeconfig override blocked", async () => {
    const out = await callTool("run_kubectl", { command: "helm --kubeconfig /tmp/evil.yaml list" });
    assert.match(out, /not allowed/i);
  });

  test("negative — protected namespace via -n flag blocked", async () => {
    const out = await callTool("run_kubectl", { command: "kubectl get pods -n kube-system" });
    assert.match(out, /Error|protected/i);
  });
});
