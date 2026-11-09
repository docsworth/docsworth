---
name: polish-page
description: Tidy a Docsworth page without changing what it says, by restructuring and rewording it and opening a polish PR for the owning team. Use when someone says "clean up this runbook", "this page is hard to follow", "polish the docs for X", or asks to reformat a page to the runbook sections.
---

# Polish a page

A polish makes a page easier to read and act on. It never changes a fact. The server
backs that up with a structural guard: `propose_edit` with `polish: true` refuses a
change to the page's code blocks, inline code, links, numbers or negation words. The
guard can't see meaning, or a command written as plain prose, so the owners still
review the diff.

## 1. Read the page

Call `read` with the page id. Work from `content` exactly as returned: it's the page
body, without the frontmatter, which a polish never touches. If the user named a topic
rather than a page, `search` first and confirm which page they mean.

## 2. Rewrite the body

You may:

- move sections that hold no code
- split long paragraphs
- turn a run of steps into a numbered list
- fix or add headings. A runbook reads best with `## When to use`, `## Steps`,
  `## Checks` and `## Rollback`.
- tighten wording

Keep these exactly as they are:

- every command and code block (fenced or inline), in the same order and under the same
  headings, and each fence's language tag (the word after ```): don't add or drop one
- every inline code span, link target and URL, and each link's text with its target
- any struck-through text, and nothing newly struck through
- each task-list item's box and text, as written
- every number with the word after it (`5 minutes`, `3 retries`)
- how often each negation or modal word appears: not, never, no, must, should,
  cannot, can't, don't, doesn't, won't, shouldn't, mustn't, isn't, aren't, only,
  without, unless, except, nor, none, neither, always

Don't add or drop facts, and keep steps in their order. If something looks wrong or
out of date, leave it and say so in the reason. Fixing it is an ordinary edit, which the owners review as one.

## 3. Propose it

Call `propose_edit` with `id`, `polish: true`, the rewritten text as `body`, and a
`reason` describing what you restructured. The server keeps the frontmatter as it is.

If it refuses, the message names each change the guard saw. Put those back exactly
and try again. Don't switch to an ordinary edit to get past the guard.

If the page shows `[restricted page]`, it links to pages you can't see, and the server
won't take a polish of it from this session (or any whole-body rewrite). Tell the user
rather than working around it.

If it refuses because this session read pages with a narrower audience, don't work
around it. Tell the user which page to polish in a fresh session.

## 4. Report

Give the PR URL and the owning team. Mention anything you noticed that looked wrong,
since a polish deliberately left it alone.
