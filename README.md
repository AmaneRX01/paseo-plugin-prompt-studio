> [!CAUTION]
> **CRITICAL: This plugin is under active development and is not safe for normal workspaces.**
>
> With this plugin enabled on Paseo Desktop/daemon 0.5.1, Paseo's core **New Workspace → Draft Agent handoff** can process the same pending Draft multiple times. The handoff lacks effective single-flight or idempotency protection, so each duplicate `create_agent_request` creates another Agent in the same Workspace. In the latest confirmed incident, one `workspace.create.request` was followed by seven independent Agent creation requests, producing seven Agents within approximately 260 ms: one intended Agent and six duplicates.
>
> The duplicate requests originate in Paseo's core client flow, not in Prompt Studio's dispatch, retry, or reconciliation path. Until the Paseo core handoff is fixed, enabling this plugin can make Agent creation unreliable and prevents the plugin from being used safely in a working environment. Do not enable it in production, important projects, or any environment that requires reliable Agent creation.

# paseo-plugin-prompt-studio

Prompt Studio is a plaintext-first Paseo plugin for drafting, organizing, versioning, and safely dispatching prompts to agents. It keeps canonical content in human-readable Markdown and JSON, preserves immutable send snapshots, and presents related activity in a read-only worklog.

The product name is **Prompt Studio for Paseo**. The repository and npm package name is `paseo-plugin-prompt-studio`; the Paseo runtime ID remains `prompt-studio`.

## Highlights

- Dedicated Prompt Studio and Worklog surfaces, sidebar entries, and Command Center actions.
- Workspace- and agent-context Prompt Scratchpad panels.
- A single plaintext vault whose `drafts/` directory contains every canonical draft lineage.
- Inbox or Project scope without tying a draft to a specific Workspace or Agent.
- Debounced autosave with optimistic version and content-hash checks, external-edit detection, and recoverable checkpoints.
- A server-enforced `draft ⇄ ready` lifecycle. Marking a draft ready creates a checkpoint; changing its title or Markdown returns it to draft.
- Hierarchical tags such as `Research/AI`, with autocomplete, case-insensitive deduplication, tree filtering, global rename/merge, and bulk assignment.
- Immutable send snapshots, stable `clientMessageId` reuse, safe retries, and Agent timeline reconciliation.
- Project-scoped Prompt Agents for related-Prompt optimization and format-only cleanup, with deterministic context counts, budget previews, durable recovery, and conflict candidates.
- Independent provider/model/thinking settings for both generation tasks, plus provider-native read-only controls and explicit disclosure where Paseo 0.5.1 cannot enforce a readable-path allowlist.
- Archive and restore support, plus journaled permanent deletion for eligible archived drafts.
- A disposable derived catalog that can always be rebuilt from canonical Markdown and JSON.
- English and Chinese UI, responsive desktop/compact layouts, and Paseo light/dark theme support.

## Requirements

- Node.js and npm
- A Paseo Desktop app or daemon compatible with this plugin API
- Plugins enabled on the target Paseo daemon

Paseo plugins are trusted, unsandboxed code. The server side can access files, processes, credentials, and network resources on the daemon machine. Review the source before installing it and only enable plugins on a trusted host.

The Paseo plugin API is currently experimental and may introduce breaking changes. Re-run the complete validation workflow after upgrading Paseo or `@getpaseo/client`.

## Install

Install dependencies and validate the project:

```powershell
npm install
npm run check
npm run smoke:compiler
```

Install the plugin from an absolute path and confirm that it is running:

```powershell
paseo plugin install D:\path\to\paseo-plugin-prompt-studio
paseo plugin ls --json
```

The expected runtime ID is `prompt-studio`.

After changing source files, validate and reload the installed plugin:

```powershell
npm run check
paseo plugin reload prompt-studio
paseo plugin logs prompt-studio
```

Use `paseo plugin reload` for source changes; do not restart the daemon.

## Using Prompt Studio

Open **Prompt Studio** from the Paseo sidebar or Command Center. Create a draft, edit its title and Markdown, and optionally organize it with hierarchical tags. Autosave reports pending, saved, conflict, and failure states.

For a saved Draft assigned to a Project, use **Optimize from related Prompts** to preview and select tag, time, history, and cross-Project context. The preview reports eligible and actually included Prompt/version counts and whether the model budget removed whole reference versions. Project-file access is off for every run unless you explicitly enable its read-only option. Use the smaller format action for prose and Markdown cleanup without Prompt history, related Drafts, or Project files. Configure the provider, model, and thinking option for each task independently from Settings.

Generation runs are durable and single-flight per Draft. While one is unresolved, Prompt Studio locks mutations and sending for that Draft but lets you browse other Drafts. A successful reply becomes the latest body, creates an undo checkpoint, marks the Draft as generated, and returns `ready` to `draft`. If the Draft changed while the Agent was running, the reply is retained as a conflict candidate and is never applied without an explicit latest-version check.

When the content is ready to send, change the draft state to **Ready**. Prompt Studio creates a checkpoint before the transition. Select an existing Agent or configure a new Agent, then freeze and send the current version. The frozen snapshot remains unchanged even if the draft is edited later.

Open **Worklog** for a read-only activity timeline. From a Workspace or Agent context, use **Open Prompt Scratchpad** to work with the drafts scoped to that Project.

## Data model

By default, Prompt Studio stores its plaintext vault at:

```text
%USERPROFILE%\.paseo\prompt-studio
```

Set `PASEO_PROMPT_STUDIO_HOME` before starting the daemon to choose another location.

Markdown and JSON files are canonical. `catalog.json` is a derived index and may be deleted and rebuilt. External Project directories are logical links only; losing a link never deletes its drafts. Back up the entire vault before moving it or changing its storage location.

Paseo 0.5.1 does not expose a provider-independent read allowlist or an OS/container security boundary for Agents. Prompt Studio validates and rejects managed-vault paths, forces the strongest available provider-native read-only policy, and repeats no-file/project-only rules in the Agent prompt. The UI identifies behavioral-only protection; it must not be interpreted as hard filesystem isolation.

## Project structure

```text
.
├─ index.ts                         # Thin Paseo contribution entry point
├─ src/
│  ├─ client/                       # React Native UI and host SDK callbacks
│  │  └─ studio/                    # Studio views, state helpers, and formatters
│  ├─ server/                       # Filesystem repositories, registration, and RPC handlers
│  │  └─ storage/                   # Safe file operations and persistence schemas
│  └─ shared/                       # Zod RPC contracts and runtime-neutral DTOs
├─ tests/                           # Storage, dispatch, recovery, and UI consistency tests
├─ scripts/                         # Paseo compiler smoke test
└─ docs/                            # Product, architecture, and development documentation
```

File suffixes enforce runtime boundaries: client modules may import client and shared modules, server modules may import server and shared modules, and shared modules must remain safe for both runtimes.

## Validation

```powershell
npm run typecheck
npm test
npm run check
npm run smoke:compiler
```

Run `npm run check` after TypeScript or test changes. Also run `npm run smoke:compiler` after changing `index.ts`, contribution registration, RPC wiring, runtime suffixes, or cross-runtime imports.

## Documentation

- [Product manual](docs/PROJECT_MANUAL.md)
- [Architecture and data-integrity model](docs/ARCHITECTURE.md)
- [Development and manual QA](docs/DEVELOPMENT.md)
- [Repository instructions](AGENTS.md)
- [Paseo plugin reference](https://paseo.sh/docs/plugins/reference)
- [Paseo SDK reference](https://paseo.sh/docs/sdk/reference)
