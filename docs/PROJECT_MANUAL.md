# Prompt Studio Project Manual

> Document version: 1.1
>
> Project: Prompt Studio for Paseo
>
> Updated: August 26, 2026

## 1. Overview

Prompt Studio is a trusted local Paseo plugin that manages prompts from editable drafts through agent dispatch and activity review.

Markdown and JSON files are the only canonical source. The plugin does not use a database and never stores draft bodies in Paseo plugin configuration. Users can edit, organize, search, and dispatch prompts in Paseo while retaining direct access to the underlying plaintext files.

Prompt Studio is designed for:

- developing long prompts over multiple editing sessions;
- managing drafts across Paseo Projects and Workspaces while remaining free to choose any agent as a dispatch target;
- retaining immutable evidence of the exact content accepted by an agent;
- retrying failed sends without accidentally delivering a different revision or creating duplicates;
- reviewing draft changes, dispatch results, and linked sessions in a read-only timeline; and
- local, transparent, backup-friendly prompt workflows without a database.

## 2. Core design

### 2.1 Plaintext first

All canonical data is stored in readable Markdown and JSON files. `catalog.json` is only a derived query index; it can be deleted and rebuilt from canonical files.

### 2.2 Mutable drafts and immutable sends

A draft remains editable. Before every send, Prompt Studio creates a checkpoint and freezes an immutable snapshot. Later draft edits never change the content already delivered to an agent.

### 2.3 Safe saves

The editor autosaves about 700 milliseconds after typing stops. Each save includes the last-read version and content hash. If an external editor or another process changes the file, Prompt Studio stops the save and reports a conflict instead of silently overwriting the external change.

### 2.4 Recoverable dispatch

Every dispatch has a stable `clientMessageId`. A failed retry reuses the original snapshot and message ID. When a request has an uncertain result, Prompt Studio reconciles it against the agent timeline before deciding whether another send is safe.

### 2.5 Draft display codes

On wide layouts, the editor shows a stable three-character draft code beside the version, for example `AV9`. Characters come from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, excluding visually ambiguous characters such as `I`, `O`, `0`, and `1`.

This code is only a visual aid. Storage, RPCs, and dispatch lineage always use the complete Draft ID.

### 2.6 Recoverable Prompt generation

For a saved Project-scoped draft, Prompt Studio can ask a new Agent to optimize the task from related Prompt context or only improve its prose and Markdown format. The related task can include current/reference checkpoint history, tag matches, time windows, selected Projects, and Inbox. Before launch, the UI reports both eligible and actually included Prompt/version counts and any whole-version budget trimming.

Each generation is persisted before Agent creation with stable reconciliation identifiers. Only one unresolved generation may exist for a Draft. A successful reply first creates an undo checkpoint, then becomes a new generated revision of the same Draft. A concurrent edit is never overwritten: the exact reply remains available as an explicit conflict candidate.

## 3. Product surfaces

### 3.1 Prompt Studio and Worklog

Paseo provides two global sidebar entries. They are also available from the Command Center with `Ctrl+K` on Windows/Linux or `⌘K` on macOS:

- **Prompt Studio / Open Prompt Studio** — search, filter, create, edit, mark ready, archive, permanently delete, and dispatch drafts from every scope.
- **Worklog / Open Worklog** — inspect a read-only timeline of draft activity, scope changes, sends, failures, and session links. It does not expose create, edit, or note-writing actions.

### 3.2 Prompt Scratchpad

Workspace and agent contexts expose one project-level Command Center action:

- **Open Prompt Scratchpad** — open the shared draft board for the current Workspace's Project, then dispatch a prompt to a Workspace, an existing agent, or a new agent.

A Scratchpad shows all drafts for the current Project. New Scratchpad drafts inherit that Project scope. Different agent task Workspaces under the same Project see the same draft set.

### 3.3 Draft management

Each draft supports:

- a title and Markdown body;
- unlimited hierarchical tags, where `A/B` appears as B under A and comparison is case-insensitive;
- the persistent states `draft`, `ready`, and `archived`, plus permanent deletion for eligible archived drafts;
- Inbox or Project scope;
- autosave, checkpoints, immutable send snapshots, and event history; and
- constrained lifecycle transitions, archive restoration, and guarded permanent deletion.

