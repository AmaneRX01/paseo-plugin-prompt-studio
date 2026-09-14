import { Platform } from "react-native";

// Browser-only reads import legacy preferences. All current settings persist on the host.
interface BrowserStorage {
  getItem(key: string): string | null;
}

export function readClientStorage(key: string): string | null {
  if (Platform.OS !== "web") return null;
  try {
    return (globalThis as { localStorage?: BrowserStorage }).localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function browserLanguage(): string | null {
  if (Platform.OS !== "web") return null;
  try {
    return (globalThis as { navigator?: { language?: string } }).navigator?.language ?? null;
  } catch {
    return null;
  }
}
