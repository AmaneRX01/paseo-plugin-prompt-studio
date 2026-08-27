#!/usr/bin/env node

/**
 * Cross-platform Paseo compiler smoke test.
 *
 * Replicates the validation performed by `paseo-compiler-smoke.ps1` but runs on
 * macOS and Windows without requiring PowerShell.
 *
 * The script locates the local Paseo Desktop installation, invokes its bundled
 * plugin compiler through Electron's "run as Node" mode, and verifies that the
 * plugin contributes the expected client surfaces and server RPCs.
 *
 * Override the Paseo Desktop location:
 *   PASEO_DESKTOP_PATH=/Applications/Paseo.app npm run smoke:compiler
 */

const { spawn } = require("node:child_process");
const { existsSync, statSync, writeFileSync, unlinkSync } = require("node:fs");
const { homedir, tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");

function defaultDesktopPath() {
  if (process.platform === "darwin") {
    return "/Applications/Paseo.app";
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
    return path.join(localAppData, "Programs", "Paseo", "Paseo.exe");
  }
  throw new Error(
    `Unsupported platform: ${process.platform}. This smoke test supports macOS and Windows. ` +
      "Set PASEO_DESKTOP_PATH to the Paseo Desktop app bundle or executable if you believe the path is detectable."
  );
}

function resolveDesktopPath() {
  const override = process.env.PASEO_DESKTOP_PATH;
  if (override) {
    const trimmed = override.trim();
    if (!path.isAbsolute(trimmed)) {
      throw new Error(`PASEO_DESKTOP_PATH must be an absolute path, received: ${trimmed}`);
    }
    return path.resolve(trimmed);
  }
  return defaultDesktopPath();
}

function resolveExecutable(desktopPath) {
  if (process.platform === "darwin") {
    const insideBundle = path.join(desktopPath, "Contents", "MacOS", "Paseo");
    if (existsSync(insideBundle)) return insideBundle;

    if (existsSync(desktopPath) && !statSync(desktopPath).isDirectory()) {
      return desktopPath;
    }
  }

  if (!existsSync(desktopPath)) {
    throw new Error(
      `Paseo Desktop was not found at the expected path: ${desktopPath}\n` +
        "Install Paseo Desktop or set PASEO_DESKTOP_PATH to the app bundle (macOS) or executable (Windows)."
    );
  }
  return desktopPath;
}

function resolveCompilerPath(desktopPath) {
  if (process.platform === "darwin") {
    return path.join(
      desktopPath,
      "Contents",
      "Resources",
      "app.asar",
      "node_modules",
      "@getpaseo",
      "server",
      "dist",
      "server",
      "server",
      "plugins",
      "compiler.js"
    );
  }

  // Windows: desktopPath points to Paseo.exe; compiler lives next to it under resources/.
  return path.join(
    path.dirname(desktopPath),
    "resources",
    "app.asar",
    "node_modules",
    "@getpaseo",
    "server",
    "dist",
    "server",
    "server",
    "plugins",
    "compiler.js"
  );
}

function resolveCompilerContainerPath(desktopPath, compilerPath) {
  return process.platform === "win32"
    ? path.join(path.dirname(desktopPath), "resources", "app.asar")
    : compilerPath;
}

function buildPayload(entryPath, compilerUrl) {
  const entryLiteral = JSON.stringify(entryPath);
  const compilerLiteral = JSON.stringify(compilerUrl);

  return `
import(${compilerLiteral}).then(async ({ compilePlugin }) => {
  const bundle = await compilePlugin(${entryLiteral});
  if (!bundle.clientBundle || !bundle.serverBundle) throw new Error("Compiler did not return both bundles");
  const sdk = { defineRpc: (value) => value, defineAttachmentSource: (value) => value };

  const clientFactory = (0, eval)(bundle.clientBundle);
  const clientModule = clientFactory((id) =>
    id === "zod" ? require("zod") :
    id === "@getpaseo/plugin" || id === "@getpaseo/plugin/server" ? sdk : {}
  );
  const clientSeen = [];
  const add = (kind) => (...args) => clientSeen.push(\`\${kind}:\${typeof args[0] === "string" ? args[0] : args[0].id}\`);
  const clientCleanup = clientModule.default({
    addSurface: add("surface"),
    addSidebarItem: add("sidebar"),
    addWorkspacePanel: add("panel"),
    addCommandCenterItem: add("command"),
    addAttachmentSource: add("attachment"),
    addTheme: add("theme"),
  });
  if (typeof clientCleanup !== "function") throw new Error("Client contribution did not return cleanup");
  const expectedClient = [
    "surface:prompt-studio",
    "sidebar:prompt-studio",
    "surface:worklog",
    "sidebar:worklog",
    "panel:prompt-scratchpad-workspace",
    "panel:prompt-scratchpad-agent",
    "command:open-prompt-studio",
    "command:open-worklog",
    "command:open-prompt-scratchpad-workspace",
  ];
  if (JSON.stringify(clientSeen) !== JSON.stringify(expectedClient)) {
    throw new Error(\`Unexpected client contributions: \${clientSeen.join(", ")}\`);
  }

  const serverFactory = (0, eval)(bundle.serverBundle);
  const serverModule = serverFactory((id) =>
    id === "@getpaseo/plugin" || id === "@getpaseo/plugin/server" ? sdk : require(id)
  );
  const serverSeen = [];
  const serverCleanup = serverModule.default({
    handle(contract, handler) {
      if (typeof handler !== "function") throw new Error(\`Non-function handler for \${contract.name}\`);
      serverSeen.push(contract.name);
    },
    addSurface() {}, addSidebarItem() {}, addWorkspacePanel() {},
    addCommandCenterItem() {}, addAttachmentSource() {}, addTheme() {},
  });
  if (typeof serverCleanup !== "function") throw new Error("Server contribution did not return cleanup");
  const expectedServer = [
    "prompt-studio.catalog-scan",
    "prompt-studio.container-ensure",
    "prompt-studio.draft-create",
    "prompt-studio.draft-get",
    "prompt-studio.draft-autosave",
    "prompt-studio.draft-tags-set",
    "prompt-studio.tag-rename",
    "prompt-studio.tag-batch",
    "prompt-studio.draft-scope",
    "prompt-studio.draft-transition",
    "prompt-studio.draft-batch-transition",
    "prompt-studio.draft-delete",
    "prompt-studio.snapshot-get",
    "prompt-studio.checkpoint-get",
    "prompt-studio.checkpoint-restore",
    "prompt-studio.dispatch-send",
    "prompt-studio.dispatch-retry",
    "prompt-studio.dispatch-reconcile",
    "prompt-studio.generation-settings-get",
    "prompt-studio.generation-settings-update",
    "prompt-studio.generation-preview",
    "prompt-studio.generation-start",
    "prompt-studio.generation-get",
    "prompt-studio.generation-sync",
    "prompt-studio.generation-apply-candidate",
    "prompt-studio.generation-discard",
    "prompt-studio.generation-abandon",
  ];
  if (JSON.stringify(serverSeen) !== JSON.stringify(expectedServer)) {
    throw new Error(\`Unexpected server RPCs: \${serverSeen.join(", ")}\`);
  }

  const smokeMarker = process.env.PROMPT_STUDIO_SMOKE_MARKER;
  if (!smokeMarker) throw new Error("Missing smoke success marker path");
  require("node:fs").writeFileSync(smokeMarker, "ok", "utf8");
  console.log(\`Paseo compiler smoke OK (\${bundle.clientBundle.length} client bytes, \${bundle.serverBundle.length} server bytes)\`);
  console.log(clientSeen.join("\\n"));
  console.log(serverSeen.join("\\n"));
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
  `.trim();
}

function main() {
  const desktopPath = resolveDesktopPath();
  const executable = resolveExecutable(desktopPath);
  const compilerPath = resolveCompilerPath(desktopPath);
  const compilerContainerPath = resolveCompilerContainerPath(desktopPath, compilerPath);

  // Ordinary Windows Node cannot stat paths inside Electron's app.asar, while
  // the Paseo Electron runtime used below can import them. Validate the archive
  // itself on Windows and let the runtime report a missing internal compiler.
  if (!existsSync(compilerContainerPath)) {
    throw new Error(
      `Paseo plugin compiler container not found at: ${compilerContainerPath}\n` +
      "Verify that Paseo Desktop is installed and that PASEO_DESKTOP_PATH points to the correct location."
    );
  }

  const entryPath = path.resolve(path.join(__dirname, "..", "index.ts"));
  const compilerUrl = pathToFileURL(compilerPath).href;
  const payload = buildPayload(entryPath, compilerUrl);
  const runner = `eval(Buffer.from(${JSON.stringify(Buffer.from(payload, "utf8").toString("base64"))}, "base64").toString("utf8"))`;

  const markerPath = path.join(tmpdir(), `prompt-studio-smoke-${randomUUID().replace(/-/g, "")}.ok`);

  const child = spawn(executable, ["-e", runner], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PROMPT_STUDIO_SMOKE_MARKER: markerPath,
    },
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    try {
      if (signal) {
        throw new Error(`Paseo compiler smoke was terminated by signal ${signal}`);
      }
      if (code !== 0) {
        throw new Error(`Paseo compiler smoke exited with code ${code}`);
      }
      if (!existsSync(markerPath)) {
        throw new Error("Paseo compiler smoke did not report a successful contribution validation");
      }
      console.log("Paseo compiler smoke validation completed successfully.");
      process.exit(0);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    } finally {
      try {
        unlinkSync(markerPath);
      } catch {
        // ignore cleanup failure
      }
    }
  });
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
