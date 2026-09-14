import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  catalogScanRpc,
  containerEnsureRpc,
  draftCreateRpc,
  draftGetRpc,
  draftAutosaveRpc,
  draftTagsSetRpc,
  tagRenameRpc,
  tagBatchRpc,
  draftScopeRpc,
  draftTransitionRpc,
  draftBatchTransitionRpc,
  draftDeleteRpc,
  snapshotGetRpc,
  checkpointGetRpc,
  checkpointRestoreRpc,
  dispatchSendRpc,
  dispatchRetryRpc,
  dispatchReconcileRpc,
  dispatchPendingCountsRpc,
} from "./shared/contracts";
import {
  generationSettingsGetRpc,
  generationSettingsUpdateRpc,
  generationPreviewRpc,
  generationStartRpc,
  generationGetRpc,
  generationSyncRpc,
  generationApplyCandidateRpc,
  generationDiscardRpc,
  generationAbandonRpc,
} from "./shared/generation";
import {
  projectLinkDeleteRpc,
  projectLinkMigrateRpc,
  projectLinksListRpc,
} from "./shared/project-links";
import { preferencesSettings } from "./shared/preferences-settings";
import { draftAttachmentsSearchRpc } from "./shared/draft-attachments";
import { generationHandlers, handlers, promptStudioStore } from "./server/handlers";
import { createDraftAttachmentHandler } from "./server/draft-attachments";
import { registerDispatchObserver } from "./server/dispatch-observer";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(preferencesSettings);
  server.handle(catalogScanRpc, handlers.catalogScan);
  server.handle(containerEnsureRpc, handlers.containerEnsure);
  server.handle(projectLinksListRpc, handlers.projectLinksList);
  server.handle(projectLinkMigrateRpc, handlers.projectLinkMigrate);
  server.handle(projectLinkDeleteRpc, handlers.projectLinkDelete);
  server.handle(draftCreateRpc, handlers.draftCreate);
  server.handle(draftGetRpc, handlers.draftGet);
  server.handle(draftAutosaveRpc, handlers.draftAutosave);
  server.handle(draftTagsSetRpc, handlers.draftTagsSet);
  server.handle(tagRenameRpc, handlers.tagRename);
  server.handle(tagBatchRpc, handlers.tagBatch);
  server.handle(draftScopeRpc, handlers.draftScope);
  server.handle(draftTransitionRpc, handlers.draftTransition);
  server.handle(draftBatchTransitionRpc, handlers.draftBatchTransition);
  server.handle(draftDeleteRpc, handlers.draftDelete);
  server.handle(snapshotGetRpc, handlers.snapshotGet);
  server.handle(checkpointGetRpc, handlers.checkpointGet);
  server.handle(checkpointRestoreRpc, handlers.checkpointRestore);
  server.handle(dispatchSendRpc, handlers.dispatchSend);
  server.handle(dispatchRetryRpc, handlers.dispatchRetry);
  server.handle(dispatchReconcileRpc, handlers.dispatchReconcile);
  server.handle(dispatchPendingCountsRpc, handlers.dispatchPendingCounts);
  server.handle(draftAttachmentsSearchRpc, createDraftAttachmentHandler(promptStudioStore));
  server.handle(generationSettingsGetRpc, generationHandlers.generationSettingsGet);
  server.handle(generationSettingsUpdateRpc, generationHandlers.generationSettingsUpdate);
  server.handle(generationPreviewRpc, generationHandlers.generationPreview);
  server.handle(generationStartRpc, generationHandlers.generationStart);
  server.handle(generationGetRpc, generationHandlers.generationGet);
  server.handle(generationSyncRpc, generationHandlers.generationSync);
  server.handle(generationApplyCandidateRpc, generationHandlers.generationApplyCandidate);
  server.handle(generationDiscardRpc, generationHandlers.generationDiscard);
  server.handle(generationAbandonRpc, generationHandlers.generationAbandon);
  return registerDispatchObserver(server, promptStudioStore);
}
