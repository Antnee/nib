# Decisions

What's decided, one line per decision, grouped like the [guide](../guide/README.md). The
number leads to the full entry in [`decisions-log.md`](decisions-log.md): search it for
`| 142 |`. The entry gives the reasons, the ideas turned down, and what has changed it since.
Ideas that were rejected, and decisions that were later replaced, are in the log but not here.

## Basics

- **6b** The logical operators are the words `and`, `or` and `not`.
- **6c** The bitwise operators `&`, `|`, `^`, `~`, `<<` and `>>` work on integer types only.
- **7** Names are bound with `let` (immutable), `var` (mutable) or `const` (compile-time constant).
- **7a** Variables have no sigil: there is no `$`.
- **7b** Tuples and records can be destructured into names.
- **12** Locals and parameters may not shadow each other. They may shadow a module-level declaration or a prelude name, with a warning.
- **17** Memory is garbage-collected. There is no pointer arithmetic and no `&` address-of operator.
- **17a** Every index into a collection or string is bounds-checked.
- **21** The syntax uses braces for blocks and has no semicolons.
- **21a** Newlines end statements, except where the line-continuation rules say otherwise: inside brackets, and when a line starts or ends with certain operators or keywords.
- **40** The reserved words are listed in `keywords.md`.
- **48b** Assignment is a statement, never an expression. Compound assignment works on a `var`, and `x++` and `x--` are statements only.
- **54** The compiler enforces case: PascalCase for types and variants, camelCase for functions, fields and variables, UPPER_SNAKE for every `const`, lowercase dotted modules. Acronyms are words (`HttpClient`), except the `UInt` types. Case never changes meaning.
- **55** Static members are reached as `Type.function()` and `Type.Variant`, instance members as `value.method()`. A capital letter before the dot always means a type.
- **59** Comments are `//` to end of line and nestable `/* … */`; `#!` is allowed on the first line only. `///` doc comments are CommonMark, and their code examples are parsed but not run. Comments never affect compilation.
- **72** Chained comparisons such as `a < b < c` are a compile error that suggests `a < b and b < c` or a range. This also keeps `f<T>(x)` unambiguous.
- **119** Type annotations on `let` and `var` are optional (`let quotes: List<Quote> = …`) and required on signatures. Annotate when the right-hand side doesn't make the type obvious.
- **120** `print(text)` is in the prelude and writes a line to standard output, for scripts. Structured output goes through `std.log`.
- **139** A map literal is `["key": value]`, and `[:]` is an empty map, beside list literals `[a, b]`.
- **140** A string literal may appear inside `${}` of another literal, including `html"""` inside `html"""`.
- **145** Commas separate items in list, map and argument lists, parameter and type-parameter lists, and import lists, with an optional trailing comma. Declaration bodies use newlines. A list that doesn't fit in 120 columns goes one item per line, with a trailing comma.
- **153** Locals and parameters may not shadow each other. They may shadow a module-level declaration or prelude name, with a warning, and the outer one stays reachable qualified; shadowing an imported module name is an error.
- **160** `_` means only "ignore" and appears only where a name would be bound: patterns, `let _ = f()`, `catch _ { }` and unused parameters. There is no member shorthand or placeholder partial application; write a closure.
- **198** Every reserved word can also name a member (field, getter, method, payload or attribute field), which always follows `.`, `fn` or `get` or precedes `:`. Elsewhere reserved words stay reserved. Keywords added after version 1 are contextual.
- **203** Newlines are whitespace inside brackets; a line ending mid-expression continues; a line starting with `.`, `?.`, `|>`, `??`, `?:`, `catch` or `else` continues the one before; otherwise a newline ends the statement. `f (x)` is not a call.
- **204** String tags are a closed set, each with compile-time rules for what it may interpolate: `html`, `sql`, `url`, `path`, `secret`, plus `r` for raw strings. One `Url` type and `url` tag cover every URI.
- **209** The unsigned integers are `UInt`, `UInt8`, `UInt16` and `UInt32` (and `toUInt8()` and so on), a listed exception to the rule against two capitals in a row.
- **296** A line that starts with `??` or `?:` continues the line before; the formatter moves a trailing `??` or `?:` to the start of the next line.
- **307** A string tag exists only where inserted values must be encoded for its grammar: `html`, `sql`, `url`, `path` and `secret`. Anything else is a type with a `parse`, plus named constants for common values.

## Values

- **1b** Bindings, fields, parameters, records, strings and collections are immutable unless they opt in with `var`.
- **19b** `List`, `Map` (which keeps insertion order) and `Set` are copy-on-write values.
- **19c** For every collection, `x[k]` panics when the key or index is missing, and `x.get(k)` returns `T?`.
- **20** A literal's tag decides how interpolated values are treated: `html"…"` escapes for the position, `url"…"` percent-encodes, `sql"…"` sends bound parameters and `path"…"` rejects separators. `r"…"` is raw. Plain strings aren't accepted where these are needed.
- **36** The number types are `Int` (64-bit), `Int8`, `Int16`, `Int32`, `UInt` (64-bit), `UInt8`, `UInt16`, `UInt32`, `Float`, `Float32` and `Decimal`. Overflow panics in every build.
- **36a** `Decimal` is exact base-10, stored as a scaled big integer. `+`, `-` and `*` are exact, and division states its places and rounding.
- **36b** `/` works only on `Float`. Integers divide with `div` and `mod`, and a `Decimal` divides with `dividedBy(…, places:, rounding:)`.
- **38** Strings are immutable UTF-8. `length` counts graphemes, beside `byteLength` and `codePointLength`; `first`, `last` and `slice` work in graphemes. Strings are built by interpolation and `join` only.
- **43** `"…"` interpolates `${expr}` and `r"…"` is raw. `"""…"""` and `r"""…"""` are multi-line, with indentation stripped up to the closing delimiter. Tagged literals exist, such as `sql"…"`. Single quotes and backticks are unused.
- **48a** `1..10` is an inclusive range and `0..<n` an exclusive one. There is no `..=`. Ranges are values.
- **129** Triple quotes may be used on one line, so a literal containing `"` needs no escaping: `html"""<p class="error">${e}</p>"""`. Single quotes and backticks aren't string delimiters.
- **225** `Decimal` has no `/`: division is `dividedBy(d, places:, rounding:)`. Rounding is always stated with a `Rounding` value; `toInt()` gives `Int?` for exact conversions; `allocate(into:, places:)` and `allocate(by:, places:)` split without losing a cent.
- **226** No format strings: numbers have `formatted(…)` with named arguments (`width`, `fill`, `places` with `rounding`, `sign`, `grouping`, `base`, `notation`), used inside interpolation. Strings have `padStart` and `padEnd`.
- **230** A number literal takes the type it's used as. Unannotated, an integer literal is an `Int` and one with a point is a `Decimal`, not a `Float`. Literals must fit their type, and only literals adapt.
- **231** `Int` is the one 64-bit signed integer; there's no `Int64`. Typed numbers never widen implicitly, so arithmetic needs both operands of one type and conversions are written (`.toInt()`).
- **244** An integer type without a width is the 64-bit one: `Int` and `UInt`, beside `Int8`, `Int16`, `Int32`, `UInt8`, `UInt16` and `UInt32`. There's no `UInt64`.
- **252** `+ - * /` work on number types only. Every other type, the stdlib's included, names its arithmetic as methods: `plus`, `minus`, `times`, `dividedBy` (`instant.plus(duration)`, `money.plus(other)`).

## Functions

