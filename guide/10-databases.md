# Databases

`std.db` runs SQL that you write, as `sql"…"` literals, and decodes rows into records. It
works with MySQL (and MariaDB, Aurora MySQL and PlanetScale), Postgres (and Aurora Postgres)
and SQLite. The manifest's `engine` says which one a database is.

## Connections

`env.db("main")` gives a `Db`, backed by a pool of connections that the host owns. Each
call borrows a connection, runs its statement and gives the connection back.

This is the main difference from PHP, where a request opens one connection and keeps it
until the request ends:

- A request that's waiting on another service, such as a payment provider, holds no
  connection meanwhile. So a small pool serves many requests at once.
- Two statements in a row may run on different connections. Nothing that depends on the
  connection, such as a session variable, carries from one call to the next.
- A transaction holds one connection from `begin` until it ends, and everything it runs uses
  that connection. When statements need the same connection, use a transaction.

The pool has 10 connections. A deployment can choose another size by naming a variable in
the manifest:

```toml
[config]
DATABASE_URL = { secret = true }
DATABASE_POOL_SIZE = {}

[databases.main]
engine = "mysql"
from = "DATABASE_URL"
pool-size-from = "DATABASE_POOL_SIZE"
```

- Every instance of the app has its own pool. So the pool size times the number of
  instances has to stay under the database's connection limit.
- When every connection is in use, a call waits up to 5 seconds for one, and then fails
  with `DbError.PoolTimedOut`.

## Migrations

The tables are made and changed by migrations. Each one is a Nib file in the module that
the manifest's `migrations` names, such as `notes.migrations`
([Configuration and resources](15-host.md)). They run in the order of their file names, so
each name starts with a date and a time:

```nib
import std.db.{Db}
import std.migrations.{Migration, MigrationError}

// src/migrations/2026_10_09_0900_create_notes.nibl
record CreateNotes implements Migration {
	override fn apply(db: Db) else MigrationError {
		try db.execute(sql"""
			create table notes (
				id bigint primary key auto_increment,
				text text not null
			)
			""")
	}
}
```

- Each file declares one type that implements `Migration`, which is how the runner finds it.
  `apply` makes the change, and each statement runs as soon as it's called.
- `db.execute` fails with a `DbError`, which `MigrationError` takes with `from`, so `apply`
  says `else MigrationError`.
- A migration runs in one transaction, so one that fails leaves nothing half done. A later
  line can check the work and `fail` with `MigrationError.Check(reason: …)`, which rolls it
  back. A migration whose statements a transaction can't hold, such as Postgres's
  `create index concurrently`, answers `false` for `transactional`.
- Migrations only go forward. To undo one, write another.
- The database records each migration that has run, in a table called `nib_migrations`,
  with a checksum. Editing a migration that has already run is an error.

`nib db migrate` runs the migrations that haven't run yet, then writes the schema they
make to `schema.sql`, beside the manifest. That file is committed, and nobody edits it:

- The compiler reads it to check each `sql"…"` query against the tables, and against the
  records the rows are read into.
- CI checks that it matches what a fresh run of the migrations makes.

## Reading rows

A record marked `@db` says how its fields map to columns:

```nib
import std.db.{@db, Db, DbError}

type NoteId: Int

@db(table: "notes")
record Note {
	id: NoteId
	text: String
}

fn allNotes(db: Db) -> List<Note> else DbError {
	return try db.query<Note>(sql"select id, text from notes order by id")
}

fn findNote(db: Db, id: NoteId) -> Note? else DbError {
	return try db.queryOne<Note>(sql"select id, text from notes where id = ${id}")
}

fn noteCount(db: Db) -> Int else DbError {
	return try db.scalar<Int>(sql"select count(*) from notes")
}
```

