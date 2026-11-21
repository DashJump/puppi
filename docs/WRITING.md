# Writing docs

This is the check for a doc or README change, including `AGENTS.md`, and for code comments (JSDoc, `//`) in `@puppi/sdk`, `@puppi/cli`, `@puppi/executor-js`, `@puppi/adapter-storage`, `@puppi/conformance`, and the `@puppi/adapter-*` connectors. Use it before submitting that change.

## Rules

1. Start with what it is and what it does, in one or two sentences. No warm-up.
2. One page has one job. The title names a task or a thing ("Add a Postgres source"), not a theme.
3. Lead with the answer: the command, the default, the limit. Explain after.
4. Be specific. Use real names, flags, paths, defaults, limits, and error text. If you can't name it, cut it.
5. Write procedures as numbered steps with one action each. Give the exact command and the output the reader should see.
6. Give each concept one runnable Puppi example, not foo/bar.
7. Use lists for parallel items, tables for options (name, type, default, meaning), and prose for reasons and tradeoffs.
8. Write for scanning: headings that describe, the key fact first in each section, and code in code blocks.
9. Document defaults, failure modes, and how to recover.
10. State each fact once and link to it everywhere else.
11. Use active voice and present tense, with a named actor ("the CLI writes...").
12. Never guess. Check every flag and behavior against the code. If something is unknown, write TODO(owner) instead of hedging.

## Slop to ban (examples are illustrative)

- Filler intro. Bad: "In today's data-driven world, pipelines are essential." Good: "Example sentence, not a Puppi default. Puppi copies rows from a source to a destination on a schedule."
- Hype words (seamless, powerful, robust, effortless). Bad: "Robust retry handling." Good: "Example sentence, not a Puppi default. Failed batches retry 3 times, then the pipeline pauses."
- Restating the heading. Bad: "## Configuration" followed by "This section covers configuration." Good: open with the first setting.
- Fake generality. Bad: "Connectors can be configured in various ways." Good: "Example sentence, not a Puppi default. Set batch_size in puppi.yaml (default 500)."
- Too many bullets: an argument chopped into fragments. Write it as two sentences instead.
- Hedging. Bad: "may potentially", "typically should". Good: state the rule or the exact condition.
- Signposting. Bad: "Let's dive in", "It's important to note that...". Good: just say the thing.
- Wrap-up. Bad: "In summary, Puppi makes pipelines easy." Good: delete it.
- Bold and emoji everywhere. Good: bold only one critical warning.

## Self-check before submitting

- Does the first sentence say what this is and what it does?
- Can the reader copy and run every command as written?
- Did you check every name, flag, and default against the code?
- Delete the first paragraph, then the last. Did you lose anything? If not, leave them out.
- Is any sentence true of any product? Make it specific or cut it.
- Are any banned words or patterns left?
- Is any bulleted argument better as prose?
- In `AGENTS.md`, is a fact repeated that already lives in a package README, `CONNECTORS_STANDARDS.md`, `docs/`, or JSDoc? Cut it.
- Did you add a comment that restates the code or a name? Delete it.

## Code comments

These rules cover hand-written JSDoc, `//` comments, package READMEs, and pages in `docs/`. `pnpm generate` writes `connectors/<name>/src/openapi.ts` and `src/operations.ts`; `CONNECTORS_STANDARDS.md` says not to hand-edit them. The rules above still apply.

### What earns a place

A comment stays only if it explains something the code can't: an unusual choice, an invariant, a constraint, or a contract the caller must follow. If deleting it loses nothing a reader of the code would miss, delete it.

Delete filler, hype, and section headers over a few lines of code. If two comments say the same fact, keep the one nearest the code it explains. Never put credentials or secrets in a comment or doc, and keep personal names out of public names (images, packages, URLs).

### How every doc and comment reads

- Open with a plain, full sentence saying what the thing is. No fragments like "A fetch that never answers."
- Then the purpose: what it's for and who calls it. Then the why.
- State the current rule. Never tell history ("previously", "used to", "the old message").
- No planning jargon ("Slice A", "the next slice") or dated status ("as of 2026-09-15"). Say what the thing means.

### File comments

- One sentence on what the file is for. Add more only if it earns it.
- Never list the file's exports.
- Design rules and architecture belong in `docs/`, not in a file comment.
- How to call an export stays, as plain rules. Don't walk through one run.
- A short step-by-step map of what the file executes may stay.

### TODOs and issues

- A TODO needs an issue number and link: `TODO(#123, https://github.com/DashJump/puppi/issues/123): ...`
- References to tracked issues (`#222`) are fine.

### Public package docs

The editor shows this JSDoc on hover for an export from a published package: `@puppi/sdk`, `@puppi/cli`, `@puppi/executor-js`, `@puppi/adapter-storage`, and each `@puppi/adapter-*` connector.

- A type gets one line on what it is.
- A call gets one line on what it does, plus what the user will observe.
- No open design questions, and no links to pages in `docs/`.

### READMEs

A package README gives the pitch and links out. It says what to run and what the reader sees.

### Where things go

| Content | Home |
|---|---|
| Design rules, architecture, protocol | the matching page in `docs/` |
| How to call an export | JSDoc on that export |
| What a package is, its command, and its config | that package's `README.md` |
| Install and the first pipeline | the root `README.md` |
| Connector pull-request review | `CONNECTORS_STANDARDS.md` |
| The connector `docs` value | the `docs` field on that connector's default export, an `https://` URL |
| Version and publish steps | `.changeset/README.md` |
| History, roadmaps, test counts, dead paths | nowhere |

Before moving prose into `docs/`, check whether the page already says it. If it does, delete the copy.

### When the doc is hard to write

If a doc has to say "only call this right after X", or you can't say why a function exists, the code has a problem. Don't explain it away; open an issue.
