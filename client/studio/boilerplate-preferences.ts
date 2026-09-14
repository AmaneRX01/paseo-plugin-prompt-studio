import { useClientPreference } from "../preferences-store";
import { createHostPreferenceStore, useHostPreferences } from "../preferences/host-preferences";
import { DEFAULT_PREFERENCES } from "../../shared/preferences-settings";

export const DEFAULT_BOILERPLATES = DEFAULT_PREFERENCES.boilerplates;

export const LEGACY_STORAGE_KEY = "prompt-studio.boilerplates.v1";
const MAX_BOILERPLATE_LENGTH = 4_000;

function normalizeBoilerplates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const next = value.trim().slice(0, MAX_BOILERPLATE_LENGTH);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

const boilerplateStore = createHostPreferenceStore(
  (values) => values.boilerplates,
  (values, boilerplates) => ({
    ...values,
    boilerplates: normalizeBoilerplates(boilerplates),
  }),
);

export function getBoilerplates(): readonly string[] {
  return boilerplateStore.getSnapshot();
}

export function replaceBoilerplates(values: readonly string[]) {
  const next = normalizeBoilerplates(values);
  if (JSON.stringify(next) === JSON.stringify(boilerplateStore.getSnapshot())) return;
  boilerplateStore.set(next);
}

export function useBoilerplates(): readonly string[] {
  useHostPreferences();
  return useClientPreference(boilerplateStore);
}

export function appendBoilerplate(markdown: string, boilerplate: string): string {
  const normalized = boilerplate.trim();
  if (!normalized) return markdown;
  if (!markdown) return normalized;
  if (markdown.endsWith("\n\n")) return `${markdown}${normalized}`;
  if (markdown.endsWith("\n")) return `${markdown}\n${normalized}`;
  return `${markdown}\n\n${normalized}`;
}
