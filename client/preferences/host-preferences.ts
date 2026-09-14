import { settingsRpc } from "@getpaseo/plugin";
import * as PluginClient from "@getpaseo/plugin/client";
import type { SettingsState } from "@getpaseo/plugin/client";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  DEFAULT_PREFERENCES,
  defaultPreferences,
  preferencesSettings,
  preferencesSettingsSchema,
  type PreferencesSettings,
} from "../../shared/preferences-settings";
import { readClientStorage } from "../web";

export const LEGACY_PREFERENCE_KEYS = {
  language: "prompt-studio.language",
  showDescriptions: "prompt-studio.show-descriptions",
  boilerplates: "prompt-studio.boilerplates.v1",
  history: "prompt-studio.history-preferences.v1",
  projectChoices: "prompt-studio.project-choices.v1",
} as const;

type LegacyReader = (key: string) => string | null;

function sameValues(left: PreferencesSettings, right: PreferencesSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function historyLimit(value: unknown): PreferencesSettings["snapshotLimit"] | null {
  return value === 3 || value === 5 || value === 10 || value === 20 ? value : null;
}

function validDraftId(value: string): boolean {
  return /^dr_[a-f0-9]{16}$/.test(value);
}

function validCheckpointId(value: string): boolean {
  return /^cp_[a-f0-9]{24}$/.test(value);
}

function normalizeLegacyBoilerplates(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const text = entry.trim().slice(0, 4_000);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length === 100) break;
  }
  return result;
}

function normalizeLegacyStars(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [draftId, checkpointIds] of Object.entries(value as Record<string, unknown>)) {
    if (!validDraftId(draftId) || !Array.isArray(checkpointIds)) continue;
    const ids = [...new Set(checkpointIds.filter(
      (checkpointId): checkpointId is string => typeof checkpointId === "string" && validCheckpointId(checkpointId),
    ))];
    if (ids.length) result[draftId] = ids.slice(0, 1_000);
  }
  return result;
}

function normalizeLegacyProjectChoices(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const projectId = entry.trim().slice(0, 512);
      if (!projectId || seen.has(projectId)) continue;
      seen.add(projectId);
      result.push(projectId);
      if (result.length === 100) break;
    }
    return result;
  }
  if (!value || typeof value !== "object") return null;
  return normalizeLegacyProjectChoices(Object.values(value as Record<string, unknown>));
}

/**
 * Merge browser-era values only when the host document is still untouched.
 * Keeping this predicate pure makes the destructive part of migration easy to
 * test: an existing host value can never be replaced by a stale browser copy.
 */
export function mergeLegacyPreferences(
  current: PreferencesSettings,
  read: LegacyReader = readClientStorage,
): PreferencesSettings {
  if (!sameValues(current, DEFAULT_PREFERENCES)) return current;

  const next: PreferencesSettings = {
    ...current,
    boilerplates: [...current.boilerplates],
    checkpointStarsByDraft: { ...current.checkpointStarsByDraft },
    projectChoices: [...current.projectChoices],
  };
  const language = read(LEGACY_PREFERENCE_KEYS.language);
  if (language === "en" || language === "zh") next.language = language;

  const showDescriptions = read(LEGACY_PREFERENCE_KEYS.showDescriptions);
  if (showDescriptions === "true" || showDescriptions === "false") {
    next.showDescriptions = showDescriptions === "true";
  }

  try {
    const raw = read(LEGACY_PREFERENCE_KEYS.boilerplates);
    if (raw) {
      const parsed = normalizeLegacyBoilerplates(JSON.parse(raw));
      if (parsed) next.boilerplates = parsed;
    }
  } catch {
    // A malformed legacy value is ignored; the host document remains usable.
  }

  try {
    const raw = read(LEGACY_PREFERENCE_KEYS.history);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const snapshotLimit = historyLimit(parsed.snapshotLimit);
      const checkpointLimit = historyLimit(parsed.checkpointLimit);
      if (snapshotLimit !== null) next.snapshotLimit = snapshotLimit;
      if (checkpointLimit !== null) next.checkpointLimit = checkpointLimit;
      if (typeof parsed.starredCheckpointsCountTowardLimit === "boolean") {
        next.starredCheckpointsCountTowardLimit = parsed.starredCheckpointsCountTowardLimit;
      }
      next.checkpointStarsByDraft = normalizeLegacyStars(parsed.checkpointStarsByDraft);
    }
  } catch {
    // A malformed legacy value is ignored; the host document remains usable.
  }

  try {
    const raw = read(LEGACY_PREFERENCE_KEYS.projectChoices);
    if (raw) {
      const parsed = normalizeLegacyProjectChoices(JSON.parse(raw));
      if (parsed) next.projectChoices = parsed;
    }
  } catch {
    // A malformed legacy value is ignored; the host document remains usable.
  }

  return preferencesSettingsSchema.parse(next);
}

