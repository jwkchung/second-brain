#!/usr/bin/env node
// Nightly batch job: reads newly-archived conversations and extracts
// structured notes about multiple entity types (people, companies, projects
// by default) from them, using a subagent that follows one written Skill
// file per entity type rather than a regex.
//
// Renamed from nightly-extract-people.mjs once a second and third entity
// type (companies, projects) were added alongside people — the old name
// undersold what this job does, and a job permissioned to write only under
// a single people/ directory would silently drop any company- or
// project-level fact that wasn't tied to a specific person.
//
// Runs once per night (cron/launchd/systemd timer — bring your own
// scheduler), not per session. This deliberately does NOT hook SessionEnd:
// SessionEnd has no documented guarantee on crashes/hard kills, and a
// nightly pass avoids races between parallel sessions touching the same
// output files concurrently. It reads from the archive that the (reliable,
// per-turn) Stop hook already produced — see archive-claude-session.mjs.
//
// Uses a real model call (via the `claude` CLI, so it rides your existing
// subscription rather than separate API billing) because this step needs
// actual judgment — a bulk-creation bar, identity matching, a no-gossip/
// no-speculation rule, cross-entity linking — that a regex can't apply. See
// the skill files for the exact rules each entity type follows.
//
// Config (env vars, all optional):
//   VAULT_DIR       Root of your vault. Default: ./vault
//   CONV_SUBDIR      Path under VAULT_DIR holding archived conversations.
//                     Default: sources/conversations/claude
//   SKILLS_DIR       Directory containing one subfolder per entity-type
//                     skill, each holding a SKILL.md. Default: ../skills
//                     (the three shipped in this repo: update-person-file,
//                     update-company-file, update-project-file)
//   ENTITY_DIRS      JSON object mapping a skill directory name to the
//                     vault subdirectory its extraction is allowed to write
//                     to, e.g. '{"update-person-file":"people"}'. Merges
//                     over (doesn't need to fully replace) the built-in
//                     defaults below.
//   CLAUDE_BIN       Path to the `claude` CLI. Default: claude (resolved via PATH)
//   CLAUDE_MODEL     Model to run the extraction with. Default: claude-sonnet-5

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VAULT_DIR = process.env.VAULT_DIR || join(process.cwd(), "vault");
const CONV_DIR = join(VAULT_DIR, process.env.CONV_SUBDIR || "sources/conversations/claude");
const SKILLS_DIR = process.env.SKILLS_DIR || join(__dirname, "..", "skills");
const CHECKPOINT_PATH = join(VAULT_DIR, ".extract-checkpoint.json");
const LOG_PATH = process.env.LOG_PATH || join(VAULT_DIR, "nightly-extract.log");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

// Default output subdirectory for each skill shipped in this repo. A skill
// directory not listed here (your own, custom one) needs an entry in
// ENTITY_DIRS or it's skipped with a warning, rather than guessed at.
const DEFAULT_ENTITY_DIRS = {
  "update-person-file": "people",
  "update-company-file": "companies",
  "update-project-file": "projects",
};

function entityDirs() {
  let overrides = {};
  if (process.env.ENTITY_DIRS) {
    try {
      overrides = JSON.parse(process.env.ENTITY_DIRS);
    } catch (e) {
      console.error(`Could not parse ENTITY_DIRS as JSON: ${e.message}`);
      process.exit(1);
    }
  }
  return { ...DEFAULT_ENTITY_DIRS, ...overrides };
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const prior = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf-8") : "";
    writeFileSync(LOG_PATH, prior + line + "\n");
  } catch {
    // logging failure shouldn't crash the run
  }
}

function readCheckpoint() {
  if (!existsSync(CHECKPOINT_PATH)) return 0;
  try {
    return new Date(JSON.parse(readFileSync(CHECKPOINT_PATH, "utf-8")).lastRun).getTime();
  } catch {
    return 0;
  }
}

function writeCheckpoint() {
  writeFileSync(CHECKPOINT_PATH, JSON.stringify({ lastRun: new Date().toISOString() }, null, 2));
}

