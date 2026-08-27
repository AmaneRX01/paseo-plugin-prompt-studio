# Architecture

## Goals and boundaries

Prompt Studio is a daemon-local, plaintext-first Paseo plugin. It persists drafts, recovery data, and dispatch lineage. Worklog is a read-only projection derived from those canonical facts and owns no write workflow. The project does not provide cross-daemon, Git, or cloud synchronization. `projectId`, `workspaceId`, and absolute paths are machine-local links and must not be treated as portable vault identity.

## Runtime layers

| Layer | Directory | Responsibility | Allowed dependencies |
| --- | --- | --- | --- |
| Contribution | `index.ts` | Register RPCs, surfaces, panels, and commands | client, server, shared |
| Client | `src/client/` | React Native UI, TanStack Query, Paseo SDK/RPC calls | client, shared |
| Server | `src/server/` | Node filesystem access, vault registration, Project mapping, dispatch/generation coordination, and RPC handlers | server, shared |
| Shared | `src/shared/` | Zod RPC contracts, schemas, and DTOs | host-provided shared dependencies |

Client modules must not import `*.server.ts`; server modules must not import `*.client.tsx`. Shared modules must not depend on the Node filesystem or the React Native runtime.

## Request flow

1. `index.ts` binds shared RPC contracts to server handlers.
2. The client submits logical IDs and schema-validated input through `useRpc()`.
3. The handler resolves Paseo context and calls the Store or dispatch coordinator.
4. The Store updates canonical Markdown/JSON inside logical and cross-process file locks.
5. The response is validated again by the contract schema. Body autosave and independent tag mutations update the active Draft and Query cache separately; structural operations keep the derived catalog synchronized.

Normal Paseo operations use the host SDK. Only plugin-specific filesystem behavior uses RPC. The client never creates a second Paseo connection. Prompt generation is deliberately two-phase: short RPCs prepare/reconcile durable jobs, while the client waits on the host SDK's Agent handle outside the plugin RPC timeout and then calls a short `sync` RPC.

## Plaintext vault layout

The default root is `~/.paseo/prompt-studio` on macOS / Linux and `%USERPROFILE%\.paseo\prompt-studio` on Windows. Set `PASEO_PROMPT_STUDIO_HOME` before starting the daemon to override it.

```text
prompt-studio/
├─ README.md
├─ AGENTS.md
├─ companion.json                      # Portable identity of the single Prompt Studio vault
├─ catalog.json                         # Disposable derived index
├─ .transactions/                       # Layout/delete/generation-apply journals and deletion quarantine
├─ local/project-map.json               # External directory ⇄ Project/Workspace links and vault registration
├─ local/generation-settings.json        # Host-local provider/model/thinking choices
├─ events/YYYY/MM/*.json
├─ drafts/dr_<id>/
│  ├─ draft.md
│  ├─ meta.json
│  ├─ checkpoints/*.md
│  ├─ snapshots/<id>.md
│  ├─ snapshots/<id>.json
│  ├─ dispatches/<id>.json
│  ├─ generations/gn_<id>/
│  │  ├─ meta.json                       # Durable job state and frozen provenance
│  │  ├─ request.md                      # Exact immutable Agent input
│  │  └─ response.md                     # Exact normalized reply/candidate evidence
│  └─ events/YYYY/MM/*.json
└─ legacy/containers/<container-id>/    # Legacy manifests, events, and Worklog evidence
```

The root is the only path registered as a Paseo Project. `companion.json` stores portable vault identity. `local/project-map.json` is the only machine-local mapping file; it stores one-time Project/Workspace registration state plus mappings between external Project roots, Project IDs, Workspace locators, and logical container IDs. External Projects are not plugin-owned storage boundaries. If a directory disappears, a Paseo Project is removed, or link data becomes stale, scans emit a warning but preserve the mapping and every Draft. Host-side Project relationships are checked read-only through the Workspace list in the Paseo SDK, never through an RPC that accepts client-supplied paths.

