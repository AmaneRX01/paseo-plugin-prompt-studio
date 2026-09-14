import { useSyncExternalStore } from "react";

export interface ClientPreferenceStore<T> {
  getSnapshot(): T;
  set(next: T): void;
  subscribe(listener: () => void): () => void;
}

export function useClientPreference<T>(store: ClientPreferenceStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
