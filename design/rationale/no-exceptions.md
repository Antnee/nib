# Why Nib has no exceptions

Status: agreed (round 2). Revisit only with a concrete case this design handles badly.

## Decision

Recoverable failures are values: `-> T else E` (a `Result<T, E>`), passed up with `try`. Panics exist only for
bugs (bounds violations, broken invariants). They cannot be caught inside ordinary code. The
runtime catches them at the request boundary, so one request dies and the server carries on.

## Reasons

1. **Failure is visible in the signature.** `fn parse(s: String) -> Date else ParseError`
   says it can fail. `fn add(a: Int, b: Int) -> Int` says it cannot. With exceptions, every
   call might throw, and nothing in the code tells a reader, a reviewer or an agent which ones.
2. **The control flow is visible.** Every place a function can exit early is marked with `try` or `fail`.
   There are no invisible jumps through the call stack.
3. **Checked exceptions were the obvious fix, and they failed.** Java made failures part of the
   signature, but the cost at the call site (try/catch everywhere, or `throws` lists that
   spread through the code) drove people to wrap or swallow them.
4. **`try` is one word.** You get the brevity of exceptions without the invisibility, and
   unlike Go's `if err != nil` there is no boilerplate.
5. **It fits shared-nothing.** A panic behaves like a PHP fatal error: it is contained to one
   request.

## What we give up

- Hierarchies of exception types. We use enums of error cases plus a common `Error`
  interface for wrapping and context.
- Throwing from deep inside a call stack without touching the code in between. Every layer in
  between has to say `try`. We consider that a feature.