The client loads the complete paged Workspace directory and the host-provided empty-Project records, then keeps that directory current through the Paseo Workspace subscription. A Project without a Workspace remains visible for filtering but cannot be selected as a Draft scope or new-Agent target until Paseo creates a Workspace locator. When a persisted locator is archived, server operations search only the same logical `projectId`, validate a current Workspace snapshot and root, and atomically replace the machine-local locator before continuing. They never fall back to another Project or to a global Agent search.

Draft metadata and summaries use schema v5. Scope represents only Inbox or source-Project ownership. It does not record Workspace or Agent. Workspace IDs are machine-local locators used to resolve a Project and create an Agent; Agent IDs exist only in dispatch, generation, session, and timeline facts. `contentOrigin` is either manual or generated provenance; only a body change, external edit, or checkpoint restore resets it to manual. Every scope stores its lineage directly under the single `drafts/` directory.

The client applies a one-second stabilization window to scope selection. Consecutive selections keep only the last target; returning to the canonical scope cancels the entire interaction without an RPC. A stable, effective scope change creates a checkpoint and then atomically updates the same `meta.json`. It does not move a directory or create a scope-move journal. The Draft ID and physical path remain unchanged. Selecting the same Project is a no-op and creates no checkpoint, event, or version.

Legacy `Prompt-Studio-Inbox/`, `companions/`, and `local/placements/` layouts are upgraded on first initialization with a `storage-unification.json` journal. Pending legacy scope-move journals finish first; then each Draft lineage moves into the unified `drafts/`, and remaining legacy-container files move to `legacy/containers/`. Recovery may continue when the source has moved and the target exists. If both source and target exist, recovery stops immediately to avoid creating two canonical copies. Legacy companion registrations are not deleted because their Workspace/Agent history may still be needed. The client ignores old Workspaces under the vault root, and the server refuses to relink those paths as external Projects. A new vault begins in a pending state and registers its root through the host SDK on the first catalog access; registration failure preserves the pending state and exposes a retry action.

The three-character uppercase Draft code shown in the wide editor is deterministically derived from the random Draft ID. It is a non-canonical UI identifier: it is not written to metadata, the catalog, or lineage, and cannot replace the full Draft ID at RPC boundaries.

The current version does not create or write `worklog/`. Legacy Worklog Markdown is preserved and read only as historical entries during catalog rebuilds; neither the client nor server exposes an append path.

Legacy schema-v2 `scope.workspaceId` and `scope.agentId` fields are compatibility input. Schemas drop them on read so they no longer participate in ownership, filtering, or scope comparisons; the next ordinary mutable write naturally removes them. An archived v2 Draft without `archivedFromStatus` normalizes to `draft`. Legacy v3 `starred` normalizes to `ready`, as does `archivedFromStatus: starred`. Schema v2–v4 reads normalize `contentOrigin` to manual without rewriting files; the next normal mutable write atomically upgrades them to v5. Immutable historical snapshots are not batch-rewritten, and legacy fields in them are ignored at runtime. Interrupted legacy scope-journal recovery also normalizes to Project scope.

## Draft lifecycle and permanent deletion

The active state machine is `draft ⇄ ready`. A manual `draft → ready` transition first creates a `ready` checkpoint for that revision. Only `ready` may freeze and send a new snapshot. A real title or Markdown change through autosave, an external Markdown edit, or a checkpoint restore that changes Markdown returns `ready` to `draft` in the same atomic revision and creates a `draft.status-changed` event. Either active state may be archived; metadata stores `archivedFromStatus`, and restore must return to that state. The strict autosave RPC accepts neither state nor tags. The server alone enforces content-based downgrade behavior.

Sidebar multi-selection plans lifecycle changes from catalog summaries, but the batch RPC reuses the ordinary transition path and verifies every selected Draft's logical ID, version, and content hash before writing. Mixed selections skip ineligible/no-op items. Independent eligible items continue after a stale or blocked item, and the validated response exposes changed, unchanged, and failed Draft IDs so the client can report partial completion. Restore targets each Draft's own `archivedFromStatus`; a batch never flattens archived Drafts into one active state.