The global draft list searches titles, tags, and current Markdown. It can filter by state, Project, or multiple nodes in the tag tree and sorts results by the most recent content update.

Tag nodes show direct and aggregate counts. Selecting a draft tag applies its filter. Tags can be renamed globally, automatically merged into an existing case-insensitive destination, or added to and removed from multiple selected drafts. Checkpoints may be starred; drafts themselves do not have a starred state.

### 3.4 Worklog

Worklog derives a single timeline from Prompt Studio facts, including:

- draft creation and updates;
- scope changes, with source and destination Projects;
- successful and failed dispatches; and
- linked Paseo agent sessions.

Worklog does not import unrelated agent conversations. A linked session stores only the agent information needed for the relationship and the exact user message sent by Prompt Studio.

Checkpoints are recovery data. They remain in the draft lineage and are counted in the editor, but they are not expanded into individual Worklog rows by default.

Worklog is strictly read-only. It has no UI, RPC, or server path for adding manual log entries. Legacy Worklog Markdown remains available as read-only historical notes and is never rewritten.

### 3.5 Prompt Agent actions and settings

The action bar below the Markdown editor has three actions:

- **Add boilerplate** opens one language-neutral list of reusable phrases. Selecting a phrase appends it to the end of the current Markdown with a blank-line separator and enters the normal autosave flow. Users can add, edit, and delete phrases; a fresh client starts with three common English fragments.
- **Prompt optimization** opens the context-source and count preview. Checkpoints from the current Draft, Prompt bodies from selected Projects/Inbox, and Prompt bodies matching selected tags are independently enabled and each has its own time range. The current Draft's Project and tags are selected initially; enabled Project and tag sources are combined and deduplicated. The three configurable day stops default to 3, 7, and 14 days, with **All time** fixed as the last option. Project-file inspection defaults off for every run.
- **Quick optimization** directly performs a light prose/Markdown cleanup. It never includes other Prompts, history, or Project files.

Settings keeps separate provider, model, and thinking choices for these tasks and persists three strictly ascending reference-range day values. If a saved choice is no longer available, Prompt Studio reports it and does not silently choose another. During an unresolved job, body/scope/state/send/archive actions for that Draft are locked, but other Drafts remain browsable. AI-optimized revisions use the same editor and Draft-list presentation as manually edited revisions.

Prompt Studio rejects its managed vault as Agent cwd, uses the strongest provider-native read-only settings available, and repeats the file-access restrictions in the localized task prompt. When Project inspection is enabled, the UI shows the resulting protection level beside that permission.

### 3.6 Localization and responsive layout

The interface supports English and Simplified Chinese. It adapts to wide and compact layouts and uses Paseo theme tokens for light and dark themes.

## 4. Terminology

| Term | Meaning |
| --- | --- |
| Inbox | Global logical scope not linked to an external Project |
| Project link | Machine-local relationship between an external project directory and a Paseo Project/Workspace in `project-map.json` |
| Scope | A draft's logical ownership: the global Inbox or one Project; it is not a Workspace or agent dispatch target |
| Draft | The current editable, autosaved prompt |
| Checkpoint | A staged Markdown copy used for recovery |
| Snapshot | An immutable, byte-exact Markdown copy frozen before dispatch |
| Dispatch | One delivery of a snapshot, including its target, state, attempts, and message ID |
| Generation | One durable Prompt-optimization job, its exact Agent request/reply evidence, and apply/conflict provenance |
| Lineage | The relationships among a draft, snapshots, dispatches, and agent sessions |
| Worklog | A read-only activity timeline derived from canonical draft and dispatch facts |
| Canonical data | Markdown and JSON files that serve as the source of truth |

## 5. Installation

### 5.1 Requirements

- Node.js
- npm
- Paseo Desktop and daemon with a compatible plugin API
- Plugins enabled on the target daemon

Paseo plugins are trusted and unsandboxed. Server code can access files, processes, credentials, and network resources on the daemon machine. Review the source before installing it and enable plugins only on a trusted machine.