- **14** Overloads differ by their number of positional parameters or by their `named` parameters, never by type alone.
- **27** A closure is `fn(o) => expr` or `fn(o) { … }` with a block. Parameter types come from context, or are written. Function types are `fn(Order) -> Money else PriceError`. There are no trailing closures or local named functions.
- **44** Function bodies always use an explicit `return`. Expression-bodied closures (`=>`) and `match` arms give values.
- **44a** Function bodies use an explicit `return`.
- **63** Closures capture automatically, by value and read-only. `use (mut x)` captures a `var` by reference so the closure can change it; `use` only takes `mut`, and a plain `use (x)` is an error.
- **64** `return`, `try` and `fail` in a closure leave only the closure. Higher-order functions are generic over the error, `fn map<U, E: Error>(f: fn(T) -> U else E) -> List<U> else E`, so an infallible closure makes the call infallible.
- **65** `x |> f` passes `x` to a one-argument callable: a single-arity function or a closure (`x |> fn(v) => clamp(v, 0, 10)`). The value is never inserted implicitly, and `try` works across the chain.
- **66** Functions are values of type `fn(A) -> B else E`. Callables are named and static functions, closures and bound methods (`formatter.format`); a bound value-type `mut fn` needs a closure with `use (mut x)`. No string callables or invokable objects.
- **107** A parameter marked `@callerLocation loc: SourceLocation` is filled in by the compiler with the call site when omitted, and can be passed on explicitly as `loc:`. It doesn't count towards arity. Used by logging, `assert`, panics and `todo()`.
- **135** A named argument with nothing after the colon takes the local of the same name: `charge(token, total, idempotencyKey:)` means `idempotencyKey: idempotencyKey`.
- **166** A parameter declared `named` is labelled at every call (`resize(photo, width: 800, height: 600)`), and only such parameters are labelled. Positional arguments fill the others in order.
- **211** Only a `named` parameter may have a default (`named timeout: Duration = Duration.of(seconds: 30)`), evaluated at each call. Overloads may not differ only in defaulted parameters; overloads remain for optional positional arguments.
- **223** No overloading by type: overloads differ by count or labels. Use an interface for an open set, an enum for a closed one, a label when the type says how an argument is used, or different names for different meanings.
- **232** Labelled arguments may be written in any order; the formatter rewrites them into the parameters' declared order.
- **239** There's no leading-dot shorthand: write a closure, `lines.map(fn(line) => line.total)`. A line starting with `.` after a complete expression still continues a chain.
- **259** In a function type that returns a function, `else` belongs to the nearest (inner) function type. Brackets are recommended: `fn(S) -> (fn(T) -> Ack else E)`.
- **265** Functions are declared only at the top level or as members; inside a body, a function is a closure (`let name = fn(…) => …`). A closure may read a captured `var`, but changing one needs `use (mut x)`.
- **286** An argument is labelled exactly when its parameter is `named`; positional arguments fill the rest in order. A variant's payload is labelled like a record's fields, and overloads differ by positional count or `named` parameters.
- **288** An unused parameter may be named `_`, but doesn't have to be.
- **297** A declared function or closure that returns nothing but can fail writes `else E` straight after its parameters; `-> Void else E` is a warning. A function type still writes `-> Void else E`.

## Types

- **5** Typing is static and strong, with local type inference. Function signatures must state their types.
- **6** Values never convert implicitly. The only exceptions are that literals take their type from context and a distinct type widens to its base type.
- **10** The two kinds of user-defined type are `record` (a value) and `class` (an object with identity).
- **10b** A type implements an interface only by saying so with `implements`; several interfaces are separated by commas.
- **10d** Methods are declared inside the type's body.
- **10e** Members are always reached through `this`; it is never implicit.
- **10f** On a value type, a `mut fn` changes the value and can only be called through a `var`; the fields it changes must be `var`. A class changes its own `var` fields from any method without `mut`.
- **11** Enums are sum types with exhaustive `match`. They can be backed by values, including backing tags on variants with payloads.
- **11b** Enums with payloads are used for results, messages and UI state.
- **13** Only a type writes its own fields. A computed property is a `get` whose body is one expression after `=>`, read without parentheses; it can't be `mut` or fail. Interfaces may require `get`s. There are no setters.
- **15** Types and functions take type parameters, with constraints. The rules are #68 to #75.
- **34** A record is built with a literal where all its fields are visible. A class is built with `new` through its `construct(…)`. Construction that can fail is a static function returning `Type else Error`, such as `parse`.
- **34a** A field can have a default, `status: OrderStatus = OrderStatus.Pending`, evaluated at each construction. Fields with defaults can be left out of a literal.
- **34b** In a literal, `Limiter { limit, window }` is short for `Limiter { limit: limit, window: window }`.
- **37** `type Name: String` declares a distinct type. It widens to its base implicitly (unless `@sensitive`), but is built only by wrapping, `Name(x)`, as visibility allows. `alias` gives an interchangeable name.
- **334** A distinct type is a subtype of its base, but has arithmetic only if it `implements Numeric`, since most are identities. `+` and `-` between two of one such type keep it (`Qty + Qty` is a `Qty`); other operators give the base. Two different distinct types never mix.
- **56** Each conversion is defined once by its owner. Built-in ones are `x.toY()`, and the return type shows whether it can fail: `big.toInt8() -> Int8?`, `"42".toInt() -> Int else ParseError`. Domain types use their own constructors, such as `Email.parse(raw)`.
- **60** Interfaces are types, so they're PascalCase, with no `I` prefix or `Interface` suffix. Implementations are named for what they are: `StripeGateway implements PaymentGateway`.
- **62a** `new PaymentGateway { fn charge(…) -> … { … } }` builds a one-off value implementing an interface inline, mainly for test fakes.
- **68** Generics use angle brackets: `List<T>`, `fn first<T>(items: List<T>) -> T?`, `record Page<T>`. Type arguments are inferred where possible, otherwise written (`Form.decode<SignUpForm>(req)`). No higher-kinded types in v1.
- **68a** Type arguments are inferred from a call's arguments, or from a target type written in the same statement (an annotated `let`, a return type, an enclosing field); otherwise they're written at the call.
- **68c** There's no user-visible specialisation (a different implementation for one type argument, like C++'s `vector<bool>`). The compiler may specialise for speed only where it can't be observed.
- **68d** Const generics (`Matrix<3, 3>`) aren't in v1, but `<const N: Int>` is reserved for them. If added, they'd start with integer parameters and no arithmetic on them.
- **69** Generic constraints are inline interfaces, `<T: Comparable>`, combined with `and` (`<K: Hashable and Comparable>`). There's no `where` clause. `This` names the implementing type inside an interface.
- **69b** Type arguments aren't erased. Code is specialised once per value-type layout and shared across reference types, and a generic container of a value type never boxes its elements (`List<Int>` is a flat array).
- **70** There's no operator overloading in v1: user types name their operations as methods (`a.plus(b)`). Adding C#-style operators later stays possible.
- **71** Records, enums and distinct types get structural `==` automatically; classes have it only by implementing `Equatable` (`fn equals(other: This) -> Bool`). Ordering comes only from `Comparable`. Identity is checked with `sameInstance(a, b)`, never an operator.
- **73** A method of a generic type can require more of its type parameter with `when`: `pub fn sum() -> T when T: Numeric`. Calling it when the constraint isn't met is a compile error naming the constraint.
- **74** Interfaces can require static functions, `interface Parseable { static fn parse(text: String) -> This else Error }`, and generic code calls them on the type parameter (`T.parse(text)`).
- **75** `Parseable` means "can be built from text". Built-in scalars and backed enums implement it, and user types opt in (`type Email = private String implements Parseable`). Codecs build each field through it; a field type without it is a compile error.
- **98** Dependencies are injected through constructors and held as interface-typed fields. The idiom is a typed container: a class whose `lazy` fields say how to build each service. Missing dependencies and cycles are compile errors; there's no reflection or autowiring.
- **100** A service is a `class`, since it has identity, and its fields are its dependencies.
- **102** A value type's `mut fn` replaces its value, so it needs a `var` binding, and it may change only `var` fields. A class changes its own `var` fields from any method without `mut`; `let` only stops rebinding. Outside code can't write fields.
- **105** `lazy name: T = …` on a class is computed on first read and then cached, and is read like a field. Its initialiser can't fail, cycles between lazy fields are compile errors, and there's no reset.
- **136** A class or record converts implicitly to an interface it implements, and a distinct type widens to its base. Function types are contravariant in parameters and covariant in results. Generic types are invariant: convert with `map`.
- **154** A type may implement several interfaces, comma-separated after `implements`. A `get` requirement may be met by a stored field of a more specific type.
- **158** `type Email: private String` makes the constructor `Email(…)` private to the type, so its static functions (such as `parse`) are the only way to make one.
- **165** A public distinct type such as `type CartId: Int` is read from text through its base, so it needs no `parse` of its own. A type with a `private` constructor must implement `Parseable` with its own `parse`, because validating is why it exists.
- **167** `new Shape { … }` builds a one-off implementation of an interface inline. `new` is a keyword meaning a new object: a one-off implementation, or a class built through its constructor.
- **169** `Parseable` has no type parameter: `static fn parse(text: String) -> This else Error`. An implementation may narrow the error, so direct callers see the specific type, as in `type Email: private String implements Parseable`.
- **179** A type argument the arguments don't determine may come from a type written in the same statement: a `let` or field annotation, a parameter's type, the return type, or an enclosing literal's field type. Write the type once: on the call only when the statement doesn't name it.
- **185** `const` may be declared inside a type and read as `Type.NAME`, always in UPPER_SNAKE, and can be a `match` pattern. A lint asks for `const` when a static getter only returns a compile-time value.
- **208** Every enum with a backing type implements the prelude's `BackedEnum<V>` automatically: `static fn fromValue(value: V) -> This?` and `get value: V`.
- **212** Records, enums and distinct types implement `Equatable` and `Hashable` automatically when every field does; classes opt in.
- **213** There is no universal base type and no anonymous records. JSON of unknown shape uses the `Json` enum through accessors (`data["user"]["name"].string ?? "anonymous"`).
- **215** `${x}` accepts a `Stringable` (`fn toString() -> String`), and inside `html"…"` the result is escaped while `Html` goes in as it is. Scalars, backed enums and distinct types over `Stringable` types get it automatically; a `@sensitive` type can't have it.
- **218** A call writes every type argument without a default, or none, leaving them to inference; partial lists and placeholders aren't allowed.
- **227** An interface member may have a body, its default. Every member that implements an interface member says `override`; an `override` matching nothing is an error. When two interfaces default the same member, the type must define it.
- **234** `is` and `match` patterns test for null, enum variants and literals only. Testing a value for a type other than its own, such as an interface value for a class, is a compile error.
- **237** A `get` is for what a value is or has: cheap, no arguments, can't fail, no effects, same answer each time. A method is for what it does: computing over items, conversions, effects, arguments.
- **242** `value with (field: …)` copies a record with the named fields changed; it's the only way to change a record from outside its `mut fn`s. Classes can't use `with`.
- **246** A variant may not take the name of a type visible where it's declared (the checker warns, suggesting `XFailed` for an error enum). Prelude names are exempt.
- **258** A field changes only if it's declared `var`, in a record's `mut fn` as in a class; a `mut fn` changing a plain field is an error.
- **266** An implementing member keeps the interface's names for its `named` parameters, checked with `override`, and can't make a parameter `named` or not `named`.
- **273** A getter's body is one expression after `=>`, and it can't fail or change anything; anything needing statements is a method.
- **275** A record is built by calling its type with every field named, `Point(x: 1, y: 2)`, and copied with `with (…)`. Braces only open bodies of statements or declarations.
- **276** A class's constructor is `construct(…) { … }`; a `private`, `pub` or `var` parameter is also a field. The body sets every other field once before using `this`, can't fail, and classes are built with `new Type(…)`.
- **277** `internal` is written only on a constructor parameter, to promote it to a field with the default (package) visibility. Anywhere else, and with `var`, it's an error.
- **295** A class with no `construct` is built with `new Type()`, and each field needs a default; an empty public `construct() {}` is a warning. A class in a `.d.nibl` file without one is built only by the host.
- **303** A distinct type is written `type UserId: Int` (or `type Email: private String`); `alias X = Y` names the same type, and `type X = Y` is an error.

