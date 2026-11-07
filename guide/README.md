# The Nib guide

Nib is a statically typed language for web servers that also compiles for the browser.
It aims to read like English, to show what a line does without hidden rules, and to work as
well for agents as for people.

There is no compiler yet. A checker in `tools/nib` parses and type-checks the examples, the
standard library's declarations and every code example in this guide.

## How to read it

The chapters build on each other, but each one stands on its own if you know another typed
language. Code blocks show working Nib. A block that starts with a `// Rejected:` comment
shows code the compiler refuses, and the comment says why.

The standard library's reference is in `std/src/`. Each module there is a directory of
`.d.nibl` files, such as `std/src/forms/forms.d.nibl`: signatures with doc comments, and no
bodies. The prelude, the names available everywhere without an import, is
`std/src/prelude.d.nibl`.

## Coming from PHP

| PHP | Nib |
|-----|-------|
| `$name = "Ann";` | `let name = "Ann"` (or `var` if it changes) |
| `"Hello {$name}"` | `"Hello ${name}"` |
| `<<<EOT … EOT;` | `"""` on its own lines |
| `function total(array $lines): float` | `fn total(lines: List<Line>) -> Decimal` |
| `fn($x) => $x * 2` | `fn(x) => x * 2` |
| `?int`, `$a ?? $b`, `$a?->b` | `Int?`, `a ?? b`, `a?.b` |
| `throw` / `try … catch` | `-> T else E`, `fail`, `try` to pass a failure on, `catch err { … }` after a call to handle it |
| `match ($x) { … }` | `match x { … }`, which the compiler checks covers every case, where PHP throws when nothing matches |
| `enum Status: string` | `enum Status: String` |
| `readonly class` | `record` |
| `class` | `class`, without inheritance |
| `function __construct(private Db $db) {}` | `construct(private db: Db) {}` |
| `new Foo(...)` | `new Foo(…)` for a class; a record is a value: `Point(x: 1, y: 2)` |
| `instanceof` | no type tests: use an enum and `match`. `is` tests a pattern, as a `match` arm does: `null`, a variant, a literal |
| `#[Attribute]` | `@attribute` |
| `namespace`, `use` | a directory is a module; `import` |
| `composer.json` | `nib.toml` |
| `getenv('API_KEY')`, `.env` | `env.secret("API_KEY")`, declared in `nib.toml`; `.env` in development |
| generators (`yield`) | generators (`yield`), returning an `Iterable` |
| `new PDO(…)`, one connection per request | `env.db("main")`: a pool; each call borrows a connection and gives it back, and a transaction keeps one until it ends |
| `$pdo->lastInsertId()` | `db.insertId<K>(sql"insert …")`, from the insert itself |
| `fopen`, `fgets`, `fclose` | `dir.open(path)`, `io.lines(…)`; closed at the end of the request |
| PHPUnit | `test "…" { expect … }` in `*.test.nibl` files |

## Contents

0. [A first look](00-first-look.md): a whole web app, read from top to bottom, with a link
   to each chapter it uses
1. [Basics](01-basics.md): programs, comments, bindings, names, lines
2. [Values](02-values.md): numbers, text, typed literals, collections, tuples, ranges
3. [Functions](03-functions.md): parameters and labels, closures, function values, pipes
4. [Types](04-types.md): records, classes, enums, distinct types, interfaces, generics
5. [Null](05-null.md): `T?`, `??`, `?.` and narrowing
6. [Errors](06-errors.md): `else` in signatures, `try`, `fail`, handling and panics
7. [Control flow](07-control-flow.md): `if`, `match`, patterns, loops, `defer`
8. [Modules and packages](08-modules.md): directories, imports, visibility, the manifest
9. [The web](09-web.md): requests and responses, routes, guards, middleware, forms, sessions, cookies, pages
10. [Databases](10-databases.md): connections, queries, new rows' IDs, transactions, UUIDs
11. [Attributes and secrets](11-attributes.md): codecs, checked attributes, `@sensitive`
12. [Testing](12-testing.md): test files, `expect`, fakes
13. [Concurrency](13-concurrency.md): `start`, waiting, cancellation
14. [Streams](14-streams.md): reading and writing a piece at a time, generators, channels
15. [Configuration and resources](15-host.md): what a program needs from its host, `.env`
16. [Dates and times](16-time.md): moments, time zones, calendar arithmetic, storing, showing dates to people