### 5.2 Install dependencies and validate

Run from the repository root:

```powershell
npm install
npm run check
npm run smoke:compiler
```

- `npm run check` performs strict TypeScript checking and integration tests.
- `npm run smoke:compiler` uses the local Paseo plugin compiler to validate the client/server bundles, cleanup function, and contribution manifest.

### 5.3 Install the plugin

```powershell
paseo plugin install D:\path\to\paseo-plugin-prompt-studio
paseo plugin ls --json
```

Confirm that the runtime ID is `prompt-studio`, its state is `running`, and no load error is present.

### 5.4 Reload after source changes

```powershell
npm run check
paseo plugin reload prompt-studio
paseo plugin logs prompt-studio
```

Use `plugin reload` for source changes. Do not restart the daemon merely to load a plugin edit.

## 6. Usage

### 6.1 Create and edit a draft

1. Open Prompt Studio or a contextual Prompt Scratchpad.
2. Select **New draft**.
3. Enter a title and Markdown body. In the tag input, press Enter or comma to create a removable chip. Existing tags autocomplete, and `/` creates a hierarchical path.
4. Wait for the editor state to move from unsaved to saving and then saved.
5. When the content is ready to dispatch, manually change the state from `draft` to `ready`. Prompt Studio immediately creates a checkpoint for that revision.

Drafts created in the global surface start in the Inbox. Drafts created from a Scratchpad inherit the current Project scope. In Workspace and agent contexts, the Workspace ID only locates the Project. An agent context may also preselect a dispatch target, but a draft never belongs to a Workspace or agent.

The active lifecycle is `draft ⇄ ready`. Either active state can be archived; restoring an archive returns it to the previous active state. Any real title or Markdown change to a ready draft returns it to `draft`, including external body edits and checkpoint restoration that changes the body.

Tags are a separate metadata domain. Tag edits do not change the content version, `updatedAt`, lifecycle state, checkpoints, snapshots, or events. A no-op content save also leaves a ready draft unchanged.

### 6.2 Change scope

A saved draft can move between:

- the global Inbox; and
- any available Project.

Workspace and agent IDs are not part of scope. They remain freely selectable dispatch targets and do not change draft ownership.

After a scope selection, the client waits one second for it to stabilize. Further selections replace the pending destination. Returning to the canonical scope during this window cancels the complete interaction: no server request, checkpoint, event, or version change occurs.

A stable, real scope change is committed once. The server first creates a checkpoint and then atomically updates the same draft metadata under transaction locks. The Draft ID and physical `drafts/dr_<id>` path remain unchanged; no second canonical copy is created.

### 6.3 Send to an existing agent

1. Wait until the draft is saved and set it to `ready`. Draft and archived states cannot send.
2. Under **Send current version**, select **Existing agent**.
3. Search for and select a non-archived agent.
4. Select **Freeze snapshot and send**.
5. Review the `accepted`, `failed`, or `pending` state in the dispatch history.

### 6.4 Create an agent and send

1. Select **New agent**.
2. Choose a source Workspace, provider, and model.
3. Select provider-supported mode and reasoning effort, and optionally enter an agent title.
4. Select **Freeze snapshot and send**.

The new agent runs in the selected source Workspace. Sending does not change the draft's scope. Prompt Studio refuses to create an agent inside its own vault Workspace to avoid recursive management.

### 6.5 Handle failed or uncertain sends

- **Retry the same snapshot** reuses the original snapshot and `clientMessageId`; it never substitutes the latest draft content.
- **Reconcile timeline** checks the target agent's canonical timeline to determine whether the message was already accepted.
- An `accepted` dispatch is never sent again.

An archived draft cannot retry a failed dispatch and must be restored first. Timeline reconciliation remains available because it only confirms an existing delivery and never sends a message.

### 6.6 Inspect snapshots and checkpoints

In **Snapshots and checkpoints**:

- Select a sent version to view the exact Markdown received by the agent. Historical snapshots are permanently read-only.
- Select a checkpoint to view its version, reason, time, hash, and read-only Markdown.
- Select **Restore this Markdown**, then confirm, to restore that body as a new current revision.

