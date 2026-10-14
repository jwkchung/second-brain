---
name: update-company-file
description: Create or update a company file in the vault (default location vault/companies/<company-slug>.md) from an update about a company, a document/email/meeting note, or a batch of newly-archived conversations. Covers file location, required frontmatter, the identity-merge protocol, linking to other entities, and the bar for auto-creating a file from a bulk/automated source. Use whenever the user gives an update involving a specific company, asks to create or update a company's file, or hands you a batch of sources to extract companies from.
---

# Skill: Update Company File

This skill has two callers: you, invoked directly in a conversation when the
user mentions wanting to update, create, or look at a company's file; and
`scripts/nightly-extract-entities.mjs`, which pastes this same file into a
prompt and runs it unattended against newly-archived conversations. Follow
the rules below the same way regardless of which one invoked you — the
"Creating files from bulk or automated sources" section is what changes the
bar, not a different rule set.

## When to run this
Run this whenever the user gives an update involving a company, whenever you
pull new information about one from email, meeting notes, or documents, or
when asked to create a new company file. This also covers automated/bulk
capture (an email sync, a batch extraction run) — see "Creating files from
bulk or automated sources" below before auto-creating anything from that
kind of source.

## Where the file lives
`<OUTPUT_SUBDIR>/<company-slug>.md` (default: `vault/companies/<company-slug>.md`)

Use a short lowercase slug for the filename (e.g. `acme-corp.md`,
`globex.md`). If no file exists for the company yet, create one using the
structure below. If one exists, update it in place, do not create a
duplicate.

Before creating a new file, check for an existing company by *any* known
identifier (email domain, alias) via the frontmatter, not just by name — a
name match alone will miss the same company under a different spelling
(e.g. "Acme Corp" vs "AcmeCorp"), and a slug match alone will miss it under
a different name variant.

## Required frontmatter
Every company file carries this frontmatter:

```yaml
---
type: company
title: <Display Name>
relationship: employer | vendor | client | investor | counterparty
domains: []        # email domains, lowercase, no @
aliases: []         # display name variants seen across sources, lowercase
---
```

This exists for the same reason the person skill's frontmatter contract
does: identity matching needs a stable contract to key off instead of
guessing. `domains` and `aliases` are cumulative — append to them, never
replace, as new identifiers turn up.

### Relationship
`relationship` describes how this company relates to the user (employer,
vendor, client, investor, counterparty). Don't conflate it with a person's
role there — an individual's relationship to the user (recruiter, manager,
point of contact) belongs on their own person file, not here.

## Identity-merge protocol
If two existing files turn out to be the same real company (e.g. a
name-based file and a domain-based file are the same company, or "Acme
Corp" and "AcmeCorp" turn out to be one firm): keep whichever is more
complete as canonical, union every `domains`/`aliases` entry from both into
its frontmatter, and merge the body (dedupe "Key facts," keep all "Recent
context" entries, flag contradictions per the rule below). Delete the other
file — don't leave a stale duplicate around "just in case" — and fix
anything that linked to its old slug.

## Linking to other entities
When a Key fact or Recent context entry mentions a person or project that
already has its own file, wikilink the first mention of them in that bullet
(`[[their-slug]]`), using the same identifier-lookup discipline as the
identity-merge protocol above — never guess a slug, never create a link to
a file that doesn't exist. Don't re-link the same entity repeatedly within
one bullet; once per bullet where they're mentioned is enough. The reverse
direction (who links to this company) doesn't need maintaining by hand —
that's what your vault tool's backlinks panel is for (e.g. Obsidian).

## File structure
Every company file uses these sections, in this order:

```
# <Name>

## Who they are
One or two sentences: what they do, how they relate to the user. No biography.

## What's owed, in either direction
Any open commitments, promises, or financial/contractual terms in either
direction (vendor payment terms, equity/comp obligations, lease terms) —
not a running transaction log, just what's currently open.

## Key facts
Durable, relevant facts about the relationship or dealings with them
(terms, history, structure). Each fact ends with a link back to the source
it came from — a fact with no traceable source can't be checked or
corrected later.

## Key people
A short, curated list of who actually matters here — the people at this
company the user deals with directly — wikilinked. Not exhaustive; the
backlinks panel already surfaces every incidental mention, this list is for
who's actually core to the relationship.

## Recent context
The last few things that happened or were discussed, kept short.
```

Do not add a "Decisions made" or "Open questions / blockers" section here —
that content belongs on the relevant project file, or the person file of
whoever's actually being dealt with, not duplicated at the company level. A
company isn't a single decision-making thread the way a project is.

## Rules
- This file is relationship context, not a dossier. Do not record sensitive
  details (internal financials beyond what's directly relevant, legal
  matters not involving the user, employee personal information) unless
  directly and explicitly relevant to something being worked on with them.
- **Recent context pruning rule**: keep at most the last 5 items, or
  everything from the last 30 days, whichever is fewer. When an entry ages
  out, either promote it into "Key facts" if it's durable and still
  relevant, or drop it.
- **Contradiction handling**: never silently overwrite a "Key fact" with
  new conflicting information. Flag it explicitly instead — e.g. "Note:
  this conflicts with the earlier fact that X, confirm which is current" —
  and keep both until resolved.
- Never record anything that reads as gossip, speculation about motives, or
  judgment. Stick to what was said and done.
- If given a vague or partial update, ask only if you genuinely can't tell
  which section it belongs in. Otherwise make a reasonable call and note
  the assumption.
- The test for whether something belongs in this file: would the user need
  this the next time they're about to deal with this company? If a line
  doesn't clear that bar, leave it out.

## Creating files from bulk or automated sources
A bulk import has no signal about which companies actually matter — it will
hand you every domain that's ever emailed the user, most of which are noise
(vendors who sent one invoice, a mailing list).

Before auto-creating a company file from a bulk/automated source, require
at least one of:
- Two-way correspondence with someone at that company, not just an inbound
  message.
- 3 or more separate interactions across any source.
- An existing entry for them in a system of record (e.g. Contacts) — an
  intentional signal they matter, regardless of message volume.

A company that doesn't clear this bar isn't worth a file — leave it out
rather than creating a placeholder.
