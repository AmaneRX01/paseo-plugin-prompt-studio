import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const languageSchema = z.enum(["en", "zh"]);
const historyLimitSchema = z.union([
  z.literal(3),
  z.literal(5),
  z.literal(10),
  z.literal(20),
]);
const draftIdSchema = z.string().regex(/^dr_[a-f0-9]{16}$/);
const checkpointIdSchema = z.string().regex(/^cp_[a-f0-9]{24}$/);

export const preferencesSettingsSchema = z.object({
  language: languageSchema.default("en"),
  showDescriptions: z.boolean().default(true),
  boilerplates: z.array(z.string().trim().min(1).max(4_000)).max(100).default([
    "Keep the response concise and focused.",
    "Avoid adding fragmented or redundant test work.",
    "Make only changes that are directly related to the request.",
  ]),
  snapshotLimit: historyLimitSchema.default(5),
  checkpointLimit: historyLimitSchema.default(5),
  starredCheckpointsCountTowardLimit: z.boolean().default(true),
  checkpointStarsByDraft: z.record(draftIdSchema, z.array(checkpointIdSchema).max(1_000)).default({}),
  // These are remembered logical Project IDs, ordered most-recent first. No
  // filesystem roots or Workspace locators belong in host preferences.
  projectChoices: z.array(z.string().min(1).max(512)).max(100).default([]),
  showSidebarShortcuts: z.boolean().default(true),
  showComposerShortcut: z.boolean().default(true),
  showHeaderShortcut: z.boolean().default(true),
  showExplorerShortcut: z.boolean().default(true),
}).strict();

export type PreferencesSettings = z.output<typeof preferencesSettingsSchema>;

export const preferencesSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 2,
  schema: preferencesSettingsSchema,
  migrate(values, fromVersion) {
    if (fromVersion !== 1) throw new Error(`Unsupported preferences version: ${fromVersion}`);
    return preferencesSettingsSchema.parse(values);
  },
});

export const DEFAULT_PREFERENCES: PreferencesSettings = preferencesSettingsSchema.parse({});

export function defaultPreferences(): PreferencesSettings {
  return preferencesSettingsSchema.parse(DEFAULT_PREFERENCES);
}
