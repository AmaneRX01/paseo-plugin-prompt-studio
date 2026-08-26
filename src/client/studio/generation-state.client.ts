import type { GenerationJobStatus } from "../../shared/generation.shared";
import type { MessageKey } from "../i18n.client";

const unresolvedStatuses = new Set<GenerationJobStatus>([
  "prepared",
  "launching",
  "running",
  "result-ready",
  "conflict",
  "needs-attention",
]);

export function isUnresolvedGenerationStatus(status: GenerationJobStatus): boolean {
  return unresolvedStatuses.has(status);
}

export function generationStatusMessageKey(status: GenerationJobStatus): MessageKey {
  switch (status) {
    case "prepared": return "generation.phase.prepared";
    case "launching": return "generation.phase.launching";
    case "running": return "generation.phase.running";
    case "result-ready": return "generation.phase.result-ready";
    case "applied": return "generation.phase.applied";
    case "conflict": return "generation.phase.conflict";
    case "needs-attention": return "generation.phase.needs-attention";
    case "failed": return "generation.phase.failed";
    case "discarded": return "generation.phase.discarded";
    case "abandoned": return "generation.phase.abandoned";
  }
}