- `query` gives every row.
- `queryOne` gives the one row, or `null` when there's none. More than one row is an error.
- `scalar` gives the single value of the single row, such as a count.
- `rows` gives the rows a few at a time, for a table too large to read at once
  ([Streams](14-streams.md#database-rows)).

### Building a query

A search page often has filters that apply only when a field is filled in. A `Sql` inside
another one's `${…}` is pasted in as SQL, so a query can be built from parts:

```nib
import std.db.{Db, DbError, Sql}

record NoteFilter {
	folder: Int?
	after: NoteId?
}

enum NoteOrder {
	Newest
	Oldest

	get sql: Sql => match this {
		NoteOrder.Newest => sql"id desc"
		NoteOrder.Oldest => sql"id asc"
	}
}

fn search(db: Db, filter: NoteFilter, order: NoteOrder) -> List<Note> else DbError {
	var filters: List<Sql> = []
	let folder = filter.folder
	if folder is not null {
		filters.push(sql"folder = ${folder}")
	}
	let after = filter.after
	if after is not null {
		filters.push(sql"id > ${after}")
	}
	return try db.query<Note>(sql"select id, text from notes where ${Sql.and(filters)} order by ${order.sql}")
}
```

- A `Sql` is safe to paste, because its own `${…}` are still sent as parameters. Any other
  value in `${…}` is a parameter, as always.
- `Sql.and(filters)` puts each filter in brackets and joins them with `and`. With no filters
  it's `true`, so the search finds every note. `Sql.or` joins with `or`, and
  `Sql.join(parts, separator:)` joins with anything, such as `sql", "`.
- A parameter can't name a column. So a sort the visitor chooses is an enum whose cases
  each give a fixed `sql"…"`, as `NoteOrder` does.
- Each combination of filters is a different statement, prepared and kept on its own.

## Writing

`execute` runs a statement and gives nothing back:

```nib
import std.db.{Db, DbError}

fn rename(db: Db, id: NoteId, text: String) else DbError {
	try db.execute(sql"update notes set text = ${text} where id = ${id}")
}
```

`insert` writes a record marked `@db` into the table it names, a column for each field:

```nib
import std.db.{@db, Db, DbError}

@db(table: "tags")
record Tag {
	name: String
}

fn addTag(db: Db, tag: Tag) else DbError {
	try db.insert(tag)
}
```

`insert` writes every field, so a record it inserts can't have a field for a column the
database fills in itself, such as an ID it generates or a column it computes. That would be
an error. A record such as `Note`, with its `id`, is a stored row, and there's none until the
database has made the ID. So there are three ways to add one:

- Make the ID in the app, as a UUID ([UUIDs](#uuids)). The record is then complete before
  it's stored, and `insert` writes it.
- Let the database make the ID, and get it back with `insertId` ([The ID of a new
  row](#the-id-of-a-new-row)).
- Declare a second record for what you insert, without the generated fields, beside the one
  you read.

### The ID of a new row

`insertId` runs an insert and gives back the ID that the database generated for the row:

```nib
import std.db.{Db, DbError}

fn addNote(db: Db, text: String) -> NoteId else DbError {
	return try db.insertId<NoteId>(sql"insert into notes (text) values (${text})")
}
```

The ID comes back with the insert itself, so no other request's insert can be mixed up with
it. On Postgres, the compiler adds `returning` for the table's identity column, which it
reads from the schema. A table with no generated ID is a compile error. There's no separate "last insert ID" call, because the next call may run on another
connection.

On Postgres, `returning` also gives back other columns the database fills in, through
`queryOne`:

```nib
import std.db.{Db, DbError}

fn addAndRead(db: Db, text: String) -> Note else DbError {
	return try db.queryOne<Note>(sql"insert into notes (text) values (${text}) returning id, text")
		?? panic("an insert returns its row")
}
```

### How many rows changed

`countChanges` gives the number of rows that an insert, update or delete matched:

```nib
import std.db.{Db, DbError}

fn renameIfUnchanged(db: Db, id: NoteId, from: String, to: String) -> Bool else DbError {
	let changed = try db.countChanges(sql"update notes set text = ${to} where id = ${id} and text = ${from}")
	return changed == 1
}
```

A row counts even when the update sets the value it already had. That's how Postgres counts,
and MySQL connections are set up to count the same way. So a count of 1 means the row was
found.

### When a row already exists

A statement that would give two rows the same value in a unique index fails with
`DbError.Duplicate`, which names the index. Where a duplicate is an answer for the person
rather than a failure, catch it:

```nib
import std.db.{Db, DbError}

enum Renaming {
	Renamed
	NameTaken
}

fn renameTag(db: Db, from: String, to: String) -> Renaming else DbError {
	db.execute(sql"update tags set name = ${to} where name = ${from}") catch err {
		if err is DbError.Duplicate(constraint: "tags_name_key") {
			return Renaming.NameTaken
		}
		fail err
	}
	return Renaming.Renamed
}
```

- Checking first, with a `select`, isn't enough: another request can take the name between
  the check and the update. The unique index is what decides, so its error is the answer.
- `constraint` is the index's name, as the schema declares it, on every engine.
- An insert that should do nothing when the row exists says so in the statement instead,
  with `on conflict do nothing`, and nothing fails.
- On Postgres, a transaction can't run another statement after this error. Return from the
  function, so its deferred rollback runs, or run the statement in a savepoint, with
  `tx.begin()`, to carry on.
- Other refusals, such as a foreign key that points nowhere, are `DbError.Rejected`, with the
  database's own code.

### Many rows

A statement run in a loop is prepared once on each connection, and after that only its
values are sent:

```nib
import std.db.{Db, DbError}

fn addAll(db: Db, texts: List<String>) else DbError {
	let tx = try db.begin()
	defer tx.rollback()
	for text in texts {
		try tx.execute(sql"insert into notes (text) values (${text})")
	}
	try tx.commit()
}
```

The transaction makes the loop fast as well as all or nothing. Without one, each insert is
committed, and written to disk, by itself.

To insert records, `insertAll` writes several hundred rows to a statement, which is much
faster still. Either every row is inserted or none is:

```nib
import std.db.{Db, DbError}

fn addTags(db: Db, tags: List<Tag>) else DbError {
	try db.insertAll(tags)
}
```

## Transactions

A transaction is begun, its rollback is deferred, and it's committed at the end:

```nib
import std.db.{Db, DbError}

fn moveNote(db: Db, id: NoteId, toFolder: Int) else DbError {
	let tx = try db.begin()
	defer tx.rollback()
	try tx.execute(sql"update notes set folder = ${toFolder} where id = ${id}")
	try tx.execute(sql"update folders set count = count + 1 where id = ${toFolder}")
	try tx.commit()
}
```

- `rollback()` does nothing after `commit()`, so deferring it is always safe. It undoes the
  work when anything fails, or when the function returns before committing.
- A `Tx` is a `Db`, so a function that takes a `Db` works inside a transaction without
  knowing.
- `begin()` on a `Tx` starts a savepoint, which commits or rolls back on its own.
- The checker warns about a transaction that's begun but never committed, or that has no
  `defer tx.rollback()`.

`begin(isolation: Isolation.Serializable)` asks for the strictest isolation. With nothing
given, the database's own default is used: repeatable read on MySQL, and read committed on
Postgres.

### When transactions clash

Two transactions can clash: in a deadlock, or when a serializable transaction can't be kept
apart from another. The database rolls one back, and it fails with `DbError.Conflict`.
Running the whole transaction again usually succeeds:

```nib
import std.db.{Db, DbError}

fn moveWithRetries(db: Db, id: NoteId, toFolder: Int) else DbError {
	for attempt in 1..3 {
		moveNote(db, id, toFolder) catch err {
			if err is DbError.Conflict and attempt < 3 {
				continue
			}
			fail err
		}
		return
	}
}
```

### Messages that go with a transaction

A message published to a queue can belong to a transaction. `queue.within(tx)` gives an
`Outbox`, whose messages are delivered only if the transaction commits:

```nib
import std.db.{Db, DbError}
import std.json.{@json}
import std.queue.{DurableQueue, QueueError}

@json
record NoteAdded {
	id: NoteId
}

enum AddError implements Error {
	Database(from DbError)
	Queue(from QueueError)

	override get message: String => match this {
		AddError.Database => "saving the note failed"
		AddError.Queue => "queueing the note's message failed"
	}
}

fn addAndAnnounce(db: Db, added: DurableQueue<NoteAdded>, text: String) -> NoteId else AddError {
	let tx = try db.begin()
	defer tx.rollback()
	let id = try tx.insertId<NoteId>(sql"insert into notes (text) values (${text})")
	try added.within(tx).publish(NoteAdded(id:))
	try tx.commit()
	return id
}
```

- A rollback discards the message. So no one is told about a note that was never saved.
- Publishing straight to the queue, outside the transaction, could send the message and
  then lose the note, or save the note and lose the message.

### Keeping transactions out of the rules

Code that holds a business's rules, such as signing up, needs its changes to commit
together, but it needn't know about `Tx` or SQL. The shop gives it an interface instead,
which lists what one piece of work can touch and has `commit` and `rollback`:
[`users/work.nibl`](../examples/shop/src/users/work.nibl). A class in the storage code
implements it with one transaction
([`storage/work.nibl`](../examples/shop/src/storage/work.nibl)), and the tests implement
it in memory ([`users/fakes.test.nibl`](../examples/shop/src/users/fakes.test.nibl)).

This is a pattern, often called a unit of work, and not part of the language. The rules
write `work.users.saveCredentials(…)` and `work.outbox.publish(…)`, then `work.commit()`.

## Encrypted columns

A field marked `@db(encrypt: "pii")` is stored encrypted, with the keyring called `pii`. An
encrypted column can't be searched, so a field you look things up by, such as an email
address, has a blind index as well: a keyed hash of the value, stored in a column of its
own.

```nib
import std.crypto.{BlindIndex}
import std.db.{@db, Db, DbError}

const CUSTOMER_EMAIL = BlindIndex(name: "customers.email", column: "email_idx", keyring: "pii")

@db(table: "customers")
record Customer {
	id: Int

	@db(encrypt: "pii", blindIndex: CUSTOMER_EMAIL)
	email: String

	@db(encrypt: "pii")
	phone: String
}

fn findCustomer(db: Db, email: String) -> Customer? else DbError {
	let index = try db.blindIndex(CUSTOMER_EMAIL, email)
	return try db.queryOne<Customer>(sql"select id, email, phone from customers where email_idx = ${index}")
}
```

- The keyring is attached to the database where the program starts, with
  `db.withKeyring("pii", keyring)`. `Keyring.parse` reads it from a secret, so a bad key
  stops the program before it takes a request.
- Reading a row decrypts its encrypted fields. `insert` encrypts them, and writes each blind
  index to its column.
- A lookup hashes the value it's looking for with `db.blindIndex`, and matches the index
  column, as `findCustomer` does. The same value always gives the same hash, so a unique
  constraint on the index column works too.
- An insert or update written by hand has no record to take the attributes from, so it
  encrypts the value itself, with `db.encrypt(value, keyring: "pii")`, and hashes it with
  `db.blindIndex`.
- A blind index is only for a field that's encrypted, so the field says both.
- The index's `name` is part of every hash, so it never changes. Its `column` can be renamed
  in a migration.

```nib error
// Rejected: a blind index is for an encrypted column, so the field says `encrypt` as well.
import std.crypto.{BlindIndex}
import std.db.{@db}

const MEMBER_EMAIL = BlindIndex(name: "members.email", column: "email_idx", keyring: "pii")

@db(table: "members")
record Member {
	@db(blindIndex: MEMBER_EMAIL)
	email: String
}
```

The shop keeps its users' email addresses this way:
[`users/user.nibl`](../examples/shop/src/users/user.nibl) declares the field, and
[`storage/users.nibl`](../examples/shop/src/storage/users.nibl) looks users up and writes
them.

## UUIDs

An auto-increment integer is a good key inside the database. An ID that other systems see,
such as in a URL or an API, is better as a UUID. A UUID can be made before the row is
inserted, and it doesn't show how many rows there are:

```nib
import std.uuid.{Uuid, Uuids}

type OrderId: Uuid

fn newOrderId(uuids: Uuids) -> OrderId {
	return OrderId(uuids.next())
}
```

- `uuids.next()` makes a version 7: the time, then random bits. As a key, it adds to the
  end of an index, where a random key would scatter writes through it.
- A version 7 shows when it was made. When that mustn't show, use `uuids.random()`, a
  version 4.
- `Uuid.v5(namespace:, name:)` gives the same UUID for the same name every time.
- Versions 1, 2, 3, 6 and 8 can be made too, for systems that already use them. Versions 1,
  2 and 6 take the node to use, so a UUID never reveals the machine it was made on.
- `Uuid.parse` reads any version, and `uuid.version` says which one it is.

Code is given a `Uuids` (`env.uuids`), as it's given a `Clock`. A test uses `FakeUuids`,
which makes the same UUIDs in every run ([Testing](12-testing.md)).

A database stores a UUID in a `uuid` column on Postgres, and in a `binary(16)` column on
MySQL. JSON and forms write it as text, such as `0192f3a4-7b1c-7d2e-9f3a-5b6c7d8e9f0a`.
