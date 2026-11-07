# Panics

Status: agreed (round 10).

## What a panic is

A panic is a bug, never an expected outcome. Expected failures use `else` / `fail` (see
`no-exceptions.md`).

Sources: an index or key out of range, integer overflow, `.orPanic("why")`, `panic("why")`,
`assert(cond, "why")` (asserts stay on in release builds), stack overflow, and runtime limits
(time, memory).

`panic` returns `Never`.

## Who catches it

Ordinary code cannot catch a panic. If it could, panics would become exceptions again.

The boundary is the **unit of work**, and the runtime owns it:

| Host | Unit of work | On panic |
|------|--------------|----------|
| HTTP server | one request | Throw away the instance. Send a safe 500, or abort the connection if headers were already sent. |
| Queue consumer / cron | one message or job | Throw away the instance. Nack the message and retry with backoff; dead-letter it after N attempts. |
| CLI | the process | Report to stderr, exit with code 101. |
| Browser | the app | Show the fallback UI, report the panic, and stop handling events until reload. |
| Tests | one test | `expectPanic(…)` is the only API that catches a panic. |

## Why shared-nothing makes this safe

Each request runs in its own instance, so after a panic there is no half-updated shared state
to worry about. Connections, transactions, file handles and pools belong to the host, not the
instance. The host rolls back open transactions and returns connections to the pool reset.
Cleanup does not depend on user code running during the panic.

## The report

`PanicReport` contains:

- the kind (`IndexOutOfBounds`, `Overflow`, `Assertion`, `Explicit`, `StackOverflow`,
  `OutOfMemory`, `Timeout`)
- the message, plus automatic context (e.g. the index and the length)
- a source-mapped stack trace
- the request ID and trace ID (#24b)
- a request summary (method, route, response status), with no body or headers by default
- the build version

The runtime writes it as a structured log at `error` level and marks the trace span as failed.
`--json` emits it as machine-readable output for agents.

Fields marked `@sensitive` are redacted in reports, logs and debug output.

## The response

- **Release builds:** a 500 with only an opaque reference (the request ID). JSON clients get
  RFC 9457 problem details; browsers get a plain HTML page. No message, stack or internals.
- **Dev (`nib run`):** a full error page with source, stack and request details, in the
  spirit of PHP's Whoops / Ignition.
- A release build never shows details unless it was built with an explicit flag. Nothing is
  detected from the environment.

## The application hook

`onPanic(report) -> Response` customises the response and sends the report to error
trackers. It runs in a **fresh** instance and receives only the report, never the panicked
request's state. If the hook itself panics or times out, the runtime falls back to the default
response.
