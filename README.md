# second-brain

Turn every Claude Code session into durable, structured notes in a local
Markdown vault (e.g. an Obsidian vault) — automatically, with no manual
copy-pasting, and without routing your conversations through a third-party
service.

Two small pieces:

1. **A Stop hook** that archives each finished session's transcript to a
   readable Markdown file the moment the session ends.
2. **A nightly job** that reads whatever archived conversations are new and
   runs a Claude subagent over them, following one written *Skill* file per
   entity type (people, companies, and projects, by default), to extract
   structured, cross-linked notes into your vault — with source citations,
   an anti-gossip rule, and a bar for what's worth keeping.

Nothing here calls out to a hosted memory service. Everything reads and
writes local files; the only model calls are the ones you already have
through your Claude Code subscription.

## Why

Claude Code sessions contain a lot of context that's useful later and
otherwise evaporates the moment the terminal closes: decisions made, people
mentioned, commitments taken on. This pipeline's job is narrow and
deliberately boring: capture the raw transcript reliably, then let a
model — not a regex — decide what's actually worth remembering, against
rules you can read and edit.

## Phase 1 (what's here today)

- **`scripts/archive-claude-session.mjs`** — a Claude Code `Stop` hook. Reads the
  hook's JSON payload from stdin, pulls the session transcript
  (`~/.claude/projects/**/*.jsonl`), strips it down to the human-readable
  turns (skipping subagent chatter and pure tool calls), and writes one
  Markdown file per session with YAML frontmatter (`date`, `project`,
  `session_id`). Idempotent — re-running on the same session replaces its
  file rather than duplicating it, since a session can fire `Stop` more than
  once (`--resume`, retries).
- **`scripts/nightly-extract-entities.mjs`** — a batch job (bring your own
  scheduler — cron, launchd, systemd timer) that looks at conversation files
  modified since its last successful run, and if there are any, spawns
  `claude -p` with a locked-down tool allowlist to read them and update
  entity files in your vault. Nothing runs, and no model call happens, if
  there's nothing new. Deliberately a nightly batch rather than a per-session
  hook: a hook has no durability guarantee across crashes/force-quits, and a
  nightly pass avoids races between parallel sessions touching the same
  output files concurrently.
- **`skills/update-person-file/SKILL.md`** — the actual rules followed when
  updating a person file: file location and frontmatter contract, the bar
  for creating a file from a bulk/automated source (two-way correspondence,
  3+ interactions, or already a known contact — not just "mentioned once"),
  the identity-merge protocol, a pruning rule for recent context, and an
  explicit no-gossip/no-speculation rule. It's a real Claude Code Skill
  (proper frontmatter, drop the `update-person-file/` directory into your
  `skills/` directory and Claude Code will pick it up) — so you can invoke
  it two ways: directly in conversation ("update Mike's file with this"),
  or unattended, since `nightly-extract-entities.mjs` pastes this same file
  into its batch prompt. Both paths follow identical rules; edit the one
  file to change either.
- **`scripts/schedule_tomorrow_wake.sh`** — optional, macOS-only. If you run the
  nightly job on a laptop that might be asleep at the scheduled hour, this
  renews a one-off `pmset schedule wake` entry so the machine is awake for
  it. Irrelevant on an always-on machine or server.

What Phase 1 deliberately does *not* do: no entity extraction or title
synthesis at archive time (that's a model-judgment step, kept separate and
batched), no hosted/third-party memory store, no attempt to resolve identity
across sources beyond what each skill file's protocol covers.

## Phase 2 (just landed)

Phase 1 shipped with a single extraction target (people). Phase 2 asked the
obvious next question — now that the pipeline has run for real against real
conversations, is "people" actually the only entity worth a file? — and
answered it by adding two more, plus the linking between all three:

- **`skills/update-company-file/SKILL.md`** and
  **`skills/update-project-file/SKILL.md`** — two more Skills, same shape as
  `update-person-file`: their own frontmatter contract, identity-merge
  protocol, bulk-creation bar (companies), and status/decisions/blockers
  structure (projects). Both are real Claude Code Skills too, invocable
  directly or through the nightly job.
- **`scripts/nightly-extract-entities.mjs`** (renamed from
  `nightly-extract-people.mjs`) now *discovers* skills instead of hardcoding
  one: it scans `skills/` for any `<name>/SKILL.md`, maps each to an output
  subdirectory (`ENTITY_DIRS`, defaulting to the three shipped here), and
  runs a single subagent pass that can read and write across all of them in
  one go. Dropping in a fourth skill (`skills/update-X-file/SKILL.md` plus
  an `ENTITY_DIRS` entry) needs no code change.