Checkpoint restoration changes only Markdown. The current title, tags, lifecycle state, and scope remain unchanged. Before replacement, Prompt Studio saves the current body as a new `restore` checkpoint, allowing the restoration itself to be undone.

Restoration includes the current version and content hash for optimistic concurrency control. An external edit or concurrent write therefore cannot be overwritten silently.

### 6.7 Permanently delete an archived draft

1. Archive the draft. If it has a `pending` dispatch, complete a retry or timeline reconciliation first.
2. Select **Permanently delete** in the archive notice.
3. Review the checkpoint, snapshot, and dispatch counts that will be removed.
4. Enter the complete Draft ID shown by the page and confirm.

Permanent deletion removes the canonical draft directory, all checkpoints, snapshots, dispatches, cross-container events, and derived catalog entries for that draft. It cannot be undone. Messages already accepted into a Paseo agent session are external history and are not deleted with the local draft.

### 6.8 Review Worklog

1. Open the standalone **Worklog** surface.
2. Use search and filters to narrow the activity timeline.
3. Select **Refresh files** when canonical files need to be rescanned.

Worklog never offers draft creation, draft editing, or manual note entry. Make all changes in Prompt Studio or a Scratchpad.

## 7. Conflicts and recovery

### 7.1 Autosave conflicts

When an external edit or concurrent write changes the version or hash, the editor:

1. stops autosave;
2. displays a conflict or save error; and
3. blocks navigation away from the current draft to protect local unsaved state.

Select **Reload canonical file** to load the latest disk revision before continuing. External changes are first recorded as an `external-edit` checkpoint and event.

### 7.2 Periodic checkpoints

On a successful autosave, Prompt Studio creates a periodic checkpoint when at least five minutes have passed since the previous checkpoint. Scope changes, sends, and external edits force a checkpoint. Checkpoint restoration first creates a `restore` checkpoint of the current body.

### 7.3 Catalog recovery

`catalog.json` is safe to delete. Normal surface loads and window refocuses use the daemon's in-process derived cache instead of repeatedly scanning the vault. Selecting **Refresh files** rebuilds the catalog from draft, event, snapshot, dispatch, and legacy Worklog files. An open draft is reconciled separately for external edits.

### 7.4 Damaged files

When a scan encounters one malformed JSON file, Prompt Studio reports a warning and skips that file while loading all other canonical content. Use the relative path in the warning to repair it or restore it from backup.

## 8. Data storage

### 8.1 Default location

The default plaintext root is:

```text
%USERPROFILE%\.paseo\prompt-studio
```

Set `PASEO_PROMPT_STUDIO_HOME` before starting the daemon to use another location. This changes canonical data placement; back up and verify existing data before migrating it.

### 8.2 Directory layout

```text
prompt-studio/
├─ README.md
├─ AGENTS.md
├─ companion.json                    # portable identity of the single vault
├─ catalog.json                       # disposable derived index
├─ .transactions/                     # recovery journals and delete quarantine
├─ local/project-map.json             # local directory and Project/Workspace links
├─ events/YYYY/MM/*.json
├─ drafts/dr_<id>/
│  ├─ draft.md
│  ├─ meta.json
│  ├─ checkpoints/*.md
│  ├─ snapshots/<id>.md
│  ├─ snapshots/<id>.json
│  ├─ dispatches/<id>.json
│  └─ events/YYYY/MM/*.json
└─ legacy/containers/<container-id>/  # evidence retained from older layouts
```

The complete root is registered as one dedicated Prompt Studio Paseo Project. On the first catalog read, the plugin attempts to register this path through the host SDK. A failure remains visibly pending with a retry action.

`companion.json` holds the portable vault identity. `local/project-map.json` holds machine-local vault registration state and mappings among external directories, Project IDs, and Workspace locators. These local links are not portable cross-daemon identities.

Every draft resides in the same `drafts/` directory. Changing scope only updates one metadata file and never moves the lineage.

If an external project directory becomes unavailable or its Paseo Project is removed, Prompt Studio reports a link warning but preserves the mapping and every draft. Permanent deletion is available only through the plugin and remains protected by archive state, version/hash checks, and unresolved-dispatch checks.