## Null

- **8** A type that can be null is written `T?`. Null is handled with `null`, `?.`, `??` and narrowing after a test.
- **8a** Null is tested with `is null` and `is not null`. `x == null` and `x != null` are errors that point to them.
- **53** `a ?: b` works only on types that implement `Emptiable`, such as strings and collections, and means `a.isEmpty ? b : a`. `??` is for null.
- **137** `a == b` with `a: T?` and `b: T` is allowed, and is `false` when `a` is null.
- **161** `??` only ever handles null. Its right side is a value, an exiting expression (`?? return Response.notFound()`), or a block that has to leave. Failures are handled with `catch`, never `??`.
- **233** After a null test (`is not null`, or `is null` with the other branch, or an `if` that always leaves), a local, parameter or `var` is its non-null type. Fields, getters and captured `var`s don't narrow. `== null` is an error.
- **298** A `??` or `?:` block holding only a `return` or `fail` is a warning; write it on the line (`?? return …`).
- **315** `x is not null` is the only form and names nothing; it narrows a local or parameter. A field, getter or call goes in a `let` first. Testing a value that can't be `null` is an error.

## Errors

- **9** There are no exceptions. A function that can fail returns a result, written `-> T else E`. A caller passes the failure on with `try` or handles it with `catch` or `match`.
- **9c** A signature declares its failure as `-> Order else OrderError`, and the body fails with `fail`. Every type after `else` implements `Error`.
- **9d** `let order = find(id) catch err { … }` binds the success value; `err` holds the failure inside the block only. When the value is used, the block must leave; after a call used as a statement it may simply end.
- **9e** Results have ordinary methods: `.ok()` gives `T?`, dropping the error on purpose, and `.orPanic("why")` asserts success with a required message.
- **45** Only tests and the top-level handler can catch a panic. In the browser the app stops and shows a fallback UI. Details show only under `nib run`; `@sensitive` values are redacted and reports leave out bodies and headers.
- **52** `try` before a call passes its failure on to the caller. There's no postfix `?`.
- **52a** `try` covers one fallible call: the call chain to its right, binding like unary minus. Each other fallible call needs its own `try`. A `try` that covers nothing fallible is an error, and `try` doesn't apply to `T?`.
- **52b** An error variant written `Cart(from CartError)` wraps a `CartError` automatically at a `try` or `fail`, one level deep; exactly one variant may accept the type. `from` variants expose `.cause`. Otherwise use `.mapError(…)`.
- **61** There's no special error kind: an error is an ordinary type implementing the `Error` interface, which gives `message` and `cause` for logs. Every type after `else` must implement it.
- **111** `todo("why")` has type `Never`, so it can stand in for a body or a `match` arm, and panics if reached. Dev builds compile with it, `nib check` lists each one, and release builds refuse to compile.
- **155** A `Result` can never be dropped unhandled: it is passed on with `try`, handled, matched or bound. Dropping any other non-`Void` value is a warning; `let _ = f()` drops one on purpose.
- **159** Every type after `else` in a signature implements `Error`. Every enum gets a generated debug and log form, so any error can be logged as a field.
- **162** A `from` variant wraps an error unchanged when passed on with `try`. To convert one at the call, write `catch err { fail f(err) }`; `.mapError(f)` converts the error of a `Result` held in a variable.
- **168** Handling a failure at a call is always `catch err { … }`; to handle one variant and pass the rest on, test inside the block and `fail err`, which applies `from` wrapping like `try`. Matching `Result.Err(…)` is for tests and results held on purpose.
- **170** When a fallible call is a statement, its `catch` block may simply end and execution continues after it. When the call's value is used, the block must leave.
- **172** A `catch` handler isn't allowed in the condition of `if` or `while`, or as a `match` subject; bind the value first. A `??` block isn't allowed there either; `??` with a value, `return` or `fail` is.
- **228** `Error` has `cause`, defaulting to null, and `chain()`; an error enum's `cause` is its `from` variant's payload, which must implement `Error`. A `message` describes its own layer only, and printers join the chain with `: `.
- **229** An error's `message` is for developers and logs only. Text people see is chosen by the page or handler that shows it; forms record a `FieldProblem` per field (`Missing`, `Invalid(cause:)`, `Explained(text:)`).
- **235** `fail value` converts an error as `try` does: directly, or through exactly one `from` variant of the function's error type.
- **236** Every type after `else` in a signature, function type or closure must implement `Error`, and a type parameter there is declared `E: Error`. A result that isn't a failure goes in the return type.
- **241** One `try` covers one fallible call, and `catch` handles only its operand's failure; an inner fallible call needs its own `try`. `try` binds like unary `-`, taking only the call chain to its right.
- **289** Every error carries `trace: List<SourceLocation>`, written by the compiler from the `fail` that made it through each `try` or `fail` that passed it on. Logging writes it; it isn't part of the error's value.
- **290** If every caller deals with a case at once and none passes it on, it's an outcome and goes in the return type as an enum; if callers pass it on with `try`, it's an error.
- **291** A statement that drops a non-`Void` value is a warning, including under `try`; a dropped `Result` is an error. `let _ = …` drops a value on purpose. There's no `@mustUse`.
- **294** A function declaring `else E` when nothing in its body can fail gets a warning to drop it. Overrides, interface defaults and closures are exempt.
- **299** A call's failure is handled with `catch` (`let n = parse(text) catch err { return 1 }`); `else` after a call is an error. `try` and `catch` together on one call are an error. `else` keeps its signature meaning.
- **313** A variant marked `from Error` takes any error no other variant takes with `from`; a variant naming its error wins, and two such variants are an error. Allowed only where failures are reported.
- **319** A `from Error` variant is allowed only in an error that implements `ToResponse`, or in the error `main` fails with, in the same module; elsewhere it's a compile error.
- **326** An error enum that doesn't write `message` gets each variant's name in words: `NotFound` gives `not found`. A record or class that implements `Error` writes its own.

