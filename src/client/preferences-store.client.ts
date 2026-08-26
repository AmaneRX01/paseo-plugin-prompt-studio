import { useSyncExternalStore } from "react";

export interface ClientPreferenceStore<T> {
  getSnapshot(): T;
  set(next: T): void;
  subscribe(listener: () => void): () => void;
}

export function readClientStorage(key: string): string | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeClientStorage(key: string, value: string): void {
  try {
    (globalThis as { localStorage?: Storage }).localStorage?.setItem(key, value);
  } catch {
    // Some native runtimes do not provide web storage; the live value remains usable.
  }
}

export function createClientPreferenceStore<T>(
  initialValue: T,
  persist: (value: T) => void,
): ClientPreferenceStore<T> {
  let current = initialValue;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    set(next) {
      if (Object.is(next, current)) return;
      current = next;
      persist(next);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useClientPreference<T>(store: ClientPreferenceStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
