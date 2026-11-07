# Checks waiting for the type stage

Agreed rules that the checker can't enforce yet, because they need types, argument
matching or a formatter. When the checker gains the ability, implement the rule, add a test
case in `test/cases`, and remove it from this list. When a new decision is agreed whose rule
the checker can't enforce yet, add it here.

The list was started in round 64; older decisions haven't been swept into it yet, so
`design/decisions-log.md` stays the full record.

## Types

- **No error text for people (#229).** An `Error`'s `message` never flows into an
  `html"…"` literal, a response body or a form's `explaining`; it's for logs only. The
  checker catches `.message` written straight into an `html"…"` literal or `explaining`;
  following it through locals, functions and response bodies needs data flow.
- **Error causes (#228).** A `from` payload from a dependency implements `Error` (the
  checker can only see this package's and the stdlib's types). The compiler writes `cause`
  for an enum that implements `Error`.
- **Revealed secrets (#240).** A secret's `revealed` text never reaches a log or a plain
  string. The checker catches `.revealed` written straight into `${…}` in a plain or
  `html"…"` literal, or into a log call's arguments; following it through a `let` or a
  function needs data flow.
- **Literal dates and times (#306).** `Date.of` and `Time.of` with literal arguments name a
  day and a time that exist: `Date.of(year: 2026, month: Month.February, day: 30)` is an
  error. With other arguments they panic at run time. `Currency.of("GBX")` (#321) likewise
  names a current ISO 4217 code.

- **Negated pairs (#6d, #148).** `not x.isEmpty` is written `x.isNotEmpty`, and
  `not x.contains(y)` is `x.doesNotContain(y)`, when the type declares the negated member.
  Needs member types, which the checker has; not yet written.

- **Generated IDs (#309).** `db.insertId` runs an `insert` into a table whose schema has a
  generated key (`auto_increment`, an identity column, an SQLite rowid); otherwise it's an
  error. Needs the schema.

- **Duplicate rows (#344).** A pattern `DbError.Duplicate(constraint: "…")` with a literal
  names a unique index or primary key the schema declares; a misspelt one never matches.
  Needs the schema.

- **Inserting generated columns (#343).** `db.insert(row)` and `db.insertAll(rows)` refuse a
  record with a field for a column the database generates: an identity, `serial` or
  `auto_increment` key, or a computed column (`generated always as (…)`). The message names
  the ways round it: make the ID in the app, use `insertId` with SQL, or insert a record
  without those fields. A column with a default isn't generated. Needs the schema.

- **Resources (#249).** A writer never closed is discarded at the end of the unit of work,
  and something used after `close()` panics: both at run time. The checker warns about the
  cases it can see: a writer that's never closed, and something opened in a loop without a
  `close()` in it.

## Build

- **Queue addresses (#219).** Each address's name matches a queue the deployment binds.

## Formatter

- **Width (#145, #245).** A signature stays on one line within 120 columns; otherwise one
  parameter per line, with a trailing comma. The checker already warns about lines over 120
  and rejects lines over 150, counting a tab as four.
- **Label order (#232).** Labelled arguments are rewritten into the parameters' declared
  order. The checker accepts any order.

## Use

- **Unused parameters.** A parameter the body never reads is named `_`, and a handler that
  never reads the request leaves it out (#328). The checker doesn't record whether a
  parameter is read, so a handler's unread `req` isn't caught (it does reject `_: Request`).
  An implementing member's `named` parameters keep the interface's names, so they're exempt.