## Control flow

- **31** `==` compares values. `is` matches a shape and can bind names.
- **46** `defer expr` runs when its block exits (last in, first out), normally or by `fail`, but not on panic. `defer else expr` runs only when the block doesn't finish normally: on `fail` or cancellation. A deferred call that can fail must handle it.
- **48** Loops are `for x in iterable`, `while cond` and `do { … } while cond`, with no C-style `for`. `break` and `continue` can name a labelled loop. The loop variable is immutable and a collection is iterated as a snapshot.
- **49** The conditional expression is `cond ? a : b`; nested ones need parentheses. There is no `if … then … else` expression.
- **50** `match` is exhaustive, with `_` as a default; a lint warns when `_` covers variants of your own package's enum. Alternatives are joined with `or`, and guards use `if`.
- **133** `return` and `fail` are expressions of type `Never`, so they can be a `match` arm, a branch of `?:`, or take an expression (`fail match err { … }`).
- **143** An `or` pattern may bind names, as in `Shape.A(x) or Shape.B(x) => x`, when every alternative binds the same names with the same types.
- **216** `for x in source` takes an `Iterable<T, E>`, whose `Iterator` has `mut fn next() -> T? else E`. A fallible source is written `for x in try source`. `String` isn't iterable. Type parameters may have defaults, last in the list.
- **250** A function whose body uses `yield` is a generator returning `Iterable<T>` or `Iterable<T, E>`; it runs as items are read, and `return` ends it without a value. A closure can't yield.
- **251** A block never gives a value. A value-giving `match` has expression arms (a value, `return` or `fail`), and a `??` block must leave. `let name: Type` with no value is set exactly once on every path before use.
- **292** A pattern names a variant's values as building one does (`Limited(retryAfter:)`, `Rectangle(width: w)`); unnamed values are ignored, and `(_)` is an error. A single unnamed payload, as in `Ok(T)`, is unnamed in patterns too.
- **316** A variant is always written with its enum's name, in patterns as in expressions (`LinkOutcome.InvalidOrExpired`); a bare variant name is an error.

## Modules and packages

- **18** Code is organised into modules within packages, brought in with `import`. The rules are #77 to #84.
- **22** There are three visibility levels: `private` (the type, or the file for top-level declarations), the default (the whole package) and `pub` (exported). A hard boundary means splitting code into separate packages.
- **77** A module is a directory: every `.nibl` file in it shares one namespace, and files have no module header. File names are for people; there's no class-per-file rule.
- **78** A package is the versioned unit of distribution: a manifest plus a `src/` tree of modules. A module's name is its path from `src/`, rooted at the package name (`shop.orders`).
- **79** Module names are lowercase letters and digits with no separators (`payments`, `stripe`). Structure comes from nesting (`payments.stripe`), not compound names.
- **80** `import shop.orders` brings in a module, used by its last segment (`orders.create(…)`). Types, constants and attributes may be imported by name (`import shop.orders.{Order}`); functions never are. `as` renames; no wildcards. Same-module files need no import.
- **81** The top level holds only declarations and compile-time `const`s: no top-level `var`, static initialisers or code run on import. Every program, script or server starts at `main`.
- **83** The stdlib lives under the reserved root `std` (`import std.http`, used as `http.get(…)`); no package may be named `std`. A small prelude (core types, `print`, `panic`, `assert` and more) needs no import.
- **97** The consumer owns the interface: a domain module declares `OrderRepository`, and an adapter module implements it and imports the domain, so dependencies point inwards.
- **104** A local or parameter can't share a name with an imported module; import the type by name instead (`import std.db.{Db}` lets you write `db: Db`). A field may share a module's name.
- **124** The prelude is tiny and changes only at an edition boundary; new things go in `std.*`. Your own declarations win over prelude names, with a warning, so a new prelude name never breaks code.
- **201** The prelude holds the names nearly every file needs and the types its own signatures use. Syntax may produce a type that must be imported to be named: `url"…"` needs no import, but writing `Url` in a signature does.
- **202** Constants may be imported by name, like types (`import shop.users.{MINIMUM_PASSWORD_LENGTH}`); functions are still reached through their module.
- **260** There's no `std.text`: `lines` is `io.lines` and `Case` is in `std.codec`. A field may share a module's name; only locals and parameters may not.
- **322** Modules of one package may import each other in a cycle, since nothing runs at import, but the checker warns at each import that makes one. Between packages, cycles are impossible.
- **337** `import shop.ui with {SignUpForm}` brings in a module and names from it, on one line; it's the only way to import both.

## The web