- **Cross-entity linking.** Each skill now has a "Linking to other entities"
  rule: a fact in a person file can wikilink a company or project file and
  vice versa, with the same no-guessing-a-slug discipline as the
  identity-merge protocol, and the reverse direction is left to your vault
  tool's backlinks panel rather than a hand-maintained list.

This is a config/discovery change to the nightly job, not a rewrite — the
Stop hook and the identity-merge/pruning/no-gossip rules underneath each
skill are unchanged from Phase 1.

## Setup

```bash
git clone <this-repo>
cd second-brain
```

1. Point a vault at it (or let it create `./vault` on first run):
   ```bash
   export VAULT_DIR=/path/to/your/vault
   ```
2. Wire the Stop hook into Claude Code's settings
   (`~/.claude/settings.json` or a project's `.claude/settings.json`):
   ```json
   {
     "hooks": {
       "Stop": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "VAULT_DIR=/path/to/your/vault node /path/to/second-brain/scripts/archive-claude-session.mjs"
             }
           ]
         }
       ]
     }
   }
   ```
3. Schedule the nightly job (cron example, 3am daily):
   ```cron
   0 3 * * * VAULT_DIR=/path/to/your/vault node /path/to/second-brain/scripts/nightly-extract-entities.mjs
   ```
   By default this runs all three shipped Skills (people, companies,
   projects). Drop a skill's directory out of `skills/` (or set
   `SKILLS_DIR` to a folder that doesn't include it) if you only want a
   subset.
   On macOS, if the machine sleeps, also schedule
   `scripts/schedule_tomorrow_wake.sh` to run daily (as root, via
   LaunchDaemon — `pmset schedule` requires root) a few minutes before the
   extraction job.

All paths are overridable via environment variables — see the header
comments in each script for the full list (`VAULT_DIR`, `CONV_SUBDIR`,
`SKILLS_DIR`, `ENTITY_DIRS`, `CLAUDE_BIN`, `CLAUDE_MODEL`, …).

## Future plan

Roughly in priority order:

- **More entity types.** People/companies/projects cover the obvious cases;
  decisions and commitments as their own linkable entity type (rather than
  a section inside a project file) is the next candidate, once there's real
  evidence a project file isn't enough.
- **Multi-source archiving.** The Stop-hook pattern generalizes past Claude
  Code: the same "archive raw → batch-extract later" split applies to email,
  iMessage/WhatsApp exports, meeting notes, or any other `*.jsonl`/text
  source — each just needs its own thin archiver that writes into the same
  conversation-file shape the nightly job already consumes.
- **A config file** (`vault.config.json` or similar) instead of only env
  vars, so a vault can declare its own layout, active skills, and model
  choice in one place instead of a shell environment.
- **Harness portability.** The archiver is Claude-Code-specific today (it
  expects that JSONL transcript shape and that Stop-hook payload). A second
  archiver for at least one other agent harness would validate that the
  "harness-specific archiver → harness-agnostic nightly extractor" boundary
  actually holds.
- **Dry-run / review mode** for the nightly job — write proposed entity-file
  diffs somewhere reviewable instead of applying them directly, for anyone
  who wants a human-in-the-loop step before anything lands in their vault.
- **Tests.** Right now correctness rests on manual runs against real
  transcripts. Fixture-based tests (sample JSONL in, expected Markdown out)
  for the archiver are the obvious first slice; the nightly extractor is
  harder to test deterministically since it's a model call, but a fixed set
  of "should create a file" / "should not clear the bar" cases against the
  skill's rules is doable.

## Design notes / non-goals

- This is not a vector-search or RAG system. The vault is plain Markdown; if
  you want semantic search over it, that's a layer on top, not something
  this pipeline does.
- The nightly job's subagent is deliberately boxed in with
  `--allowedTools`/`--disallowedTools` to Read/Write/Edit/Glob/Grep on the
  vault directory only — no shell, no network, no ability to spawn further
  agents. That restriction was added after observing the opposite (an
  unrestricted run fanning out into dozens of recursive subagents instead of
  processing files sequentially) — keep it if you fork this.
- Nothing here phones out to a hosted memory/CRM product. If you want that,
  this pipeline is not it — and isn't trying to be.
- Phase 1 ran unattended for about two weeks against real conversations,
  with real inspection of the output, before Phase 2 added more entity
  types. The recommended rule for extending this yourself: don't add the
  next entity type or source until the current one has run for real,
  unattended, long enough that you've actually looked at what it produced —
  extraction bugs and bad judgment calls show up in the output, not in the
  code.

## License

MIT — see [LICENSE](LICENSE).
