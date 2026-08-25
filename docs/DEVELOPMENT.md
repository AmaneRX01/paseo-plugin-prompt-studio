# Development

## Common commands

```powershell
npm install
npm run typecheck
npm test
npm run check
npm run smoke:compiler
```

`npm run check` runs strict TypeScript validation and the Node integration tests. `npm run smoke:compiler` uses the local Paseo Desktop plugin compiler to verify the client/server bundles, cleanup behavior, and contribution manifest.

## Change workflow

1. Read the root `AGENTS.md` and the relevant modules.
2. Preserve the `*.client.tsx`, `*.server.ts`, and `*.shared.ts` runtime boundaries.
3. Prefer small modules in the existing feature directory instead of expanding the Studio or Store aggregation files.
4. Add integration coverage under `tests/` when behavior changes.
5. Run `npm run check`. Also run `npm run smoke:compiler` after changing the entry point, RPC registration, or a cross-runtime import.
6. For an installed plugin, apply source changes with `paseo plugin reload prompt-studio`, then inspect `paseo plugin logs prompt-studio`.

## High-risk test areas

Automated tests cover these high-risk paths:

- Single-vault creation, Project registration retries, and external directory/Project link mappings.
- Journaled upgrades from legacy Inbox/companion layouts, interrupted recovery, stabilized Project-scope changes, rapid round-trip no-ops, legacy `scope.workspaceId`/`scope.agentId` compatibility, and a single canonical lineage.
- Missing external Project directories producing warnings without deleting drafts; permanent deletion remains an explicit plugin action.
- Catalog caching, explicit rebuilds, corrupt-JSON degradation, and external Markdown edits.
- The independent tag concurrency domain, case-insensitive normalization, hierarchical counts and filters, global rename/merge, bulk changes, and interrupted transaction recovery.
- Optimistic concurrency, cross-process file locking, and periodic checkpoints.
- Checkpoint content reads, hash/lineage validation, pre-restore backups, reversible restores, no-ops, and stale-revision rejection.
- Snapshot immutability, stable message IDs, failed-send retries, retry rejection while archived, and read-only reconciliation after archive.
- Existing/new Agent dispatch boundaries and linked session timelines.
- The absence of Worklog write paths, no writable Worklog directory in the vault, and safe read-only compatibility with legacy Worklog Markdown.
- Junction and symlink boundary protection.

## Client visual system

`src/client/ui.client.tsx` is the single source for client geometry and theme styling. Interactive controls use two heights: 38 px standard and 32 px compact. Buttons, single-line inputs, and interactive options use a 6 px radius; cards and empty states use an 8 px radius. Fully rounded geometry is reserved for read-only status labels, radio indicators, and timeline nodes.

- Controls in one row must all use the standard size or all use `small`. Do not patch alignment locally with `minHeight` or `paddingVertical`.
- Borderless editors use the `bare` variant of `NativeTextInput`. Do not override the shared input with local `backgroundColor` or `borderRadius: 0` styles.
- Components must not hard-code colors. Text, backgrounds, borders, statuses, and accents come from the Paseo theme or `paletteOf(theme)`.
- Keep interactive options on one line and truncate when necessary so long Project, Workspace, Provider, or Model names do not increase row height.
- Manually verify UI changes in wide and compact layouts, in English and Chinese, and in light and dark themes. Save comparison screenshots for important surfaces.

## Manual acceptance checklist

1. Confirm that `prompt-studio` is `running` and its logs contain no unexpected stderr.
2. Open Prompt Studio and Worklog from both the sidebar and Command Center. Prompt Studio must expose draft actions; Worklog must expose only search, refresh, and the activity timeline.
3. From different Workspace/Agent contexts in one Project, confirm that the Command Center shows exactly one **Open Prompt Scratchpad** entry. Each context must open the same Project draft set, and draft scope must not include a Workspace or Agent.
4. Create an Inbox draft, let it save, then assign a Project scope. The Draft ID and `drafts/dr_<id>` path must remain unchanged, with no scope-move journal.
5. Verify `draft ⇄ ready`, the ready checkpoint, and automatic return to draft after content edits. Only ready drafts may be sent to an existing or new Agent. Inspect the snapshot, dispatch, `clientMessageId`, and linked session.
6. Perform `A → B → A` within one second. The UI must cancel the pending scope change without changing the version, checkpoints, or events. Remaining on B past the stabilization window must submit once, and Worklog must show the source and target scope without expanding checkpoint activity.
7. Archive and restore from both draft and ready, confirming restoration to the prior active state. Permanent deletion must require the full Draft ID, reject pending dispatches, and remove the draft from the list, Worklog, canonical lineage, container events, and catalog.
8. Delete `catalog.json`, select **Refresh files**, and confirm a complete plaintext rebuild. Temporarily move a linked Project directory and confirm that only a link warning appears and no drafts are deleted. Ordinary window focus must not trigger continuous full scans.
9. Verify wide/compact layouts, English/Chinese UI, and light/dark themes. Pay particular attention to the ready accent, checkpoint stars, and the permanent-delete danger token.
10. Open checkpoints with different reasons in **Snapshots and checkpoints**. Confirm read-only content, secondary confirmation, the pre-restore backup, and success feedback. Create a conflict with an external edit and confirm that restore does not overwrite the canonical file.
11. Create, remove, and autocomplete flat and hierarchical tags. Verify the tree, counts, click-to-filter behavior, rename/merge, and bulk add/remove in wide and compact layouts. Confirm that tag actions do not change draft version, `updatedAt`, status, or checkpoint/event counts.

## Paseo API compatibility

The plugin API is still evolving. After upgrading Paseo or `@getpaseo/client`, generate a temporary plugin with the matching CLI and compare its declarations, then run typecheck and compiler smoke. Do not create a separate Paseo client inside this plugin; UI code uses the host SDK, and plugin-specific daemon behavior uses schema-validated RPC.