export type HostPreferencesStatus = "loading" | "error" | "invalid" | "ready";

export interface HostPreferencesSnapshot {
  values: PreferencesSettings;
  revision: string | null;
  status: HostPreferencesStatus;
  error: string | null;
  saving: boolean;
  saveError: string | null;
}

export interface HostPreferencesBinding {
  /** A completed read or a new hook revision, rather than a retained render. */
  fresh?: boolean;
  status: HostPreferencesStatus;
  values?: PreferencesSettings;
  revision?: string;
  error?: string;
  saving?: boolean;
  saveError?: string | null;
  save(values: PreferencesSettings, revision: string): Promise<boolean | { values: PreferencesSettings; revision: string }>;
  reload(): Promise<void>;
}

/** Avoid class expressions: the host evaluates this bundle in Hermes at runtime. */
export function createHostPreferencesController() {
  let snapshot: HostPreferencesSnapshot = {
    values: defaultPreferences(), revision: null, status: "loading",
    error: null, saving: false, saveError: null,
  };
  const listeners = new Set<() => void>();
  let activeBinding: HostPreferencesBinding | null = null;
  let storedValues = defaultPreferences();
  let attemptedLegacyMigration = false;
  let queuedValues: PreferencesSettings | null = null;
  let lastFailedAttempt: { values: PreferencesSettings; revision: string } | null = null;
  const supersededRevisions = new Set<string>();

  const getSnapshot = (): HostPreferencesSnapshot => snapshot;
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  function emit(next: Partial<HostPreferencesSnapshot>): void {
    if (Object.entries(next).every(([key, value]) => Object.is(snapshot[key as keyof HostPreferencesSnapshot], value))) return;
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  }
  function applyValues(values: PreferencesSettings, revision = snapshot.revision): void {
    if (sameValues(values, snapshot.values) && revision === snapshot.revision) return;
    emit({ values: preferencesSettingsSchema.parse(values), revision });
  }

  function sync(binding: HostPreferencesBinding): void {
    activeBinding = binding;
    // Retained hook consumers can still publish the revision preceding our write.
    if (binding.revision && supersededRevisions.has(binding.revision)) {
      if (!binding.fresh) return;
      // Host revisions are content hashes: reverting values can legitimately
      // return an earlier revision. Only stale renders are excluded.
      supersededRevisions.delete(binding.revision);
    }
    emit({ status: binding.status, error: binding.error ?? null });
    if (binding.status !== "ready" || !binding.values || !binding.revision) return;
    const values = preferencesSettingsSchema.parse(binding.values);
    if (!snapshot.saving) {
      storedValues = values;
      applyValues(values, binding.revision);
    } else if (binding.revision !== snapshot.revision) {
      storedValues = values;
      emit({ revision: binding.revision });
    }
    if (!attemptedLegacyMigration) {
      attemptedLegacyMigration = true;
      const migrated = binding.revision === "missing" ? mergeLegacyPreferences(values) : values;
      if (!sameValues(migrated, values)) void save(migrated, binding.revision);
    }
  }

  function update(next: PreferencesSettings): void {
    const values = preferencesSettingsSchema.parse(next);
    if (sameValues(values, snapshot.values)) return;
    applyValues(values);
    if (snapshot.saving) {
      // Coalesce rapid changes without dropping any earlier field edits.
      queuedValues = values;
      return;
    }
    void save(values, snapshot.revision, true);
  }

  async function save(values: PreferencesSettings, revision = snapshot.revision, optimistic = false): Promise<boolean> {
    let next = preferencesSettingsSchema.parse(values);
    if (!revision || !activeBinding) {
      emit({ saveError: "Prompt Studio settings are not connected yet. Reload and retry." });
      return false;
    }
    if (snapshot.saving) {
      emit({ saveError: "A settings save is still pending. Retry after it finishes." });
      return false;
    }
    if (optimistic) applyValues(next);
    emit({ saving: true, saveError: null });
    let expectedRevision = revision;
    while (true) {
      try {
        const saved = await activeBinding.save(next, expectedRevision);
        if (!saved) throw new Error(activeBinding.saveError ?? "Settings changed elsewhere or could not be saved. Reload to review, or retry.");
        const receipt = typeof saved === "object" ? saved : null;
        const ownRevision = receipt?.revision ?? expectedRevision;
        const accepted = receipt ? preferencesSettingsSchema.parse(receipt.values) : next;
        if (receipt && ownRevision !== expectedRevision) supersededRevisions.add(expectedRevision);
        supersededRevisions.delete(ownRevision);
        // A delayed acknowledgement must not replace a newer external revision.
        if (snapshot.revision === expectedRevision || snapshot.revision === ownRevision) {
          storedValues = accepted;
          applyValues(queuedValues ?? accepted, ownRevision);
        }
        lastFailedAttempt = null;
        if (!queuedValues) {
          applyValues(storedValues);
          emit({ saving: false, saveError: null });
          return true;
        }
        next = queuedValues;
        queuedValues = null;
        // Only the exact revision returned by our own write authorizes the next
        // write. A concurrent host edit therefore conflicts rather than rebasing.
        expectedRevision = ownRevision;
      } catch (error) {
        lastFailedAttempt = { values: queuedValues ?? next, revision: expectedRevision };
        queuedValues = null;
        applyValues(storedValues);
        emit({ saving: false, saveError: error instanceof Error ? error.message : String(error) });
        return false;
      }
    }
  }

  async function retry(): Promise<boolean> {
    const attempt = lastFailedAttempt;
    return attempt ? save(attempt.values, attempt.revision, true) : false;
  }
  async function reload(): Promise<void> {
    if (!activeBinding || snapshot.saving) return;
    await activeBinding.reload();
    lastFailedAttempt = null;
    queuedValues = null;
    emit({ saveError: null });
  }
  function resetForTests(): void {
    snapshot = {
      values: defaultPreferences(), revision: null, status: "loading",
      error: null, saving: false, saveError: null,
    };
    storedValues = defaultPreferences();
    activeBinding = null;
    queuedValues = null;
    lastFailedAttempt = null;
    supersededRevisions.clear();
    attemptedLegacyMigration = false;
    for (const listener of listeners) listener();
  }
  return { getSnapshot, subscribe, sync, update, save, retry, reload, resetForTests };
}