## Prompt generation jobs

The related-Prompt task uses deterministic filtering and ordering, not embeddings. Current target Markdown is always included in full. Filter schema v2 exposes three independent, time-bounded sources: the target Draft's checkpoints, current Prompt bodies from selected Projects/Inbox, and current Prompt bodies matching any selected tag. A finite range is stored as `<days>d` (1–3650 days), and `all` remains valid. Settings stores three strictly ascending slider stops, defaulting to 3, 7, and 14 days; settings files written before this field existed receive those defaults in memory and are not rewritten until an explicit settings save. Project and tag sources use OR semantics, while multiple values inside either source also use OR semantics. A Prompt matching both sources is included once. Related-Prompt checkpoint history is not loaded; only the target Draft contributes checkpoint versions. Eligible non-archived current bodies are ordered by shared-tag count, same Project, timestamp, and Draft ID, and every body is deduplicated by `(draftId, contentHash)`.

Input budget is `min(64K, 50% of the selected model's declared context window)`, with 32K used when unknown. The conservative estimate is `ceil(UTF-8 bytes / 2)` and includes the built-in instructions. The target never truncates. Whole reference bodies are added in order: related current bodies, then target history; a body that does not fit is skipped intact. The preview and frozen job retain eligible/included Prompt counts, reference-version counts, target-history counts, and the truncation flag. Durable jobs created with the legacy filter shape remain readable and resumable without rewriting their immutable request or provenance. Format-only generation includes no history, references, or Project access.

`GenerationRepository` stores the job before Agent creation with stable request/client-message IDs and labels. Its state machine is `prepared → launching → running → result-ready → applied | conflict`, plus `needs-attention`, `failed`, `discarded`, and `abandoned`. A Draft may have only one nonterminal job. Creation uses a compare-and-set launch claim; lost acknowledgements reconcile by labels and Agent cwd and never create a replacement. The exact reply is newline-normalized and persisted before any Draft mutation.

Applying a reply re-locks the Draft and verifies the frozen version/hash. Success creates `before-generation` or `before-format`, writes a new revision even for identical text, sets generated provenance, and returns `ready` to `draft`. A mismatch preserves `response.md` as a conflict candidate. Applying that candidate requires another explicit latest version/hash. Manual body writes, external body edits, and restores reset provenance; metadata-only edits preserve it. Agents are explicitly archived only after a reply or terminal state is durable, and user Workspaces are never archived.

Every launch resolves the logical Draft Project on the server. Inbox, broken mappings, vault/legacy-vault paths, roots containing a vault, root symlinks/Junctions, and cwd mismatches are rejected. Codex is forced to approval-never/read-only/no-web; Kimi uses plan mode when Project access is off; other supported providers receive their strongest native deny/read policy. The complete localized task and output-only rules are also in the first user prompt because not every Paseo 0.5.1 provider honors `systemPrompt`. When Project reading is enabled, the UI presents the resulting native-policy or behavioral-only status beside that permission rather than as unrelated preview metadata.

## Tag hierarchy and independent mutation domain

Tags remain string arrays in Draft `meta.json`, but they are not part of the content revision. Add, remove, reorder, case normalization, hierarchical rename, and bulk changes must not alter `version`, `contentHash`, `updatedAt`, status, checkpoints, snapshots, or events. A single-Draft tag mutation uses the last-read tag set as its optimistic concurrency condition. Global rename and bulk operations run under logical-ID, process, and cross-process file locks.

Tags use Unicode NFC normalization, trimmed path segments, and case-insensitive keys. `A/B` places B under A. The hierarchy has no separate source of truth; it is derived from canonical Draft tags. `count` deduplicates Drafts that contain a node or any descendant, while `directCount` includes only Drafts with that exact path. Rename propagates by path prefix across every Draft. If the target exists, case-insensitive deduplication merges them. Checkpoints and send snapshots intentionally exclude tag history.

