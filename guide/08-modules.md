# Modules and packages

## Packages

A package is what gets versioned and published: a manifest, `nib.toml`, and a `src/`
directory of modules.

```toml
[package]
name = "antnee/shop"
version = "0.1.0"
nib = "^1.0.0"

[dependencies]
stripe = { package = "stripe/stripe", version = "^4.0.0" }
```

A package's name in the registry is `vendor/name`, such as `antnee/shop`.

- In the package's own code, its modules start with the name part: `shop.orders`.
- A dependency is imported by the key it has in the manifest: `stripe` above. You choose the
  keys, so two dependencies can never clash.
- `std` is reserved for the standard library.

`nib.lock` records the exact version of each package installed, with a hash of its
contents. It's committed with the code.

Installing a package never runs any of its code.

The manifest also lists what the program needs from its host: its configuration variables,
databases, queues and directories. See [Configuration and resources](15-host.md).

## Modules

**A module is a directory.** Every `.nibl` file in the directory belongs to that module,
and can use the other files' declarations without importing them.

A file doesn't say which module it's in: its directory decides. Moving the file moves it to
another module. File names are only for people, with one exception: migrations run in the
order of their file names. Each migration file declares one type that implements `Migration`,
which is how the runner finds it. It's a record, because it holds no dependencies: `apply`
is given the database.

Otherwise a module's files can be split however suits its readers. One class per file is a
team's choice, not a rule.

```
src/
	orders/          shop.orders
		cart.nibl
		checkout.nibl
		checkout.test.nibl
	storage/         shop.storage
		orders.nibl
```

A module's name is lowercase letters and digits, with no separators: `payments`, never
`payment_gateway`. For structure, nest directories: `payments/stripe` is `payments.stripe`.

## Imports

```nib
import std.http.{Request, Response, Status}
import std.log

fn missing(req: Request) -> Response {
	log.info("no page at ${req.path}")
	return Response.text("not found", status: Status.NOT_FOUND)
}
```

- `import std.log` brings in the module, used by its last segment: `log.info(…)`. `as`
  renames it.
- `{…}` brings in types and constants by name. Attributes are listed first, with `@`:
  `import std.db.{@db, Db}`.
- An imported function is always called through its module (`log.info`, never a bare
  `info`), so a call shows where it lives. A function in the same module is called by its
  name alone.
- To use both a module's functions and names from it, import them on one line with
  `with`: `import std.log with {Level}` brings in `log` and `Level`. It's the only way to
  write that, so `fmt` merges `import std.log` and `import std.log.{Level}` into it.
- A type or constant can be used through its module too, once the module is imported:
  `log.Level.Info`. Import it by name when you use it often. Reach it through the module
  when its name would clash, as `log.Route` beside `std.http`'s `Route`, or when the module
  says what it is, as `passwords.Policy`.
- An import's path is an address, and its last segment is the name it gives. A module
  doesn't hold the modules inside it, so `import std.crypto` doesn't give
  `crypto.passwords`: import `std.crypto.passwords` for that. This is how Go and Rust
  import, and `{…}` is Rust's `use a::b::{C, D}` and JavaScript's named imports.
- There are no wildcard imports and no re-exports: a name lives in one place.
- Modules in the same package may import each other in a cycle, because nothing runs when
  a module is loaded, so there's no loading order to get wrong. It's a warning, though: two
  modules that need each other can't be read one before the other. Move what they share
  into one of them, or into a module of its own.
- An unused import is a warning.

A local can't have the name of a module the file imports. Import the type by name instead:
`import std.db.{Db}`, then `db: Db`. Importing names from a module doesn't import the module
itself, so after `import std.db.{Db}` the name `db` is free. It's `with` that brings in the
module as well.

### The prelude

The names nearly every file needs come without an import:

- the number types, `Bool`, `String`, `Bytes`, `List`, `Map`, `Set`, `Result`, `Void` and
  `Never`;
- interfaces such as `Error`, `Stringable`, `Parseable`, `Comparable` and `Sensitive`;
- `Secret`, which a `secret"…"` literal builds;
- the functions `print`, `panic`, `assert`, `todo` and `sameInstance`;
- the compiler's own attributes.

The full list is in `std/src/prelude.d.nibl`.

A literal can produce a type that isn't in the prelude: `url"…"` gives a `Url` with no
import. Writing the name `Url` in a signature, field or annotation needs
`import std.http.{Url}`.

## Visibility

| Written | Visible |
|---------|---------|
| `private` | inside the type, or the file for a top-level declaration |
| (nothing) | anywhere in the package |
| `pub` | to other packages too |

Package-wide is the default, so it isn't written. The one exception is a constructor's
parameter, where `internal` marks a field visible anywhere in the package. There, leaving
the visibility out means the parameter isn't a field at all. See
[Constructors](04-types.md#constructors).

Modules within a package are namespaces, not walls. For a hard boundary, split code into
packages in one workspace.

A type from a dependency can't appear in your package's `pub` API, unless the manifest marks
that dependency `public = true`. That way, a dependency's types can't leak into your users'
code by accident.

## Tests in a module

`orders/checkout.test.nibl` belongs to the `orders` module, so its tests can use anything in
that module.

Declarations in test files, such as helpers, fixtures and fakes, are visible to every test
file in the package. A test in another module imports them like anything else:
`users.testUser(…)`. Production code never sees them, so they can't clash with its names.

## Test-only modules

A package can offer stand-ins for other packages' tests, as `std.testing` does. The
manifest lists those modules, and only test files can import them:

```toml
[testing]
modules = ["stripe.testing"]
```

A test-only module is ordinary code otherwise. It can import other test-only modules. See
[Testing](12-testing.md).
