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
    "Deploy the base Commvault configuration (ConfigMap + Secret with cvcreds). Must run before CommServer or other components. Stores credentials and the CS hostname that all components inherit.",
    {
      csHostname:            z.string().describe("CommServer or gateway hostname stored in CV_CSHOSTNAME, e.g. commserve.mynamespace.svc.cluster.local"),
      namespace:             z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
      releaseName:           z.string().optional().describe("Helm release name (defaults to '<prefix>config' or 'cvconfig')"),
      user:                  z.string().describe("Admin username REQUIRED for cvcreds Secret"),
      password:              z.string().describe("Admin password REQUIRED for cvcreds Secret"),
      authcode:              z.string().optional().describe("Auth code (alternative to user/password)"),
      prefix:                z.string().optional().describe("Global prefix for all release/resource names when running multiple CommCells in one namespace, e.g. 'k8-service1-'"),
      suffix:                z.string().optional().describe("Global suffix appended to all resource names (global.suffix)"),
      csClientName:          z.string().optional().describe("CommServer client name written to CV_CSCLIENTNAME in the ConfigMap. Use when components must identify the CS by client name rather than hostname."),
      imagePullSecret:       z.string().optional().describe("Name of an existing image pull secret used by all Commvault components (global.image.pullSecret)"),
      pullsecretCreate:      z.boolean().optional().describe("Create an image pull secret as part of this config deployment (pullsecret.create=true). Requires pullsecretName, pullsecretUsername, pullsecretPassword."),
      pullsecretName:        z.string().optional().describe("Name for the pull secret to create (pullsecret.name)"),
      pullsecretRegistry:    z.string().optional().describe("Registry host for the pull secret, default docker.io (pullsecret.registry)"),
      pullsecretUsername:    z.string().optional().describe("Registry username for the pull secret (pullsecret.username)"),
      pullsecretPassword:    z.string().optional().describe("Registry password or token for the pull secret (pullsecret.password)"),
      ccCertificatePath:     z.string().optional().describe("Path to the Command Center TLS certificate file on the MCP server pod, e.g. /certs/testlab.pfx (secret.CCCertificate via --set-file)"),
      ccCertificatePassword: z.string().optional().describe("Password for the Command Center TLS certificate (secret.CCCertificatePassword)"),
    },
    (args) => tryCatchTool(() => {
      const { csHostname, namespace, user, password, authcode, prefix, suffix, csClientName,
              imagePullSecret, pullsecretCreate, pullsecretName, pullsecretRegistry,
              pullsecretUsername, pullsecretPassword, ccCertificatePath, ccCertificatePassword } = args;
      assertNamespaceAllowed(namespace);

      if (!authcode && (!user || !password)) {
        throw new Error(
          "Credentials are REQUIRED for config chart deployment.\n" +
          "Please provide either:\n" +
          "  1. Both 'user' and 'password', OR\n" +
          "  2. An 'authcode'"
        );
      }

      const releaseName = args.releaseName || (prefix ? `${prefix}config` : "cvconfig");
      const cmd = [
        "helm", "upgrade", "--install", releaseName, chart("config"),
        "--namespace", namespace, "--create-namespace",
      ];
      appendSetArg(cmd, "csOrGatewayHostName", csHostname);
      appendSetArg(cmd, "secret.user", user);
      appendSetArg(cmd, "secret.password", password);
      appendSetArg(cmd, "secret.authcode", authcode);
      appendSetArg(cmd, "global.prefix", prefix);
      appendSetArg(cmd, "global.suffix", suffix);
      appendSetArg(cmd, "csClientName", csClientName);
      appendSetArg(cmd, "global.image.pullSecret", imagePullSecret);
      if (pullsecretCreate) appendSetArg(cmd, "pullsecret.create", "true");
      appendSetArg(cmd, "pullsecret.name",     pullsecretName);
      appendSetArg(cmd, "pullsecret.registry", pullsecretRegistry);
      appendSetArg(cmd, "pullsecret.username", pullsecretUsername);
      appendSetArg(cmd, "pullsecret.password", pullsecretPassword);
      if (ccCertificatePath) cmd.push("--set-file", `secret.CCCertificate=${ccCertificatePath}`);
      appendSetArg(cmd, "secret.CCCertificatePassword", ccCertificatePassword);
      const res = runCommand(cmd);
      return { content: [{ type: "text", text: `Command: ${redactCommandForLog(cmd)}\n\n${formatResult(res)}` }] };
    })
  );

  // ── deploy_component ───────────────────────────────────────────────────────
  server.tool(
    "deploy_component",
    "Deploy a single Commvault component. The config chart must be deployed first unless csHostname is supplied directly. Supports prefix for multi-CommCell namespaces.",
    {
      component:       z.enum(Object.keys(CHART_MAP)).describe("Component to deploy"),
      tag:             z.string().describe("Image tag REQUIRED, e.g. 11.42.1 or registry.example.com/ns/repo:11.42.1 (use image.location format)"),
      releaseName:     z.string().optional().describe("Helm release name override (defaults to '<prefix><defaultName>')"),
      namespace:       z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
      registry:        z.string().optional().describe("Container image registry, e.g. registry.testlab.commvault.com/eng-public"),
      imageNamespace:  z.string().optional().describe("Image namespace/sub-path within registry, e.g. image-library"),
      imageRepository: z.string().optional().describe("Image repository name override, e.g. commserve"),
      storageClass:    z.string().optional().describe("Default storage class for certsandlogs PVC (global.storageClass.certsandlogs)"),
      prefix:          z.string().optional().describe("Global prefix for all release/resource names for multi-CommCell namespaces, e.g. 'k8-service1-'"),
      suffix:          z.string().optional().describe("Global suffix appended to all resource names (global.suffix)"),
      clientName:      z.string().optional().describe("Commvault client name, e.g. 'cs1', 'ma1', 'ws'. When prefix is set and clientName is omitted, automatically derived from the component default name to prevent double-prefix in K8s resource names."),
      displayname:     z.string().optional().describe("Client display name shown in CommCell Console (displayname). Defaults to clientName."),
      csHostname:      z.string().optional().describe("CommServer internal service hostname, e.g. commserve.dyadav.svc.cluster.local (csOrGatewayHostName). Overrides the value from the config ConfigMap."),
      clusterDomain:   z.string().optional().describe("Kubernetes cluster domain suffix (global.clusterDomain). Default: svc.cluster.local. Only needed for non-standard clusters."),
      imagePullSecret: z.string().optional().describe("Name of an existing image pull secret (global.image.pullSecret)"),
      // Resource requests and limits
      memoryRequest:   z.string().optional().describe("Pod memory request, e.g. '4Gi' (resources.requests.memory)"),
      cpuRequest:      z.string().optional().describe("Pod CPU request, e.g. '500m' (resources.requests.cpu)"),
      memoryLimit:     z.string().optional().describe("Pod memory limit, e.g. '16Gi' (resources.limits.memory)"),
      cpuLimit:        z.string().optional().describe("Pod CPU limit, e.g. '2' (resources.limits.cpu)"),
      // CommServer-specific
      email:                     z.string().optional().describe("[commserver] Email of the first admin user (email)"),
      sqlSaPassword:             z.string().optional().describe("[commserver] SQL Server SA password (secret.sa_password)"),
      serviceType:               z.string().optional().describe("[commserver|webserver] Service type for external-facing service: LoadBalancer (CS default), ClusterIP, NodePort"),
      cvfwdport:                 z.number().optional().describe("[all] Override the Commvault firewall daemon port, default 8403 (cvfwdport)"),
      storageClassCsDb:          z.string().optional().describe("[commserver] Storage class for CommServe database PVC (storageClass.csdb)"),
      storageClassCsDbSize:      z.string().optional().describe("[commserver] Size for CommServe database PVC, default 100Gi (storageClass.csdb_size)"),
      storageClassDrBackups:     z.string().optional().describe("[commserver] Storage class for DR backup PVC (storageClass.drbackups)"),
      storageClassDrBackupsSize: z.string().optional().describe("[commserver] Size for DR backup PVC, default 50Gi (storageClass.drbackups_size)"),
      storageClassMedia:         z.string().optional().describe("[commserver] Storage class for media PVC (storageClass.cvmedia)"),
      storageClassMediaSize:     z.string().optional().describe("[commserver] Size for media PVC, default 100Gi (storageClass.cvmedia_size)"),
      // MediaAgent / AccessNode
      storageClassJobResults:     z.string().optional().describe("[mediaagent|accessnode] Storage class for job results PVC (storageClass.jobresults)"),
      storageClassJobResultsSize: z.string().optional().describe("[mediaagent|accessnode] Size for job results PVC, default 20Gi (storageClass.jobresults_size)"),
      // MediaAgent only
      storageClassIndexCache:     z.string().optional().describe("[mediaagent] Storage class for index cache PVC (storageClass.indexcache)"),
      storageClassIndexCacheSize: z.string().optional().describe("[mediaagent] Size for index cache PVC, default 20Gi (storageClass.indexcache_size)"),
      storageClassDdb:            z.string().optional().describe("[mediaagent] Storage class for deduplication database PVC (storageClass.ddb)"),
      storageClassDdbSize:        z.string().optional().describe("[mediaagent] Size for DDB PVC, default 50Gi (storageClass.ddb_size)"),
      // WebServer only
      storageClassCache:     z.string().optional().describe("[webserver] Storage class for upload/download cache PVC (storageClass.cache)"),
      storageClassCacheSize: z.string().optional().describe("[webserver] Size for cache PVC, default 10Gi (storageClass.cache_size)"),
      // CommandCenter only
      httpPort:       z.number().optional().describe("[commandcenter] HTTP port on the CommandCenter service, default 80 (httpPort)"),
      httpsPort:      z.number().optional().describe("[commandcenter] HTTPS port on the CommandCenter service, default 443 (httpsPort)"),
      clientHostName: z.string().optional().describe("[commandcenter] External FQDN for Command Center, max 62 chars, e.g. cc.testlab.commvault.com (clientHostName)"),
      webserverName:  z.string().optional().describe("[commandcenter] WebServer client name to connect to (webserverName)"),
      extraSets:      z.array(z.string()).optional().describe("Additional --set key=value pairs for any other chart value"),
    },
    (args) => tryCatchTool(() => {
      const { component, tag, namespace, imageRepository, storageClass, extraSets,
              prefix, suffix, csHostname, sqlSaPassword, clientHostName, webserverName,
              displayname, imagePullSecret, clusterDomain, email, serviceType, cvfwdport,
              memoryRequest, cpuRequest, memoryLimit, cpuLimit,
              storageClassCsDb, storageClassCsDbSize, storageClassDrBackups, storageClassDrBackupsSize,
              storageClassMedia, storageClassMediaSize,
              storageClassJobResults, storageClassJobResultsSize,
              storageClassIndexCache, storageClassIndexCacheSize,
              storageClassDdb, storageClassDdbSize,
              storageClassCache, storageClassCacheSize,
              httpPort, httpsPort } = args;
      const registry       = args.registry      || CV_IMAGE_REGISTRY  || undefined;
      const imageNamespace = args.imageNamespace || CV_IMAGE_NAMESPACE || undefined;
      assertNamespaceAllowed(namespace);

      if (component === "commandcenter" && clientHostName && clientHostName.length > 62) {
        throw new Error(
          `clientHostName "${clientHostName}" is ${clientHostName.length} characters long.\n` +
          "Kubernetes requires it to be ≤ 62 characters. Please use a shorter hostname."
        );
      }

      if (component === "commserver" && !csHostname) {
        try {
          const listRes = runCommand(["helm", "list", "--namespace", namespace, "--output", "json"]);
          const releases = JSON.parse(listRes.stdout);
          const expectedName = prefix ? `${prefix}config` : "cvconfig";
          const configExists = releases.some(
            r => (r.name === expectedName || r.chart?.startsWith("config-")) && r.status === "deployed"
          );
          if (!configExists) {
            const relHint = prefix ? `${prefix}config` : "cvconfig";
            throw new Error(
              `Config chart '${relHint}' must be deployed before CommServer.\n` +
              "The config chart contains the cvcreds Secret that CommServer inherits.\n" +
              `Run deploy_config first${prefix ? ` with prefix='${prefix}'` : ""}.`
            );
          }
        } catch (e) {
          if (e.message.includes("must be deployed before")) throw e;
        }
      }

      const { dir, defaultName } = CHART_MAP[component];
      const name = args.releaseName || (prefix ? `${prefix}${defaultName}` : defaultName);

      // When prefix is set and no explicit clientName is given, auto-derive clientName from defaultName
      // to prevent double-prefix in K8s resource names. The chart template computes:
      //   metadataname = global.prefix + clientName (if set) OR global.prefix + Release.Name
      // Without this: prefix="k8-" + Release.Name="k8-commserve" → resource="k8-k8-commserve" (wrong)
      // With this:    prefix="k8-" + clientName="commserve"     → resource="k8-commserve"     (correct)
      const effectiveClientName = args.clientName || (prefix ? defaultName : undefined);

      const cmd = [
        "helm", "upgrade", "--install", name, chart(dir),
        "--namespace", namespace, "--create-namespace",
      ];
      appendSetArg(cmd, "global.image.tag", tag);
      appendSetArg(cmd, "global.image.registry", registry);
      appendSetArg(cmd, "global.image.namespace", imageNamespace);
      appendSetArg(cmd, "global.image.pullSecret", imagePullSecret);
      const loc = computeImageLocation(registry, imageNamespace, tag, null, imageRepository || REPO_MAP[component], imageRepository);
      appendSetArg(cmd, "image.location", loc);
      appendSetArg(cmd, "global.storageClass.certsandlogs", storageClass);
      appendSetArg(cmd, "global.prefix", prefix);
      appendSetArg(cmd, "global.suffix", suffix);
      appendSetArg(cmd, "global.clusterDomain", clusterDomain);
      appendSetArg(cmd, "clientName", effectiveClientName);
      appendSetArg(cmd, "displayname", displayname);
      appendSetArg(cmd, "csOrGatewayHostName", csHostname);
      if (cvfwdport !== undefined) appendSetArg(cmd, "cvfwdport", String(cvfwdport));
      // Resource requests / limits
      appendSetArg(cmd, "resources.requests.memory", memoryRequest);
      appendSetArg(cmd, "resources.requests.cpu",    cpuRequest);
      appendSetArg(cmd, "resources.limits.memory",   memoryLimit);
      appendSetArg(cmd, "resources.limits.cpu",      cpuLimit);
      // CommServer-specific
      if (component === "commserver") {
        appendSetArg(cmd, "email",                       email);
        appendSetArg(cmd, "secret.sa_password",          sqlSaPassword);
        appendSetArg(cmd, "serviceType",                 serviceType);
        appendSetArg(cmd, "storageClass.csdb",           storageClassCsDb);
        appendSetArg(cmd, "storageClass.csdb_size",      storageClassCsDbSize);
        appendSetArg(cmd, "storageClass.drbackups",      storageClassDrBackups);
        appendSetArg(cmd, "storageClass.drbackups_size", storageClassDrBackupsSize);
        appendSetArg(cmd, "storageClass.cvmedia",        storageClassMedia);
        appendSetArg(cmd, "storageClass.cvmedia_size",   storageClassMediaSize);
      }
      // MediaAgent and AccessNode shared storage
      if (component === "mediaagent" || component === "accessnode") {
        appendSetArg(cmd, "storageClass.jobresults",      storageClassJobResults);
        appendSetArg(cmd, "storageClass.jobresults_size", storageClassJobResultsSize);
      }
      // MediaAgent-only storage
      if (component === "mediaagent") {
        appendSetArg(cmd, "storageClass.indexcache",      storageClassIndexCache);
        appendSetArg(cmd, "storageClass.indexcache_size", storageClassIndexCacheSize);
        appendSetArg(cmd, "storageClass.ddb",             storageClassDdb);
        appendSetArg(cmd, "storageClass.ddb_size",        storageClassDdbSize);
      }
      // WebServer-specific
      if (component === "webserver") {
        appendSetArg(cmd, "serviceType",              serviceType);
        appendSetArg(cmd, "storageClass.cache",       storageClassCache);
        appendSetArg(cmd, "storageClass.cache_size",  storageClassCacheSize);
      }
      // CommandCenter-specific
      if (component === "commandcenter") {
        appendSetArg(cmd, "clientHostName", clientHostName);
        appendSetArg(cmd, "webserverName",  webserverName);
        if (httpPort  !== undefined) appendSetArg(cmd, "httpPort",  String(httpPort));
        if (httpsPort !== undefined) appendSetArg(cmd, "httpsPort", String(httpsPort));
      }
      for (const s of extraSets || []) cmd.push("--set", s);

      const res = runCommand(cmd);
      return { content: [{ type: "text", text: `Command: ${redactCommandForLog(cmd)}\n\n${formatResult(res)}` }] };
    })
  );

  // ── deploy_ring ────────────────────────────────────────────────────────────
  server.tool(
    "deploy_ring",
    "Deploy a complete Commvault ring: config → CommServer → access nodes → media agents → web server → command center. REQUIRES: tag, username, and password (or authcode). Use prefix for multi-CommCell namespaces.",
    {
      tag:                   z.string().describe("Image tag REQUIRED, e.g. 11.42.1 or 11.42.82.Rev1409"),
      namespace:             z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
      user:                  z.string().describe("Admin username REQUIRED (unless authcode is provided)"),
      password:              z.string().describe("Admin password REQUIRED (unless authcode is provided)"),
      authcode:              z.string().optional().describe("Auth code (alternative to user/password)"),
      accessNodeCount:       z.number().default(2).describe("Number of access nodes"),
      mediaAgentCount:       z.number().default(1).describe("Number of media agents"),
      repo:                  z.string().optional().describe("Full image path, e.g. registry.io/eng/image-library (splits on last /)"),
      registry:              z.string().optional().describe("Registry (use repo= to pass full path)"),
      imageNamespace:        z.string().optional().describe("Image namespace (use repo= to pass full path)"),
      storageClass:          z.string().optional().describe("Default storage class for certsandlogs PVC across all components"),
      deployDdbRole:         z.boolean().default(false).describe("Also deploy DDB backup ClusterRole"),
      prefix:                z.string().optional().describe("Global prefix for all release/resource names, e.g. 'k8-service1-'"),
      suffix:                z.string().optional().describe("Global suffix appended to all resource names (global.suffix)"),
      clusterDomain:         z.string().optional().describe("Kubernetes cluster domain, default svc.cluster.local (global.clusterDomain)"),
      imagePullSecret:       z.string().optional().describe("Name of an existing image pull secret for all components (global.image.pullSecret)"),
      // Config pull secret creation
      pullsecretCreate:      z.boolean().optional().describe("Create an image pull secret in config chart (pullsecret.create=true)"),
      pullsecretName:        z.string().optional().describe("Name of pull secret to create (pullsecret.name)"),
      pullsecretRegistry:    z.string().optional().describe("Registry for pull secret (pullsecret.registry)"),
      pullsecretUsername:    z.string().optional().describe("Username for pull secret (pullsecret.username)"),
      pullsecretPassword:    z.string().optional().describe("Password for pull secret (pullsecret.password)"),
      ccCertificatePath:     z.string().optional().describe("Path to Command Center TLS certificate on MCP server pod (secret.CCCertificate via --set-file)"),
      ccCertificatePassword: z.string().optional().describe("Password for the Command Center TLS certificate (secret.CCCertificatePassword)"),
      // CommServer
      email:         z.string().optional().describe("Email of the first CommServer admin user (email)"),
      sqlSaPassword: z.string().optional().describe("SQL Server SA password for CommServer (secret.sa_password)"),
      csServiceType: z.string().optional().describe("Service type for CommServer external gateway, default LoadBalancer (serviceType)"),
      // MediaAgent storage
      maStorageClassJobResults:     z.string().optional().describe("Storage class for all MediaAgent job results PVCs (storageClass.jobresults)"),
      maStorageClassJobResultsSize: z.string().optional().describe("Size for MediaAgent job results PVCs, default 20Gi"),
      maStorageClassIndexCache:     z.string().optional().describe("Storage class for all MediaAgent index cache PVCs (storageClass.indexcache)"),
      maStorageClassIndexCacheSize: z.string().optional().describe("Size for MediaAgent index cache PVCs, default 20Gi"),
      maStorageClassDdb:            z.string().optional().describe("Storage class for all MediaAgent DDB PVCs (storageClass.ddb)"),
      maStorageClassDdbSize:        z.string().optional().describe("Size for MediaAgent DDB PVCs, default 50Gi"),
      // CommandCenter
      commandCenterHostname: z.string().optional().describe("External FQDN for Command Center, max 62 chars (clientHostName)"),
      webserverClientName:   z.string().optional().describe("WebServer client name that Command Center should connect to (webserverName)"),
    },
    (args) => tryCatchTool(() => {
      let { tag, namespace, user, password, authcode, accessNodeCount, mediaAgentCount,
            repo, storageClass, deployDdbRole, prefix, suffix, clusterDomain, imagePullSecret,
            pullsecretCreate, pullsecretName, pullsecretRegistry, pullsecretUsername, pullsecretPassword,
            ccCertificatePath, ccCertificatePassword,
            email, sqlSaPassword, csServiceType,
            maStorageClassJobResults, maStorageClassJobResultsSize,
            maStorageClassIndexCache, maStorageClassIndexCacheSize,
            maStorageClassDdb, maStorageClassDdbSize,
            commandCenterHostname, webserverClientName } = args;
      let registry       = args.registry      || CV_IMAGE_REGISTRY  || undefined;
      let imageNamespace = args.imageNamespace || CV_IMAGE_NAMESPACE || undefined;
      assertNamespaceAllowed(namespace);

      if (!tag) throw new Error("Image tag is REQUIRED for ring deployment.");
      if (!authcode && (!user || !password)) {
        throw new Error("Authentication credentials are REQUIRED. Provide 'user' + 'password' or 'authcode'.");
      }
      if (commandCenterHostname && commandCenterHostname.length > 62) {
        throw new Error(
          `commandCenterHostname "${commandCenterHostname}" is ${commandCenterHostname.length} characters long.\n` +
          "Kubernetes requires it to be ≤ 62 characters."
        );
      }

      if (repo) {
        const split = splitRepo(repo);
        registry       = split.registry;
        imageNamespace = split.imageNamespace;
      }

      const domain = clusterDomain || "svc.cluster.local";

      // Helm release names are prefixed for helm-list visibility.
      // K8s resource names are driven by global.prefix + clientName (set in helmBase).
      const rname = (base) => prefix ? `${prefix}${base}` : base;

      // CommServer internal service hostname for in-cluster component registration.
      // cv.metadataname = prefix + clientName("commserve") = {prefix}commserve
      // Internal service name = {prefix}commserve  →  FQDN: {prefix}commserve.{namespace}.{domain}
      const csInternalHost = `${rname("commserve")}.${namespace}.${domain}`;

      const results = [];
      const run = (label, cmd) => {
        results.push(`\n--- ${label} ---\n>> ${redactCommandForLog(cmd)}`);
        const res = runCommand(cmd, 180_000);
        results.push(formatResult(res));
        return res.exitCode;
      };

      // helmBase builds the common helm args for every component.
      // clientNameBase: when prefix is set, sets clientName=base to prevent double-prefix:
      //   cv.metadataname = prefix + clientNameBase = {prefix}commserve  (correct)
      //   without it:      prefix + Release.Name    = {prefix}{prefix}commserve (wrong)
      const helmBase = (relName, chartDir, clientNameBase) => {
        const cmd = ["helm", "upgrade", "--install", relName, chart(chartDir), "--namespace", namespace, "--create-namespace"];
        appendSetArg(cmd, "global.image.tag",           tag);
        appendSetArg(cmd, "global.image.registry",      registry);
        appendSetArg(cmd, "global.image.namespace",     imageNamespace);
        appendSetArg(cmd, "global.image.pullSecret",    imagePullSecret);
        appendSetArg(cmd, "global.storageClass.certsandlogs", storageClass);
        appendSetArg(cmd, "global.prefix",              prefix);
        appendSetArg(cmd, "global.suffix",              suffix);
        appendSetArg(cmd, "global.clusterDomain",       clusterDomain);
        if (prefix) appendSetArg(cmd, "clientName", clientNameBase);
        return cmd;
      };

      // 1. Config
      const configCmd = ["helm", "upgrade", "--install", rname("config"), chart("config"), "--namespace", namespace, "--create-namespace"];
      appendSetArg(configCmd, "csOrGatewayHostName",        csInternalHost);
      appendSetArg(configCmd, "secret.user",                user);
      appendSetArg(configCmd, "secret.password",            password);
      appendSetArg(configCmd, "secret.authcode",            authcode);
      appendSetArg(configCmd, "global.prefix",              prefix);
      appendSetArg(configCmd, "global.suffix",              suffix);
      appendSetArg(configCmd, "global.image.pullSecret",    imagePullSecret);
      if (pullsecretCreate) appendSetArg(configCmd, "pullsecret.create", "true");
      appendSetArg(configCmd, "pullsecret.name",     pullsecretName);
      appendSetArg(configCmd, "pullsecret.registry", pullsecretRegistry);
      appendSetArg(configCmd, "pullsecret.username", pullsecretUsername);
      appendSetArg(configCmd, "pullsecret.password", pullsecretPassword);
      if (ccCertificatePath) configCmd.push("--set-file", `secret.CCCertificate=${ccCertificatePath}`);
      appendSetArg(configCmd, "secret.CCCertificatePassword", ccCertificatePassword);
      run("Deploy Config", configCmd);

      // 2. DDB role (optional)
      if (deployDdbRole) {
        run("Deploy DDB Role", ["helm", "upgrade", "--install", rname("cv-ddb-role"), chart("cv-ddb-backup-role"), "--namespace", namespace, "--create-namespace"]);
      }

      // 3. CommServer
      const csCmd = helmBase(rname("commserve"), "commserve", "commserve");
      appendSetArg(csCmd, "image.location",   imageLocationSet(registry, imageNamespace, REPO_MAP.commserver, tag));
      appendSetArg(csCmd, "email",            email);
      appendSetArg(csCmd, "secret.sa_password", sqlSaPassword);
      appendSetArg(csCmd, "serviceType",      csServiceType);
      run("Deploy CommServer", csCmd);

      // 4. Access Nodes
      for (let i = 1; i <= accessNodeCount; i++) {
        const c = helmBase(rname(`accessnode${i}`), "accessnode", `accessnode${i}`);
        appendSetArg(c, "image.location", imageLocationSet(registry, imageNamespace, REPO_MAP.accessnode, tag));
        run(`Deploy Access Node ${i}`, c);
      }

      // 5. Media Agents
      for (let i = 1; i <= mediaAgentCount; i++) {
        const c = helmBase(rname(`ma${i}`), "mediaagent", `ma${i}`);
        appendSetArg(c, "image.location",                  imageLocationSet(registry, imageNamespace, REPO_MAP.mediaagent, tag));
        appendSetArg(c, "storageClass.jobresults",          maStorageClassJobResults);
        appendSetArg(c, "storageClass.jobresults_size",     maStorageClassJobResultsSize);
        appendSetArg(c, "storageClass.indexcache",          maStorageClassIndexCache);
        appendSetArg(c, "storageClass.indexcache_size",     maStorageClassIndexCacheSize);
        appendSetArg(c, "storageClass.ddb",                 maStorageClassDdb);
        appendSetArg(c, "storageClass.ddb_size",            maStorageClassDdbSize);
        run(`Deploy Media Agent ${i}`, c);
      }

      // 6. Web Server
      const wsCmd = helmBase(rname("webserver"), "webserver", "webserver");
      appendSetArg(wsCmd, "image.location", imageLocationSet(registry, imageNamespace, REPO_MAP.webserver, tag));
      run("Deploy Web Server", wsCmd);

      // 7. Command Center
      const ccCmd = helmBase(rname("commandcenter"), "commandcenter", "commandcenter");
      appendSetArg(ccCmd, "image.location",  imageLocationSet(registry, imageNamespace, REPO_MAP.commandcenter, tag));
      appendSetArg(ccCmd, "clientHostName",  commandCenterHostname);
      appendSetArg(ccCmd, "webserverName",   webserverClientName);
      run("Deploy Command Center", ccCmd);

      results.push("\n=== Ring deployment complete. Run get_status to monitor pods. ===");
      return { content: [{ type: "text", text: results.join("\n") }] };
    })
  );
}
