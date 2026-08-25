# Repository Instructions

## Project

- This repository is a trusted local Paseo plugin named Prompt Studio.
- Read `README.md` for product scope and `docs/ARCHITECTURE.md` before changing persistence, dispatch, or runtime boundaries.
- Keep `index.ts` as a thin contribution-composition entry point.

## Runtime boundaries

- Put React Native UI, hooks, styles, and host callbacks in `*.client.tsx` under `src/client/`.
- Put Node APIs, filesystem access, registration, and RPC implementation in `*.server.ts` under `src/server/`.
- Put Zod RPC contracts and runtime-neutral DTOs in `*.shared.ts` under `src/shared/`.
- Client modules may import client and shared modules, never server modules. Server modules may import server and shared modules, never client modules.
- Use the host-provided Paseo SDK for normal Paseo operations and plugin RPC only for plugin-specific daemon behavior.

## Data integrity

- Treat Markdown/JSON files as the canonical source; `catalog.json` must remain disposable and rebuildable.
- Accept logical IDs at RPC boundaries. Never accept an arbitrary client-supplied filesystem path.
- Preserve atomic writes, path-boundary checks, symlink/Junction rejection, optimistic version/hash checks, and cross-process locking.
- Preserve immutable send snapshots and reuse the same snapshot and `clientMessageId` during retry or reconciliation.
- Any storage schema, layout, migration, or dispatch-lineage change requires focused recovery and regression tests.

## UI

- Use Paseo theme tokens for every text, background, border, status, and accent color.
- Respect `layout.compact`; validate desktop/narrow layouts and light/dark themes for UI changes.
- Keep asynchronous server state in TanStack Query and expose visible pending, error, conflict, and retry states.

## Validation

- Run `npm run check` after TypeScript or test changes.
- Also run `npm run smoke:compiler` after changing `index.ts`, contribution registration, RPC wiring, file suffixes, or cross-runtime imports.
- Reload an installed plugin with `paseo plugin reload prompt-studio`; do not restart the daemon for source changes.

## Code review rules

- Flag any path that can silently overwrite an external edit, create two canonical copies of one draft, or resend an accepted message.
- Flag client/server boundary violations and unvalidated RPC inputs or outputs.
- Flag hard-coded UI colors or unstyled React Native `Text`.
- Prefer extracting a cohesive repository, view, or state machine over growing `store.server.ts` or `studio.client.tsx` further.
