> [!IMPORTANT]
> **Global sidebar surfaces require a Paseo build with the Agent-creation race fixed.**
>
> Official Paseo 0.8.0 retains the core **New Workspace → Draft Agent handoff** race: when several retained Draft screens are mounted, the same pending Draft can be processed multiple times and each duplicate `create_agent_request` creates another Agent in the same Workspace. In the latest confirmed incident, one `workspace.create.request` was followed by seven independent Agent creation requests, producing seven Agents within approximately 260 ms: one intended Agent and six duplicates.
>
> This repository is used with a Paseo fork that adds the missing cross-instance Draft consumption and daemon-side creation idempotency, so Prompt Studio again registers its global Prompt Studio and Worklog sidebar surfaces and global Command Center actions. Plugin-side safeguards remain in place regardless of the host: dispatch fails closed across processes and coalesces the same canonical Draft revision and target even when retained clients supply different Dispatch IDs. On an unfixed official build, this global configuration can make native Agent creation unreliable; do not rely on such a build for important work.

# paseo-plugin-prompt-studio

Prompt Studio is a plaintext-first Paseo plugin for drafting, organizing, versioning, and safely dispatching prompts to agents. It keeps canonical content in human-readable Markdown and JSON, preserves immutable send snapshots, and presents related activity in a read-only worklog.

The product name is **Prompt Studio for Paseo**. The repository and npm package name is `paseo-plugin-prompt-studio`; the Paseo runtime ID remains `prompt-studio`.

## Highlights

- Dedicated Prompt Studio and Worklog sidebar surfaces with global Command Center actions, plus Workspace-local mirrors of both panels.
- Workspace- and agent-context Prompt Scratchpad panels, plus a compact Workspace Scratchpad in Explorer.
- A single plaintext vault whose `drafts/` directory contains every canonical draft lineage.
- Inbox or Project scope without tying a draft to a specific Workspace or Agent, including Projects that do not yet have a Workspace.
- Debounced autosave with optimistic version and content-hash checks, external-edit detection, and recoverable checkpoints.
- A server-enforced `draft ⇄ ready` lifecycle. Marking a draft ready creates a checkpoint; changing its title or Markdown returns it to draft.
- Sidebar multi-selection with select-all-matching, batch lifecycle actions (Draft, Ready, Archive, Restore), and bulk tag assignment/removal.
- Hierarchical tags such as `Research/AI`, with autocomplete, case-insensitive deduplication, tree filtering, and global rename/merge.
- Immutable send snapshots, idempotent dispatch IDs, stable `clientMessageId` reuse, safe retries, and Agent timeline reconciliation.
- Project-scoped Prompt Agents for related-Prompt optimization and format-only cleanup, with deterministic context counts, budget previews, durable recovery, and conflict candidates.
- Independent provider/model/thinking settings for both generation tasks, plus provider-native read-only controls and concise protection-level labels.
- Archive and restore support, plus journaled permanent deletion for eligible archived drafts.
- A disposable derived catalog that can always be rebuilt from canonical Markdown and JSON.
- English and Chinese UI, responsive desktop/compact layouts, and Paseo light/dark theme support.

## Settings and shortcuts

Open **Settings → Plugins → Prompt Studio** (or **Prompt Studio settings** in Command Center). The main plugin page no longer has a settings dialog.

- **General**: language, descriptions, history limits, boilerplates, and four independent shortcut switches: sidebar, conversation composer, Workspace header, and file Explorer tab. Click **Save preferences** to apply the form.
- **Prompt Agents**: provider, model, thinking options, and reference time ranges.
- **Migration**: inspect and resolve unavailable Project links.

Preferences are shared by clients of the same host and survive plugin reload and daemon restart. Existing settings migrate with shortcuts enabled. Settings remains accessible even if all shortcuts are disabled. Other clients without plugin UI open pick up visibility changes within about 15 seconds. Disabling an Explorer contribution does not forcibly close a tab already restored by Paseo.

## Requirements

- Node.js and npm
- Paseo 0.8.x on the daemon and any app loading the client contributions
- Plugins enabled on the target Paseo daemon

Paseo plugins are trusted, unsandboxed code. The server side can access files, processes, credentials, and network resources on the daemon machine. Review the source before installing it and only enable plugins on a trusted host.

The Paseo plugin API is currently experimental and may introduce breaking changes. Re-run the complete validation workflow after upgrading Paseo or the official `@getpaseo/plugin` / `@getpaseo/client` dependencies.

## Install

Install dependencies and validate the project:

**macOS / Linux**

```bash
npm install
npm run check
npm run smoke:compiler
```

**Windows**

```powershell
npm install
npm run check
npm run smoke:compiler
```

Install the plugin from an absolute path and confirm that it is running:

**macOS / Linux**

```bash
paseo plugin install /path/to/paseo-plugin-prompt-studio
paseo plugin ls --json
```

**Windows**

```powershell
paseo plugin install D:\path\to\paseo-plugin-prompt-studio
paseo plugin ls --json
```

The expected runtime ID is `prompt-studio`.

After changing source files, validate and reload the installed plugin:

**macOS / Linux**

```bash
npm run check
paseo plugin reload prompt-studio
paseo plugin logs prompt-studio
```

**Windows**

```powershell
npm run check
paseo plugin reload prompt-studio
paseo plugin logs prompt-studio
```

Use `paseo plugin reload` for source changes; do not restart the daemon.

## Using Prompt Studio

Open **Prompt Studio** from the Paseo sidebar or Command Center. Create a draft, edit its title and Markdown, and optionally organize it with hierarchical tags. Autosave reports pending, saved, conflict, and failure states. The same views are also available as Workspace-local panels inside an open Workspace.