During an upgrade from an older layout, Prompt Studio first recovers unfinished scope moves, then uses `.transactions/storage-unification.json` to merge Inbox and companion draft lineages into the unified `drafts/` directory. Recovery is idempotent after interruption. If both source and destination contain the same Draft ID, migration stops for manual inspection instead of guessing which copy is canonical.

Non-draft evidence from old containers is retained under `legacy/containers/`. The plugin does not automatically delete old companion Paseo Project records because their Workspace and agent history may still matter. It ignores legacy Workspaces under the vault root and refuses to relink archived subdirectories as external Projects.

The current version does not create a `worklog/` directory and never modifies legacy Worklog Markdown. Old files are read only for historical compatibility.

### 8.3 Backup recommendations

Back up the complete plaintext root. In particular, preserve:

- `companion.json` and `drafts/`;
- `events/` and `.transactions/`;
- `local/project-map.json` when restoring to the same machine; and
- `legacy/` after an upgrade from an older layout.

`catalog.json` does not need to be part of a critical backup. After restoration, verify directory permissions and select **Refresh files** in Prompt Studio.

## 9. Security and data integrity

Prompt Studio protects canonical data through the following rules:

- RPC inputs accept logical IDs instead of arbitrary client-supplied filesystem paths.
- Writes use temporary files and atomic replacement.
- Every resolved path is checked against its storage boundary.
- Symlinks and Windows Junctions cannot escape a container.
- In-process logical locks and cross-process file locks serialize mutations.
- Versions and SHA-256 content hashes provide optimistic concurrency control.
- Scope changes atomically update metadata in the unified draft directory instead of moving files. Older multi-companion layouts use recoverable transaction journals.
- Lifecycle transitions use a server-side state machine and dedicated RPCs. Autosave cannot accept a client-supplied state, although a real content edit server-side forces `ready` back to `draft`.
- Permanent deletion accepts a logical Draft ID only, requires an archived state, full-ID confirmation, and no unresolved dispatch, and uses a recoverable delete journal.
- Dispatch retries preserve the original snapshot and message ID.
- Logs must never include passwords, tokens, or other secrets.

## 10. Project structure and runtime boundaries

```text
.
├─ index.ts                         # contribution-composition entry point
├─ src/client/                      # React Native UI, hooks, and Paseo SDK calls
│  └─ studio/                       # Studio views, types, and formatting logic
├─ src/server/                      # Node filesystem, registration, dispatch, and RPC handlers
│  └─ storage/                      # persistence models and safe file operations
├─ src/shared/                      # Zod RPC contracts and runtime-neutral DTOs
├─ tests/                           # storage and dispatch integration tests
├─ scripts/                         # Paseo compiler smoke test
└─ docs/                            # project documentation
```

Runtime boundaries are strict:

- `*.client.tsx` may import client and shared modules only.
- `*.server.ts` may import server and shared modules only.
- `*.shared.ts` must not depend on Node filesystem or React Native runtime APIs.
- `index.ts` registers RPCs, surfaces, panels, and commands without owning business logic.
- Normal Paseo operations use the host SDK; plugin-specific daemon behavior uses Zod-validated RPCs.

## 11. Development and validation

### 11.1 Commands

```powershell
npm run typecheck
npm test
npm run check
npm run smoke:compiler
```

Run `npm run check` after TypeScript or test changes. Also run `npm run smoke:compiler` after changing `index.ts`, contribution registration, RPC wiring, file suffixes, or cross-runtime imports.

### 11.2 High-risk changes

Add focused recovery and regression tests for changes to:

- storage schemas or directory layout;
- data migration or scope movement;
- snapshot, dispatch, or session lineage;
- the draft lifecycle, archive restoration, or permanent deletion;
- external-edit detection and concurrent writes; or
- file locking, path boundaries, and symlink/Junction rejection.

### 11.3 Manual acceptance checklist

