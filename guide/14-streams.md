# Streams

A stream is data that's read a piece at a time, as it's needed: rows from a database, the
lines of a large file, an upload as it arrives. Nothing in the stream is read until something
asks for it, so a stream of any length fits in memory.

## Streams are `Iterable`

There's no separate stream type. A stream is an `Iterable`, read with `for`, like a list:

```nib
import std.db.{@db, Db, DbError}

@db
record OrderIdRow {
	id: Int
}

fn countOrders(db: Db) -> Int else DbError {
	var count = 0
	for row in try db.rows<OrderIdRow>(sql"select id from orders") {
		count++
	}
	return count
}
```

- Each row is fetched when the loop reaches it.
- A stream can fail partway, as a database connection can. Its type says so:
  `db.rows` gives an `Iterable<OrderIdRow, DbError>`.
- `for row in try source` passes such a failure on. The `try` covers every step of the loop,
  not only the call.
- Reading only as fast as the loop asks also means a slow consumer slows the producer down,
  rather than filling memory.

### Working on a stream

`map`, `filter`, `take` and `batched` work on any `Iterable`, and give another one without
reading anything. The work happens as the result is read:

```nib
import std.db.{Db, DbError}

fn bigOrderIds(db: Db) -> Iterable<Int, DbError> {
	return db.rows<OrderIdRow>(sql"select id from orders").map(fn(row) => row.id).take(100)
}
```

- `batched(500)` gives lists of 500 items (the last may be shorter), for saving or sending a
  batch at a time.
- A `List` has its own `map` and `filter`, which work at once and give a `List`. Their
  function can fail, and the call then fails with it.
- On any other `Iterable`, the function runs later, while the result is read, so it can't
  fail. Collect the items with `toList()` first, or write a generator that uses `try`:

```nib error
// Rejected: `map` on a stream is lazy, so its function can't fail.
import std.db.{Db, DbError}

fn prices(db: Db) -> Iterable<Int, DbError> {
	return db.rows<OrderIdRow>(sql"select id from orders").map(fn(row) => try Int.parse("${row.id}"))
}
```

### Database rows

A loop over `db.rows` can run other statements on the same `db`:

- The rows are the ones the query matched when it started. A row the loop updates comes
  back as it was, if it hasn't come back already.
- The stream holds a database connection until the loop ends, even when it ends early.
- Inside a transaction, the loop's statements share that connection, and they're part of
  the transaction.
- Outside one, each statement borrows another connection from the pool and commits on its
  own. Begin a transaction when they must succeed or fail together.

A stream that waits for a second connection while holding one can use up the pool. When no
connection comes back in time, a call fails with `DbError.PoolTimedOut`.

## Streams of bytes

A stream of bytes is an `Iterable<Bytes, IoError>`. Each item is the next chunk. These give
one:

- `req.body.stream()`: a request body as it arrives;
- `dir.open(path)`: a file;
- the body of a response from the HTTP client.

Functions that read a stream of bytes and give another stream turn one form into another:

| Function | Reads | Gives |
|----------|-------|-------|
| `gzip.decompressing` | gzip data | the bytes inside |
| `gzip.compressing` | bytes | gzip data |
| `io.lines` | UTF-8 text | each line, as a `String` |
| `csv.decoding<T>` | CSV with a header row | each row, as a `T` |
| `csv.encoding` | records | CSV, a header row first |
| `json.decodeEach<T>` | a JSON array, or one value per line | each value, as a `T` |
| `json.events` | JSON | each token |

They nest, so a large compressed upload can go into the database without ever being held
in memory:

```nib
import std.compress.gzip
import std.csv with {@csv, CsvError}
import std.db.{@db, Db, DbError}
import std.http.{Request}

@csv
@db(table: "sales")
record SaleRow {
	sku: String
	quantity: Int
}

enum ImportError implements Error {
	Csv(from CsvError)
	Database(from DbError)

	override get message: String => "couldn't import the sales"
}

fn importSales(req: Request, db: Db) -> Int else ImportError {
	let rows = csv.decoding<SaleRow>(gzip.decompressing(req.body.stream()))
	var count = 0
	for row in try rows {
		try db.insert(row)
		count++
	}
	return count
}
```

A byte stream is read with `for`. There's no `Reader` type with a buffer to fill.

## Writing

Bytes are written through a `Writer`, such as a file from `dir.create(path)`:

```nib
import std.files.{Dir, FileError}
import std.io.{IoError}

enum SaveError implements Error {
	Files(from FileError)
	Io(from IoError)

	override get message: String => "couldn't save the report"
}

fn saveReport(dir: Dir, lines: List<String>) else SaveError {
	let out = try dir.create(path"report.txt")
	for line in lines {
		try out.write("${line}\n".toBytes())
	}
	try out.close()
}
```

