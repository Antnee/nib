# AGENTS.md

This repo holds the design of **Nib**, a new programming language. It is being
designed by a human and an AI together, over several rounds of discussion.

Source files use the `.nibl` extension.

When a language feature comes from another language, credit it in `design/references.md`.

## Current phase: design, not implementation

There is no compiler yet. Nothing here is code that runs. Do not scaffold an implementation
unless you are asked to.

## How decisions are recorded

- `design/decisions-log.md` is the single source of truth for what has been decided: one
  row per decision, in full, with its reasons and history.
- `design/decisions.md` is its index for readers: one line per decision in force, grouped
  like the guide. Every agreed decision gets a line there in the same piece of work, and a
  decision that's replaced loses its line. Open and proposed items don't appear there.
- Each topic has a status: **open**, **proposed**, **agreed**, or **rejected**.
- Only **agreed** items are part of the language. A **proposed** item is one side's position
  and is still up for argument. Never present a proposed item as settled.
- When a decision changes, update its entry and add a note saying why. Do not delete the
  history of rejected ideas; record them so the same ground is not covered twice.

## Checking code

There is no compiler, but there is a checker: a parser and name checker in `tools/nib`
(TypeScript, no dependencies, Node 24 or later). `design/grammar.md` is the grammar it
implements.

- After changing any `.nibl` file or the guide, run
  `node tools/nib/src/cli.ts check packages examples std guide`. It must report 0 errors and 0
  warnings. Add `--json` for machine-readable output.
- The stdlib's API is declared in `std/src/` as `.d.nibl` files: signatures without bodies.
  First-party packages, such as `nib/access`, are declared the same way in `packages/`,
  which stands in for the registry: a dependency on one is read from there and checked.
  When example code needs a stdlib name or member that isn't declared, decide whether the
  stdlib should have it (add it, in line with `decisions-log.md`) or the code is wrong.
- When a decision changes the syntax, update `design/grammar.md`, the parser, and
  `tools/nib/test/cases` together, then run `node tools/nib/test/run.ts`.
- When the checker flags code that you believe is valid, decide which is wrong. If the code
  follows an agreed decision, fix the tool. If it doesn't, fix the code. If the decisions
  don't say, record the question in `decisions-log.md`.
- The checker resolves names, imports and static members, and checks that implementing
  members say `override` and keep the interface's parameter names, and that a constructor sets every field once before `this` is used. Its type stage checks instance members, records built from their fields, `new` against constructors, attribute arguments against the attribute's fields, calls'
  arguments (number, labels and types), whether values fit the types they're given to, `let`s set
  later (once on every path), type
  arguments and their constraints, number literals and arithmetic, interpolation, secrets (`@sensitive`), closures, assignments to
  `let`s, parameters and captured `var`s, who may write a field or call a `mut fn`, private
  members and private construction, generators, things opened in loops and writers never
  closed, transactions never committed or with no deferred rollback, null safety with narrowing, `try`,
  `fail`, `catch` and `??`, dropped values, `==` between different types, the values a pattern names, `match` exhaustiveness, route handlers
  against their patterns, with their `@guard` and `@path` markers, and the names asked of
  `Env` against what the manifest declares, that `main` is `pub`, that each migration
  file declares one `Migration`, that no two rate limits share a name, and that a codec-marked type's fields can be written by that codec (and a `@json` enum's variants as tagged objects). It doesn't read dependencies or follow values through data flow, so passing is necessary, not sufficient (`tools/nib/PENDING-CHECKS.md`). Code in doc comments is checked
  but not run: names it doesn't declare (`db`, `this`) are unknown rather than errors, and
  a stdlib type or attribute declared in one module needs no import, so everything else
  about an example must be right.

## When a decision is agreed

Agreeing a decision isn't finished until the tooling and the artefacts follow it. In the
same piece of work:

1. Set its status in `design/decisions-log.md`, with a note of what was applied, and give it
   a line in `design/decisions.md` (removing the line of any decision it replaces).
2. Update the stdlib declarations in `std/src/` and the example code.
3. If it changes the syntax: `design/grammar.md`, the parser and `tools/nib/test/cases`
   together, then run `node tools/nib/test/run.ts`.
