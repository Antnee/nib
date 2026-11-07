# Errors

There are no exceptions. A function that can fail says so in its signature, and every place
where a failure can happen is marked in the code. Bugs are different: they panic.

## Failing

```nib
enum QuantityError implements Error {
	NotWhole(from ParseError)
	TooMany(maximum: Int)

	override get message: String => match this {
		QuantityError.NotWhole => "not a whole number"
		QuantityError.TooMany(maximum:) => "more than ${maximum}"
	}
}

fn quantity(text: String) -> Int else QuantityError {
	let n = try Int.parse(text)
	if n > 99 {
		fail QuantityError.TooMany(maximum: 99)
	}
	return n
}
```

- `-> Int else QuantityError` reads "returns an `Int`, or fails with a `QuantityError`".
- `fail` leaves the function with an error, as `return` leaves it with a value.
- A function says `else` only if something in it can fail. When nothing can, the checker
  warns, because a reader trusts a signature to say what can go wrong. A method that
  implements an interface's can keep the interface's `else`, or drop it
  ([Interfaces](04-types.md#interfaces)).
- Every type after `else` implements `Error`. That gives it a `message`, and, for an error
  that wraps another, a `cause` and a `chain`. It can be an interface, such as `ToResponse`,
  which is an `Error` that can also give a response: the function can then fail with any
  error that implements it.
- An outcome that isn't really an error belongs in the return type, as a `T?` or an enum:
  a search that found nothing, or a payment that needs another step.
- Text that people see is chosen by the page or handler that shows it, never taken from an
  error. One reason: a site may show pages in several languages.

### Messages

An error's `message` is for developers and logs. It's in lower case, and describes only its
own layer.

An enum that doesn't write `message` gets one from each variant's name, in words:

```nib
enum CacheError implements Error {
	Unreachable
	TimedOut(after: Int)
}
```

- `CacheError.Unreachable`'s message is `unreachable`.
- `CacheError.TimedOut`'s is `timed out`.
- A variant's payload is never part of it, since a payload can hold something that mustn't
  be logged.

Write `message` yourself when the name doesn't say enough, as `QuantityError` does to give
the maximum. Writing it replaces the message of every variant, so its `match` covers them
all.

A record or a class that implements `Error` always writes `message`, because it has no
variant names to use.

### An outcome, or an error?

Look at what callers do with it:

- If every caller deals with the case as soon as it happens, and none passes it on, it's an
  outcome. Put it in the return type, as an enum.
- If callers pass it on with `try`, it's an error.

An expired coupon is an outcome: the basket page tells the shopper straight away. A coupon
store that can't be reached is an error: the code that applies coupons can only pass it on.

```nib
enum CouponOutcome {
	Applied(discount: Decimal)
	Expired
	Unknown
}

enum CouponError implements Error {
	Unreachable

	override get message: String => match this {
		CouponError.Unreachable => "the coupon store couldn't be reached"
	}
}

fn applyCoupon(code: String) -> CouponOutcome else CouponError {
	let discount = try storedDiscount(code) ?? return CouponOutcome.Unknown
	return discount > 0 ? CouponOutcome.Applied(discount:) : CouponOutcome.Expired
}

fn storedDiscount(code: String) -> Decimal? else CouponError {
	fail CouponError.Unreachable
}
```

A caller `match`es the outcome, which must cover every case, and passes the error on with
`try`.

A failure that every caller handles with `catch` straight after the call is fine as it is.
`catch` handles a failure where it happens ([Handling an error](#handling-an-error-catch)).
Reading a form is one: `req.body.form<SignUpForm>() catch err { … }` shows the form again
with its problems, from `err.state`. Its error says so by implementing `HandledAtCall`
([Errors handled at the call](#errors-handled-at-the-call)). The test is for what goes in an
error enum: don't put an outcome there, beside failures that callers pass on with `try`.

Keeping outcomes out of error types also keeps those types small. Each layer's error then
holds only the failures it passes on.

## Passing an error on: `try`

Put `try` in front of a call that can fail:

- when the call succeeds, `try` gives its value;
- when the call fails, the function around it fails with the same error (converted, if
  needed: see below).

**One `try` covers one call.** Any other call inside it that can fail needs its own:

```nib
fn checked(n: Int) -> Int else QuantityError {
	return n > 99 ? fail QuantityError.TooMany(maximum: 99) : n
}

fn parsed(text: String) -> Int else QuantityError {
	return try checked(try Int.parse(text))
}
```

`fail` can stand where a value is expected, as in the `? :` above or after `??`. It leaves
the function, so that branch never needs a value. `return` can stand there too.

```nib error
// Rejected: `Int.parse(text)` can fail too, and one `try` covers one call.
fn careless(text: String) -> Int else QuantityError {
	return try checked(Int.parse(text))
}
```

`try` binds like a minus sign: it applies to the call chain on its right and nothing more,
and covers that chain's last call. So `try cart.subtotal().plus(cost)` covers `plus`, and is
only allowed if `subtotal` can't fail. `try a() + try b()` adds two values, and
`try find(id) is null` tests what `find` found.

When several steps in a chain can fail, split the chain with `let`, one `try` each:

```nib
fn bothQuantities(a: String, b: String) -> Int else QuantityError {
	let first = try quantity(a)
	let second = try quantity(b)
	return first + second
}
```

### Converting errors

An error passed on by `try` or `fail` has to fit the function's own error type. It's
converted through a variant marked `from`.

Take `quantity` above. `Int.parse(text)` fails with a `ParseError`, but `quantity` fails with a
`QuantityError`. `QuantityError` has one variant that takes a `ParseError`,
`NotWhole(from ParseError)`, so `try` wraps the `ParseError` in it.

- If no variant takes the error, or more than one does, it's a compile error.
- The wrapped error becomes the new error's `cause`, so a log can print the whole chain,
  each layer's message joined with `: `. A `from` variant's own message names only its
  layer, such as `database`, so the log reads `database: connection refused`.
- Conversion goes one level only. If an error needs wrapping twice, write the outer step
  yourself.

The conversion isn't written on the line. `try Int.parse(text)` doesn't say that a failure
becomes `QuantityError.NotWhole`. To see where a failure goes, read the function's error type
and its `from` variants.

So add a `from` variant with care. A variant added just to make a `try` compile can turn an
outcome a person should see, such as an expired link, into a failure that only a log shows.
When a caller needs to tell failures apart, handle them with `catch` before they're wrapped.

### Taking any error

At the edge of an app, many failures mean the same thing. A page can do nothing about a
database that's down or a cache that timed out, so each one is a `500`. A variant marked
`from Error` takes any error that no other variant takes:

```nib
import std.http.{Response, Status, ToResponse}

enum PageError implements ToResponse {
	NotFound
	Failed(from Error)

	override fn toResponse() -> Response {
		return match this {
			PageError.NotFound => Response.notFound()
			PageError.Failed => Response.problem(status: Status.INTERNAL_SERVER_ERROR)
		}
	}
}
```

- It's the catch-all, on purpose, like PHP's `catch (\Throwable $e)`. Every layer below
  names each error it passes on, and the edge is the one place that doesn't need to.
- A variant that names its error, such as `Database(from DbError)`, still takes that error
  first.
- The log shows the whole chain, so nothing about the cause is lost.
- It belongs only where failures are reported rather than handled: an error that becomes a
  response, by implementing `ToResponse`, or the error `main` fails with. Anywhere else it's
  a compile error. Code whose callers handle its failures, such as an account's rules, keeps
  a variant for each one, so the callers can tell them apart.
- Only one variant can take any error.

```nib error
// Rejected: an account's callers handle its errors, so each one needs its own variant.
enum AccountError implements Error {
	Failed(from Error)

	override get message: String => "account update failed"
}
```

### Errors handled at the call

An error that implements `HandledAtCall` is handled where it happens, with `catch` straight
after the call. A form that doesn't decode is one: its `FormError` is shown again as the form,
with its problems. Passed on, it would become a failure it isn't, so a form with an empty
field would give an error page.

So `try` can pass one on only to a function that fails with that kind of error itself, and no
`from` variant takes one, not even `from Error`:

```nib error
// Rejected: a `FormError` is handled where it happens, so `try` doesn't pass it on.
import std.forms.{@form}
import std.http.{Request, Response}

@form
record CommentForm {
	text: String
}

fn postComment(req: Request) -> Response else PageError {
	let form = try req.body.form<CommentForm>()
	return Response.text(form.text)
}
```

- A function that only reads the form, `fn read(req: Request) -> CommentForm else FormError`,
  can pass it on unchanged, and its caller catches it.
- Your own error can implement `HandledAtCall` too, for a failure that every caller handles
  on the spot.

### Where a failure happened

Every error carries a `trace`, a list of places in the code:

- first, the `fail` that started the failure;
- then each `try` or `fail` that passed it on, through every wrap.

Logging an error writes its chain of messages and its trace. A failed `main` prints both too.
An error tracker can read the places from `err.trace`.

The trace isn't part of the error's value. So two errors are equal wherever they happened,
and a test can `expect` a particular error without caring where it was made.

## Handling an error: `catch`

`catch` after a call handles its failure, binding the error to a name for the block:

```nib
fn quantityOrOne(text: String) -> Int {
	let n = quantity(text) catch err {
		print("using 1, because the quantity was ${err.message}")
		return 1
	}
	return n
}
```

What the block must do depends on how the call is used:

- When the call's value is used, as with `let n = …` above, the block has to leave: with
  `return`, `fail` or `panic`, or, inside a loop, with `break` or `continue`. Otherwise there
  would be no value to carry on with.
- When the call is a statement on its own, or its value is dropped with `let _ =`, the block
  may simply end, and the code after it runs:

```nib
fn note(text: String) {
	let _ = quantity(text) catch err {
		print("ignored a bad quantity: ${err.message}")
	}
}
```

To handle one kind of failure and pass the others on, test the error inside the block, and
`fail` it otherwise. `fail` converts the error the same way `try` does:

```nib
fn capped(text: String) -> Int else QuantityError {
	let n = quantity(text) catch err {
		if err is QuantityError.TooMany {
			return 99
		}
		fail err
	}
	return n
}
```

`catch _ { … }` handles a failure without naming the error.

`try` and `catch` are the two things a caller can do with a failure: pass it on, or handle
it. So a call takes one or the other, never both.

A `catch` handler can't go in the condition of an `if` or `while`, or in what a `match`
matches, because its block would be hard to tell apart from the statement's own. Bind the
value with `let` first.

### Which to write

`try` and `catch` are for a call that can fail. `??` is for a value that may be `null`, and
`?:` for text or a list that may be empty:

| You have | You want | Write |
|----------|----------|-------|
| a call that can fail | to pass the failure on | `try f()` |
| a call that can fail | to handle the failure | `f() catch err { … }` |
| a call that can fail | to handle it without the error | `f() catch _ { … }` |
| a value that may be `null` | a fallback | `x ?? fallback` |
| a value that may be `null` | to leave instead | `x ?? return …` or `x ?? fail …` |
| a value that may be `null` | to do something, then leave | `x ?? { … }` |
| a value that may be `null` | to stop, because `null` would be a bug | `x ?? panic("…")` |
| text or a list that may be empty | a fallback | `x ?: fallback` |

A call that can fail and gives a value that may be `null` uses both:
`try users.find(id) ?? fail WebError.NotFound`.

## Results as values

A call that can fail, written without `try` or `catch`, gives a `Result`. A `Result` holds
either the success value or the error. That's useful in tests, and to keep a result for
later:

```nib
fn isValid(text: String) -> Bool {
	let result = quantity(text)
	return result is Result.Ok
}
```

- `result.ok()` gives the value, or `null` if it failed, dropping the error on purpose.
- `result.orPanic("why this can't fail")` asserts success.
- `result.mapError(fn(e) => …)` converts the error.
- `try result` passes it on.

A `Result` can never be dropped unhandled:

```nib error
// Rejected: the `Result` is dropped. Pass it on with `try`, or handle it with `catch`.
fn forgetful(text: String) {
	quantity(text)
}
```

`let _ = f()` drops it on purpose, where ignoring a failure really is right.

Any other value a statement drops is a warning, unless it's `Void`. That includes an outcome,
such as the `CouponOutcome` above: `try applyCoupon(code)` on its own line would ignore
whether the coupon applied. Write `let _ = …` when dropping the value really is right.

## Closures and loops

`try` inside a closure leaves the closure, not the function around it.

A function that takes a closure, such as `map`, can fail in the same ways as the closure you
give it. When the closure can't fail, neither can the call, and it needs no `try`. When the
closure can fail, the call needs a `try` of its own:

```nib
fn quantities(texts: List<String>) -> List<Int> else QuantityError {
	return try texts.map(fn(text) => try quantity(text))
}
```

A loop over a source that can fail partway, such as rows read from a database, is written
`for row in try source { … }`. The `try` covers each step of the loop.

## Panics

A panic is for a bug, not for an outcome the code expects. These panic:

- an index that's out of range;
- arithmetic that overflows;
- `panic("…")`;
- a failed `assert(…)`;
- `todo("…")`, which marks unfinished code. A release build refuses to compile while any
  remain.

A panic stops the unit of work (the request, or the job), and the host logs it. Only tests
and the host can catch one.

## Why not exceptions?

An exception can come out of any call, so a reader can't see which lines might fail. To
handle one, you have to know what every layer below might throw.

Here, `try` marks each place a function can fail, and the signature lists what it can fail
with. The compiler checks both.
