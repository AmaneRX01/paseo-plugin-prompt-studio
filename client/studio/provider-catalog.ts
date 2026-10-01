import type { PluginClientContext } from "@getpaseo/plugin/client";

type Providers = PluginClientContext["paseo"]["providers"];
export type ProviderCatalogSnapshot = Pick<
  Awaited<ReturnType<Providers["snapshot"]>>,
  "cwd" | "entries" | "generatedAt"
>;

/** Keep known models visible while their provider refreshes, within one directory. */
function retainLoadingModels(
  next: ProviderCatalogSnapshot,
  previous: ProviderCatalogSnapshot | undefined,
): ProviderCatalogSnapshot {
  if (!previous || previous.cwd !== next.cwd) return next;
  const previousEntries = new Map(previous.entries.map((entry) => [entry.provider, entry]));
  return {
    ...next,
    entries: next.entries.map((entry) => {
      const cached = previousEntries.get(entry.provider);
      if (!entry.enabled || entry.status !== "loading" || entry.models?.length
        || !cached?.enabled || !cached.models?.length) return entry;
      return {
        ...entry,
        models: cached.models,
        modes: entry.modes ?? cached.modes,
        defaultModeId: entry.defaultModeId === undefined ? cached.defaultModeId : entry.defaultModeId,
      };
    }),
  };
}

export function selectableProviderEntries(snapshot: ProviderCatalogSnapshot | undefined) {
  return (snapshot?.entries ?? [])
    .filter((entry) => entry.enabled && (entry.status === "ready" || entry.status === "loading"))
    .map((entry) => ({
      ...entry,
      models: (entry.models ?? []).filter((model) => model.isSelectable !== false),
    }))
    .filter((entry) => entry.models.length > 0);
}

/** The daemon's returned cwd identifies the subscription, including canonicalized paths. */
export function createProviderCatalogReader(
  providers: Pick<Providers, "snapshot" | "subscribe" | "refresh">,
  cwd?: string,
) {
  let scopeKnown = false;
  let scope: string | undefined;
  let current: ProviderCatalogSnapshot | undefined;
  const pending = new Map<string | undefined, ProviderCatalogSnapshot>();

  function accept(snapshot: ProviderCatalogSnapshot): ProviderCatalogSnapshot {
    // A response started before a live update must not erase the newer models.
    if (current && Date.parse(snapshot.generatedAt) < Date.parse(current.generatedAt)) return current;
    current = retainLoadingModels(snapshot, current);
    return current;
  }

  return {
    async read(): Promise<ProviderCatalogSnapshot> {
      const snapshot = await providers.snapshot({ cwd });
      if (!scopeKnown || scope !== snapshot.cwd) {
        scopeKnown = true;
        scope = snapshot.cwd;
        current = undefined;
      }
      const queued = pending.get(scope);
      pending.clear();
      const result = accept(snapshot);
      return queued ? accept(queued) : result;
    },
    subscribe(onChange: (snapshot: ProviderCatalogSnapshot) => void): () => void {
      let active = true;
      const unsubscribe = providers.subscribe((update) => {
        if (!active) return;
        if (!scopeKnown) {
          const queued = pending.get(update.cwd);
          if (!queued || Date.parse(update.generatedAt) >= Date.parse(queued.generatedAt)) {
            pending.set(update.cwd, update);
          }
          return;
        }
        if (update.cwd === scope) onChange(accept(update));
      });
      return () => {
        if (!active) return;
        active = false;
        unsubscribe();
      };
    },
    async refresh(): Promise<ProviderCatalogSnapshot> {
      await providers.refresh({ cwd });
      return this.read();
    },
  };
}