Cross-Draft rename and bulk operations use an internal journal that exists only until the current transaction finishes. Atomic tag writes place a temporary transaction marker in `meta.json`; after the cursor advances and every marker is removed, the journal is deleted. Journals are not exposed through DTOs, events, checkpoints, or user-restorable history. They exist only to complete interrupted work or conservatively preserve newer external tag edits. Applicable locks follow `vault-recovery → tags-global → catalog → draft`. Tag-directory reads recover pending journals before publishing a result, so the client never observes a partially completed hierarchy.

Recent snapshot/checkpoint limits, whether starred checkpoints consume the limit, and checkpoint stars are client display preferences in local storage. They do not modify immutable checkpoint Markdown or participate in restore, hashes, or dispatch lineage. When stars consume the limit, starred checkpoints are kept first and recent unstarred entries fill the remaining slots. Otherwise all starred checkpoints are shown in addition to the configured number of recent unstarred entries. The final list is sorted newest first.

Permanent deletion is not a persisted Draft state. The RPC accepts only a logical Draft ID and requires an archived Draft with no pending or malformed dispatch. Confirmation must repeat the matching Draft ID. The transaction writes a `draft-delete` journal, moves the complete Draft directory into controlled quarantine, recursively deletes it after boundary validation, removes Draft events from current and legacy containers, removes the journal, and rebuilds the catalog. Initialization idempotently completes an interrupted deletion. A broken external Project link never starts this process. Only an explicit in-plugin action can permanently delete a Draft. Deletion leaves no tombstone or Worklog entry and cannot remove a message already accepted into a Paseo Agent session.

## Catalog and refresh boundary

`catalog.json` is a disposable metadata index without Draft bodies. The daemon also holds a complete derived catalog cache in memory. The catalog filters by state and Project, not by Workspace or Agent. Workspace- and Agent-context Scratchpads for one Project read the same Draft set. Normal Prompt Studio, Worklog, and Scratchpad queries read the cache instead of repeatedly traversing every checkpoint, snapshot, dispatch, event, and legacy Worklog. A full canonical rebuild occurs only on the process's first query, a missing cache, or an explicit client **Refresh files** action.

Prompt Studio catalog queries do not poll on a timer. The catalog has a 60-second freshness window and does not automatically rescan on focus. The independent Paseo Workspace/Project directory uses a complete paged snapshot, a connection-local subscription for Workspace upsert/removal events, and a 60-second/focus refetch to discover empty-Project changes that the public Workspace subscription does not expose. **Refresh files** refreshes both directories. Only an open Draft is read again when focus returns, allowing external-edit detection. Autosave responses include the summary, an optional checkpoint, and an optional event; client and server caches merge those increments without a full scan. If title and Markdown are unchanged, autosave creates no checkpoint, event, or version. Tag mutations update tags and the derived hierarchy incrementally. Draft lists sort by most recent update and have no Draft-star priority.

After an external tool edits a closed Draft, the user can run **Refresh files** for full reconciliation. An open Draft reconciles independently when read. External modifications still become checkpoints and events and must never be silently overwritten by autosave.

## Consistency and safety invariants

