# Concurrency

## No `async`

Any function can wait: on the database, an HTTP call, a file. While it waits, the runtime
runs other work, and nothing in the code says so. There's no `async`, no `await`, and no
split between functions that wait and functions that don't. `db.query(…)` and
`http.get(…)` are ordinary calls.

To wait for a length of time, call `sleep` on a `Clock`: `clock.sleep(Duration.of(seconds: 2))`.
Other tasks run meanwhile. In a test, a `FakeClock` moves forward instead of waiting, so a test
of retries runs instantly.

Within one instance of an app, tasks take turns on one thread. They switch only when one
waits on I/O, so two tasks never change memory at the same moment, and there are no locks.

A web app does several things at the same instant by running many instances, which share
nothing.

## `start`

`start` begins a call and carries on straight away. The result has the call's own type,
and reading it waits until the call has finished:

```nib
interface Rates {
	fn shipping(postcode: String) -> Decimal else RateError
	fn tax(postcode: String) -> Decimal else RateError
}

enum RateError implements Error {
	Unavailable

	override get message: String => "the rates service is unavailable"
}

fn costs(rates: Rates, postcode: String, subtotal: Decimal) -> Decimal else RateError {
	let shipping = start rates.shipping(postcode)
	let tax = start rates.tax(postcode)
	return subtotal + try shipping + try tax
}
```

Both calls run at the same time. Reading `shipping` waits for it, and because the call can
fail, the read takes a `try`, as the call would have.

The rules that keep this safe:

- **A task belongs to its block.** The block can't end until its tasks have finished.
- **Leaving early cancels.** If the block ends early (a `try` that fails, a `fail`, a
  `return`), its unfinished tasks are cancelled. Above, if `shipping` fails, `tax` is
  cancelled.
- **An unfinished task can't escape.** Passing a task to a function, returning it or
  capturing it in a closure all read it, and reading waits for it to finish. So a task never
  outlives its block.
- **A started result must be read.** Leaving one unread is an error. To run a call only for
  its effect, write `let _ = start …`; the block then waits for it at its end.
- **Tasks end before `defer`s run**, so `defer tx.rollback()` can't pull a transaction out
  from under a running task.

```nib error
// Rejected: `tax` is started but never read, so its result and any failure would be lost.
fn forgotten(rates: Rates) else RateError {
	let tax = start rates.tax("NG1 1AA")
}
```

There's no fire-and-forget task. Work that must outlive the request goes on a queue. For
small, best-effort work after a response, such as sending an analytics event, a response
carries it with `onSent`: it runs only if the response is sent. Its work can't fail, so it
handles its own failures, usually by logging them.

## Many at once

To call something for every item in a list, with a limit on how many run at once:

```nib
fn allShipping(rates: Rates, postcodes: List<String>) -> List<Decimal> else RateError {
	return try postcodes.mapConcurrently(limit: 5, each: fn(postcode) => try rates.shipping(postcode))
}
```

When all the calls have finished, the results come back in the list's order. If one fails,
the calls still running are cancelled, and the whole call fails.

## Channels

To pass values between tasks in one block, such as a producer and a consumer, use a
`Channel<T>` from `std.channels`:

```nib
import std.channels.{Channel, ChannelError}
import std.files.{Dir, FileError, Path}
import std.io with {IoError}

enum CountError implements Error {
	Files(from FileError)
	Io(from IoError)
	Stopped(from ChannelError)

	override get message: String => "couldn't count the errors in the log"
}

fn readLines(dir: Dir, path: Path, out: Channel<String>) else CountError {
	defer out.close()
	for line in try io.lines(try dir.open(path)) {
		try out.send(line)
	}
}

fn countErrors(dir: Dir) -> Int else CountError {
	let lines = Channel<String>.bounded(capacity: 100)
	let reader = start readLines(dir, path"app.log", lines)
	var errors = 0
	for line in lines {
		if line.contains("ERROR") {
			errors++
		}
	}
	try reader
	return errors
}
```

- A channel holds a limited number of values, set by `capacity`.
- `send` waits while the channel is full. So a fast producer can't fill memory ahead of a
  slow consumer.
- `receive` waits while the channel is empty, and gives `null` once it's closed and empty.
- A `for` loop over a channel receives until it's closed and empty.
- `send` fails with `ChannelError.Closed` if the channel has been closed.
- The producer closes the channel when it's done, here with `defer`, so the consumer's loop
  ends even if reading fails.
- `try reader` reads the task, which passes on any failure the producer had.

Between instances, messages go through queues.

## Cancellation

A request is cancelled:

- when its deadline passes;
- when the client goes away, but only for a request that just reads: `GET`, `HEAD`, event
  streams and WebSockets.

A request that changes something (`POST`, `PUT`, `PATCH`, `DELETE`) keeps running to the end
if the client goes away, within its deadline. So a checkout that has charged a card isn't
stopped before it saves the order.

Cancellation isn't an error value, and it can't be caught. It takes effect the next time the
task waits. Then every block ends as if it had returned early:

- the block's own tasks are cancelled;
- both `defer` and `defer else` run, so partial work is undone.

A long calculation that never waits isn't interrupted. The instance's time limit stops it
instead.

Work that must finish whatever happens goes on a queue.
