import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { output as ZodOutput } from "zod";
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
  type GenerationSettings,
} from "../shared/generation.shared";
import {
  createGenerationCoordinator,
  type GenerationPaseo,
  type GenerationRuntimeStore,
} from "./generation-coordinator.server";

export interface GenerationHandlerStore extends GenerationRuntimeStore {
  getGenerationSettings(): Promise<GenerationSettings>;
  updateGenerationSettings(
    input: ZodOutput<typeof generationSettingsUpdateRpc.input>,
  ): Promise<GenerationSettings>;
}

function runtimePaseo(context: PluginHandlerContext): GenerationPaseo {
  // GenerationPaseo is the deliberately small structural subset used by this
  // plugin. The host supplies the full PaseoApi through PluginHandlerContext.
  return context.paseo as unknown as GenerationPaseo;
}

export function createGenerationHandlers(store: GenerationHandlerStore) {
  return {
    async generationSettingsGet(
      _input: ZodOutput<typeof generationSettingsGetRpc.input>,
    ) {
      return { settings: await store.getGenerationSettings() };
    },

    async generationSettingsUpdate(
      input: ZodOutput<typeof generationSettingsUpdateRpc.input>,
    ) {
      return { settings: await store.updateGenerationSettings(input) };
    },

    async generationPreview(
      input: ZodOutput<typeof generationPreviewRpc.input>,
      context: PluginHandlerContext,
    ) {
      const preview = await createGenerationCoordinator(store, runtimePaseo(context)).preview(input);
      return { preview };
    },

    async generationStart(
      input: ZodOutput<typeof generationStartRpc.input>,
      context: PluginHandlerContext,
    ) {
      return createGenerationCoordinator(store, runtimePaseo(context)).start(input);
    },

    async generationGet(input: ZodOutput<typeof generationGetRpc.input>) {
      const job = input.generationId
        ? await store.getGeneration(input.draftId, input.generationId)
        : await store.findUnresolvedGeneration(input.draftId);
      return { job };
    },

    async generationSync(
      input: ZodOutput<typeof generationSyncRpc.input>,
      context: PluginHandlerContext,
    ) {
      return createGenerationCoordinator(store, runtimePaseo(context)).sync(
        input.draftId,
        input.generationId,
      );
    },

    generationApplyCandidate(
      input: ZodOutput<typeof generationApplyCandidateRpc.input>,
      context: PluginHandlerContext,
    ) {
      return createGenerationCoordinator(store, runtimePaseo(context)).applyCandidate(input);
    },

    async generationDiscard(
      input: ZodOutput<typeof generationDiscardRpc.input>,
      context: PluginHandlerContext,
    ) {
      const job = await createGenerationCoordinator(store, runtimePaseo(context)).discard(
        input.draftId,
        input.generationId,
      );
      return { job };
    },

    async generationAbandon(
      input: ZodOutput<typeof generationAbandonRpc.input>,
      context: PluginHandlerContext,
    ) {
      const job = await createGenerationCoordinator(store, runtimePaseo(context)).abandon(
        input.draftId,
        input.generationId,
      );
      return { job };
    },
  };
}
