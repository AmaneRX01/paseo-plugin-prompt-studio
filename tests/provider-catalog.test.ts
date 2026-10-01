import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProviderCatalogReader,
  selectableProviderEntries,
  type ProviderCatalogSnapshot,
} from "../client/studio/provider-catalog";

type Entry = ProviderCatalogSnapshot["entries"][number];
type Providers = Parameters<typeof createProviderCatalogReader>[0];
const cwd = "D:\\project";

function entry(provider: string, overrides: Partial<Entry> = {}): Entry {
  return {
    provider, enabled: true, status: "ready",
    models: [{ provider, id: `${provider}-model`, label: `${provider} model` }],
    ...overrides,
  };
}

function snapshot(entries: Entry[], tick = 0, directory: string | undefined = cwd) {
  return { entries, generatedAt: new Date(tick).toISOString(), cwd: directory, requestId: `request-${tick}` };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fakeProviders(initial: Awaited<ReturnType<Providers["snapshot"]>> = snapshot([])) {
  let listener: Parameters<Providers["subscribe"]>[0] | undefined;
  let response: ReturnType<Providers["snapshot"]> = Promise.resolve(initial);
  const reads: Parameters<Providers["snapshot"]>[0][] = [];
  const refreshes: Parameters<Providers["refresh"]>[0][] = [];
  let released = 0;
  const providers: Providers = {
    snapshot(options) { reads.push(options); return response; },
    subscribe(handler) { listener = handler; return () => { released += 1; }; },
    async refresh(options) { refreshes.push(options); return { requestId: "refresh", acknowledged: true }; },
  };
  return {
    providers, reads, refreshes,
    emit: (value: ProviderCatalogSnapshot) => listener?.(value),
    respond: (value: typeof response) => { response = value; },
    released: () => released,
  };
}

test("a slow provider does not hide models from ready providers", async () => {
  const fake = fakeProviders(snapshot([
    entry("codex"), entry("cursor", { status: "loading", models: undefined }),
    entry("hidden", { models: [{ provider: "hidden", id: "alias", label: "Alias", isSelectable: false }] }),
    entry("disabled", { enabled: false }),
  ]));
  const reader = createProviderCatalogReader(fake.providers, cwd);
  const result = await reader.read();
  assert.deepEqual(selectableProviderEntries(result).map((value) => value.provider), ["codex"]);
  assert.equal(result.entries[1].status, "loading");
  assert.deepEqual(fake.reads, [{ cwd }]);
});

test("updates received before the initial response use the daemon's canonical cwd", async () => {
  const fake = fakeProviders();
  const pending = deferred<Awaited<ReturnType<Providers["snapshot"]>>>();
  fake.respond(pending.promise);
  const reader = createProviderCatalogReader(fake.providers, "d:/project/.");
  reader.subscribe(() => {});
  const read = reader.read();
  fake.emit(snapshot([entry("other")], 2, "D:\\other"));
  fake.emit(snapshot([entry("codex")], 1));
  pending.resolve(snapshot([], 0));
  const result = await read;
  assert.deepEqual(selectableProviderEntries(result).map((value) => value.provider), ["codex"]);
  assert.deepEqual(fake.reads, [{ cwd: "d:/project/." }]);
});

test("late responses cannot overwrite models discovered by a live update", async () => {
  const fake = fakeProviders(snapshot([entry("codex")], 0));
  const reader = createProviderCatalogReader(fake.providers, cwd);
  const updates: ProviderCatalogSnapshot[] = [];
  reader.subscribe((value) => updates.push(value));
  await reader.read();
  const pending = deferred<Awaited<ReturnType<Providers["snapshot"]>>>();
  fake.respond(pending.promise);
  const read = reader.read();
  fake.emit(snapshot([entry("codex"), entry("claude")], 2));
  pending.resolve(snapshot([], 1));
  assert.deepEqual(selectableProviderEntries(await read).map((value) => value.provider), ["codex", "claude"]);
  assert.equal(updates.length, 1);
});

test("models and modes survive refresh loading but removed and failed providers disappear", async () => {
  const fake = fakeProviders(snapshot([entry("codex", { defaultModeId: "auto", modes: [{ id: "auto", label: "Auto" }] })]));
  const reader = createProviderCatalogReader(fake.providers, cwd);
  let latest: ProviderCatalogSnapshot | undefined;
  reader.subscribe((value) => { latest = value; });
  await reader.read();
  fake.emit(snapshot([entry("codex", { status: "loading", models: undefined })], 1));
  assert.equal(selectableProviderEntries(latest)[0]?.models[0].id, "codex-model");
  assert.equal(selectableProviderEntries(latest)[0]?.defaultModeId, "auto");
  fake.emit(snapshot([entry("codex", { status: "error", error: "CLI unavailable", models: undefined })], 2));
  assert.deepEqual(selectableProviderEntries(latest), []);
  assert.equal(latest?.entries[0].error, "CLI unavailable");
  fake.emit(snapshot([], 3));
  assert.deepEqual(latest?.entries, []);
});

test("global and workspace catalogs ignore updates for another scope", async () => {
  for (const directory of [undefined, cwd]) {
    const initial = { ...snapshot([entry("codex")]), cwd: directory };
    const fake = fakeProviders(initial);
    const reader = createProviderCatalogReader(fake.providers, directory);
    let updates = 0;
    reader.subscribe(() => { updates += 1; });
    await reader.read();
    fake.emit({ ...snapshot([entry("other")], 1), cwd: directory === undefined ? cwd : undefined });
    assert.equal(updates, 0);
    fake.emit({ ...snapshot([entry("claude")], 2), cwd: directory });
    assert.equal(updates, 1);
  }
});

test("a changed canonical scope cannot inherit models from the old directory", async () => {
  const fake = fakeProviders(snapshot([entry("codex")]));
  const reader = createProviderCatalogReader(fake.providers, cwd);
  await reader.read();
  fake.respond(Promise.resolve(snapshot([entry("codex", { status: "loading", models: undefined })], 1, "D:\\replacement")));
  assert.deepEqual(selectableProviderEntries(await reader.read()), []);
});

test("retry refreshes discovery and recovers after a failed initial request", async () => {
  const fake = fakeProviders();
  const reader = createProviderCatalogReader(fake.providers, cwd);
  const pending = deferred<Awaited<ReturnType<Providers["snapshot"]>>>();
  fake.respond(pending.promise);
  const read = reader.read();
  pending.reject(new Error("Connection lost"));
  await assert.rejects(read, /Connection lost/);
  fake.respond(Promise.resolve(snapshot([entry("codex")], 1)));
  assert.equal(selectableProviderEntries(await reader.refresh())[0]?.provider, "codex");
  assert.deepEqual(fake.refreshes, [{ cwd }]);
  assert.equal(fake.reads.length, 2);
});

test("unmount cleanup releases demand once and ignores late updates", async () => {
  const fake = fakeProviders(snapshot([entry("codex")]));
  const reader = createProviderCatalogReader(fake.providers, cwd);
  let updates = 0;
  const release = reader.subscribe(() => { updates += 1; });
  await reader.read();
  release();
  release();
  fake.emit(snapshot([entry("claude")], 1));
  assert.equal(updates, 0);
  assert.equal(fake.released(), 1);
});