4. If it adds a rule: make the checker enforce it, with a test case. If the checker can't
   yet (it needs types, argument matching or a formatter), add the rule to
   `tools/nib/PENDING-CHECKS.md` instead.
5. If it changes keywords, literals, comments or other tokens: update the highlighting
   grammar in `tools/editors/textmate/syntaxes/nib.tmLanguage.json`, and run
   `node tools/editors/textmate/test/check.mjs examples std` (its header says how to
   install the tokenizer).
6. Credit any language or library it came from in `design/references.md`, and update
   `design/agenda.md` and `design/std-findings.md` if it settles an item there.
7. Update the language guide in `guide/` wherever it describes the changed rule, with a
   working example, and an `nib error` block for a rule the checker enforces.
8. Run `node tools/nib/src/cli.ts check packages examples std guide`: 0 errors, 0 warnings.

## Formatting

`node tools/nib/src/cli.ts fmt <paths>` puts code in its canonical form (`decisions.md`
#284), and `fmt --check` lists what it would change. When you change the formatter, add a
case to `tools/nib/test/format` and run `node tools/nib/test/format.ts`. `check` warns
about a file `fmt` would change, so run `fmt` on what you've written before checking it.

## The language guide

`guide/` explains the language to someone who will use it: one chapter per topic, plain
English, short examples. It describes only **agreed** decisions (a proposed one is marked as
proposed), and, like example code, never cites decision numbers or rounds.

`guide/00-first-look.md` reads `examples/notes/src/main.nibl` from top to bottom, and the
checker fails if their code differs, so change the two together.

Its code is checked: a fenced block marked `nib` that holds declarations is type-checked
(the blocks of one chapter form one module), a block of statements is parsed, and a block
marked `nib error` must be rejected. A block that repeats a name another block declares
(a second `main`) is marked `nib standalone`, which checks it in a module of its own;
never rename things, or explain the tooling, in text meant for readers. Start a rejected block with a `// Rejected:` comment
that says why, and confirm the reason with `NIB_SHOW_REJECTED=1`.

## Writing example code

Code under `examples/` (and, later, any Nib code) must stand on its own for a reader who
has never seen this repo's design documents.

- Never refer to decision numbers (`#13`), rounds, findings, work packages, tickets or
  "the design" in code or comments. Explain the reason in plain words instead.
- Comments say why, not what. If a construct needs a design document to make sense, that
  is a finding: record it in `decisions-log.md`, not in a comment.
- Design commentary belongs in `design/` and in an example's `FINDINGS.md`, not in `.nibl`
  files.
- Text that people see comes from the page or handler that shows it, never from an error's
  `message`, which is for developers and logs: lower case, describing its own layer.
- Every type after `else` in a signature implements `Error`. A result that isn't a failure
  goes in the return type, as an enum. The test: if every caller deals with a case as soon as
  it happens and none passes it on (a wrong password, an expired link), it's an outcome, so
  it goes in the return type. If callers pass it on with `try`, it's an error. Don't add
  such outcomes to an error enum next to the failures it wraps. A failure every caller
  handles with `catch` straight after the call, such as a form's `FormError`, is fine as it
  is: it implements `HandledAtCall`, so the checker refuses `try` on it.
- A form's fields are named through its schema, `SignUpForm.fields.email`, never as strings.
- A constructor that takes three or more dependencies marks each one `named`, so the code that
  builds it says which is which.
- A `get` is for what a value is or has: one expression after `=>` (the checker enforces
  that, and that it can't fail or change anything), cheap, the same answer each time. A
  method is for what it does: computing over its items, converting, anything with an effect
  or arguments.

## Principles

Agreed, and explained with examples in `design/principles.md`. Judge every proposal against
them:

1. **Clear over clever.** A reader, human or agent, can tell what a line does without
   knowing hidden rules.
2. **Readable as plain text.** Code makes sense with no language server or highlighting;
   "the editor shows it" is not a reason.
3. **Magic only where it pays for itself.** "Language X does it" is not a reason on its own.
4. **One obvious way.** One spelling for each thing.
5. **Safe by default, explicit to opt out.** The risky choice is asked for by name.
6. **Start small, widen later.** When unsure, leave it out: adding later breaks nothing.
7. **DX and AX together.** Diagnostics that say what to do, predictable APIs, and one
   canonical format, which `fmt` writes and `check` enforces.
