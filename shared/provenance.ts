import { z } from "zod";
import { dispatchIdSchema, draftIdSchema } from "./contracts";

export const DISPATCH_PROVENANCE_KIND = "ps-dispatch" as const;
export const DISPATCH_PROVENANCE_VERSION = 1 as const;

export const dispatchProvenanceDataSchema = z.object({
  draftId: draftIdSchema,
  draftTitle: z.string(),
  dispatchId: dispatchIdSchema,
  revision: z.number().int().positive(),
  sentAt: z.string().datetime({ offset: true }),
}).strict();

export const dispatchProvenanceRowSchema = z.object({
  type: z.literal("plugin"),
  id: dispatchIdSchema,
  kind: z.literal(DISPATCH_PROVENANCE_KIND),
  version: z.literal(DISPATCH_PROVENANCE_VERSION),
  data: dispatchProvenanceDataSchema,
}).strict().superRefine((row, context) => {
  if (row.id !== row.data.dispatchId) {
    context.addIssue({
      code: "custom",
      path: ["id"],
      message: "Provenance row id must equal data.dispatchId",
    });
  }
});

export type DispatchProvenanceData = z.infer<typeof dispatchProvenanceDataSchema>;
export type DispatchProvenanceRow = z.infer<typeof dispatchProvenanceRowSchema>;

export function createDispatchProvenanceRow(
  data: DispatchProvenanceData,
): DispatchProvenanceRow {
  return dispatchProvenanceRowSchema.parse({
    type: "plugin",
    id: data.dispatchId,
    kind: DISPATCH_PROVENANCE_KIND,
    version: DISPATCH_PROVENANCE_VERSION,
    data,
  });
}
