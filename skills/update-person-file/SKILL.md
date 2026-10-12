---
name: update-person-file
description: Create or update a person file in the vault (default location vault/people/<name-slug>.md) from an update about someone, a document/email/meeting note, or a batch of newly-archived conversations. Covers file location, required frontmatter, the identity-merge protocol, and the bar for auto-creating a file from a bulk/automated source. Use whenever the user gives an update involving a specific person, asks to create or update someone's file, or hands you a batch of sources to extract people from.
---

# Skill: Update Person File

This skill has two callers: you, invoked directly in a conversation when the
user mentions wanting to update, create, or look at someone's file; and
`scripts/nightly-extract-people.mjs`, which pastes this same file into a prompt and
runs it unattended against newly-archived conversations. Follow the rules
below the same way regardless of which one invoked you — the "Creating files
from bulk or automated sources" section is what changes the bar, not a
different rule set.

## When to run this
Run this whenever the user gives an update involving a specific person,
whenever you pull new information about someone from email, meeting notes,
or documents, or when asked to create a new person file. This also covers
automated/bulk capture (an email sync, a text/WhatsApp import, a batch
extraction run) — see "Creating files from bulk or automated sources" below
before auto-creating anything from that kind of source.

## Where the file lives
`<OUTPUT_SUBDIR>/<name-slug>.md` (default: `vault/people/<name-slug>.md`)

Use a short lowercase slug for the filename (e.g. `mike-schmidt.md`,
`partner.md`). If two people share a first name, disambiguate with a last
initial or role (`eli-son.md`). If no file exists for the person yet, create
one using the structure below. If one exists, update it in place, do not
create a duplicate.

Before creating a new file, check for an existing person by *any* known
identifier (email, phone, WhatsApp jid, iMessage handle, alias) via the
frontmatter, not just by name — a name match alone will miss the same person
under a different identifier, and a slug match alone will miss the same
person under a different name spelling.

## Required frontmatter
Every person file carries this frontmatter, in addition to any file-specific
fields (`company`, `google_contact_id`, etc.):

```yaml
---
type: person
title: <Display Name>
relationship: <how they relate to the user — see "Relationship vs. employer" below>
emails: []          # every known address, lowercase
phones_or_ids: []   # phone numbers, WhatsApp jids, iMessage handles — as encountered
aliases: []         # display name variants seen across sources, lowercase
---
```

This exists so any tool doing identity matching (not just you, mid-conversation)
has a stable contract to key off instead of guessing. `emails`,
`phones_or_ids`, and `aliases` are cumulative — append to them, never
replace, as new identifiers for the same person turn up.

### Relationship vs. employer
`relationship` describes how this person relates to the user (partner,
recruiter, tenant, vendor, family, friend, colleague). `company` (or an
employer field) describes who they work for. Never conflate the two — don't
write a relationship into the company field (e.g. `company: (fiance)`) as a
workaround for not having a relationship field. If both are true (a friend
who is also a tenant), record both.

### Unresolved identities
If a source only gives a raw internal id with no real name attached (e.g. a
WhatsApp participant id the bridge couldn't resolve to a display name),
don't create a named-looking file for it. Either fold it into an existing
person if any other identifier ties it to one, or park it as `type: person`,
`title: <the raw id>`, `unresolved: true` — a placeholder to merge or rename
later, not treated as a real name.

## Identity-merge protocol
If two existing files turn out to be the same real person (e.g. an
email-based file and a phone-based file are the same contact): keep
whichever is more complete as canonical, union every `emails` /
`phones_or_ids` / `aliases` entry from both into its frontmatter, and merge
the body (dedupe "Key facts," keep all "Recent context" entries, flag
contradictions per the rule below). Delete the other file — don't leave a
stale duplicate around "just in case" — and fix anything that linked to its
old slug.

## File structure
Every person file uses these sections, in this order:

```
# <Name>

## Who they are
One or two sentences. Relationship to the user and role, nothing more. No biography.

## What's owed, in either direction
Any open commitments, promises, or expectations between the user and this person.

## Key facts
Durable, relevant facts about the working relationship or dealings with
them; not their personal life details unless directly relevant to something
being worked on together. Each fact ends with a link back to the source it
came from (email, text, meeting note) — a fact with no traceable source
can't be checked or corrected later.

## Recent context
The last few things that happened or were discussed with them, kept short.
```

## Rules
- This file is relationship context, not a dossier. Do not record sensitive
  personal details about the person (health, finances, family situation)
  unless it is directly and explicitly relevant to something being worked on
  together. Financial or contractual terms that ARE the relationship (rent
  amount for a tenant, comp discussed with a recruiter) are in bounds;
  unrelated personal health/finance/family details are not.
- **Recent context pruning rule**: keep at most the last 5 items, or
  everything from the last 30 days, whichever is fewer. When an entry ages
  out, either promote it into "Key facts" if it's durable and still
  relevant, or drop it. This is a fixed rule, not a judgment call, so
  different passes over the same file (interactive or automated) prune
  consistently.
- **Contradiction handling**: never silently overwrite a "Key fact" with new
  conflicting information. Flag it explicitly instead — e.g. "Note: this
  conflicts with the earlier fact that X, confirm which is current" — and
  keep both until resolved.
- Never record anything that reads as gossip, speculation about their
  motives, or judgment of their character. Stick to what was said and done.
- If given a vague or partial update, ask only if you genuinely can't tell
  which section it belongs in. Otherwise make a reasonable call and note the
  assumption.
- The test for whether something belongs in this file: would the user need
  this the next time they're about to talk to or deal with this person? If a
  line doesn't clear that bar, leave it out.

## Creating files from bulk or automated sources
The rules above assume someone is dictating an update about a person they
already know matters. A bulk import (a mailbox sync, a text history dump, a
batch extraction run) has no such signal — it will hand you thousands of
senders and contacts, and most one-off senders are noise (marketing lists,
no-reply addresses, a single transactional email), not relationships.

Before auto-creating a person file from a bulk/automated source, require at
least one of:
- Two-way correspondence (they've been replied to, or have replied), not
  just an inbound message.
- 3 or more separate interactions across any source.
- An existing entry for them in a system of record (e.g. Contacts) — an
  intentional signal they matter, regardless of message volume.

A sender that doesn't clear this bar isn't worth a file — leave them out
rather than creating a placeholder, and don't lower the bar just because the
source made it easy to generate one. If in doubt whether an existing person
already covers a given identifier, check "Required frontmatter" and the
identity-merge protocol above before creating a new one.
