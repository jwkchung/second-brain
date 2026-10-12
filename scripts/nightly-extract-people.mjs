#!/usr/bin/env node
// Nightly batch job: reads newly-archived conversations and extracts
// structured notes from them (by default, people — see skills/update-person-file.md),
// using a subagent that follows a written skill file rather than a regex.
//
// Runs once per night (cron/launchd/systemd timer — bring your own scheduler),
// not per session. This deliberately does NOT hook SessionEnd: SessionEnd has
// no documented guarantee on crashes/hard kills, and a nightly batch avoids
// race conditions between parallel sessions. It reads from the archive that
// the (reliable, per-turn) Stop hook already produced — see archive-claude-session.mjs.
//
// Uses a real model call (via the `claude` CLI, so it rides your existing
// subscription rather than separate API billing) because this step needs
// actual judgment — a bulk-creation bar, identity matching, a no-gossip/
// no-speculation rule — that a regex can't apply. See the skill file for the
// exact rules it follows.
//
// Config (env vars, all optional):
//   VAULT_DIR        Root of your vault. Default: ./vault
//   CONV_SUBDIR       Path under VAULT_DIR holding archived conversations.
//                      Default: sources/conversations/claude
//   OUTPUT_SUBDIR     Path under VAULT_DIR the extraction is allowed to write to.
//                      Default: people
//   SKILL_PATH        Path to the markdown skill file defining the extraction
//                      rules. Default: ../skills/update-person-file/SKILL.md
//                      (shipped in this repo — the same file is also a real
//                      Claude Code Skill you can invoke directly in a
//                      conversation, not just through this batch job)
//   CLAUDE_BIN        Path to the `claude` CLI. Default: claude (resolved via PATH)
//   CLAUDE_MODEL      Model to run the extraction with. Default: claude-sonnet-5

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VAULT_DIR = process.env.VAULT_DIR || join(process.cwd(), "vault");
const CONV_DIR = join(VAULT_DIR, process.env.CONV_SUBDIR || "sources/conversations/claude");
const OUTPUT_DIR = join(VAULT_DIR, process.env.OUTPUT_SUBDIR || "people");
const SKILL_PATH = process.env.SKILL_PATH || join(__dirname, "..", "skills", "update-person-file", "SKILL.md");
const CHECKPOINT_PATH = join(VAULT_DIR, ".extract-checkpoint.json");
const LOG_PATH = process.env.LOG_PATH || join(VAULT_DIR, "nightly-extract.log");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

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

function main() {
  if (!existsSync(CONV_DIR)) {
    log(`No conversations directory at ${CONV_DIR} yet — nothing to do.`);
    return;
  }
  if (!existsSync(SKILL_PATH)) {
    log(`Skill file not found at ${SKILL_PATH} — aborting.`);
    process.exit(1);
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

  log(`Found ${newFiles.length} new conversation(s) to process.`);

  const prompt = `Read and follow the skill at ${SKILL_PATH} exactly — it defines the output format, the bulk-creation bar, the identity-merge protocol, and the rules for what belongs in an entry.

Process these newly-archived conversation files:
${newFiles.map((f) => `- ${f}`).join("\n")}

For each one: read it, decide which real people (if any) are mentioned clearly enough to clear the bulk-creation bar described in the skill (two-way correspondence / 3+ interactions / already a known contact — a passing one-off mention does not clear it). For each person who clears the bar, check ${OUTPUT_DIR}/ for an existing file matching them by name or alias before creating a new one, and create or update their file following the skill's exact structure and frontmatter contract. Every fact you add must cite the source conversation file it came from.

Scope: only read files under ${VAULT_DIR}, and only create or edit files under ${OUTPUT_DIR}/. Do not touch the conversation archive or anything else. Do not use any tool other than reading and editing files. If a conversation has no one worth a file, do nothing for it — leave it out rather than creating a placeholder.`;

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
