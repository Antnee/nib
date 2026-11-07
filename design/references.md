# References and inspiration

Every feature we take from elsewhere is credited here, with what we took and what we changed.

| Feature | Source(s) | What we took / changed |
|---------|-----------|------------------------|
| Canonical, config-free formatter | Go (`gofmt`), Rust (`rustfmt`), Zig | Formatting is enforced by the toolchain |
| Tabs for indentation | Go (`gofmt`) | Also an accessibility argument: each reader sets their own width |
| Single toolchain binary | Go, Cargo (Rust), Deno | |
| `Result<T, E>` + `?` | Rust, Swift (`throws`/`try`), Zig (`!T`, `try`) | Errors are values that show up in signatures |
| Sum types + exhaustive match | ML, Haskell, Rust, Swift, Kotlin sealed classes | |
| `is` patterns that bind a name | C# (`x is Foo f`), Rust `if let`, Swift `if case` | |
| Nullable `T?`, `?.`, `??`, flow narrowing | Kotlin, C# nullable reference types, TypeScript, Swift | Null exists only in types that say so |
| Arity overloading | Erlang, Elixir (`name/arity`) | No type-based overloading |
| Named arguments | C#, Kotlin, Swift, PHP 8 | Only a `named` parameter is labelled, and it always is (#286), as Swift's labels are part of a function's name; Python's keyword-only parameters (`*`) |
| An implementation keeps its interface's parameter names | Swift (a protocol's argument labels are part of the requirement), Kotlin (warns when an override renames a parameter) | Only for `named` parameters, the ones a call labels (#286) |
| `_` placeholders for partial application | Scala, PHP partial function application RFC, PHP first-class callables `f(...)` | The number of placeholders selects the arity |
| Interfaces with default methods | Java 8+, C# 8+, Rust traits, Swift protocol extensions | |
| Record (value) vs class (identity) | C# record/class, Swift struct/class, Kotlin data class | No inheritance on classes |
| Constructors that declare fields | PHP 8 constructor promotion, TypeScript parameter properties | A parameter marked `private`, `internal`, `pub` or `var` is a field; the body is ordinary, `{}` when empty. Swift's implicit memberwise initialiser was tried first and rejected: a reader couldn't find it |
| `internal` for the default visibility | C# and Swift `internal` | Written only on a constructor's parameter, where leaving it out means "not a field"; Swift allows the redundant spelling everywhere, Nib doesn't |
| Fields set once by the constructor | Swift two-phase initialisation, Java definite assignment of `final` fields | Every field set on every path before `this` is used |
| `new` for objects, not values | Java, C#, PHP (`new`); Swift and Kotlin (values built like calls) | `new` only where the result has identity; records are built like calls |
| Records built like calls, fields named | Swift memberwise initialisers, Kotlin data classes, Python dataclasses | Every argument named; replaces brace literals, which clash with blocks as Go's and Rust's do |
| `secret url"…"`, `Secret<T>` | The user's idea; Rust's `secrecy::Secret<T>` wraps any value the same way | A tagged literal that stays secret |
| Cookies with safe defaults; signed and encrypted cookies | Rails (`cookies.signed`, `cookies.encrypted`), Go `http.Cookie`, Symfony `Cookie` | `Secure`, `HttpOnly`, `SameSite=Lax` unless turned off by name; a tampered cookie reads as missing; the keyring is passed in, not global |
| Explicit delegation | Kotlin `by`, Go embedding | |
| Restricted setter visibility | C# `{ get; private set; }`, Swift `private(set)` | |
| Injection-safe literals | Scala string interpolators (doobie `sql"..."`), JS tagged templates (postgres.js, lit-html), Python 3.14 t-strings (PEP 750), Java String Templates (JEP 430, withdrawn), Go `html/template`, Google Safe types / browser Trusted Types | Built in, and sinks refuse plain strings |
| Compile-time checked SQL (tooling) | Rust `sqlx` | |
| Newline handling | Python implicit line joining, Go semicolon insertion, Kotlin/Swift leading-dot chains | |
| Block scope with no local shadowing | C# (CS0136) | |
| Shared-nothing request model | PHP | |
| Host abstraction over one API | Deno / web-standard APIs, WASI | |
| Untyped literals typed by context | Go untyped constants | |
| Copy-on-write value collections | Swift Array/Dictionary | |
| Construction gated by field visibility | Rust (private fields block struct literals) | |
| "Parse, don't validate" | Alexis King (2019 essay) | Fallible constructors return `Result` |
| `and` / `or` / `not` | Python, Ruby, PHP (low-precedence variants) | The only spelling; no `&&` |
| Explicit string length units | Swift (grapheme-based `count`), Rust (`len` is bytes) | |
| Exact decimal type | C# `decimal`, Python `decimal`, Java `BigDecimal` | |
| Distinct named types | Go defined types, Haskell `newtype`, Rust newtype pattern | |
| Subtypes that widen to their base | Ada subtypes, Scala 3 opaque types, Kotlin value classes, TypeScript branded types | Widening is implicit; narrowing goes through a constructor |
| `div` / `mod` words | Pascal, MySQL `DIV`/`MOD`, Python `//` | |
| `let … else` | Rust let-else, Swift `guard let` | |
| Negated predicate pairs | managur/Collection (`isEmpty`/`isNotEmpty`), managur/rick-role (`is`/`isNot`, `has`/`hasNot`) | |
| Request context propagation | W3C Trace Context, OpenTelemetry | |
| Field punning | JavaScript shorthand properties, Rust struct init shorthand | |
| Cloud interfaces | WASI keyvalue / messaging / blobstore proposals, Fermyon Spin, Dapr | |
| Collection API | managur/Collection v2 (`contains` vs `containsMatch`, `first() -> ?T`) | |
| "Bool plus why" decisions | managur/rick-role (`allows(..., because: $reason)`) | Done as an enum + `is` pattern instead of an out param |
| Uniform access principle (computed properties) | Bertrand Meyer / Eiffel, C# properties, Kotlin, Swift computed properties | Read-only. A getter cannot mutate or fail |
| Panics contained to a unit of work | Erlang/OTP "let it crash" + supervisors, PHP fatal errors per request | The runtime is the supervisor |
| Safe error responses | RFC 9457 (Problem Details for HTTP APIs) | |
| Dev error pages | PHP Whoops, Laravel Ignition, Rails better_errors | Dev only, never shown in release builds |
| Panic exit code 101 | Rust | |
| Browser fallback UI | React error boundaries, Elm | App-wide for now |
| Runtime limits as panics | PHP `max_execution_time` / `memory_limit` | |
| `defer` | Go (function-scoped), Swift and Zig (block-scoped) | Block-scoped; does not run on panic |
| `defer else` | Zig `errdefer` | Runs only on the failure path |
| Labelled `break` | Java, Go, Kotlin, Rust | |
| `or` in match patterns | Rust `\|`, Python `\|` | Spelled as a word, like the logical operators |
| `do … while` | C, Java, PHP | |
| Postfix `++` / `--` as statements only | Go | |
| Inclusive `a..b`, exclusive `a..<b` | Kotlin (`..` / `..<`), PHP `range()`, SQL `BETWEEN` | |
| `try` prefix for propagation, alongside `?.` / `??` / ternary | Swift, Zig | No `catch` |
| One `try` per fallible call, binding like a unary operator (#241) | Zig (`try` is a prefix operator on one expression) | Replaced Swift's rule, where `try` covers the whole expression |
| Sensitive values: an explicit reveal, a `Sensitive` interface, a `secret"…"` literal, constant-time comparison (#240) | Rust `secrecy` (`expose_secret`), Pydantic `SecretStr`, PHP 8.2 `#[\SensitiveParameter]`, taint tracking (Perl, Ruby) | |
| Parentheses required for nested ternaries | PHP 8 | |
| `ifEmpty(default)` | Kotlin | |
| `from` error wrapping | Rust `From` + `?`, thiserror `#[from]` | Declared on the variant; no trait search |
| Enforced naming case | C#, Java conventions; Go (case = visibility, which we avoid) | Case only restricts names, never changes meaning |
| `to` / `from` / `parse` conversions | Rust (`to_string`, `From`, `parse`), Kotlin (`toInt`) | |
| Return type shows if a conversion can fail | Kotlin (`toInt` / `toIntOrNull`), Rust (`From` / `TryFrom`) | One spelling, `toY()` |
| Doc comments with checked examples | Rust doctests, Python doctest, C# `///` | CommonMark; checked, not run, with assumed names left unknown |
| Shebang line | Unix scripts, PHP CLI | |
| Documentation that sets the bar | php.net (direct `/{function}` URLs, version notes) | |
| `test "name" { }` blocks | Zig, Go `_test.go` files (placement) | |
| Test code lives only where production can't reach it: test files, and test-only modules named in the manifest (#261) | Rust dev-dependencies and `#[cfg(test)]`, Go `_test.go` files and `httptest`-style packages | Go's shared fake packages aren't enforced; Rust's need feature flags or separate crates |
| The manifest declares configuration and named resources; each environment binds them through variables (#262) | Fermyon Spin (manifest plus runtime config), Cloudflare Workers bindings, the Twelve-Factor App | |
| Warning on import cycles (#322) | ESLint `import/no-cycle`, madge; contrast Go, which forbids them | A warning, since nothing runs at import |
| `.env` for development (#262) | Node `dotenv`, PHP `vlucas/phpdotenv` (Laravel, Symfony), Ruby `dotenv` | A strict subset, written fresh; never read in production |
| Directories granted on the command line (#262) | Deno `--allow-read` / `--allow-write` | Named grants: `--dir name=path` |
| Power-assert failure output | Groovy/Spock power asserts, pytest assert rewriting | |
| Data-driven tests | PHPUnit data providers, Go table tests, pytest parametrize | Expressed with `for … in` |
| Anonymous interface implementations | Java anonymous classes, Kotlin `object :`, Go struct literals | |
| Nestable block comments | Rust, Swift, Kotlin, Haskell | |
| `fn(x) => expr` closures | PHP 7.4 arrow functions, C#/JS arrows | `fn` keyword kept for greppability |
| `_.member` shorthand | Scala placeholder syntax, Kotlin `it` | Member chains and call arguments only |
| Capture by value, explicit by-reference | PHP closures (`use`, `use (&$x)`), C++ capture lists | |
| Fallibility generic over the closure | Swift `rethrows`, Rust closures returning `Result` | Uses `else Never` |
| Pipe operator with explicit placeholder | Hack (`$$`), PHP 8.5 `\|>`, F#, Elixir (implicit first argument, not adopted), OCaml | `_` in any position, never implicit |
| Operator declarations in the type body | C# (`public static Money operator +(…)`), Kotlin `operator fun`, Swift static operators | Fixed operator set, cannot fail |
| Operator traits owned by the left operand (not adopted) | Rust `Add<Rhs>`, Python `__add__` / `__radd__` | Replaced by "one operand is the declaring type" |
| `This` for the implementing type | Rust / Swift `Self`, PHP `static` | PascalCase, because it is a type |
| `compare` → `Ordering` | Rust `Ord`, Haskell `Ord`, Kotlin `Comparable`, PHP `<=>` | Gives all four comparisons, so they cannot disagree |
| No chained comparisons | Rust, Go (compile errors); contrast Python's chaining | |
| Reified generics | C#, Kotlin `reified` | Contrast Java type erasure |
| Higher-kinded types (not adopted in v1) | Haskell, Scala | |
| Minimal const generics (reserved) | Rust `min_const_generics`, C++ non-type template parameters | |
| Specialisation hazards | C++ `std::vector<bool>`, Rust `specialization` (unstable since 2016) | Only invisible, compiler-internal specialisation |
| Generic code-sharing strategy | C#/.NET (shared reference types, per-value-type specialisation), Go 1.18 GC-shape stenciling, Swift witness tables, Java erasure and Project Valhalla | Unboxed value types guaranteed |
| Conditional methods | Swift conditional conformance (`where`), Rust `impl<T: Ord>`, C# extension methods with constraints | Spelled `when` |
| Static interface members | C# 11 static abstract members, Swift static protocol requirements, Rust associated functions | |
| `Parseable` | Rust `FromStr`, Swift `LosslessStringConvertible`, C# `IParsable<T>` | Used by codecs at compile time |
| Operators only on built-in types (v1) | Go, Java | User overloading deferred |
| Module = directory, qualified calls (`orders.create`) | Go packages | No header line; types importable by name |
| `internal` as the default visibility | C# `internal` (assembly), Rust `pub(crate)` | Default rather than opt-in |
| No side effects on import | ES modules (mostly), Go (contrast `init()`), contrast PHP `include` and Python modules | No `init` at all |
| No wildcard imports | Go, Google Java style, PEP 8 guidance | |
| `std.` stdlib prefix | Rust `std::`, Java `java.` | |
| Re-exports (not adopted) | Rust `pub use`, TypeScript `export … from` | |
| TOML manifest | Cargo (`Cargo.toml`), Python `pyproject.toml` | |
| `vendor/name` package names | Composer / Packagist | |
| Local dependency names | Cargo `package = "…"` renaming | Always explicit |
| Minimal version selection (not adopted) | Go modules (Russ Cox, 2018) | Rejected in round 19 |
| Coexisting major versions | Cargo, npm nesting (per version, not per dependent) | |
| Enforced semantic versioning | Elm (`elm bump`), Rust `cargo-semver-checks` | Built into publish |
| Immutable releases and yanking | crates.io (yank), Go module proxy and `retract`; the 2016 left-pad incident | |
| Checksum transparency log | Go sumdb | |
| No install scripts | Contrast npm `postinstall`, Composer scripts | Supply-chain safety |
| Workspaces | Cargo workspaces, Go workspaces, npm/pnpm workspaces | |
| Constraint operators | Composer (`^ ~ = != , \|\|`, stability flags), Cargo (bare = caret, pre-release opt-in), npm semver | Operator always required; `~` always takes a full version |
| Public / private dependencies | Rust RFC 1977 and RFC 3516 (`public = true`, `exported_private_dependencies` lint; still unstable in 2026) | A compile error, not a lint |
| Nested private copies | npm `node_modules` nesting | Only when sharing is impossible, and only for private dependencies |
| Root-only overrides | Cargo `[patch]`, Go `replace`, npm `overrides`, Composer inline aliases | |
| Lock file and explicit update | Composer (`composer.lock`, `composer update`), Cargo | |
| `version = "workspace"` | pnpm / Yarn `workspace:` protocol, Cargo `workspace = true` | Rewritten to a real constraint on publish |
| `conflict` | Composer `conflict` | |
| Ports and adapters | Alistair Cockburn (hexagonal architecture), Robert C. Martin (dependency inversion principle) | |
| Composition root, pure DI | Mark Seemann (*Dependency Injection in .NET*) | |
| Compile-time wiring (possible future tool) | Google Wire (Go), Dagger (Java) | |
| Interior mutability cell | Rust `Cell` / `RefCell` | |
| `mutating` only on value types | Swift (`mutating func` on structs; classes mutate freely) | |
| `lazy` fields | Kotlin `by lazy`, Swift `lazy var`, C# `Lazy<T>` | Compile-time cycle check |
| Typed container | Symfony compiled container (generated typed getters), Mark Seemann's composition root | Hand-written, no config files |
| Logging targets and routing | Rust `tracing` (targets, subscribers), Python `logging` hierarchy, Monolog channels and handlers, SLF4J / Logback | Call site ambient, routing at the root |
| Caller location | Swift `#file` / `#line` defaults, C# `[CallerMemberName]` / `[CallerLineNumber]`, Rust `#[track_caller]` and `module_path!()`, Monolog IntrospectionProcessor | Declared in the signature |
| Ambient unit-of-work context | .NET `ExecutionContext` / `AsyncLocal`, Node `AsyncLocalStorage`, Java `ScopedValue`; contrast Go `context.Context` | Read-only, owned by the host |
| Logging facade with swappable back ends | SLF4J, PSR-3, Rust `log` / `tracing` facades | The facade is in the stdlib |
| `todo()` | Rust `todo!()`, Kotlin `TODO()`, Scala `???` | Blocks release builds |
| Concurrency is not parallelism | Rob Pike (2012 talk) | |
| No function colouring | Go goroutines, Java virtual threads (Loom), PHP Fibers; Bob Nystrom's essay "What Color is Your Function?" | |
| Structured concurrency | Nathaniel J. Smith ("Notes on structured concurrency, or: Go statement considered harmful", Trio), Swift task groups and `async let`, Kotlin coroutine scopes, Java `StructuredTaskScope` | |
| Channels | Go, CSP (Hoare), Kotlin channels | Bounded, scoped to a `concurrent` block |
| Message passing between isolated processes | Erlang processes, Alan Kay's original description of OOP | Shared-nothing instances talking over queues |
| WASM stack switching | JS Promise Integration (JSPI), WASI 0.3 async | |
| Block-scoped tasks | Swift `async let` (implicitly awaited at scope exit), Trio nurseries | No separate scope keyword; the block is the scope |
| Bounded task pools | Go `errgroup.SetLimit`, p-limit (JS), Kotlin `Semaphore` | |
| Typed attributes | PHP 8 attributes, C# attributes, Java annotations | Compile time only |
| Cache stampede protection | Go `singleflight`, Laravel `Cache::remember` + locks, XFetch (probabilistic early expiration), HTTP `stale-while-revalidate` | |
| Rate limits declared once by name (#330) | Laravel `RateLimiter::for`, ASP.NET Core rate-limiting policies | A typed constant rather than a registered name, so the key's type and the limit are checked |
| `zip` (#331) | Python `zip`, Rust `Iterator::zip`, Kotlin, Swift, C# LINQ `Zip`, Laravel collections | Strict, as Python's `zip(strict=True)`: different lengths are a panic, not a quiet trim |
| A duplicate-row error of its own (#344) | Rails `ActiveRecord::RecordNotUnique`, Laravel `UniqueConstraintViolationException`, SQLSTATE `23505` | One variant on every engine, naming the index, with the rest left as `Rejected` |
| Queue semantics | SQS (visibility timeout, DLQ), RabbitMQ, Symfony Messenger, Laravel queues (failed jobs, retry) | |
| Implicitly resolved futures | MultiLisp `future` (Halstead, 1985), Alice ML, Oz dataflow variables; contrast Swift `async let` (needs `await`) | No resolver method |
| Database-backed queues | Laravel database queue, Rails Solid Queue, Elixir Oban, Go River, Postgres `SKIP LOCKED` | |
| After-response work | Cloudflare Workers `ctx.waitUntil`, PHP-FPM `fastcgi_finish_request()`, Laravel `defer()` / terminable middleware | Attached to the response value; best effort, errors logged |
| Checked purity | Psalm / PHPStan `@pure`, D `pure`, Fortran `PURE`, GCC `__attribute__((pure))` | Verified by the compiler, not trusted |
| Conformance test kits | Go `testing/fstest`, PSR integration tests, WebPlatform Tests | |
| Preludes and editions | Rust (prelude per edition) | |
| Components as functions | React function components, Elm `Html`, Go templ, Kotlin kotlinx.html, F# Giraffe ViewEngine, Blade components (slots) | No separate template language |
| Contextual auto-escaping | Go `html/template`, Google Closure Templates | Parsed at compile time |
| Misuse-resistant crypto | libsodium / NaCl, PHP `password_hash` / `password_needs_rehash`, Tink | |
| Enums in JSON with an internal `"type"` tag | kotlinx.serialization sealed classes; serde `#[serde(tag = "type")]`; Jackson `@JsonTypeInfo`; TypeScript discriminated unions | (#281) |
| Files that ship with the build | Go `embed` and `http.FileServerFS`; Java JAR resources; .NET embedded resources; Rust `rust-embed` | The host chooses whether they're embedded or deployed beside the program (#280) |
| Pool wait timeouts, `PoolTimedOut` | Rust sqlx `Error::PoolTimedOut`; HikariCP `connectionTimeout`; Rails `ConnectionTimeoutError` | A call waits for a free connection up to a limit, then fails (#279) |
| Statements between a cursor's rows | Postgres cursors inside a transaction | The stream sees the rows as they were when its query started (#279) |
| Blind indexes | Paragon CipherSweet | An index's name, part of every hash, is kept apart from its column (#278) |
| SQL-file, forward-only migrations | Flyway, golang-migrate, sqlx migrations, dbmate | Checked against queries at compile time |
| One-line raw triple quotes | C# 11 raw string literals, Python `"""` | |
| Schema snapshot | Rails `schema.rb` / `structure.sql`, Django migration state | |
| Migrations as code with history | Laravel, Doctrine Migrations, Rails, Phinx | Forward-only, `verify` step |
| Legacy hash verification and rehash | PHP `password_verify` / `password_needs_rehash`, PHC string format | |
| `yield` from a block arm | Java 14 `switch` expressions | |
| Named-argument shorthand `f(x:)` | Ruby 3.1 | |
| Variance rules | Kotlin / C# declaration-site `out` / `in`, Scala; function subtyping (contravariant parameters) | Generics invariant |
| Traversal-resistant file access | Go 1.24 `os.Root`, Rust cap-std, WASI preopens, Linux `openat2` `RESOLVE_BENEATH`, Deno permissions | |
| Unit of work | Martin Fowler (PoEAA), Doctrine `EntityManager`, Entity Framework `DbContext` | A domain-declared interface |
| Transactional outbox | Chris Richardson (microservices.io) | |
| Sagas and compensation | Garcia-Molina & Salem (1987), microservices.io; contrast XA two-phase commit | |
| `@mustUse` | Rust `#[must_use]`, C++17 `[[nodiscard]]` | |
| `.field` accessor shorthand | Elm `.field`, Swift 5.2 key paths as functions; `it` (Kotlin) was considered and rejected; contrast Scala's overloaded `_` | |
| Required argument labels; the boolean-trap lint | Swift argument labels; Kotlin named arguments | |
| `new Interface { … }` for inline implementations | Java anonymous classes (`new Runnable() { … }`); PHP `new class () implements … { … }` | |
| Constructor naming as convention, not language | Go's `NewFoo` (Effective Go, not the spec) | |
| Bodyless `implements Parseable` on distinct types | Rust `#[derive]`, Haskell `deriving` | |
| `Parseable` without an error type parameter | Rust `FromStr` (error as an associated type) | |
| Access decisions by voters (`ensure` / `check`, `can:`, `on:`) | managur/rick-role (`allows(…, to:, on:)`), Symfony security voters, Laravel policies; Google Zanzibar / OpenFGA for relationship-based voters | Typed actions (an enum per subject) instead of strings; the reason is a record with a typed code |
| Middleware wrapping `next` | PSR-15, Express, Go handler wrapping | `next` returns a response, never the app's error |
| Typed guards on route groups | Axum extractors, FastAPI dependencies, Laravel route-group middleware | The guard's value is a handler parameter, not a request attribute |
| URL patterns and most-specific-wins matching | Go 1.22 `ServeMux`; FastRoute; Symfony and FastAPI path parameters by name | No regex constraints: the parameter's type validates |
| Importing attributes | PHP 8 attributes (`use` imports, e.g. Doctrine's `#[ORM\Column]`) | `@` in the import list |
| Case policies in codec attributes | serde `rename_all`; Swift `keyDecodingStrategy` (a policy on the decoder, not the type: considered and not taken) | Field named for what it affects (`columns:`, `keys:`) |
| Cancellation at wait points | Trio cancel scopes; Swift and Kotlin cooperative cancellation; contrast Go `context` | An unwind, not an error value |
| Server-sent events | WHATWG HTML `EventSource`, `Last-Event-ID` | Bounded connections; reconnection is the protocol's job |
| WebSocket origin checks | OWASP cross-site WebSocket hijacking | |
| Private addresses refused by default (#190, #321) | OWASP Server-Side Request Forgery prevention, Stripe `smokescreen`, Ruby `ssrf_filter` | Checked after DNS and on every redirect |
| Record literals not allowed in conditions | Rust (struct literals in `if`/`while`/`match` heads), Go (composite literals in `if`) | Parentheses lift the rule |
| Contextual keywords | Kotlin soft keywords, C# contextual keywords | `get`, `from`, `named`, `attribute`, `test`, `expect` |
| Reserved words as member names | PHP 7 context-sensitive lexer (`$foo->new()`, `function list()` in a class); JavaScript property names; Kotlin | Not for parameters, which Nib names without a `$` |
| New keywords are contextual | C# (every keyword since 1.0: `yield`, `var`, `async`, `await`, `record`) | |
| One URL type, named URL | WHATWG URL Standard ("Standardize on the term URL"); browsers' `URL`, Go `net/url`, Rust `url`; contrast Java's `URI` and `URL` | |
| Lexing interpolation as nested tokens | Swift and Kotlin string interpolation | Any expression, including nested literals |
| Multi-line string indentation | C# 11 raw string literals, PHP 7.3 heredoc | The closing delimiter's indentation is removed |
| Cancelling only safe requests on disconnect | HTTP method safety (RFC 9110); contrast PHP `ignore_user_abort` and Node, which run on | The deadline always cancels |
| Durations from named units; ISO 8601 for data | Java `Duration` and `Period`, TC39 Temporal `Duration`, ISO 8601 durations, Postgres interval input | One constructor, `Duration.of(…)`; no calendar units |
| Declaration files for the stdlib's API | TypeScript `.d.ts`, OCaml `.mli`, C headers | The prelude is a declaration file too |
| Defaults on named parameters only | PHP 8 named arguments, Kotlin, Swift, C# | Only on a `named` parameter, so a call that changes one shows it |
| `Stringable` for interpolation | PHP 8 `Stringable`, Rust `Display`, Swift `CustomStringConvertible`; contrast Java's universal `toString()` | Not for `@sensitive` types |
| Iteration with an error type | Rust `IntoIterator`/`Iterator` and `TryStream`, Java `Iterable`, PHP `IteratorAggregate` | One interface; `E` defaults to `Never` |
| Codecs as a shared data model (#217, proposed) | Rust serde (`Serialize`/`Serializer`: one derive, many formats); Swift `Codable` with `Encoder`/`Decoder` | The compiler generates one field walk per opted-in type; each codec, in std or not, implements the encoder and decoder for its format |
| All-or-nothing type arguments (#218) | Java, C# and Swift (no partial explicit type arguments); considered and not taken: C++ prefix deduction, Rust and Kotlin `_` placeholders | |
| Typed queue addresses (#219) | Vert.x event-bus addresses; Akka Typed `ServiceKey[T]`; the Datatype Channel pattern (Hohpe and Woolf, *Enterprise Integration Patterns*) | A name and a message type declared once, as session keys are |
| Guards that refine a value down a route chain (#220) | Axum extractors; Laravel route model binding with `scopeBindings()` (a child looked up within its parent); the user's Slim 4 "belongs to" middleware | Typed functions instead of IDs found by convention |
| Route group prefixes (#221) | Laravel `Route::prefix()->group()`, Symfony route prefixes, FastRoute `addGroup`, Go chi `Route` | |
| Null objects (#222) | Bobby Woolf, "Null Object" (*Pattern Languages of Program Design 3*); PSR-3 `NullLogger` | `log.Discard` |
| 120-column formatter width (#145) | PSR-12's soft limit; one parameter per line with a trailing comma as in rustfmt and Prettier | |
| No overloading by type (#223) | Go, Rust and PHP (none); against Java, C#, Swift, Kotlin and C++ | Interfaces, enums, labels or different names instead |
| `ApiClient` with a base URL (#224) | Guzzle's `base_uri`; .NET named `HttpClient`s with `BaseAddress` | Its calls take only relative URLs, so input can't redirect it to another host |
| `Decimal` division with stated rounding (#225) | Java `BigDecimal.divide(divisor, scale, RoundingMode)`; rounding-mode names from IEEE 754 and the General Decimal Arithmetic spec, renamed to say what happens to negatives | No `/`, and no default mode |
| `allocate` (#225) | Martin Fowler's Money pattern (*Patterns of Enterprise Application Architecture*); moneyphp `allocate` | Parts that add up to the original |
| `Money` and `Currency` (#76, #321) | Java JSR 354 (`MonetaryAmount`, `CurrencyUnit`), moneyphp `Money`, Ruby `money`, ISO 4217 | A record with public fields; no operators |
| A cache that fails open (#321) | Rails `Rails.cache.fetch` with its error handler, Laravel's failover cache store | An outage runs `compute` and logs a warning |
| Number formatting with named arguments (#226) | Swift `FormatStyle`, JavaScript `Intl.NumberFormat` and `toFixed`, Kotlin `padStart`/`padEnd`; considered and not taken: C `printf`, PHP `sprintf`, Python format specs, Rust `format!` | Checked at compile time; the checker points `sprintf` users to it |
| Interface members with defaults (#227) | Java 8 default methods, Rust default trait methods, Swift protocol extensions, Kotlin and C# 8 default interface members | No fields, so not traits; two defaults for one member must be resolved by the type |
| Required `override` (#227) | PHP 8.3 `#[\Override]` (its RFC's upgrade case), Kotlin and Swift `override`, TypeScript `noImplicitOverride` | Required on every member that implements an interface member, so renames in an interface are loud |
| Error causes and chains (#228) | Rust `Error::source` and the API guideline that `Display` doesn't repeat the source; `anyhow`'s chain; Java `Throwable.getCause`; PHP `getPrevious`; considered: Go's `%w` with `errors.Is`/`As` | The compiler writes `cause` for `from` variants; no searching the chain by type |
| No error text for people (#229) | Rails `errors.add(:email, :taken)` with I18n lookup; OWASP guidance on not exposing internal errors | Forms keep a `FieldProblem` per field; pages choose the words |
| Number literals take their context's type (#230) | Swift literal protocols (`ExpressibleByIntegerLiteral`); Groovy (a literal with a point is a `BigDecimal`); Raku (`0.1` is an exact rational); considered and not taken: a `Float` default (C, Java, Go, Rust, Swift, Kotlin, PHP), C#'s `m` suffix | With no context, `3.95` is a `Decimal` |
| One 64-bit integer, no implicit widening (#231) | Go, Rust and Swift explicit numeric conversions; considered and not taken: C#, Java and Kotlin implicit widening, C's integer promotions | `Int` is the only 64-bit signed integer |
| Labelled arguments in any order, canonical order from the formatter (#232) | Kotlin, Python, C# and PHP 8 named arguments (any order); Swift (declared order, enforced); `gofmt` and `rustfmt` as the source of one canonical form | The checker accepts any order; the formatter puts labels in declared order |
| Null narrowing for stable locals (#233) | Kotlin smart casts and their "could have changed" rule; TypeScript control-flow narrowing; Swift `if let` | Locals and parameters narrow; fields, getters and captured `var`s bind a name |
| No `is` on interface values (#234) | Considered and not taken for now: PHP `instanceof`, Kotlin `is`, Swift `as?` | Enums carry closed sets of cases |
| Every error type implements `Error` (#236) | Swift (`throws` requires `Error`), Java `Throwable`; considered: Rust's optional `std::error::Error` | Carrier objects such as `FormState` implement it too |
| Getter or method (#237) | Kotlin and C# property guidelines; Swift API guidelines (computed properties are O(1)) | A getter reads what a value is or has; a method computes or acts |
| Parameter source markers on handlers (#238) | Spring `@PathVariable`, ASP.NET Core `[FromRoute]`, FastAPI `Path()`, Symfony `#[CurrentUser]` and `#[MapEntity]` | Checked against the route table, so a marker can't be stale |
| Removing member shorthand (#239) | Reverses Elm's `.field` accessors and Swift key paths as functions, taken by #160 | One spelling: a closure |
| Doc-comment examples illustrate and are parsed, not run; runnable examples, if ever, as test-file functions shown in the docs (#243) | Go `Example` functions | Rust doctests and Python `doctest` considered: running needs hidden setup in the docs |
| Copy with changes, `value with { … }` (#242) | C# `with` expressions, Kotlin `copy(…)`, OCaml `{ r with … }` | Records only |
| Line width: recommended 120, limit 150, a tab counted as four (#245) | rustfmt (tab as four), PSR-12 soft limit | |
| Streams as iterables of values and byte chunks; one I/O error type (#247) | Rust iterators and `io::Read`, Go `io`, Java streams | A `Reader` interface held back |
| Lazy `map`/`filter` on any iterable, eager on lists (#248) | Rust iterator adapters, Kotlin and Swift `.lazy` (turned down as a second name) | |
| Unit-of-work ownership of opened resources; writers commit on close (#249) | PHP end-of-request cleanup, atomic write-by-rename, database transactions | |
| Generators with `yield` (#250) | PHP, Python, C# `yield return`, JavaScript `function*` | |
| `emit` for a block arm's value (#250, removed by #251) | Java `yield` in switch expressions, renamed to keep `yield` for generators | |
| Blocks give no value; `let x: T` set later, once on every path (#251) | Java, C#, Swift and Kotlin definite assignment; PHP's switch-then-assign habit | |
| Arithmetic operators for numbers only; `plus`/`minus`/`times`/`dividedBy` elsewhere (#252) | Java `java.time` (`plus`, `minus`), PHP Carbon (`addHours`), Joda-Time | |
| Unrouted log events go to standard error at `Info` and above | Python's `logging.lastResort` handler (warnings and above to stderr when nothing is configured) | Ours starts at `Info`, so a script's progress messages show |
| Error return traces (#289) | Zig's error return traces; Sentry-style stack traces in PHP | Each `try` and `fail` that passes an error on adds its place; the trace isn't part of the error's value |
| Constant-time `==` on secrets and bytes (#287) | Go `crypto/subtle.ConstantTimeCompare`, Rust `subtle`, PHP `hash_equals` | The ordinary `==` is the safe one, rather than a separate call |
| Dropped values warn (#291) | Swift (an unused result warns unless the function is `@discardableResult`), Rust `#[must_use]` | Every value but `Void` is treated so, with no opt-out attribute yet |
| Patterns name a variant's values (#292) | Swift (`case .storage:` ignores a payload; labelled associated values), OCaml and Rust struct-variant patterns (`Rect { width, .. }`) | The pattern names values as building one does; a value without a name, as in `Ok(T)`, stays unnamed |
| A request built for tests (#293) | Laravel's `$this->post(…)`, Rails request specs, Go's `httptest.NewRequest` | Passed straight to a handler; its session is read back afterwards |
| `catch` handles a failure at the call (#299) | Zig (`f() catch \|err\| { … }` beside `try`), Swift (`do { try … } catch`) | Postfix on one call, as in Zig; the signature keeps `-> T else E` |
| `type X: Base` for a distinct type (#303) | Go (`type UserId int`), Haskell `newtype`, Kotlin value classes; the colon is a backed enum's | `=` stays for `alias`, which is the same type |
| Dates and times (#306) | TC39 Temporal (`Instant`, `ZonedDateTime`, `PlainDate`, `PlainTime`; the "compatible" rule for missing and doubled local times), Java `java.time` (`Period` on dates, month ends clamped), NodaTime (moments and local values kept apart), `Intl.DateTimeFormat` `dateStyle` and `timeStyle`, Unicode CLDR | No zoneless date-time; a zoned value has no arithmetic; no default zone |
| Choosing a time zone by country (#306) | Derick Rethans, "Selecting Time Zones" (derickrethans.nl), the IANA database's country and comment data, PHP `DateTimeZone::listIdentifiers(PER_COUNTRY)` and `getLocation()` | The stdlib gives the data; the picker is app code |
| A connection per call, statements cached per connection (#308) | Go `database/sql`, pgx's statement cache, MySQL Connector/J `cachePrepStmts`, HikariCP and sqlx (a default pool of 10); contrast PHP's connection per request | No switch to per request; a transaction keeps one connection |
| The new row's ID from the insert itself (#309) | MySQL's OK packet (`last_insert_id`), as read by PDO `lastInsertId` and Go `LastInsertId`; Postgres `RETURNING`; SQLite `last_insert_rowid()`; JDBC `executeUpdate`'s count, MySQL `CLIENT_FOUND_ROWS`; JDBC `rewriteBatchedStatements` for batched inserts | `insertId`, `countChanges`, `insertAll` |
| Transaction isolation and retrying on conflict (#310) | SQL standard isolation levels, Postgres `40001`, MySQL deadlock `1213` | The database's own default isolation |
| UUIDs, version 7 by default (#311) | RFC 9562; PHP ramsey/uuid (a node provided for version 1); Postgres `uuid`, MySQL `UUID_TO_BIN` | Made through an injected `Uuids`, as `Clock` is |
| `x is not null name` (#304) | SQL's `IS NOT NULL`; Swift `if let`, Kotlin smart casts | Binds only where a test can't narrow, such as a field |
| Composing SQL from safe parts (#312) | Rust sqlx `QueryBuilder`, jOOQ conditions (`DSL.and`, `noCondition`), Go squirrel, Postgres `format('%I')` for the contrast | A `Sql` pasted into a `Sql`; identifiers only from fixed fragments |
| A variant that takes any error (#313) | Rust `anyhow::Error` at the edge of an app beside `thiserror` in libraries; Swift `any Error`; Go's `error` | A specific `from` variant still wins |
| Guard values found by type (#314) | Rust Axum extractors, Spring and Symfony injection by type, FastAPI `Depends` for the contrast (by function) | Two guards around a route can't give the same type |
| `is not null` with no name (#315) | Narrowing of locals in TypeScript and Kotlin; Kotlin's "smart cast is impossible" on properties, and Swift's `if let`, for the contrast | A field, getter or call goes in a `let` first |
| A variant written with its enum's name in patterns (#316) | PHP 8 `match` (`Status::Paid =>`), Rust `Enum::Variant` | One spelling in patterns and expressions |
| A form's failure holding its state (#318) | Laravel's `ValidationException` carrying the validator and its errors | The state is plain data; only the failure is an `Error` |

| Blank form fields count as missing (#325) | Rails `blank?`, which counts only spaces as blank; Django's `CharField(strip=True)` for the contrast, which trims every field | The value is never trimmed; a type's `parse` may trim |
| A default error message (#326) | Rust's derived `Debug`, which writes a variant's name; `thiserror`'s `#[error]` for the contrast, which every variant writes | Lower-case words, never the payload |
| A value's text form is `toString()` (#327) | TC39 Temporal and Java `java.time`, whose `toString()` writes ISO 8601 | No getter repeats it |
| A handler takes the request only when it reads it (#328) | Axum's and FastAPI's handlers, which take only the extractors they use | Markers, not types, say where each parameter comes from |
| Only a numeric distinct type has arithmetic (#334) | F#'s units of measure and Ada's derived types, which keep arithmetic within one type; Go, which has none between defined types | The number opts in with `implements Numeric`, so an identity is the default |
| Records are loggable only when marked (#336) | Rust's `Debug`, which a type has only when it derives or implements it | Errors, enums and the stdlib's types stay loggable without a word |
| Comparing secrets in constant time (#332) | Python's `hmac.compare_digest`, Go's `subtle.ConstantTimeCompare` | A method on every secret, so the comparison is named |
| A module and its names on one line (#337) | Rust's `use a::b::{self, C}` | Spelt `with`, so it reads as English |
