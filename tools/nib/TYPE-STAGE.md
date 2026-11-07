# Plan: the checker's type stage

The checker today resolves names, imports, static members and interface implementations. It
doesn't know the type of any expression, so it can't check `value.name`, argument counts and
labels, `match` exhaustiveness, or most of `PENDING-CHECKS.md`. This plan adds a type stage
in milestones, each one useful on its own.

## Principles

1. **No false errors.** Anything the stage can't type becomes `Unknown`, which is
   compatible with everything and reports nothing. A missing feature in the stage shows up
   as checks that don't happen, never as errors in valid code.
2. **The examples are the test bed.** After each milestone, `check examples std` stays at
   0 errors and 0 warnings. Each new error is sorted the usual way: a bug in the example (fix
   it, note it in `FINDINGS.md`), a bug in the tool (fix it), or a gap in the decisions (a
   row in `design/decisions-log.md`, for the user to settle).
3. **Same shape as the rest.** TypeScript, no dependencies. A new `src/types.ts` runs after
   the name pass and reuses its resolved bindings, so names aren't resolved twice. Each rule
   gets a case in `test/cases`; each `PENDING-CHECKS.md` item it enforces leaves that file.
4. **One error per mistake.** An expression that fails to type becomes `Unknown`, so one
   wrong name doesn't cascade into ten errors.

## Types inside the checker

| Kind | Examples |
|---|---|
| Named, with arguments | `Int`, `List<Email>`, `Route<Services, User>`, `QueueAddress<EmailJob>` |
| Type parameter | `T` in `fn first<T>(…)`, with its constraints (`T: Codable<JsonCodec>`) |
| Nullable | `User?` |
| Function | `fn(Order) -> Money else PricingError` |
| Tuple | `(Int, String)` |
| `This` | the implementing type, inside an interface |
| `Never`, `Void` | `return`, `fail`, `panic(…)`; a function with no result |
| `Unknown` | anything the stage can't type yet; never reported |

A fallible call's result is a value type plus an error type (`-> T else E`, #9c), kept
separately, because `try`, `catch` and `.mapError` work on the pair, not on a `Result` value.

## Milestones

### M1: declarations and members (done)

- A signature table for every declaration in the package and the stdlib: fields, getters,
  methods (instance and static), constants, variants and their payloads, type parameters
  and constraints.