function discoverSkills() {
  const dirs = entityDirs();
  const skills = [];
  if (!existsSync(SKILLS_DIR)) return skills;
  for (const name of readdirSync(SKILLS_DIR)) {
    const skillPath = join(SKILLS_DIR, name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const outputSubdir = dirs[name];
    if (!outputSubdir) {
      log(`Skipping ${name}: no output directory configured (add it to ENTITY_DIRS).`);
      continue;
    }
    skills.push({ name, skillPath, outputDir: join(VAULT_DIR, outputSubdir) });
  }
  return skills;
}

function main() {
  if (!existsSync(CONV_DIR)) {
    log(`No conversations directory at ${CONV_DIR} yet — nothing to do.`);
    return;
  }

  const skills = discoverSkills();
  if (skills.length === 0) {
    log(`No entity-type skills found under ${SKILLS_DIR} — nothing to do.`);
    return;
  }

  const lastRun = readCheckpoint();
  const newFiles = readdirSync(CONV_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(CONV_DIR, f))
    .filter((f) => statSync(f).mtimeMs > lastRun);

  if (newFiles.length === 0) {
    log("Nothing new since last run — skipping (no model call, no cost).");
    return;
  }

  log(`Found ${newFiles.length} new conversation(s) to process against ${skills.length} entity type(s).`);

  const prompt = `Read and follow these skills exactly — together they define each entity type's file format, the bulk-creation bar, the identity-merge protocol, the cross-entity linking rule, and what belongs in each kind of file:
${skills.map((s) => `- ${s.skillPath} (writes to ${s.outputDir}/)`).join("\n")}

Process these newly-archived conversation files:
${newFiles.map((f) => `- ${f}`).join("\n")}

For each one: read it, decide which entities (of any of the above types) are mentioned clearly enough to clear the bulk-creation bar described in the relevant skill (two-way correspondence / 3+ interactions / already a known contact or entity — a passing one-off mention does not clear it). For each entity that clears the bar, check its type's output directory for an existing file matching it (by name, alias, or whatever identifier that skill defines) before creating a new one, and create or update its file following that skill's exact structure and frontmatter contract. Every fact you add must cite the source conversation file it came from. Apply each skill's linking rule across all the output directories listed above — a fact in one entity's file can link to another entity's file and vice versa, using the same no-guessing, cite-what-exists discipline.

Scope: only read files under ${VAULT_DIR}, and only create or edit files under the output directories listed above. Do not touch the conversation archive, the skill files themselves, or anything else. Do not use any tool other than reading and editing files. If a conversation has nothing worth a file in any of these entity types, do nothing for it — leave it out rather than creating a placeholder.`;

  const result = spawnSync(
    CLAUDE_BIN,
    [
      "-p",
      prompt,
      "--model",
      CLAUDE_MODEL,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read Write Edit Glob Grep",
      // --allowedTools alone is not a hard boundary in -p + acceptEdits mode —
      // observed the process still reaching for Agent/Bash/ListAgents/
      // ScheduleWakeup/ToolSearch, and a spawned sub-agent recursively
      // spawning more sub-agents instead of processing files sequentially.
      // Explicitly deny the tools that let it fan out or take other side
      // effects, since that's enforced even when the allow-list isn't.
      "--disallowedTools",
      "Agent Task Bash WebFetch WebSearch ScheduleWakeup ListAgents ToolSearch SendMessage",
      "--add-dir",
      VAULT_DIR,
    ],
    {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      env: process.env,
    }
  );

  log(`claude exited with code ${result.status}${result.signal ? ` (signal ${result.signal})` : ""}`);
  if (result.error) log(`spawn error: ${result.error.stack || result.error.message || result.error}`);
  if (result.stdout) log(`stdout:\n${result.stdout}`);
  if (result.stderr) log(`stderr:\n${result.stderr}`);

  if (result.status === 0) {
    writeCheckpoint();
    log("Checkpoint updated.");
  } else {
    log("Non-zero exit — checkpoint NOT updated, will retry these files next run.");
  }
}

main();
