$ErrorActionPreference = "Stop"

$pluginEntry = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\index.ts")).Path.Replace("\", "/")
$paseoExecutable = Join-Path $env:LOCALAPPDATA "Programs\Paseo\Paseo.exe"
if (-not (Test-Path -LiteralPath $paseoExecutable -PathType Leaf)) {
  throw "Paseo Desktop is not installed at the expected per-user path: $paseoExecutable"
}

$compilerPath = Join-Path (Split-Path -Parent $paseoExecutable) "resources\app.asar\node_modules\@getpaseo\server\dist\server\server\plugins\compiler.js"
$compilerUrl = "file:///" + $compilerPath.Replace("\", "/")
$compilerLiteral = ConvertTo-Json $compilerUrl -Compress
$entryLiteral = ConvertTo-Json $pluginEntry -Compress

$javascript = @'
import(__COMPILER__).then(async ({ compilePlugin }) => {
  const bundle = await compilePlugin(__ENTRY__);
  if (!bundle.clientBundle || !bundle.serverBundle) throw new Error("Compiler did not return both bundles");
  const sdk = { defineRpc: (value) => value, defineAttachmentSource: (value) => value };

  const clientFactory = (0, eval)(bundle.clientBundle);
  const clientModule = clientFactory((id) =>
    id === "zod" ? require("zod") :
    id === "@getpaseo/plugin" || id === "@getpaseo/plugin/server" ? sdk : {}
  );
  const clientSeen = [];
  const add = (kind) => (...args) => clientSeen.push(`${kind}:${typeof args[0] === "string" ? args[0] : args[0].id}`);
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
    throw new Error(`Unexpected client contributions: ${clientSeen.join(", ")}`);
  }

  const serverFactory = (0, eval)(bundle.serverBundle);
  const serverModule = serverFactory((id) =>
    id === "@getpaseo/plugin" || id === "@getpaseo/plugin/server" ? sdk : require(id)
  );
  const serverSeen = [];
  const serverCleanup = serverModule.default({
    handle(contract, handler) {
      if (typeof handler !== "function") throw new Error(`Non-function handler for ${contract.name}`);
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
    throw new Error(`Unexpected server RPCs: ${serverSeen.join(", ")}`);
  }

  const smokeMarker = process.env.PROMPT_STUDIO_SMOKE_MARKER;
  if (!smokeMarker) throw new Error("Missing smoke success marker path");
  require("node:fs").writeFileSync(smokeMarker, "ok", "utf8");
  console.log(`Paseo compiler smoke OK (${bundle.clientBundle.length} client bytes, ${bundle.serverBundle.length} server bytes)`);
  console.log(clientSeen.join("\n"));
  console.log(serverSeen.join("\n"));
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
'@
$javascript = $javascript.Replace("__COMPILER__", $compilerLiteral).Replace("__ENTRY__", $entryLiteral)
$encodedJavascript = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($javascript))
$runner = "eval(Buffer.from('$encodedJavascript','base64').toString('utf8'))"

$previousElectronMode = $env:ELECTRON_RUN_AS_NODE
$previousSmokeMarker = $env:PROMPT_STUDIO_SMOKE_MARKER
$smokeMarkerPath = Join-Path ([IO.Path]::GetTempPath()) ("prompt-studio-smoke-" + [Guid]::NewGuid().ToString("N") + ".ok")
try {
  $env:ELECTRON_RUN_AS_NODE = "1"
  $env:PROMPT_STUDIO_SMOKE_MARKER = $smokeMarkerPath
  & $paseoExecutable -e $runner
  $compilerExitCode = if ($null -eq $LASTEXITCODE) { if ($?) { 0 } else { 1 } } else { $LASTEXITCODE }
  if ($compilerExitCode -ne 0) {
    throw "Paseo compiler smoke exited with code $compilerExitCode"
  }
  $markerDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath $smokeMarkerPath -PathType Leaf) -and [DateTime]::UtcNow -lt $markerDeadline) {
    Start-Sleep -Milliseconds 50
  }
  if (-not (Test-Path -LiteralPath $smokeMarkerPath -PathType Leaf)) {
    throw "Paseo compiler smoke did not report a successful contribution validation"
  }
} finally {
  if ($null -eq $previousElectronMode) {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  } else {
    $env:ELECTRON_RUN_AS_NODE = $previousElectronMode
  }
  if ($null -eq $previousSmokeMarker) {
    Remove-Item Env:PROMPT_STUDIO_SMOKE_MARKER -ErrorAction SilentlyContinue
  } else {
    $env:PROMPT_STUDIO_SMOKE_MARKER = $previousSmokeMarker
  }
  Remove-Item -LiteralPath $smokeMarkerPath -Force -ErrorAction SilentlyContinue
}
