/**
 * tools/deploy.mjs — MCP tools: deploy_config, deploy_component, deploy_ring
 */

import { z } from "zod";
import { chart, CHART_MAP, REPO_MAP, DEFAULT_NAMESPACE, CV_IMAGE_REGISTRY, CV_IMAGE_NAMESPACE } from "../config.mjs";
import { runCommand, appendSetArg, formatResult, redactCommandForLog, assertNamespaceAllowed } from "../exec.mjs";
import { imageLocationSet, computeImageLocation, splitRepo } from "../image.mjs";
import { tryCatchTool } from "../errors.mjs";

export function registerDeployTools(server) {

  // ── deploy_config ──────────────────────────────────────────────────────────
  server.tool(
    "deploy_config",
    "Deploy the base Commvault configuration (ConfigMap + Secret with cvcreds). Must run before deploying CommServer or other components. Stores admin credentials that components inherit.",
    {
      csHostname:  z.string().describe("CommServer or gateway hostname, e.g. cs.commvault.svc.cluster.local"),
      namespace:   z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
      releaseName: z.string().default("cvconfig").describe("Helm release name"),
      user:        z.string().describe("Admin username REQUIRED for cvcreds Secret"),
      password:    z.string().describe("Admin password REQUIRED for cvcreds Secret"),
      authcode:    z.string().optional().describe("Auth code (alternative to user/password)"),
    },
    (args) => tryCatchTool(() => {
      const { csHostname, namespace, releaseName, user, password, authcode } = args;
      assertNamespaceAllowed(namespace);
      
      // Validate required credentials
      if (!authcode && (!user || !password)) {
        throw new Error(
          "Credentials are REQUIRED for config chart deployment.\n" +
          "The config chart creates the cvcreds Secret that all components inherit.\n" +
          "Please provide either:\n" +
          "  1. Both 'user' and 'password' parameters, OR\n" +
          "  2. An 'authcode' parameter"
        );
      }
      
      const cmd = [
        "helm", "upgrade", "--install", releaseName, chart("config"),
        "--namespace", namespace, "--create-namespace",
      ];
      appendSetArg(cmd, "csOrGatewayHostName", csHostname);
      appendSetArg(cmd, "secret.user", user);
      appendSetArg(cmd, "secret.password", password);
      appendSetArg(cmd, "secret.authcode", authcode);
      const res = runCommand(cmd);
      return { content: [{ type: "text", text: `Command: ${redactCommandForLog(cmd)}\n\n${formatResult(res)}` }] };
    })
  );

  // ── deploy_component ───────────────────────────────────────────────────────
  server.tool(
    "deploy_component",
    "Deploy a single Commvault component. The config chart (cvconfig) must be deployed first - it contains the cvcreds Secret that components inherit.",
    {
      component:       z.enum(Object.keys(CHART_MAP)).describe("Component to deploy"),
      tag:             z.string().describe("Image tag REQUIRED, e.g. 11.42.1"),
      releaseName:     z.string().optional().describe("Helm release name (defaults to component name)"),
      namespace:       z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
      registry:        z.string().optional().describe("Container image registry"),
      imageNamespace:  z.string().optional().describe("Image namespace/sub-path, e.g. image-library"),
      imageRepository: z.string().optional().describe("Image repo name override"),
      storageClass:    z.string().optional().describe("Storage class for PVCs"),
      extraSets:       z.array(z.string()).optional().describe("Additional --set key=value pairs"),
    },
    (args) => tryCatchTool(() => {
      const { component, tag, namespace, imageRepository, storageClass, extraSets } = args;
      const registry      = args.registry      || CV_IMAGE_REGISTRY  || undefined;
      const imageNamespace = args.imageNamespace || CV_IMAGE_NAMESPACE || undefined;
      assertNamespaceAllowed(namespace);
      
      // Check if config chart exists for CommServer deployment
      if (component === 'commserver') {
        try {
          runCommand(["helm", "list", "--namespace", namespace, "--output", "json"]);
          const listRes = runCommand(["helm", "list", "--namespace", namespace, "--output", "json"]);
          const releases = JSON.parse(listRes.stdout);
          const configExists = releases.some(r => r.name === 'cvconfig' && r.status === 'deployed');
          
          if (!configExists) {
            throw new Error(
              "Config chart 'cvconfig' must be deployed before CommServer.\n" +
              "The config chart contains the cvcreds Secret with admin credentials that CommServer inherits.\n" +
              "Run deploy_config first with: deploy_config(csHostname='cs.namespace.svc.cluster.local', user='admin', password='...')"
            );
          }
        } catch (e) {
          if (e.message.includes('must be deployed before')) throw e;
          // Ignore other errors (e.g., helm not installed) and let deployment proceed
        }
      }
      const { dir, defaultName } = CHART_MAP[component];
      const name = args.releaseName || defaultName;

      const cmd = [
        "helm", "upgrade", "--install", name, chart(dir),
        "--namespace", namespace, "--create-namespace",
      ];
      appendSetArg(cmd, "global.image.tag", tag);
      appendSetArg(cmd, "global.image.registry", registry);
      appendSetArg(cmd, "global.image.namespace", imageNamespace);
      const loc = computeImageLocation(registry, imageNamespace, tag, null, imageRepository || REPO_MAP[component], imageRepository);
      appendSetArg(cmd, "image.location", loc);
      appendSetArg(cmd, "global.storageClass.certsandlogs", storageClass);
      for (const s of extraSets || []) cmd.push("--set", s);

      const res = runCommand(cmd);
      return { content: [{ type: "text", text: `Command: ${redactCommandForLog(cmd)}\n\n${formatResult(res)}` }] };
    })
  );

  // ── deploy_ring ────────────────────────────────────────────────────────────
  server.tool(
    "deploy_ring",
    "Deploy a complete Commvault ring: config → CommServer → access nodes → media agents → web server → command center. REQUIRES: tag, username, and password (or authcode).",
    {
      tag:            z.string().describe("Image tag REQUIRED, e.g. 11.42.1 or 11.42.82.Rev1409"),
      namespace:      z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
      user:           z.string().describe("Admin username REQUIRED (unless authcode is provided)"),
      password:       z.string().describe("Admin password REQUIRED (unless authcode is provided)"),
      authcode:       z.string().optional().describe("Auth code (alternative to user/password)"),
      accessNodeCount: z.number().default(2).describe("Number of access nodes"),
      mediaAgentCount: z.number().default(1).describe("Number of media agents"),
      repo:           z.string().optional().describe("Full image path, e.g. registry.io/eng/image-library (splits on last /)"),
      registry:       z.string().optional().describe("Registry (use repo= to pass full path)"),
      imageNamespace: z.string().optional().describe("Image namespace (use repo= to pass full path)"),
      storageClass:   z.string().optional().describe("Storage class for PVCs"),
      deployDdbRole:  z.boolean().default(false).describe("Also deploy DDB backup ClusterRole"),
    },
    (args) => tryCatchTool(() => {
      let { tag, namespace, user, password, authcode, accessNodeCount, mediaAgentCount,
            repo, storageClass, deployDdbRole } = args;
      let registry      = args.registry      || CV_IMAGE_REGISTRY  || undefined;
      let imageNamespace = args.imageNamespace || CV_IMAGE_NAMESPACE || undefined;
      assertNamespaceAllowed(namespace);
      
      // Validate required fields for ring deployment
      if (!tag) {
        throw new Error("Image tag is REQUIRED for ring deployment. Please provide the tag parameter (e.g., 11.42.1)");
      }
      if (!authcode && (!user || !password)) {
        throw new Error("Authentication credentials are REQUIRED. Please provide either:\n  1. Both 'user' and 'password' parameters, OR\n  2. An 'authcode' parameter");
      }

      if (repo) {
        const split = splitRepo(repo);
        registry       = split.registry;
        imageNamespace = split.imageNamespace;
      }

      const results = [];
      const run = (label, cmd) => {
        results.push(`\n--- ${label} ---\n>> ${redactCommandForLog(cmd)}`);
        const res = runCommand(cmd, 180_000);
        results.push(formatResult(res));
        return res.exitCode;
      };

      const helmBase = (name, chartDir) => {
        const cmd = ["helm", "upgrade", "--install", name, chart(chartDir), "--namespace", namespace, "--create-namespace"];
        appendSetArg(cmd, "global.image.tag", tag);
        appendSetArg(cmd, "global.image.registry", registry);
        appendSetArg(cmd, "global.image.namespace", imageNamespace);
        appendSetArg(cmd, "global.storageClass.certsandlogs", storageClass);
        return cmd;
      };

      // 1. Config
      const configCmd = ["helm", "upgrade", "--install", "cvconfig", chart("config"), "--namespace", namespace, "--create-namespace"];
      appendSetArg(configCmd, "csOrGatewayHostName", `cs.${namespace}.svc.cluster.local`);
      appendSetArg(configCmd, "secret.user", user);
      appendSetArg(configCmd, "secret.password", password);
      appendSetArg(configCmd, "secret.authcode", authcode);
      run("Deploy Config", configCmd);

      // 2. DDB role (optional)
      if (deployDdbRole) {
        run("Deploy DDB Role", ["helm", "upgrade", "--install", "cv-ddb-role", chart("cv-ddb-backup-role"), "--namespace", namespace, "--create-namespace"]);
      }

      // 3. CommServer
      const csCmd = helmBase("commserve", "commserve");
      appendSetArg(csCmd, "image.location", imageLocationSet(registry, imageNamespace, REPO_MAP.commserver, tag));
      run("Deploy CommServer", csCmd);

      // 4. Access Nodes
      for (let i = 1; i <= accessNodeCount; i++) {
        const c = helmBase(`accessnode${i}`, "accessnode");
        appendSetArg(c, "image.location", imageLocationSet(registry, imageNamespace, REPO_MAP.accessnode, tag));
        run(`Deploy Access Node ${i}`, c);
      }

      // 5. Media Agents
      for (let i = 1; i <= mediaAgentCount; i++) {
        const c = helmBase(`ma${i}`, "mediaagent");
        appendSetArg(c, "image.location", imageLocationSet(registry, imageNamespace, REPO_MAP.mediaagent, tag));
        run(`Deploy Media Agent ${i}`, c);
      }

      // 6. Web Server
      const wsCmd = helmBase("webserver", "webserver");
      appendSetArg(wsCmd, "image.location", imageLocationSet(registry, imageNamespace, REPO_MAP.webserver, tag));
      run("Deploy Web Server", wsCmd);

      // 7. Command Center
      const ccCmd = helmBase("commandcenter", "commandcenter");
      appendSetArg(ccCmd, "image.location", imageLocationSet(registry, imageNamespace, REPO_MAP.commandcenter, tag));
      run("Deploy Command Center", ccCmd);

      results.push("\n=== Ring deployment complete. Run get_status to monitor pods. ===");
      return { content: [{ type: "text", text: results.join("\n") }] };
    })
  );
}