- **24a** Sessions are provided by the standard web stack.
- **58** Request input is read into `@form` records with `req.body.form<T>()` or `req.query.form<T>()`, failing with a `FormError` that holds each field's problem. Every field type must be form-decodable, checked at compile time.
- **121** `response.onSent(fn() { … })` attaches best-effort work run only if the response is sent (`Ack.onAcked` for queues). The closure can't fail, so failures are handled inside with `catch`. Its services stay alive, it has 10 seconds, and shutdown waits for it.
- **125** There's no template language: a component is a function returning `Html`, with parameters as props and `Html` parameters as slots. `html` literals aren't validated as HTML, but each interpolation is escaped for its context; one with no safe context is a compile error.
- **150** Handlers are methods on small classes whose dependencies come through their constructors, built by the container. Only the route table touches the container, picking a handler per request (`fn(app) => app.auth.signIn`); queue consumers work the same way.
- **171** Authentication (who is this?) is an ordinary function or guard returning a `User`. Authorisation is the first-party `nib/access` package: voters per subject with typed action enums, `ensure(user, can:, on:)` failing with `AccessDenied` and `check(…)` returning a `Decision`; any deny wins, and all abstaining denies.
- **173** `std.http` covers building a site without a framework: requests, responses, handlers, routes with groups, middleware and guards, cookies, sessions, CSRF, serving files shipped with the build, and the HTTP client. Authentication flows, access control, ORMs and asset building aren't in it.
- **174** Middleware has one shape: `fn handle(req: Request, next: Next) -> Response else ToResponse`, with code before and after `next(req)`, which returns a `Response`. Errors reach error reporting through the route table's `onError` hook instead.
- **175** A route table is data, not a chain: `Routes(using: […], routes: [Route.get(…), Route.group(…)])`, with each option a named argument on what it applies to. CSRF on unsafe methods, security headers and a body size limit are on by default; `csrf: Csrf.Off` exists only on unsafe methods.
- **176** A guard is a function `(Request) -> T else E` that runs before the handlers of its group (`requiring:`) and either fails with a `ToResponse` error or produces a value that handlers take as a `@guard` parameter. Middleware can't pass values to handlers.
- **177** URL patterns have literal segments, `{name}` for one segment and `{name...}` for the rest. No regex constraints or optional segments: a path parameter's type parses it, and one that doesn't parse is a 404. The most specific pattern wins; ambiguous pairs fail at start-up.
- **178** `Route.on(pattern, handler, methods: [Method.Get, Method.Post])` answers several methods; `Route.get`, `post`, `put`, `patch` and `delete` are shorthands for one. The router answers `HEAD`, `OPTIONS` and `405` itself.
- **180** A request is handled in a fixed order: match method and path (parsing path parameters, else 404); build a fresh container; run middleware (table, group, route); the built-in protections (body size, CSRF); guards, outer to inner; then the handler.
- **181** `Request` is immutable: method, path, query, case-insensitive headers, cookies, `clientIp`, body, session and CSRF token. `clientIp` is resolved through the app's `trustedProxies`, never read raw from `X-Forwarded-For`. Middleware passes a modified copy to `next`.
- **182** A body is read through the message, the same on server and client: `body.form<T>()` (failing with `FormError`), `body.json<T>()`, `body.text()`, `body.bytes()`, or `body.stream()` in chunks; GET forms use `req.query.form<T>()`. A mismatched content type fails.
- **183** `Response` is immutable, built with named constructors (`html`, `json`, `redirect`, `problem`, `stream`…) and changed by copying (`withHeader`, `withCookie`). Statuses are `Status` constants (`Status.NOT_FOUND`). `redirect` stays on the site, with 303; `redirectAway(to: Url)` leaves it.
- **184** Session values use typed keys declared once: `const SIGNED_IN = SessionKey<UserId>("userId")`, then `req.session.put(SIGNED_IN, id)` and `get(SIGNED_IN) -> UserId?`; flash messages likewise. Changes are saved when the response is sent. Cookies default to `Secure`, `HttpOnly`, `SameSite=Lax`.
- **186** `App.http` takes a function `fn(Request) -> Response else ToResponse`, and a route table's `serve` returns one, so a single function can be a whole app.
- **187** An integration makes its own configured client, `env.http.client(base:, timeout:, headers:)`, with a `Url` base. Requests take a `url"…"` relative URL whose interpolations are percent-encoded; the relative part is always appended to the base. Response bodies are capped in size.
- **188** HTTP calls always time out (5 s to connect, 30 s in all by default) and end at the request's deadline. Retries are off unless asked for and only for idempotent requests. Redirects are followed up to five times, never `https` to `http`, dropping credentials across hosts.
- **189** An HTTP call fails with `HttpError.Status(response)` on any status outside 200 to 299, unless the call lists it in `allow:`. Other `HttpError` variants are transport failures.
- **190** HTTP clients refuse private, loopback and link-local addresses by default, checked after DNS and on every redirect; a client for internal services opts in with `network: Network.Private`.
- **194** Every request has a deadline, 30 seconds by default, raised per route with `timeout:`. Long responses stream with `Response.stream(contentType:, write:)`, with backpressure; an error mid-stream aborts the connection. A deadline passed before the response starts sends a 503.
- **341** A streamed response sends its status and headers with the first chunk, so a failure before it is a `500`; a failure after it breaks the connection off.
- **195** Server-sent events are their own kind of route with a required `timeout:`; the handler takes an `EventSink` and sends events. The host sets headers, sends keep-alives and exposes `req.lastEventId`; at the limit it closes the stream and the browser reconnects.
- **197** `Route.websocket(pattern, handler, timeout:)` gives the handler a `WebSocket` with `receive()` (null once closed) and `send(text:)`/`send(json:)`. The host handles pings and message size, and checks `Origin` against the app's own unless `origins:` allows others.
- **210** `FormState.of(form)` is built from the decoded form, whose type marks its sensitive fields, so a password is never sent back to the browser.
- **220** `Route<S, G>` carries the guard's value type. The compiler checks each handler and guard against its literal pattern: the request, then `@guard` values, then `@path` parameters, returning `Response else E` with `E: ToResponse`. One guard per group; nested groups refine.
- **221** `Route.group(prefix:, requiring:, using:, routes:)` takes optional, combinable options; a prefix may hold path parameters and is flattened into full patterns, and duplicate full patterns for one method are an error.
- **224** `env.http` is an `HttpClient`, which takes an absolute `Url`. `client(base:)` returns an `ApiClient`, which takes only a `RelativeUrl`, so it can't be pointed at another host.
- **238** A handler marks a guard's value `@guard` and each path parameter `@path` (`fn show(req: Request, @guard user: User, @path cartId: CartId)`). The compiler checks every marker against the route table.
- **257** Every `HttpClient` and `ApiClient` call takes `headers: Map<String, String> = [:]`, added after the client's own headers.
- **285** A `Cookie` record defaults to `secure`, `httpOnly`, `SameSite.Lax` and `path = "/"`. `withCookie` and `withCookieRemoved` set and expire them; signed and encrypted cookies take a `Keyring` explicitly.
- **300** Each `@form` record has a compiler-written static `fields`, one `FormField` per field (`SignUpForm.fields.email`). `FormState.explaining`, `value` and `problem` take a `FormField`, so a misspelt field is a compile error.
- **305** A request's services stay alive until its `onSent` work finishes. That work has its own 10 seconds from when the response is sent, isn't cancelled by the client leaving, and is awaited at shutdown, but isn't durable.
- **314** A `@guard` parameter takes the value of whichever guard around its route gives that type; two guards there can't give one type. `@path` parameters match `{name}` anywhere in the full pattern.
- **318** Reading a form fails with a `FormError`, whose `state` is the `FormState` to redisplay the form with; `FormState` is plain data (`EMPTY`, `of`, `missing`, `explaining`).
- **329** An error every caller handles with `catch` straight after the call implements `HandledAtCall`, as `FormError` does. `try` and `fail` pass one on only to a function that fails with one itself, and no `from` variant takes one, not even `from Error`.
- **338** No HTML is written `Html.EMPTY`; an empty `html""` is an error.
- **323** `FormState` is a record of `values` and `problems`, each a map keyed by `FormField`; `FormState.EMPTY` has neither.
- **328** A handler or guard takes the request first only when it reads it, so one that doesn't leaves it out: `fn show(@guard note: Note)`.
- **325** A form field whose text is empty or only spaces counts as not submitted. Nothing is trimmed, except by a field type's own `parse`, as `Email`'s does.


## Databases