- `write` waits while the other end is slow, so memory stays flat.
- **`close` finishes the write**, like committing a transaction. A file appears only when
  `close` succeeds; until then it's written under a temporary name.
- `close` is also where a last failure can show up, such as a full disk, so it's called
  with `try`.
- A writer that is never closed is discarded when the request or job ends: the file isn't
  created, and the host logs a warning. So a half-written file can't appear by accident. The
  checker warns about a writer that's never closed.

A long download is written the same way, with `Response.stream`:

```nib
import std.csv
import std.http.{BodyWriter, Response}
import std.io.{IoError}

enum ExportError implements Error {
	Io(from IoError)

	override get message: String => "couldn't send the export"
}

fn export(rows: List<SaleRow>) -> Response {
	return Response.stream(contentType: "text/csv", write: fn(out: BodyWriter) else ExportError {
		for chunk in csv.encoding(rows) {
			try out.write(chunk)
		}
	})
}
```

The host calls the closure, and sends the status and headers with the first chunk. So a
failure before anything is written, such as a database that can't be reached, is a `500`,
as it is for a handler. A failure after that can't change the status, which has been sent.
The connection is broken off instead, so the client sees a failed download rather than a
short one. The failure is logged either way.

An export that must arrive whole, or not at all, is better built first and then sent, or
made by a background job that emails a link when it's ready.

## Standard input and output

A command-line program reads standard input from `env.stdin`, a stream of bytes like any
other. It writes to `env.stdout` and `env.stderr`, which are `Writer`s:

```nib
import std.app.{Env}
import std.io with {IoError}

pub fn main(env: Env) -> Int else IoError {
	var count = 0
	for line in try io.lines(env.stdin) {
		try env.stdout.writeLine(line.toUpperCase())
		count++
	}
	if count == 0 {
		try env.stderr.writeLine("Nothing to shout: standard input was empty.")
		return 1
	}
	return 0
}
```

- A write to standard output goes out at once. There's no commit step, and `close` only
  flushes.
- Messages for the person running the program go to `env.stderr`, so a pipe carries only the
  output.
- `main` can return a number, the exit code.
- `env.workingDir()` is the directory the program was started in, so a path typed on the
  command line can be opened with `resolveWithin`. A server has no working directory.

When the columns aren't known in advance, `csv.decodingRows` gives each row as a
`List<String>`, and `csv.encodingRows` writes rows back. `json.encode` writes any codable
value, such as a `Map<String, String>`, and `json.events` reads JSON of any shape a token at a
time.

## Closing what you open

A file, or anything else opened by a function marked `@opens`, belongs to the request or job
that opened it. In a command-line program, it belongs to the run of `main`. When that ends,
the host closes it, however it ends: normally, with a failure, or cancelled. So a forgotten
`close` can't leak past the request.

Call `close()` to release something sooner. That matters in a loop, which could otherwise
open many files before the request ends:

```nib
import std.files.{Dir, Path}
import std.io

fn countLines(dir: Dir, paths: List<Path>) -> Int else SaveError {
	var count = 0
	for path in paths {
		let file = try dir.open(path)
		defer file.close()
		for line in try io.lines(file) {
			count++
		}
	}
	return count
}
```

Opening something in a loop without closing it in the loop is a warning.

## Generators

A generator is a function that produces a stream. Its body uses `yield` to give each item,
and runs only as the items are read:

```nib
fn evens(limit: Int) -> Iterable<Int> {
	var n = 0
	while n <= limit {
		yield n
		n += 2
	}
}
```

- A function whose body uses `yield` is a generator. It returns an `Iterable<T>`.
- The body runs until the next `yield`, then pauses until the next item is asked for.
- `return` ends the stream, without a value.
- A generator that can fail partway returns an `Iterable<T, E>`. Its `try` and `fail` end the
  stream with an `E`, which reaches the reader's `for … in try`.
- If the reader stops early, the generator's `defer`s still run.
- A closure can't be a generator. Write a function at the top level that yields.

```nib error
// Rejected: a generator gives its items with `yield`, and `return` ends it without a value.
fn countdown(count: Int) -> Iterable<Int> {
	yield count
	return 0
}
```

A generator is the way to change a stream in ways `map` and `filter` can't, such as turning
one kind of failure into another:

```nib
import std.db.{Db, DbError}

enum StoreError implements Error {
	Database(from DbError)

	override get message: String => "couldn't read the store"
}

fn orderIds(db: Db) -> Iterable<Int, StoreError> {
	for row in try db.rows<OrderIdRow>(sql"select id from orders") {
		yield row.id
	}
}
```

Here `try` converts each `DbError` into a `StoreError` through its `from` variant, as it
would in an ordinary function.

## Channels

To pass values between tasks in one block, such as a producer and a consumer, use a
`Channel` from `std.channels`. It holds a limited number of values: `send` waits while it's
full, and a `for` loop over it receives until it's closed. Between instances, messages go
through queues instead.
