#!/usr/bin/env node
// Archives one Claude Code session transcript (~/.claude/projects/**/*.jsonl)
// to a markdown page in your vault's conversations directory.
//
// Deliberately simple: no LLM calls, no entity extraction, no title
// synthesis. Just turns the raw transcript into readable text and archives
// it. Pulling people/topics/decisions out of the content is a separate,
// later step — see scripts/nightly-extract-people.mjs.
//
// Usage:
//   Hook mode (recommended): wire this as a Claude Code "Stop" hook. Claude
//   Code sends a JSON payload on stdin with a transcript_path field.
//
//   Manual mode: node archive-claude-session.mjs <path-to-session.jsonl>
//
// Config (env vars, all optional):
//   VAULT_DIR          Root of your vault. Default: ./vault
//   CONV_SUBDIR         Path under VAULT_DIR for archived conversations.
//                        Default: sources/conversations/claude

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";

const VAULT_DIR = process.env.VAULT_DIR || join(process.cwd(), "vault");
const CONV_SUBDIR = process.env.CONV_SUBDIR || "sources/conversations/claude";
const VAULT_CONV_DIR = join(VAULT_DIR, CONV_SUBDIR);

function slugify(s) {
  const full = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= 60) return full || "session";
  const cut = full.slice(0, 60);
  const lastHyphen = cut.lastIndexOf("-");
  return (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut) || "session";
}

const FILLER_WORDS = new Set([
  "is", "are", "am", "was", "were", "can", "could", "should", "would",
  "please", "i", "i've", "do", "does", "did", "what", "how", "why", "not",
  "that", "have", "has", "had", "need", "want", "help", "me", "my", "you",
  "your", "the", "a", "an", "to", "of", "in", "on", "for", "with",
]);

function shortTopic(text, maxWords = 6) {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const content = words.filter((w) => !FILLER_WORDS.has(w.toLowerCase().replace(/[^a-z']/g, "")));
  // Fall back to the raw words if filtering strips almost everything (e.g. a
  // message that's mostly filler) rather than returning a near-empty slug.
  const chosen = content.length >= maxWords ? content : words;
  return chosen.slice(0, maxWords).join(" ");
}

function projectName(cwd) {
  if (!cwd) return "misc";
  return cwd.split("/").filter(Boolean).pop() || "misc";
}

function extractText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function archiveSession(jsonlPath) {
  if (!existsSync(jsonlPath)) {
    console.error(`Not found: ${jsonlPath}`);
    process.exit(1);
  }
  const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);

  const turns = [];
  let sessionId = null;
  let cwd = null;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    sessionId = sessionId || entry.sessionId;
    cwd = cwd || entry.cwd;
    if (entry.isSidechain) continue; // subagent chatter, not the main conversation
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const text = extractText(entry.message?.content);
    if (!text) continue; // skip tool-only turns (pure tool_result/tool_use, no prose)
    turns.push({ role: entry.type, text, timestamp: entry.timestamp });
  }

  if (turns.length === 0) {
    console.log(`No text turns in ${jsonlPath} — nothing to archive.`);
    return null;
  }

  const firstUserTurn = turns.find((t) => t.role === "user");
  const titleSource = firstUserTurn ? firstUserTurn.text : turns[0].text;
  const flat = titleSource.replace(/\s+/g, " ").trim();
  const cut = flat.slice(0, 80);
  const title = flat.length <= 80 ? flat : cut.slice(0, cut.lastIndexOf(" ")) + "…";
  const date = (turns[0].timestamp || new Date().toISOString()).slice(0, 10);
  const shortId = (sessionId || "unknown").slice(0, 8);
  const project = projectName(cwd);

  const fm = [
    "---",
    "type: conversation",
    `title: ${JSON.stringify(title)}`,
    `date: '${date}'`,
    `project: ${project}`,
    "transcript_import:",
    "  harness: claude-code",
    `  session_id: ${sessionId}`,
    "---",
    "",
  ].join("\n");

  const body = turns
    .map((t) => {
      const who = t.role === "user" ? "User" : "Assistant";
      const ts = t.timestamp ? new Date(t.timestamp).toISOString().replace("T", " ").slice(0, 16) : "";
      return `**${who}** (${ts}):\n\n${t.text}`;
    })
    .join("\n\n---\n\n");

  mkdirSync(VAULT_CONV_DIR, { recursive: true });

  // Idempotency: a session can fire Stop more than once (--resume, retries).
  // The session_id suffix is the true dedupe key — remove any prior archive of
  // this same session before writing the fresh one, so re-running never
  // produces duplicates even if the topic slug shifts as the conversation grows.
  for (const existing of readdirSync(VAULT_CONV_DIR)) {
    if (existing.endsWith(`-${shortId}.md`)) unlinkSync(join(VAULT_CONV_DIR, existing));
  }

  const topicSlug = slugify(shortTopic(titleSource));
  const filename = `${date}-${project}-${topicSlug}-${shortId}.md`;
  const outPath = join(VAULT_CONV_DIR, filename);
  writeFileSync(outPath, fm + "\n" + body + "\n");
  return outPath;
}

function readStdin() {
  try {
    return readFileSync(0, "utf-8"); // fd 0 = stdin
  } catch {
    return "";
  }
}

async function main() {
  const arg = process.argv[2];

  if (arg) {
    // Manual test mode: node archive-claude-session.mjs <path-to-session.jsonl>
    const out = archiveSession(arg);
    if (out) console.log(`Archived: ${out}`);
    return;
  }

  // Hook mode: Claude Code sends a JSON payload on stdin for the Stop event.
  const raw = readStdin();
  if (!raw.trim()) {
    console.error("No file argument and no stdin input — nothing to do.");
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    console.error(`Could not parse hook stdin as JSON: ${e.message}`);
    process.exit(1);
  }
  if (!payload.transcript_path) {
    console.error("Hook payload had no transcript_path — nothing to archive.");
    process.exit(0); // don't block the Stop event over this
  }

  // transcript_path writes asynchronously and can lag the hook firing by a
  // moment — a short wait here is cheap insurance against archiving a
  // transcript that's missing its last turn.
  await new Promise((r) => setTimeout(r, 500));

  const out = archiveSession(payload.transcript_path);
  if (out) console.error(`Archived: ${out}`); // stderr: doesn't interfere with hook stdout contract
  process.exit(0);
}

main();