- RPC boundaries accept logical IDs, never arbitrary client-supplied filesystem paths.
- Only the vault root is registered as the plugin Project. External Project roots are links in `project-map.json`; the plugin never creates or deletes Drafts inside them.
- A broken external Project link may only emit a warning. It must not delete mappings, Drafts, or lineage.
- Writes use temporary files and atomic replacement, with boundary checks and symlink/Junction rejection.
- Autosave includes the last-read `version` and `contentHash`; stale writes return a conflict.
- Checkpoint read and restore accept only Draft/Checkpoint logical IDs and validate file lineage and body hashes. Restore includes the last-read version/hash and creates a `restore` checkpoint before replacing current Markdown. The new revision preserves title, tags, state, and scope.
- Field-identical autosave and already-satisfied state transitions are no-ops that write no canonical files or events.
- Tag mutations are isolated from the body revision. They must not change version, hash, update time, state, recovery/dispatch lineage, or Worklog.
- Tag comparison, filtering, rename, merge, and bulk removal are case-insensitive. A parent filter matches itself and descendants; multiple selected nodes use OR semantics.
- A rapid scope round trip inside the client stabilization window must cancel without a server call, checkpoint, event, or version change. A stable effective change submits exactly once.
- `draft → ready` creates a `ready` checkpoint. Any real content edit returns `ready` to `draft`; a no-op save does not.
- An external edit becomes a checkpoint and event on the next read or save and cannot be silently overwritten.
- Generation RPCs accept only logical IDs and filters; clients cannot submit bodies, absolute paths, Agent cwd, or Agent replies. One unresolved job blocks canonical Draft mutations and sending until apply, discard, or abandon.
- A generation request is persisted before Agent creation. Reconciliation must reuse its stable IDs and labels, and an uncertain launch acknowledgement must never authorize a second Agent.
- Generated replies are persisted before apply. Stale version/hash creates a conflict candidate; successful apply creates an undo checkpoint and generated provenance even when the reply equals the current body.
- Generated Agents may never use the Prompt Studio managed vault as cwd. Project roots that overlap it in either direction or resolve through a root link are rejected.
- Worklog is a read-only projection of user activity and dispatch results. It exposes no create, edit, or note-write path. Recovery checkpoints remain in Draft lineage and are counted in the Draft but are not expanded into the main timeline. Canonical scope/state events remain complete, while round trips committed within ten seconds are projected as a net result; an unchanged net state is hidden. Dates and times use the client's local timezone.
- Legacy Worklog Markdown remains read-only and unchanged. Layout migration may archive its parent container under `legacy/`, but path-boundary and symlink/Junction protections still apply.
- Dispatch freezes a snapshot first. Failed retry reuses the snapshot and `clientMessageId`; an archived Draft must be restored before retry.
- Pending or failed dispatch may reconcile with the Agent timeline in any Draft state. Reconciliation confirms an existing delivery and never resends by itself.
- Permanent deletion rejects active Drafts, pending/malformed dispatches, stale version/hash, out-of-bound paths, and symlink/Junction traversal. Completion must leave no second canonical lineage or Draft events.
- A single corrupt JSON file produces a warning and is skipped; other canonical content still scans.
- `catalog.json` is never authoritative and must remain rebuildable after deletion or corruption.

## God-item audit

`studio.client.tsx` is approximately 1,300 lines after extracting the send panel, Prompt Agent actions/settings, Draft list, checkpoint view, Worklog, header, formatters, and types. Pure lifecycle rules also live in shared modules. The server has extracted persistence schemas, safe filesystem operations, checkpoint/generation repositories, context building, provider policy, generation coordination, and `VaultRepository`; the latter centralizes the single root, Project mappings, one-time registration, and legacy-layout recovery. `store.server.ts` remains the largest structural risk.

Preferred extraction order:

1. Extract `DraftRepository` for draft/meta/checkpoint/snapshot operations and scope metadata updates.
2. Extract `CatalogReader` for canonical event scans, legacy Worklog scans, and derived-index refresh.
3. Keep `PromptStudioStore` as the transaction-coordination facade so locks and invariants stay centralized.
4. Separate `DraftEditor` from the Studio coordinator and add component-level coverage for its autosave state machine.

`send-panel.client.tsx`, `ui.client.tsx`, `handlers.server.ts`, and `i18n.client.ts` are roughly 390–480 lines each but currently retain cohesive responsibilities. Split them only when a second dispatch flow, a second UI primitive set, or multilingual package separation creates a real boundary.

## Architecture change rules

- Assign every new feature to client, server, or shared before adding files.
- Keep `index.ts` limited to contribution composition.
- Never bypass the Store to write the plaintext vault directly.
- Storage-layout, schema, migration, or lineage changes require recovery/compatibility tests and an update to this document.
- Paseo contribution or cross-runtime import changes require compiler smoke.
