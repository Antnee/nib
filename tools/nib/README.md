# Nib tools

A parser, checker and formatter for Nib. No dependencies: Node 24 or later runs the
TypeScript directly.

    node tools/nib/src/cli.ts check packages examples std guide  # check files or directories
    node tools/nib/src/cli.ts check --json examples   # machine-readable diagnostics
    node tools/nib/src/cli.ts fmt --check examples    # list files not in canonical form
    node tools/nib/src/cli.ts fmt examples            # rewrite them in canonical form
    node tools/nib/test/run.ts                        # the test cases
    node tools/nib/test/format.ts                     # the formatter's cases
    node tools/nib/test/names.ts                      # go-to-definition's links

- `src/lexer.ts`: tokens, including string literals with their interpolations.
- `src/parser.ts`: the syntax tree; implements `design/grammar.md`.
- `src/check.ts`: names, imports, static members, interface implementations (`override`),
  attributes, visibility, naming case and doc examples. Files under a directory with `nib.toml` form one package; any other file
  stands alone. The stdlib's declaration files in `std/` (at the repo root) supply the
  prelude and every `std` module.
- `src/lsp.ts`: the language server editors start. It runs `src/server.ts` as a child
  process, and starts a fresh one, handing over the open documents, whenever the checker's
  source or the stdlib's declarations change. `src/server.ts` is the server itself: it reports the checker's diagnostics as you
  type (re-checking the whole package, with unsaved buffers in place of the files on disk),
  shows a name's type or signature on hover, goes to a name's definition, folds comment
  runs, blocks and multi-line strings, and gives the outline. See below.
- `src/format.ts`: the formatter. It works on tokens, not the syntax tree, and leaves
  anything its rules don't cover as written. Each result must keep the input's tokens
  (apart from trailing commas) and comments, and parse if the input did; otherwise the file
  is left as it was and `fmt` says why. `check` warns about a file `fmt` would change
  (this is done in `src/cli.ts`, so the test cases needn't be formatted). `test/format` holds its cases, as `name.in.nibl`
  and the `name.out.nibl` it must produce.
- `src/markdown.ts`: the code in Markdown files that are named on the command line or sit in
  a `guide/` directory. Blocks fenced `nib` that hold declarations are type-checked, one
  module per file (a block fenced `nib standalone` gets a module of its own); blocks of
  statements are parsed; blocks fenced `nib error` must be
  rejected (`NIB_SHOW_REJECTED=1` prints why each one was). A file that says
  `<!-- quotes: path -->` is checked as that one source file, and its code must match it.
- `test/cases/*.nibl`: each starts with `// expect: ok`, `// expect: error: <text>` or
  `// expect: warning: <text>`.

- `src/types.ts`: the type stage, which runs after `check.ts` and reuses the names it
  resolved. It works out each expression's type and checks instance members (`value.name`),
  records built from their fields, `with`, constructors and `new`, and calls: the number of arguments and their labels
  (only a `named` parameter takes one), against overloads told apart by arity and `named` parameters. The "boolean trap"
  lint is in `check.ts`, on declarations. It checks that a
  value fits the type it's given to (an argument, a field, a `let` annotation, a `return`,
  an assignment, a condition), infers type arguments from a call's arguments and checks
  their constraints (`Codable<JsonCodec>`, `Hashable`), and checks number literals and
  arithmetic. The type a position expects flows into closures, so
  `lines.map(fn(l) => l.total)` and `fn(app) => app.auth.signIn` are checked like any other code. What it can't type is unknown and reports nothing, so a gap is a check that
  doesn't happen, never a false error.

`PENDING-CHECKS.md` lists the agreed rules it can't enforce yet, and `TYPE-STAGE.md` is the
plan for the type stage that will enforce most of them. It also checks null safety, with
narrowing after a test (#233), what `try`, `fail`, `catch` and `??` may handle and pass on,
dropped `Result`s, that a `match` covers every case, that every error type implements
`Error`, and route handlers and guards against their full patterns. What it doesn't check: the contents of dependencies (names imported from them are trusted).

## Language server

    node tools/nib/src/lsp.ts

### PhpStorm (and other JetBrains IDEs)

1. Install the **LSP4IJ** plugin (free, by Red Hat) from Settings → Plugins → Marketplace.
2. Settings → Languages & Frameworks → Language Servers → **+**:
   - Name: `nib`
   - Command: the absolute path to Node 24, then this file, for example
     `/Users/anthony/.nvm/versions/node/v24.16.0/bin/node /Users/anthony/git/antnee-lang/tools/nib/src/lsp.ts`.
     The IDE doesn't see your shell's `PATH`, so a bare `node` may not be found, and an
     nvm path changes when you upgrade Node.
   - Mappings → File name patterns: `*.nibl`, language ID `nib`.
3. Keep the TextMate grammar (`tools/editors/textmate`) for highlighting; the server adds
   errors, folding and the outline on top of it.

LSP4IJ's console (View → Tool Windows → Language Servers) shows the traffic if something
doesn't work.

Hover and go to definition work on names that the type stage typed: locals, parameters,
fields, getters, functions and methods (with the overload the call chose), and types. Not
yet: completion and renaming.