- **11a** Stored state uses plain backed enums plus ordinary columns.
- **11c** Enums with payloads are stored in the database only when opted in with attributes. A backing value is read with `.value`, including on a variant with a payload.
- **41** A field maps to the column or key with exactly its name. Override it with a field attribute, `@db(column: "customer_id")`, or a policy on the type, `@db(columns: Case.Snake)`. A type with private construction is decoded through its own `parse`.
- **101** A repository is an interface in the domain, an implementation in an adapter module, and an in-memory fake for tests. "Not found" is null, not an error: `fn find(id: OrderId) -> Order? else RepositoryError`.
- **127** Fields are encrypted at rest with AEAD (XChaCha20-Poly1305 by default) under a `Keyring` attached to the `Db`, via `@db(encrypt: "pii")`. Searchable fields also have a blind index, `@db(encrypt: "pii", blindIndex: EMAIL_INDEX)`, a `BlindIndex` constant. Ciphertexts carry key IDs, so keys rotate.
- **128** Migrations are Nib, forward-only, one per file in the migrations module, run in file-name order. Each declares a type implementing `Migration` with `apply(db)` and `transactional` (default `true`). A history table records each run; editing an applied migration is an error.
- **130** `nib db migrate` writes the resulting schema to a committed `schema.sql`. The type checker reads it to check `sql"…"` queries against records, and CI checks it matches a fresh run of the migrations.
- **132** Clean up a transaction with `defer tx.rollback()`, not `defer else`. `rollback()` can't fail and does nothing after `commit()`. `defer else` is for undoing non-transactional work.
- **151** Domain code declares what one atomic piece of work can touch (repositories, an outbox, `commit`, `rollback`) and starts it from a `UnitOfWork` port: `let work = try this.work.begin()`, `defer work.rollback()`, `try work.commit()`. The adapter decides how; the domain never sees `Tx` or `Db`.
- **152** No two-phase commit. Work spanning independent systems is a saga: local transactions with explicit compensating actions and idempotency keys, plus reconciliation; a database change plus a message uses the outbox.
- **268** A distinct type is codable with its base's codecs, written as its base; a `private` one must implement `Parseable`. `PasswordHash` and `TokenHash` are never JSON, and `SessionKey<T>` requires `T: Codable<SessionCodec>`.
- **278** A blind index is a `std.crypto.BlindIndex(name:, column:, keyring:)` constant, used in `@db(blindIndex:)` and `db.blindIndex(…)`. Its `name` is part of every hash and never changes; its `column` can be renamed.
- **279** Statements may run during a row stream; the stream sees rows as of its start and holds a connection. On a `Tx` all share its connection. A call waiting too long for a free connection fails with `DbError.PoolTimedOut`.
- **282** Keyrings are attached to the `Db`, which encrypts and indexes with `db.encrypt(value, keyring:)` and `db.blindIndex(index, value)`. Repositories take only a `Db`.
- **342** A field with a blind index says how it is encrypted too, `@db(encrypt: "pii", blindIndex: EMAIL_INDEX)`; a `blindIndex` without `encrypt` is an error. The index's keyring makes the hashes and `encrypt`'s encrypts the value.
- **308** A connection is taken per call, not per request; a transaction runs statements on one connection. Statements are prepared and cached per connection. Pool size comes from `pool-size-from` (default 10). Engines: `mysql`, `postgres`, `sqlite`.
- **309** `execute` returns nothing; `db.insertId<K>(sql"insert …")` gives the generated ID and `db.countChanges(…)` the rows matched. `db.insertAll(rows)` writes records all or none. `queryOne` gives `T?`; there's no `querySingle`.
- **343** `insert` and `insertAll` refuse a record with a field for a column the database generates (an identity key or a computed column). Make the ID in the app, use `insertId`, or insert a record without those fields; there's no `@db(generated:)`.
- **344** `DbError.Duplicate(constraint:)` is a statement that would duplicate a unique index or primary key, on every engine; `Rejected(code:, reason:)` is any other refusal.
- **310** Transactions are `let tx = try db.begin()`, `defer tx.rollback()`, work, `try tx.commit()`; the checker warns if one isn't committed or has no deferred rollback. `begin(isolation:)` is optional, and `DbError.Conflict` means retry.
- **312** A `Sql` inside another `sql"…"`'s `${…}` is pasted in as SQL, while other values stay parameters. `Sql.join`, `Sql.and` and `Sql.or` combine fragments; chosen identifiers come from an enum giving fixed `sql"…"`.

## Attributes and secrets

- **42** `@name(…)` attaches metadata to types and fields, one attribute per codec. Attributes never change behaviour on their own; codecs read them at compile time. There is no `derives`.
- **116** Attributes are typed declarations, `pub attribute Name { … }` with record-shaped fields, so `@deprecated(since: "1.4", use: "orders.place")` has its arguments checked. They're read by the compiler, codecs and tools, never at run time. Names are lowerCamel.
- **122** An attribute may assert a property the compiler verifies, such as `@pure` (no I/O or mutation), and it's a compile error if false. The compiler may optimise on verified facts; removing `@pure` from a `pub` function is a breaking change.
- **122a** Properties the compiler can't check (durability, idempotency) aren't attributes. They're types a consumer can require (`DurableQueue`), plus conformance test kits shipped with the interface.
- **146** Attributes go before the declaration or field, separated by spaces, never commas (`@json @sensitive`). Attributes without arguments may share a line; one with arguments goes on its own line.
- **191** Attribute arguments are ordinary constant expressions, so enum values in them are qualified and imported like any other name (`Case.Snake`).
- **192** An attribute is imported like any other name, with `@` in the import list and listed first (`import std.db.{@db, Db}`). Attribute names are lowerCamel; the compiler's checked attributes (`@pure`, `@callerLocation`, `@deprecated`, `@sensitive`) are in the prelude.
- **193** Codec attributes name their fields after what they affect, with the shared `Case` enum from `std.codec`: `@db(table: "users", columns: Case.Snake)`, `@json(keys: Case.Camel)`.
- **199** `@deprecated` takes `since:` and an optional `use:`: `@deprecated(since: "1.4", use: "orders.place")`.
- **240** A `@sensitive` type implements `Sensitive`, doesn't widen to its base, isn't `Stringable`, and shows as `[redacted]`. Compose secrets with `secret"…"`; `.revealed` is the one way out. `==` on secrets takes constant time.
- **332** Two secrets of different types compare their text with `matches`, in constant time: `password.matches(confirmation)`.
- **271** `secret url"…"` and `secret html"…"` build a `Secret<Url>` or `Secret<Html>`; a bare `Secret` is `Secret<String>`. `Url.join(path, secretQuery:)` gives a `Secret<Url>`, revealed only at the edge.
- **287** `==` and `!=` on two `Sensitive` values, and on `Bytes`, take constant time wherever they differ. There's no separate constant-time comparison function.

## Testing

- **62** `nib test` runs `test "name" { … }` blocks in `x.test.nibl` files beside the source. `expect` takes a `Bool` with power-assert output; `expect r is Result.Err(…)` checks failures, `expectPanic` panics; `test "…" for x in [...]` reports each row. Tests run isolated, in parallel.
- **156** Declarations in `*.test.nibl` files are visible to every test file in the package and to no production code.
- **261** Test code lives where production can't reach it: declarations in `*.test.nibl` files are visible to every test file in the package, and modules listed in the manifest's `[testing] modules` are importable only by tests. There's no `@testOnly`.
- **293** `std.testing.request(method, path, …)` builds a `Request` to pass straight to a handler or guard, with an empty session that keeps writes, a valid CSRF token and a documentation-range client address.

## Concurrency