- Members a type gets without writing them: interface defaults (#227), equality and hashing
  (#212), `BackedEnum`'s `value` and `fromValue`, a distinct type's `parse` (#165), an error
  enum's `cause` (#228), a distinct type widening to its base (#37).
- Types of literals, locals, parameters, `this`, fields and getters; member access on a
  known type. **New check: instance members** (`value.name` must exist, with a "did you
  mean").
- LSP, from the same table: hover shows a name's type, go-to-definition jumps to it.

Built in `src/types.ts`. The member table is built on demand, per type and its arguments,
rather than as one table up front. Also checked: a record literal's fields (each one exists,
and each without a default is set) and `with`'s fields. A fallible call gives a `Result`,
except under `try` or `catch`, where each step gets the success value (#164). On the shop,
95% of member accesses have a typed object; the rest are leading-dot shorthand and closure
parameters (M5) and names from dependencies, which the checker doesn't read. Constants
from other files are typed only when annotated or a literal.

### M2: calls (done)

- Overloads by number of arguments and labels (#14, #223), positional before labelled,
  `named` parameters labelled at every call (#166), defaults on `named` parameters (#211),
  punning (`idempotencyKey:`, #135), `@callerLocation` filled in (#107).
- **New checks:** argument counts and labels, and the "boolean trap" lint (#166). Leaves
  PENDING-CHECKS: labels.
- Argument *types* aren't compared yet; that needs M3.

Built with M1. Calls through a dependency's names, and calls whose callee is a closure
parameter, aren't checked. Labelled arguments may come in any order; the formatter will put
them in declared order (#232).

### M3: assignability and generics (done)

- When a value fits a type: same type; a distinct type into its base (#37) but not back;
  `T` into `T?`; `null` into `T?`; `Never` into anything; a type into an interface it
  implements, including through attributes (`@json` → `Codable<JsonCodec>`, #217).
- Type arguments: inferred from the call's arguments (#68a) or from a type written in the
  same statement (#179); otherwise all of them written, or none (#218). Constraints checked.
- **New checks:** argument, return, field and `let` annotation types; constraints. Leaves
  PENDING-CHECKS: codecs, type arguments, inference, equality (#212).

Built in `src/types.ts`. Also checked, since the types were there: assignments, conditions
(`if`, `while`, `and`, `or` and `not` take a `Bool`), number literals against their type
(#230: range and sign, no point in an integer), arithmetic on one number type (#231, with
distinct types widening, #70a), no `/` on integers (#36b) or `Decimal` (#225, so that item
left M6), and a written type's argument count. A record literal without type arguments
infers them from its fields (`Page { items: squares }` is a `Page<Square>`). `Loggable` is
implemented by every type, as its doc says. Leniencies, each lifted by a later milestone:
a nullable value fits where a non-null one is wanted, since narrowing is M4; error types
aren't compared (M4); a `Result` whose error type isn't known fits as its value, since `E`
may be `Never`; closure parameters are unknown (M5). Not done: the error for a type
argument that neither the arguments nor the statement determine (#68a, #179), which needs
closures typed first (M5). On the shop, 1,146 of 1,206 checks compared two known types; the
one example bug found was a closure passed to `mapConcurrently` that called a fallible
function without `try`, so it returned a `Result` instead of failing.
### M4: errors, `match` and flow (done)

- `try` (#52, #241): unwraps its operand's value once (another fallible call inside needs its own `try`), an error if nothing in it can fail, and the
  error must fit the function's `else` type directly or through exactly one `from` variant
  (#52b). `fail` likewise. `catch` handles only errors and `??` only null (#161).
- `match`: arms unify to one type, `yield` in block arms (#134), `return` and `fail` are
  `Never` (#133), bare variant names when the type is known (#142).
- Narrowing: after `is`, `!= null`, and through `and` and `?:`, for `let` and `var` locals.
- **New checks:** exhaustiveness (#11), dropped `Result`s (#155), `try` with nothing to
  cover. Leaves PENDING-CHECKS: results, exhaustiveness.

Built in `src/types.ts`. Narrowing follows #233: locals and parameters, through `if`,
early exits, `and`, `or`, `not`, `?` `:`, `while` and `match` guards, and a declaration or
assignment with a non-null value; not fields, getters, `var`s inside closures, or a
narrowing from before a loop that assigns the local. With it, M3's leniencies are gone: a
`T?` no longer fits a `T`, `.name` on a `T?` needs `?.`, and function values' error types
are compared. Messages say why a narrowing doesn't apply and what to write instead (for a
field, the `if x is T name` binding). `x == null` points to `is null` (#8a). `try` and `fail`
check the function's error type, directly or through one `from` variant (`fail` too, by
#235); `try` on a source that fails partway covers its steps, and leaving it out
of a `for` is an error (#216). `catch` needs something that can fail, and its block must
leave unless it is a statement (#170); `??` on a non-null value warns, and on a `Result` is
an error (#161). Dropping any other value that isn't `Void` warns (#291). `match` checks enums (with one level of nested payload
patterns), `Bool`, `null`, and asks for `_ =>` on types whose values can't be listed; a block
arm of a `match` that gives a value ends with `yield` (#134); a variant name that doesn't
exist is an error; and `is` can't test for a type other than the value's own (#234). On the
shop, nothing new was found; four mistakes planted in a copy were all caught. Also: assigning a parameter is an error (#1b: parameters are immutable), which M5 had left out.
### M5: closures and the leading dot (done; the leading dot was later removed, #239)

- An expected type flows into closures (`fn(o) => o.total` gets `o`'s type from the
  parameter it's passed to, #27) and into `.name` shorthand (#160).
- Fallible closures, generic over their error type with `E = Never` for infallible ones
  (#64). Captures and `use (mut x)` (#63).

Built in `src/types.ts`, with the capture rule in `src/check.ts`. Every expression is typed
with the type its position expects, when there is one: an annotation, a parameter, a field,
a return type or an assignment's target. A call types its arguments in an order: plain ones
first, then the expected type for the type arguments they leave open (#179), then
literals, closures and shorthand, and last any argument that contains one (a list of
routes needs its guard's type). A static call on a generic type infers the type's
parameters too (`Route.get(…)` is a `Route<Services>` inside a `Routes<Services>`). A
closure can fail with what its `try`s and `fail`s raise; without them, a `Result` it gives
is a value, so `E` is `Never`. A type argument that only the result mentions, with nothing
in the statement to say what it is, is an error asking for it (#68a). `start` has its
call's type (#113), and `try` on it gives the value. The name pass now rejects assigning a
`let` or `const` (#7), a closure assigning a `var` it captured without `use (mut …)`, and
`use (mut …)` on a `let` (#63). `RouteHandler` and `RouteGuard` are implemented by any
function until M6 checks their shape; a guard's value is inferred from its function. On the
shop, 596 of 601 member accesses have a typed object (the rest come from dependencies);
nothing new was found in the example.
### M6: the remaining domain rules (done)

- Handlers and guards (#220): each takes the request, then the nearest guard's value, then
  the remaining path parameters by name, each `Parseable`.
- Duplicate routes after prefixes (#221). (`Decimal` has no `/`, #225, landed with M3.)
- An error's `message` reaching a page (#229): only the direct case, `.message` of an `Error`
  inside an `html"…"` literal or passed to `explaining`. Following values further needs data
  flow, which stays out of scope.

Built in `src/types.ts`. Calls to `Route`'s constructors are marked as they're typed; once a
file is typed, each route table is walked from its outermost routes, with each group
passing its prefix, its guard's value and (without a guard) its path parameters to the
routes inside. A handler or guard is read from the method its closure names, so its
parameter names are known: request first, then the guard's value, then the path
parameters by name and in order, each `Parseable`; a handler gives a `Response`, and both
fail with a `ToResponse`. Patterns and prefixes must be plain literals. Duplicates are
found per file, after prefixes, with parameter names ignored (`/a/{x}` and `/a/{y}` are the
same route). On the shop, nothing new was found; a renamed path parameter, a handler
missing its guard's value and a duplicate route, planted in a copy, were all caught. Since
#238, the guard's value is marked `@guard` and each path parameter `@path`, and a missing or
wrong marker is an error. Since #239 there is no leading-dot shorthand: a route names its
handler with a closure, `fn(app) => app.checkout.show`, whose body is read for the method.

Not in this plan: the formatter (#145's width rule), the build check on queue addresses
(#219), and dependencies' contents, which the checker doesn't read.

## Questions to settle on the way

None of these block M1. Each is settled when its milestone needs it, with a row in
`design/decisions.md`.

1. **Number literals (M1).** Settled by #230: a literal takes the type it's used as, and
   with no context `42` is an `Int` and `3.95` a `Decimal`.
2. **Generic variance (M3).** Already settled by #136: generic types are invariant, function
   types contravariant in parameters and covariant in results. The checker also reads a
   `Result` covariantly, since it is only ever read.
3. **Testing an interface value's type (M4).** Settled by #234: not for now.
4. **Narrowing a `var` (M4).** Settled by #233: `var`s narrow too, until assigned, within
   limits.
5. **Numeric conversions (M3).** Settled by #231: there is no `Int64`, and typed numbers
   never convert implicitly.

## Order of work and size

All six milestones are done: M1 and M2 together, then M3, M5, M4 and M6. What's left is in
`PENDING-CHECKS.md`: rules that need data flow, the build, a formatter, or dependencies'
contents.