Choose **Select** in the Draft sidebar to select individual rows or every Draft matching the current filters. The batch panel can mark eligible selections as Draft or Ready, archive or restore them, and add or remove tags. Mixed-status selections are supported: each lifecycle action shows how many selected Drafts are eligible, retains every Draft's pre-archive state on restore, and reports partial failures instead of hiding them.

Below the Markdown editor, use **Add boilerplate** to append a saved reusable phrase to the current Prompt. Boilerplates are user-editable, shared across UI languages, and begin with three common English prompt fragments.

For a saved Draft assigned to a Project, use **Prompt optimization** to configure three independent reference sources: checkpoints from the current Draft, current Prompt bodies from selected Projects/Inbox, and current Prompt bodies matching selected tags. Every source has its own enabled state and time range; Project and tag sources are combined with OR semantics and duplicate bodies are removed. Settings defines three ascending day-range stops, defaulting to 3, 7, and 14 days, while **All time** remains a fixed final stop. The preview reports eligible and actually included Prompt/version counts and whether the model budget omitted whole references. Project-file access is off for every run unless you explicitly enable its read-only option; the provider protection label is shown with that permission. Use **Quick optimization** for prose and Markdown cleanup without Prompt history, related Drafts, or Project files. Configure the provider, model, and thinking option for each task independently from Settings.

Generation runs are durable and single-flight per Draft. While one is unresolved, Prompt Studio locks mutations and sending for that Draft but lets you browse other Drafts. A successful reply becomes the latest body, creates an undo checkpoint, marks the Draft as generated, and returns `ready` to `draft`. If the Draft changed while the Agent was running, the reply is retained as a conflict candidate and is never applied without an explicit latest-version check.

When the content is ready to send, change the draft state to **Ready**. Prompt Studio creates a checkpoint before the transition. Select an existing Agent or configure a new Agent, then freeze and send the current version. For a new Agent, choose an existing Workspace or create a new Workspace directly under any available Project. An acknowledged new Workspace is retained across refresh or dispatch failure so retry cannot create another one implicitly. The frozen snapshot remains unchanged even if the draft is edited later.

Open **Worklog** from the Paseo sidebar or Command Center for a read-only activity timeline. From a Workspace or Agent context, use **Open Prompt Scratchpad** to work with the drafts scoped to that Project. In Paseo 0.6 and later, the Workspace Scratchpad opens in Explorer beside **Files** and **Changes**; the full Workspace and Agent panels remain available as workspace tabs.

In the message composer, bare `/studio` and `/draft` keep their existing behavior and open Prompt Studio. When either command is followed by text, Prompt Studio creates a new Draft in the current Workspace's Project with that text as its Markdown body, then opens Prompt Studio; the text is consumed by the plugin and is not dispatched to the Agent. `/worklog` remains available from the sidebar and Command Center, but is no longer a Slash Command.

## Data model

By default, Prompt Studio stores its plaintext vault at:

- macOS / Linux: `~/.paseo/prompt-studio`
- Windows: `%USERPROFILE%\.paseo\prompt-studio`

Set `PASEO_PROMPT_STUDIO_HOME` before starting the daemon to choose another location.

Markdown and JSON files are canonical. `catalog.json` is a derived index and may be deleted and rebuilt. External Project directories are Project-level logical links and do not persist a Workspace locator; losing a link never deletes its drafts. Back up the entire vault before moving it or changing its storage location.

Paseo 0.5.1 does not expose a provider-independent read allowlist or an OS/container security boundary for Agents. Prompt Studio validates and rejects managed-vault paths, forces the strongest available provider-native read-only policy, and repeats no-file/project-only rules in the Agent prompt. The UI identifies behavioral-only protection; it must not be interpreted as hard filesystem isolation.

## Project structure

```text
.
├─ index.client.tsx                 # Client contribution composition
├─ index.server.ts                  # Server RPC composition
├─ client/                          # React Native UI, hooks, and host SDK calls
│  └─ studio/                       # Studio views and client state
├─ server/                          # Filesystem, registration, dispatch, and RPC handlers
│  └─ storage/                      # Persistence models and safe file operations
├─ shared/                          # Zod RPC contracts and runtime-neutral DTOs
├─ tests/                           # Storage, dispatch, recovery, and client-state tests
├─ scripts/                         # Paseo compiler smoke and test tooling
└─ docs/                            # Product and development documentation
```

Paseo 0.8 directory boundaries enforce runtime separation: client modules may import client and shared modules, server modules may import server and shared modules, and shared modules must remain safe for both runtimes.

## Validation

**macOS / Linux**

```bash
npm run typecheck
npm test
npm run check
npm run smoke:compiler
```

**Windows**

```powershell
npm run typecheck
npm test
npm run check
npm run smoke:compiler
```

Run `npm run check` after TypeScript or test changes. Also run `npm run smoke:compiler` after changing either runtime entry, contribution registration, RPC wiring, module locations, or cross-runtime imports.

## Documentation

- [Product manual](docs/PROJECT_MANUAL.md)
- [Architecture and data-integrity model](docs/ARCHITECTURE.md)
- [Development and manual QA](docs/DEVELOPMENT.md)
- [Paseo 0.8 migration and validation](docs/MIGRATION_0_8.md)
- [Repository instructions](AGENTS.md)
- [Paseo plugin reference](https://paseo.sh/docs/plugins/v0.8/reference)
- [Paseo SDK reference](https://paseo.sh/docs/sdk/reference)