- **16** Tasks run concurrently, in structured blocks, and pass values over channels. The rules are #110 to #115.
- **110** Within an instance, Nib is concurrent but not parallel: tasks run on one thread and switch only while waiting, so they can't corrupt memory. Parallelism comes from shared-nothing instances.
- **112** There's no `async`/`await`. Any function may block; the runtime suspends the task while it waits on I/O, so `http.get` and `db.query` are ordinary calls.
- **113** `let q = start f(x)` runs a call as a task; `q` has the call's type and the first read waits for it. A block waits for its tasks, and an early exit cancels them. An unread task is an error; `let _ = start …` runs one for its effect.
- **113b** `try orders.mapConcurrently(limit: 10, each: fn(o) => pricing.quote(o))` runs at most `limit` calls at once and returns the results in input order; the first failure cancels the rest.
- **113c** When a block exits, its unfinished tasks finish or are cancelled before any `defer` runs. `defer start …` is a compile error. Deferred calls still run in reverse order.
- **114** `std.channels` has a bounded `Channel<T>` for pipelines between tasks in one block: `Channel<T>.bounded(capacity:)`, `send`, `receive`, `close` and `for item in channel`. Between instances, use queues.
- **115** There are no mutexes or atomics in v1, since tasks never run in parallel. Coordination uses channels or `mapConcurrently`.
- **196** Cancellation isn't an error value: at the task's next wait it unwinds every block as an early return, cancelling started tasks and running `defer` and `defer else`, and can't be caught. The deadline always cancels; a disconnect cancels only safe requests (`GET`, `HEAD`, streams, sockets).

## Streams

- **247** A stream is an `Iterable`, read with `for`; a byte stream is an `Iterable<Bytes, IoError>` of chunks. Transformations are functions from stream to stream (`io.lines`, `csv.decoding<T>`, `gzip.decompressing`), and writing goes through `std.io.Writer`.
- **248** `map`, `filter`, `take` and `batched` on an `Iterable` are lazy and take closures that can't fail; a `List`'s own `map` and `filter` are eager and give a `List`. A failing step needs `toList()` first or a generator.
- **249** Something opened by an `@opens` function closes when the unit of work ends; `close()` releases it sooner. Writers commit only on `try close()`, and one never closed is discarded. Using something after closing it panics.

## Configuration and resources

- **23** Programs reach the outside world through a host abstraction, so the same code runs on different hosts.
- **24** On the server, each request is shared-nothing. In the browser, code runs on an event loop.
- **24b** The runtime creates or accepts a request and trace ID (W3C `traceparent`) and passes it through logs, HTTP calls and queue messages.
- **99** Host-lifetime things (pools, clients, config) are owned by the runtime, immutable and reached through `Env`. Everything else lives for one unit of work in its container. There are no process-wide mutable singletons.
- **108** The host gives each unit of work (a request, a queue message, a command) a read-only context that user code can't replace: `std.context.current()` gives its `id` and `traceparent`. Logging, the HTTP client, queues and the database read it, so it isn't passed through every function.
- **109** Every program starts at `pub fn main`. A CLI's `main(env: Env)` may return an `Int` exit code. A server's `main(env: Env) -> App` runs once per process and returns its configuration as data; the host then calls the handler per unit of work.
- **131** The app module is `std.app`, holding `App` and `Env`.
- **144** `main` may fail: `pub fn main(env: Env) -> App else E`, with `E: Error`. On failure the host logs the error and refuses to start (a CLI exits with code 1), so config is validated once, at start-up.
- **253** `env.stdin` is an `Iterable<Bytes, IoError>`, and `env.stdout` and `env.stderr` are `Writer`s that write at once. `env.workingDir()` gives a `Dir` on a command-line host and is refused on a server.
- **262** The manifest declares every config variable (`[config]`, with `secret = true`) and resource (`[databases]`, `[queues]`, `[rate-limiters]`, `[directories]`), each bound through a `from` variable. The checker keeps `Env` calls and the manifest in sync.
- **330** A rate limit is declared once, as a `Limit<K>(name:, max:, per:)` constant, and `limiter.hit(limit, key)` takes a key of type `K`. Two limits with one name in a package are an error.
- **280** `[files.NAME] path = "dir"` declares read-only files that ship with the build; `env.files(name)` gives them and `Route.files(prefix, files)` serves them (GET and HEAD, no listings, ETags). The host chooses how they ship.
- **336** A log field is `Loggable`: values, the stdlib's types, enums and distinct types holding loggables, errors, secrets (redacted), and records or classes marked `@loggable`. A record of your own isn't otherwise, since it may hold personal data.

## Dates and times

- **62b** Code reads the time through an injected `Clock` (and randomness through an injected interface such as `SecureRandom`), so tests can swap in fakes like `FakeClock`.
- **206** A `Duration` is exact elapsed time, built with `Duration.of(…)` from optional, possibly fractional named units, weeks to nanoseconds. Months and years are rejected in favour of `Period`. ISO 8601 is for data: `Duration.parse`, `duration.toString()`.
- **255** `Clock.sleep(duration)` waits, letting other tasks run and stopping at once if its task is cancelled; a `FakeClock` moves forward instead of waiting.
- **306** `std.time` has `Instant`, `Date`, `Time`, `TimeZone`, a read-only `ZonedDateTime`, `Duration` and `Period`, with no zoneless date-time and no default zone. `instant.in(zone)` and `date.at(time, zone)` convert; arithmetic is on `Instant` and `Date` only.

## Other parts of the standard library