1. `prompt-studio` is `running`, with no unexpected stderr in its logs.
2. Sidebar and Command Center actions open Prompt Studio and Worklog separately. Prompt Studio exposes draft actions; Worklog exposes only search, refresh, and a read-only timeline.
3. Different Workspace or agent contexts under one Project expose one **Open Prompt Scratchpad** action and open the same project-scoped draft set.
4. Autosave, external-edit conflict handling, and canonical reload behave as expected.
5. `draft ⇄ ready` works in both directions. Marking ready creates a checkpoint, a real edit returns the draft to `draft`, and both active states archive and restore correctly.
6. Drafts have no starred state, filter, or pinning. Only ready drafts can send; checkpoint stars remain independent.
7. A scope change preserves the Draft ID and `drafts/dr_<id>` path and leaves exactly one canonical lineage.
8. Existing-agent sends, new-agent sends, failed retries, and timeline reconciliation all work.
9. Configure both Prompt Agent tasks. Verify related-context counts and truncation, format-only isolation, Project-read confirmation, Generated provenance, ready-to-draft downgrade, and the undo checkpoint.
10. Edit the canonical Markdown during generation. Confirm that the reply becomes a conflict candidate, stale apply is rejected, and explicit apply/discard resolves the Draft lock without creating a second Agent.
11. Permanent deletion requires an archived draft and the complete Draft ID. Pending dispatch or generation lineage blocks deletion, and an interrupted deletion resumes from its journal.
12. Deleting `catalog.json` still allows a complete list and timeline rebuild.
13. Wide and compact layouts, English and Simplified Chinese, and light and dark themes remain usable. Destructive actions use theme status colors, and confirmations fit compact layouts.

## 12. Troubleshooting

### Plugin entries do not appear

Confirm that plugins are enabled on the target daemon, `paseo plugin ls` reports `running`, and the Paseo client is viewing the host where Prompt Studio is installed.

### The UI does not change after a source edit

```powershell
npm run check
paseo plugin reload prompt-studio
```

### An RPC fails or the plugin does not start

```powershell
paseo plugin ls --json
paseo plugin logs prompt-studio
```

Inspect Zod input/output validation, client/server boundary imports, filesystem permissions, and compiler errors.

### The vault exists but Paseo registration failed

The data remains intact. Use **Retry Project/Workspace registration** in the visible warning and confirm that the daemon can open the Prompt Studio root. The plugin registers only the vault root; it does not create a companion Project for every source Project.

### Sent content differs from the current draft

This is expected. The agent received the snapshot frozen at send time, while the draft remained editable. Open **Snapshots and checkpoints** to inspect the exact content sent.

### A Prompt Agent is still running or needs attention

Return to the Draft to inspect the durable job. **Sync** reconciles the recorded Agent and never creates a replacement. A timeout does not cancel the Agent. Permission/provider failures preserve their state; use **Abandon** only when you intentionally want to resolve that job. If a generated reply conflicts with a newer Draft revision, apply it against the latest version or discard it.

## 13. Known boundaries

- Prompt Studio manages daemon-local data only. It does not provide cross-daemon, Git, or cloud synchronization.
- The Paseo plugin API is evolving. After upgrading Paseo or `@getpaseo/client`, rerun the complete checks and compiler smoke test.
- Worklog shows only Prompt Studio-related activity. It does not copy complete agent conversations or accept manual notes.
- Permanent deletion removes only the local Prompt Studio canonical lineage. It cannot delete messages already sent to a Paseo agent session.
- An unavailable external Project directory never deletes its `project-map.json` entry or drafts. Restore the directory and refresh to make the link usable again.
- `projectId`, `workspaceId`, and absolute paths are machine-local placement data, not portable identity.
- Prompt Agent read restrictions are defense in depth, not an OS/container boundary. Providers marked behavioral-only may technically read other daemon-user-readable paths despite the task prohibition.
- The Store remains the project's largest aggregation point. Prefer extracting a focused repository before adding more persistence behavior.

## 14. Related documentation

- [Overview and quick start](../README.md)
- [Architecture and data integrity](ARCHITECTURE.md)
- [Development, testing, and manual validation](DEVELOPMENT.md)
- [Agent collaboration rules](../AGENTS.md)
- [Paseo plugin reference](https://paseo.sh/docs/plugins/reference)
- [Paseo SDK reference](https://paseo.sh/docs/sdk/reference)
