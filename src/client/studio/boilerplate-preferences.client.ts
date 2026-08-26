import {
  createClientPreferenceStore,
  readClientStorage,
  useClientPreference,
  writeClientStorage,
} from "../preferences-store.client";

export const DEFAULT_BOILERPLATES = [
  "Keep the response concise and focused.",
  "Avoid adding fragmented or redundant test work.",
  "Make only changes that are directly related to the request.",
] as const;

const STORAGE_KEY = "prompt-studio.boilerplates.v1";
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

function readInitialBoilerplates(): readonly string[] {
  try {
    const raw = readClientStorage(STORAGE_KEY);
    if (!raw) return DEFAULT_BOILERPLATES;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      return DEFAULT_BOILERPLATES;
    }
    return normalizeBoilerplates(parsed);
  } catch {
    return DEFAULT_BOILERPLATES;
  }
}

const boilerplateStore = createClientPreferenceStore(
  readInitialBoilerplates(),
  (values) => writeClientStorage(STORAGE_KEY, JSON.stringify(values)),
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
