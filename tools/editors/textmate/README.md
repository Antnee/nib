# Nib syntax highlighting (TextMate grammar)

A TextMate grammar for `.nibl` files, packaged as a VS Code-style extension, which
JetBrains IDEs (PhpStorm, IntelliJ) and VS Code can both load. It highlights only. For errors
as you type, folding and the outline, add the language server too (`tools/nib/README.md`).

## PhpStorm

1. Settings → Plugins: make sure **TextMate Bundles** is enabled (it is bundled).
2. Settings → Editor → TextMate Bundles → **+**, and choose this folder
   (`tools/editors/textmate`).
3. If `.nibl` files still open as plain text, remove `*.nibl` from Settings → Editor →
   File Types → Text.

After editing the grammar, remove the bundle and add it again to reload it.

## VS Code

Copy or symlink this folder into `~/.vscode/extensions/nib`, then reload the window.

## What it knows

Comments (`///` doc comments have their own scope, so a theme can dim them), tagged and
raw strings (`html"…"`, `sql"""…"""`, `r"…"`) with `${…}` interpolation, attributes,
numbers, keywords, and the rule that any word can name a member: `.new()`, `.get(key)`
and `use:` are names, not keywords. Types are PascalCase names and constants are
`UPPER_SNAKE_CASE`, as the case rules require.

## Checking it

The grammar was tested with `vscode-textmate`, the tokenizer VS Code uses: every `.nibl`
file under `examples/` and `std/` tokenizes without leaving a string or brace open.
