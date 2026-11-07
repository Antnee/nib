# Testing

Tests are part of the language. They live in files ending `.test.nibl`, beside the code
they test and in the same module, so they can use everything in it.

```nib
enum Grade {
	Pass
	Fail

	get isPass: Bool => this == Grade.Pass
}

fn grade(score: Int) -> Grade else ScoreError {
	if score < 0 or score > 100 {
		fail ScoreError.OutOfRange(score:)
	}
	return score >= 50 ? Grade.Pass : Grade.Fail
}

enum ScoreError implements Error {
	OutOfRange(score: Int)

	override get message: String => match this {
		ScoreError.OutOfRange(score:) => "${score} is outside 0 to 100"
	}
}
```

```nib
test "a score of 50 passes" {
	expect try grade(50) == Grade.Pass
}

test "scores outside 0 to 100 are rejected" for score in [-1, 101] {
	expect grade(score) is Result.Err(ScoreError.OutOfRange)
}

test "low scores fail" {
	let result = try grade(12)
	expect not result.isPass
}
```

- `test "name" { … }` declares a test. The name says what should be true.
- `expect` takes a `Bool`. When it's false, the report shows the value of each part of the
  expression. So there's no family of `assertEquals` functions to learn.
- A test may use `try`. If the call fails, the test fails, and the report shows the error's
  chain.
- `expect result is Result.Err(…)` checks a failure, matching a pattern.
- `test "…" for x in [...]` runs once for each item, and each run is reported on its own.
  The items can be tuples: `for (input, expected) in [("a", 1), ("b", 2)]`.
- `expectPanic(fn() => …)` checks that something panics.

Each test runs in its own instance, in parallel with the others, so tests can't affect each
other. Set up with plain function calls, and clean up with `defer`.

## Fakes

There's no mocking library and no reflection. A dependency is an interface, so a test passes
an implementation of its own: a class in a test file, or a one-off made with `new`:

```nib
interface Clock {
	fn hour() -> Int
}

fn greeting(clock: Clock) -> String {
	return clock.hour() < 12 ? "Good morning" : "Good afternoon"
}
```

```nib
test "the morning greeting" {
	let early = new Clock {
		override fn hour() -> Int {
			return 9
		}
	}
	expect greeting(early) == "Good morning"
}
```

`std.testing` provides fakes for the standard library's own interfaces: `FakeClock`,
`FakeSecureRandom`, `FakeUuids`, `InMemoryCache`, `InMemoryRateLimiter` and `RecordingOutbox`. It also has
`FAST_PASSWORD_POLICY`, which hashes passwords in microseconds, so tests that sign in stay
fast.

Code that needs the time, random values or new UUIDs should ask for a `Clock`, a
`SecureRandom` or a `Uuids`, rather than using the system's directly. Then a test can control
them, with `FakeClock`, `FakeSecureRandom` and `FakeUuids`.

## Testing a handler

A web handler is a method, so a test calls it directly. `testing.request` builds a request
for it. A request's session is a handle, so what the handler writes to it can be read back
afterwards:

```nib
import std.http.{Request, Response, SessionKey}

const GREETED = SessionKey<String>("greeted")

fn greet(req: Request) -> Response {
	let name = req.query.get("name") ?? "world"
	req.session.put(GREETED, name)
	return Response.text("Hello, ${name}")
}
```

```nib
import std.http.{Method, Status}
import std.testing

test "a greeting remembers the name" {
	let req = testing.request(Method.Get, "/hello", query: ["name": "Ann"])

	let response = greet(req)

	expect response.status == Status.OK
	expect req.session.get(GREETED) == "Ann"
}
```

A handler's `@guard` value is an ordinary argument when the test calls it, so the test
passes one of its own, such as a `PageContext` for a visitor who isn't signed in. The
request's CSRF token is valid, so a POST handler runs as it would after the router's check.

## Where test code lives

Test code goes where production code can't reach it:

- **In a test file.** A class, function or constant declared in a `.test.nibl` file is
  visible to every test file in the package, and to no other file. Fakes that the
  `orders` module's tests need go in `orders/fakes.test.nibl`. A test in another module can
  use them too.
- **In a test-only module.** A package that offers fakes to other packages lists the
  modules that hold them in its manifest (see [Modules and packages](08-modules.md)).
  `std.testing` is one.

So a fake can't end up in production by mistake. A gateway that approves every charge, or a
random number generator that always gives the same numbers, is only safe in a test:

```nib error
// Rejected: production code can't import a test-only module.
import std.testing.{FakeClock}
import std.time.{Instant}

fn frozenClock() -> FakeClock {
	return FakeClock.at(Instant.EPOCH)
}
```

Within one module, test files share their names, as all the module's files do. So give a
helper a name that wouldn't be used as a parameter: `testUser(…)`, not `user(…)`. Otherwise
the module's other test files can't call a parameter `user` without shadowing it. A test in
another module reaches the helper through its module, as `users.testUser(…)`, so two modules
can each have a `fixture()`.

`expectPanic` and `expect` can only be used in test files.
