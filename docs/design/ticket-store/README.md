# Ticket store: tickets as MCP-owned structured data

Settled 2026-11-26 (D-2026-11-26-06, oracle ja3d49d8f6c9f0b56). Tickets move from `.scratch/<feature>/issues/*.md`
to one typed JSON file per feature that `hud_tickets` and HUD hooks edit directly. Feature prose
(`.scratch/<feature>/spec.md`, notes, maps) stays Markdown.

## 1. Store

- Canonical file: `.hud/tickets/<feature>.json`, committed in the repo. Pretty-printed 2-space JSON with
  deterministic key order and tickets sorted by `number`; at most 64 KiB per feature.
- Writers take a short per-project local lock (`withAbstractLock('tickets', mainRoot)`, as in
  `src/mcp/local-objectives.ts`) and write atomically. No `main-checkout` lease and no git call on edit.
- Every HUD write records `{ feature: sha256(bytes) }` in private `$HUD_HOME/projects/<project-hash>/ticket-writes.json`
  (0600, at most 256 entries) so later commits sweep only files HUD wrote, never the owner's hand edits.
- GitHub mirror (`hud tickets sync`) writes `.hud/tickets/<slug>.json` with a `mirror` block and keeps the mirror
  files git-ignored, as today.

## 2. Schema

```ts
type TicketStatus = 'needs-triage' | 'needs-info' | 'ready-for-agent' | 'ready-for-human' | 'claimed' | 'done' | 'wontfix';
type TicketKind = 'impl' | 'flake-list' | 'research' | 'prototype' | 'grilling' | 'task';

interface AcceptanceItem { id: number; text: string; done: boolean }          // id: 1-based, stable
interface FlakeCaseRecord { step: string; test?: string; case_name?: string; flow?: string; log?: string; recorded_at: string }
interface LandingRecord { at: string; job: string; flow: string; replay_base: string; gates: number; commit?: string }
interface AcceptanceReceipt { at: string; by: 'main' | 'lead' | 'owner'; flow?: string; verdict?: string }
interface TicketComment { at: string; author: string; text: string }

interface TicketRecord {
  number: number;                 // canonical id `${feature}/${NN}`
  title: string;
  kind?: TicketKind;              // default 'impl'
  status: TicketStatus;
  claimed_at?: string;            // only for legacy/explicit 'claimed'
  role?: 'imp' | 'frontend-imp';  // default 'imp'
  main_review?: boolean;
  owner_try: boolean;
  live_try: string;               // concrete instruction or 'none'
  approved_removals: string[];
  blocked_by: string[];           // canonical '<feature>/<NN>'
  objective?: string;             // overrides the feature's Objective
  what: string;
  cases?: FlakeCaseRecord[];      // kind 'flake-list'
  acceptance: AcceptanceItem[];
  landing?: LandingRecord;
  accepted?: AcceptanceReceipt;
  comments: TicketComment[];
  created_at: string;
  updated_at: string;
}

interface TicketFeatureDoc {
  version: 1;
  feature: string;                // ^[a-z0-9-]+$, matches the file name
  title?: string;
  objective?: string;
  spec_path?: string;             // e.g. .scratch/<feature>/spec.md
  mirror?: { kind: 'github'; repo: string; issue: number; url: string; synced_at: string };
  tickets: TicketRecord[];
}
```

Stored: the fields above. Derived at read time, never written to the file: live claims and worker state (from
jobs and worktrees), queue and land stages (from flows), owner try resolution (from `tries.jsonl`), the effective
state (`ready | queued | blocked | working | try | done | dropped`) and dependency waves.

Writers: the main session through `hud_tickets` (`add`, `update` incl. comments and field edits, `commit`, `sync`);
the `lead` only for repair tickets; HUD hooks (`hud_land`: status, ticked acceptance, `landing`; unattended
acceptance: `accepted`; gate flakes: `cases[]`). Workers never write tickets, and a land rejects worker diffs that
touch `.hud/tickets/**`. `hud_create` stamps `ticket` and Objective into the job once; claims are never written.

## 3. Commits

- Edits are not committed on their own. Right after `git merge --ff-only` in `hud_land` (the land already holds
  `main-checkout`), HUD takes the tickets lock, reads the newest `.hud/tickets/<feature>.json` from the main checkout
  (keeping edits made during the gate), writes `landing`, `status` and ticks, and amends the landed commit with
  `git commit --amend --no-edit --only -- <swept files>`, sweeping only files whose hash matches `ticket-writes.json`.
  New files get `git add --intent-to-add` first. Push uses the amended head.
- `recordLanding` moves from the integration worktree (before ff) to this post-ff step, so ticket paths are never
  in the landed paths and a dirty ticket file in main never fails `checkClean` or the ff.
- `.hud/tickets/*.json` and `.hud/objectives.md` count as metadata paths in `isMetadataPath`, so a replay onto a
  ticket-amended head does not re-run the gate.
- When nothing lands, `hud_tickets({op: "commit"})` / `hud tickets commit` takes the lease and the tickets lock and
  commits the HUD-written files with `--only`. Unattended acceptance tries a non-blocking commit at run end.
- Lock order is `main-checkout` → `tickets`; edits never wait on a land. This replaces the per-edit commit path and
  the queued-receipt queue (`src/mcp/ticket-commits.ts`, mcp-latency/02).

## 4. Display

- One stat-signature-cached reader in the collector layer: at most 256 `.hud/tickets/*.json` files (257th marks
  `partial`), 64 KiB each, re-parses only files whose stat signature changed, no I/O on the paint path. Falls back
  to `.scratch/<feature>/issues/*.md` per feature until a project is migrated.
- Project, Objective and Feature pages, Execution, `ticket-title.ts` and `hud board` read it. `landing.at` replaces
  the `git log --patch` mining in `project-board.ts`; Execution gets titles and `blocked_by` edges for the workflow
  waves of `docs/design/tab-roles/README.md`.
- `o` on a ticket row opens `.hud/tickets/<feature>.json` in `$EDITOR`. `hud tickets show <feature>[/<NN>]` prints a
  ticket or feature as Markdown, rendered by the same pure `renderTicketBrief()` that `hud_create({ticket})` uses for
  the worker brief.

## 5. Migration

- Readers check `.hud/tickets/<feature>.json` first and fall back to the Markdown per feature during rollout.
- Queue recovery matches items by `ticket`, not `path`; `hud_create` renders the brief from the store when
  `ticket` is given, even if an older queue item still passes a `.scratch` `brief_file`.
- `hud tickets migrate [--cwd <dir>] [--delete-legacy]` converts every Markdown variant (`resolved` → `done`,
  normalised blockers, flake cases, acceptance, landing and unattended-acceptance lines, Objective links) and
  verifies a round trip before deleting anything.
- Deleting `.scratch/*/issues/*.md` is owner-approved (spec "Removed by this spec"); it runs in the last slice,
  at a quiet queue boundary, after toktrack reads the JSON.