- **6d** Every public stdlib predicate comes with its negation, named by a mechanical rule (`contains`/`doesNotContain`, `isEmpty`/`isNotEmpty`). A lint suggests the pair over `not x.contains(…)`, though `not` still works.
- **331** The prelude has `String.replace(part, by:)`, `indexOf` and `lines`; `List.reversed`, `groupBy` and `distinct`; `Iterable.indexed()`; and `List.zip`, which panics when the lengths differ. There is no `fold` (a `for` loop says it) and no `Map.entries` (a map is already iterable as pairs).
- **19a** The collections API is modelled on the managur/Collection v2 library.
- **25** The stdlib follows shared API naming conventions.
- **35** Cloud services are stdlib interfaces with interchangeable vendor back ends.
- **39** Records are the shape of structured data, and each codec is opted into per type. Data of unknown shape uses the `Json` enum.
- **51** In the stdlib, a member that takes no arguments, can't fail and is amortised O(1) is a getter (`list.length`, `list.isEmpty`).
- **76** `Money` is a record, so `==` is structural, with no operators: `a.plus(b)` gives `Money else CurrencyMismatch`. Converting currencies is the job of an `ExchangeRate`, not of `Money`.
- **103** `std.log` is called directly: `log.info("charged", fields: ["amount": total])` or `log.channel("audit").warn(…)`, recording the caller's location and request ID. A server's `App` routes channels to sinks with `log.Route` values; `@sensitive` fields are redacted.
- **117** A cache offers `cache.remember(key, ttl, fn)` with request coalescing across instances, stale-while-revalidate and TTL jitter, so a stampede computes a value once.
- **321** The stdlib declares #76, #108, #117, #190, #195 and #197: `Money(amount:, currency:)` with `Currency.of` and `parse`; `Cache.remember(key, ttl:, compute:)`, which runs `compute` when the cache can't be reached, and `forget`; `env.cache(name)` from `[caches.NAME]`; `Route.events` and `Route.websocket`, whose handlers take the request, then an `EventSink` or a `WebSocket`, and give nothing.
- **118** Queues are durable, cross-instance and at-least-once, with retries, backoff and replayable dead-letter queues; channels are in-memory. The stdlib ships the `Queue` interface with in-memory and database-backed back ends; brokers are vendor back ends.
- **126** `passwords.hash(p)` uses the current policy (Argon2id), or a pinned `passwords.Policy`. `PasswordHash.parse` reads PHC and legacy hashes, and `verify` gives `PasswordCheck.Valid`, `Invalid` or `ValidNeedsRehash`. Only vetted choices, OS randomness and constant-time comparison.
- **149** File APIs take a `Path`, never a `String`. `path"…"` literals are checked at compile time; untrusted text joins only through `PathSegment.parse` or `dir.resolveWithin`. Access goes through host-granted `Dir` capabilities (`env.dir("logs")`) that nothing opened beneath can escape.
- **163** A `path"…"` literal may interpolate only values that can't contain `/`, `..` or NUL, checked at compile time: `PathSegment`, integers, `Date`, safe backed enums and distinct types over these. A `String` is an error suggesting `PathSegment.parse`; paths join with `base.join(…)`.
- **214** Generated operations (equality, hashing, debug forms, codecs) walk values iteratively, so deep data can't overflow the stack. Decoders limit nesting to 128 levels by default (`depthLimit:`), and large data is walked or streamed rather than loaded whole.
- **217** Codecs are a library mechanism: an attribute declared as a codec makes marked types implement `Codable<C>` for its codec, and the compiler generates the field walk. Signatures constrain on it (`T: Codable<JsonCodec>`); std codecs have no privilege.
- **219** A queue is named by a typed address declared once, `const EMAILS = QueueAddress<EmailJob>("emails")`, used by `env.queue(EMAILS)` and `Consumer.of(queue: EMAILS, …)`, so producer and consumer agree on the job type.
- **222** A null object is an ordinary class implementing an interface with do-nothing methods; use one when doing nothing is correct, never for something production needs. The stdlib ships them where obvious, named for what they do (`log.Discard`).
- **254** Data without a record type: `csv.decodingRows` and `csv.encodingRows` work with rows of strings, `json.encode` and `json.decode` handle any codable value such as a `Map`, and `json.events` reads JSON of unknown shape.
- **256** `crypto.hmacSha256(key: Sensitive, message: Bytes) -> Bytes` signs; signatures are compared with `==`, which takes constant time on `Bytes`. `Bytes.concat(parts)` joins bytes and `Bytes.hex` gives lower-case hexadecimal.
- **263** The `nib/access` package declares `Access<U>`, `Voter<U, A, S>`, `Vote`, `Decision`, `Reason` and `AccessDenied`; `DenialCode` is a marker interface. First-party packages live in `packages/` and are checked as dependencies.
- **264** Text is read with the type's `parse` (`Int.parse(text)`); no error payload is called `message`; received tokens are `Token`s and never go into pages; `Response.redirect` takes a `RelativeUrl`.
- **269** The default log channel is the last segment of the package's name, or the file name without a manifest. An event no route takes goes to standard error if it's `Info` or above; `Debug` is dropped.
- **281** A `@json` enum is written internally tagged under `"type"`, and a variant without a payload is still an object. `@json(tag:)` renames the key and `@json(variants:)` changes name case; `from` variants can't be JSON.
- **301** `List.allMatch(test)` is whether `test` holds for every item; it's true for an empty list.
- **311** `std.uuid`'s `Uuid` reads any version. Code is given a `Uuids` (`env.uuids`, `FakeUuids` in tests): `next()` makes a version 7, `random()` a version 4; `Uuid.v5` and `v3` are plain functions.
- **327** A stdlib value's text form is `toString()`, its only spelling, with no `text` or `iso` getter. Names from a standard, such as `currency.code`, `locale.tag` and `zone.id`, are kept.

## Tooling

- **2** Code compiles to one typed intermediate representation, with two back ends: a bytecode VM and WebAssembly (with GC).
- **3** All tooling ships as one binary, and its diagnostics are available as JSON.
- **4** There is one canonical format, with no configuration: tabs for indentation and no alignment.
- **47** Source files use the `.nibl` extension.
- **80a** An unused import is a warning, not an error. `nib fmt` removes unused imports and sorts the rest.
- **85** The manifest is `nib.toml`. A committed lock file, `nib.lock`, records resolved versions and content hashes.
- **86** Registry names are `vendor/name`. Code imports a dependency through a local root name chosen in the manifest (`log = { package = "acme/log", version = "2.1" }` gives `import log.json`). A package's own root is its name part.
- **87a** A bare version is exact (`1.2.3`). Constraints use `^`, `~` (patch updates only), `>= > <= <`, `!=`, `,` for AND and `||` for OR; no wildcards or hyphen ranges. Pre-releases are chosen only when a constraint names one.
- **88a** Two copies of a package are different packages with different types. Private copies never meet, since private dependencies can't appear in a public API, and with no top-level state they can't fight over globals.
- **88b** `nib pkg install` picks the highest versions satisfying every constraint and writes the lock file; nothing upgrades without `nib pkg update`. A private dependency that can't share a version gets separate copies; a public one that conflicts is an error. `nib pkg why` explains.
- **89** `nib pkg publish` compares the public API with the previous release and refuses a breaking change without a major version bump.
- **90** Installing a package never runs its code: no install scripts or build hooks. A package is source plus metadata.
- **91** Registry releases are immutable and can't be deleted. A publisher can retract a release, which stays downloadable for existing lock files but is skipped by resolution. A public checksum log makes tampering visible; private registries and git dependencies work.
- **92** A root `nib.toml` can list `[workspace] members = [...]` explicitly, with one lock file and resolution. A member depends on another with version `"workspace"`, rewritten to `^<version>` on publishing; root commands cover every member. (Syntax still proposed.)
- **93** Dependencies are private by default: their types can't appear in your `pub` API. Mark one `public = true` when sharing its types is the point; a public dependency must resolve to one version everywhere.
- **94** Only the root package can override dependencies, with `[patch]`, which replaces a package everywhere with a fork, path or git commit.
- **95** A package states the language version it needs as `nib = "^1.2"` in `[package]`.
- **96** `[conflicts]` in the manifest names a package and version range that must not appear anywhere in the dependency graph; resolution fails if it does.
- **148** The lint suggesting `x.isNotEmpty` over `not x.isEmpty` fires only when the negated member exists; user types needn't declare such pairs.
- **205** `tools/nib`, a dependency-free TypeScript checker, parses and checks Nib code against `design/grammar.md`, with test cases of programs it must accept or reject, and `--json` output.
- **207** A `.d.nibl` file declares an API without implementing it: functions, methods and getters have no body, and there are no tests. The stdlib and first-party packages are declared this way, and the checker resolves against them.
- **243** Code in doc comments illustrates and is never run; it may use names the reader is assumed to have. Examples that must work belong in code. The language guide's examples are complete and checked in full.
- **245** Lines should fit in 120 columns and must fit in 150, counting a tab as four. Over 120 is a warning; over 150 is an error.
- **274** Doc-comment examples are type-checked in a copy of their file's module, with its imports. Names they don't declare are unknown rather than errors, but static members, labels, `override` and declarations are checked. Nothing is run.
- **284** `nib fmt` writes the canonical format: lists on one line if they fit in 120 columns, else one item per line; fixed spacing and tabs; sorted, grouped imports; nothing else reordered. `nib check` warns about unformatted files.

## How the design is made

- **1** Nib aims first at replacing PHP on the server, with the same code compiling for the browser and performing well. Specialist domains live outside the stdlib.
- **1a** APIs and syntax should read like English, for people and for LLMs alike.
- **26** The language is called Nib, and its source files end in `.nibl`. Its home is niblang.dev, and its GitHub organisation is `niblang`. Its codename was alang.
- **283** The seven guiding principles are agreed: clear over clever; readable as plain text; magic only where it pays; one obvious way; safe by default, explicit to opt out; start small, widen later; DX and AX together.
- **302** `guide/00-first-look.md` reads `examples/notes/src/main.nibl` from top to bottom, linking each part to its chapter, and is checked to match that file.
- **320** The guide's order: 0 a first look, 1–7 the core, 8 modules, 9 the web, 10 databases, 11 attributes and secrets, 12 testing, 13 concurrency, 14 streams, 15 configuration and resources, 16 dates and times.