export const hostPreferences = createHostPreferencesController();

type HostSettingsState = SettingsState<typeof preferencesSettings.schema>;

const unavailableSettings: HostSettingsState = {
    status: "error",
    error: "This Paseo client does not provide host settings. Update the client and reload.",
    saving: false,
    saveError: null,
    save: async () => false,
    reset: async () => false,
    reload: async () => {},
};

function fallbackUseSettings(_definition: typeof preferencesSettings): HostSettingsState {
  return unavailableSettings;
}

export function useHostPreferences(): HostPreferencesSnapshot & {
  save(values: PreferencesSettings, revision?: string): Promise<boolean>;
  retry(): Promise<boolean>;
  reload(): Promise<void>;
} {
  const useSettings = PluginClient.useSettings ?? fallbackUseSettings;
  const settings = useSettings(preferencesSettings);
  const writeSettings = PluginClient.useRpc(settingsRpc(preferencesSettings.id).write);
  const snapshot = useSyncExternalStore(
    hostPreferences.subscribe,
    hostPreferences.getSnapshot,
    hostPreferences.getSnapshot,
  );
  const settingsError = settings.status === "error" || settings.status === "invalid"
    ? settings.error
    : null;
  const settingsRevision = settings.status === "ready" || settings.status === "invalid"
    ? settings.revision
    : null;
  const settingsValues = settings.status === "ready" ? settings.values : null;
  const lastHookRevision = useRef(settingsRevision);
  useEffect(() => {
    hostPreferences.sync({
      fresh: lastHookRevision.current !== settingsRevision,
      status: settings.status,
      ...(settingsValues ? { values: settingsValues } : {}),
      ...(settingsRevision ? { revision: settingsRevision } : {}),
      ...(settingsError ? { error: settingsError } : {}),
      saving: settings.saving,
      saveError: settings.saveError,
      save: async (values, revision) => {
        const result = await writeSettings({ values, revision });
        if (result.status !== "saved") throw new Error(result.error);
        // useSettings continues to own host hydration; the built-in write RPC
        // also returns the precise revision required by the serial save queue.
        void settings.reload();
        return { values: preferencesSettingsSchema.parse(result.values), revision: result.revision };
      },
      reload: settings.reload,
    });
    lastHookRevision.current = settingsRevision;
  }, [
    settingsError,
    settingsRevision,
    writeSettings,
    settings.reload,
    settings.saveError,
    settings.saving,
    settings.status,
    settingsValues,
  ]);
  return {
    ...snapshot,
    save: (values, revision) => hostPreferences.save(values, revision),
    retry: () => hostPreferences.retry(),
    reload: () => hostPreferences.reload(),
  };
}

export function createHostPreferenceStore<T>(
  select: (values: PreferencesSettings) => T,
  replace: (values: PreferencesSettings, next: T) => PreferencesSettings,
) {
  let source = hostPreferences.getSnapshot().values;
  let selected = select(source);
  return {
    getSnapshot: () => {
      const values = hostPreferences.getSnapshot().values;
      if (values !== source) {
        source = values;
        selected = select(values);
      }
      return selected;
    },
    set(next: T) {
      hostPreferences.update(replace(hostPreferences.getSnapshot().values, next));
    },
    subscribe: hostPreferences.subscribe,
  };
}
