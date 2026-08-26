import type { PluginContext } from "@getpaseo/plugin";
import {
  catalogScanRpc,
  checkpointGetRpc,
  checkpointRestoreRpc,
  containerEnsureRpc,
  dispatchReconcileRpc,
  dispatchRetryRpc,
  dispatchSendRpc,
  draftAutosaveRpc,
  draftBatchTransitionRpc,
  draftCreateRpc,
  draftDeleteRpc,
  draftGetRpc,
  draftScopeRpc,
  draftTagsSetRpc,
  draftTransitionRpc,
  snapshotGetRpc,
  tagBatchRpc,
  tagRenameRpc,
} from "./src/shared/contracts.shared";
import {
  generationAbandonRpc,
  generationApplyCandidateRpc,
  generationDiscardRpc,
  generationGetRpc,
  generationPreviewRpc,
  generationSettingsGetRpc,
  generationSettingsUpdateRpc,
  generationStartRpc,
  generationSyncRpc,
} from "./src/shared/generation.shared";
import { generationHandlers, handlers } from "./src/server/handlers.server";
import { PromptStudioSurface, WorklogSurface } from "./src/client/main.client";
import { PromptAgentPanel, PromptWorkspacePanel } from "./src/client/panel.client";

export default function contribute(plugin: PluginContext) {
  // Keep server singleton references directly inside each handle expression. The
  // Paseo plugin compiler strips this server-only import from the client bundle.
  plugin.handle(catalogScanRpc, handlers.catalogScan);
  plugin.handle(containerEnsureRpc, handlers.containerEnsure);
  plugin.handle(draftCreateRpc, handlers.draftCreate);
  plugin.handle(draftGetRpc, handlers.draftGet);
  plugin.handle(draftAutosaveRpc, handlers.draftAutosave);
  plugin.handle(draftTagsSetRpc, handlers.draftTagsSet);
  plugin.handle(tagRenameRpc, handlers.tagRename);
  plugin.handle(tagBatchRpc, handlers.tagBatch);
  plugin.handle(draftScopeRpc, handlers.draftScope);
  plugin.handle(draftTransitionRpc, handlers.draftTransition);
  plugin.handle(draftBatchTransitionRpc, handlers.draftBatchTransition);
  plugin.handle(draftDeleteRpc, handlers.draftDelete);
  plugin.handle(snapshotGetRpc, handlers.snapshotGet);
  plugin.handle(checkpointGetRpc, handlers.checkpointGet);
  plugin.handle(checkpointRestoreRpc, handlers.checkpointRestore);
  plugin.handle(dispatchSendRpc, handlers.dispatchSend);
  plugin.handle(dispatchRetryRpc, handlers.dispatchRetry);
  plugin.handle(dispatchReconcileRpc, handlers.dispatchReconcile);
  plugin.handle(generationSettingsGetRpc, generationHandlers.generationSettingsGet);
  plugin.handle(generationSettingsUpdateRpc, generationHandlers.generationSettingsUpdate);
  plugin.handle(generationPreviewRpc, generationHandlers.generationPreview);
  plugin.handle(generationStartRpc, generationHandlers.generationStart);
  plugin.handle(generationGetRpc, generationHandlers.generationGet);
  plugin.handle(generationSyncRpc, generationHandlers.generationSync);
  plugin.handle(generationApplyCandidateRpc, generationHandlers.generationApplyCandidate);
  plugin.handle(generationDiscardRpc, generationHandlers.generationDiscard);
  plugin.handle(generationAbandonRpc, generationHandlers.generationAbandon);

  plugin.addSurface("prompt-studio", PromptStudioSurface);
  plugin.addSidebarItem({
    id: "prompt-studio",
    title: "Prompt Studio",
    icon: "BookOpen",
    surface: "prompt-studio",
  });
  plugin.addSurface("worklog", WorklogSurface);
  plugin.addSidebarItem({
    id: "worklog",
    title: "Worklog",
    icon: "FileText",
    surface: "worklog",
  });

  plugin.addWorkspacePanel({
    id: "prompt-scratchpad-workspace",
    title: "Prompt Scratchpad",
    icon: "FileText",
    context: "workspace",
    Component: PromptWorkspacePanel,
  });
  plugin.addWorkspacePanel({
    id: "prompt-scratchpad-agent",
    title: "Prompt Scratchpad",
    icon: "FileText",
    context: "agent",
    Component: PromptAgentPanel,
  });

  plugin.addCommandCenterItem({
    id: "open-prompt-studio",
    title: "Open Prompt Studio",
    icon: "BookOpen",
    keywords: ["prompt", "draft", "studio", "草稿"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("prompt-studio");
    },
  });
  plugin.addCommandCenterItem({
    id: "open-worklog",
    title: "Open Worklog",
    icon: "FileText",
    keywords: ["worklog", "log", "timeline", "日志", "工作日志"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("worklog");
    },
  });
  plugin.addCommandCenterItem({
    id: "open-prompt-scratchpad-workspace",
    title: "Open Prompt Scratchpad",
    icon: "FileText",
    keywords: ["prompt", "scratchpad", "draft", "workspace", "草稿"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("prompt-scratchpad-workspace");
    },
  });

  return () => {};
}
