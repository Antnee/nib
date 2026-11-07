# Attributes and secrets

## Attributes

An attribute is metadata on a declaration, a field or a parameter, written before it:

```nib
import std.codec.{Case}
import std.json.{@json}

@json(keys: Case.Snake)
record Quote {
	postcode: String
	totalPence: Int
	@json(key: "eta")
	arrivesIn: Int
}
```

- An attribute is imported like a type, with `@`: `import std.json.{@json}`. The compiler's
  own (below) are in the prelude.
- Its arguments are named, and each is a constant, written the same way as anywhere else:
  `Case.Snake`, not a bare `snake`.
- Attributes without arguments can share a line: `@json @sensitive`. An attribute with
  arguments goes on its own line.
- An attribute never changes behaviour on its own. The compiler, codecs and tools read it
  when the code is compiled. Nothing can read it while the program runs, because there's no
  reflection.

You can declare your own, with typed fields, so its uses are checked:

```nib
attribute audited {
	reason: String
	retainDays: Int = 365
}

@audited(reason: "payments")
record Refund {
	amount: Decimal
}
```

Each argument names one of the fields and holds a value of its type:

```nib error
// Rejected: `retainDays` holds an `Int`, and this is a `String`.
@audited(reason: "payments", retainDays: "a year")
record Chargeback {
	amount: Decimal
}
```

### Codecs

Turning a type into JSON, form fields, CSV or database rows is opt-in, one format at a time:

| Attribute | Module | Makes the type |
|-----------|--------|----------------|
| `@json` | `std.json` | `Codable<JsonCodec>` |
| `@form` | `std.forms` | `Codable<FormCodec>` |
| `@csv` | `std.csv` | `Codable<CsvCodec>` |
| `@db` | `std.db` | `Codable<DbCodec>` |

An API says which codec it needs: `Response.json<T: Codable<JsonCodec>>(value: T)`. So a
record that holds a password hash, and is marked only `@db`, can't be sent as JSON by
mistake.

A field is stored under exactly its own name, as a JSON key or a column, unless:

- the type sets a naming rule, such as `keys: Case.Snake` or `columns: Case.Snake`; or
- the field gives its own name: `@json(key: "eta")`.

Every field's type must be one the codec can write:

- numbers, `Bool`, `String`, `Bytes` and backed enums;
- the stdlib's value types, such as `Instant`, `Date`, `Duration` and `Url`;
- a type marked with the same codec's attribute;
- `T?`, `List<T>`, `Set<T>` and `Map<K, V>` of those;
- a distinct type whose base is one of those. It's written as its base. If it has a
  `private` constructor, it's read back through its own `parse`, so it must implement
  `Parseable`, and decoding can't skip its validation.

These types can be encoded on their own too, not only as fields. So
`json.encode(["sku": "TEA-01"])` writes a JSON object.

### Enums in JSON

A `@json` enum with payloads is written as an object. The key `"type"` holds the variant's
name, and the payload's fields sit beside it:

```nib
import std.json.{@json}

type UserId: Int

@json
enum EmailJob {
	ConfirmEmail(userId: UserId)
	ResetPassword(userId: UserId)
}
```

`EmailJob.ConfirmEmail(userId: 7)` is written as `{"type": "ConfirmEmail", "userId": 7}`.

- A variant without a payload is an object too: `{"type": "SignUpSubmitted"}`. So a field
  can be added to it later without changing its shape.
- `@json(variants: Case.Snake)` changes how the names are written, so `ConfirmEmail` becomes
  `"confirm_email"`. `keys:` still applies to the fields.
- `@json(tag: "kind")` uses another key instead of `"type"`. A field written under the same
  key as the tag is an error.
- Reading an object whose tag is missing, or names no variant, fails with a `JsonError`.
- A `from` variant can't be written, because its payload has no fields to sit beside the
  tag:

```nib error
// Rejected: `Storage` wraps a value with `from`, so it has no fields to write.
import std.json.{@json}

enum StorageError implements Error {
	Lost
}

@json
enum Outcome {
	Done
	Storage(from StorageError)
}
```

### Storing a field another way

A `@db` field can say how it's stored instead. `@db(embed: true, prefix: "total_")` stores a
record across several columns, one for each of its fields, so `total: Money` becomes
`total_amount` and `total_currency`; then each of `Money`'s fields must be storable, and
`Money` needs no `@db` of its own. `@db(json: true)` stores the value as JSON in one column,
so its type must be `@json`. `@db(encrypt: "pii")` stores it encrypted
([Encrypted columns](10-databases.md#encrypted-columns)).

Some stdlib types work with only some codecs. A `PasswordHash` can be stored in the
database, but it can't be written as JSON, so it can't be sent out by mistake:

```nib error
// Rejected: a `PasswordHash` can't be written as JSON.
import std.crypto.passwords.{PasswordHash}
import std.json.{@json}

@json
record AccountExport {
	passwordHash: PasswordHash
}
```

A web session is a codec too, for small values: what it can hold is in
[the web chapter](09-web.md#sessions).

Third-party codecs work the same way, through `std.codec`.

### The compiler's attributes

| Attribute | Checked |
|-----------|---------|
| `@pure` | the function does no I/O and changes nothing; an error if it does |
| `@deprecated(since:, use:)` | using it is a warning that names the replacement |
| `@callerLocation` | on a `SourceLocation` parameter: the compiler passes the caller's location |
| `@sensitive` | the type is a secret: see below |
| `@opens` | the function opens something, such as a file; opening it in a loop without closing it is a warning (see [Streams](14-streams.md)) |

`std.log` adds `@loggable`, which lets a record or class of your own go into a log whole
([Where logs go](15-host.md#where-logs-go)).

`std.http` adds `@guard` and `@path`, which mark where a route handler's parameters come
from.

## Secrets

A password, an API key or a token must never end up in a log, an error page or a telemetry
service by accident, but code still has to hash it, check input against it and send it to
other services. A type marked `@sensitive` is a secret:

```nib
@sensitive
type Password: private String implements Parseable {
	override static fn parse(text: String) -> Password else PasswordError {
		if text.length < 12 {
			fail PasswordError.TooShort
		}
		return Password(text)
	}
}

enum PasswordError implements Error {
	TooShort

	override get message: String => "shorter than 12 characters"
}
```

A secret:

- shows as `[redacted]` in logs, panic reports and debug output, and forms never send one
  back to the browser;
- isn't `Stringable`, so it can't go into `${…}`;
- doesn't convert to its base type, and has none of its base's members, so
  `let text: String = password` and `password.length` are errors;
- is compared with `==` in the same time wherever two differ, so the time taken doesn't
  show how much of a guess was right.

```nib error
// Rejected: a secret can't go into a plain string.
fn leak(password: Password) -> String {
	return "the password is ${password}"
}
```

Every `@sensitive` type implements the prelude's `Sensitive` interface, and the functions
that use secrets take a `Sensitive`, so the app passes a secret on without ever reading it:

```nib
import std.crypto.passwords with {PasswordHash}

fn store(password: Password) -> PasswordHash {
	return passwords.hash(password)
}
```

`passwords.hash(password)` uses the recommended policy. An app that chooses its own, as the
shop does, passes it: `passwords.hash(password, policy)`.

When text has to be built around a secret, such as an `Authorization` header, a
`secret"…"` literal gives a new secret, not a `String`:

```nib
import std.app.{Env}
import std.http.{ApiClient, Url}

fn paymentsApi(env: Env, base: Url, apiKey: Secret) -> ApiClient {
	return env.http.client(base:, authorization: secret"Bearer ${apiKey}")
}
```

A link or a page that holds a secret is a secret too. `secret url"…"` and `secret html"…"`
follow the rules of `url"…"` and `html"…"`, take secrets in their `${…}`, and give a
`Secret<RelativeUrl>` (or `Secret<Url>`) and a `Secret<Html>`. A plain `Secret` holds text.
`Url.join` takes secret query values with the label `secretQuery`, and gives a `Secret<Url>`:

```nib
import std.crypto.{Token}
import std.html.{Html}
import std.http.{Url}

fn confirmLink(base: Url, token: Token) -> Secret<Url> {
	return base.join(url"confirm", secretQuery: ["token": token])
}

fn confirmButton(link: Secret<Url>) -> Secret<Html> {
	return secret html"<a href=\"${link}\">Confirm your email</a>"
}
```

```nib error
// Rejected: the token would make the link an ordinary value, which a log could show.
import std.crypto.{Token}
import std.http.{RelativeUrl}

fn confirmPath(token: Token) -> RelativeUrl {
	return url"confirm?token=${token}"
}
```

`secret` only means this directly before a tagged string, so it can still name a variable.

There's one way out: `revealed` gives the secret's text. It's for handing a secret to code
that only takes a `String`, such as another library.

- Every place a secret leaves its type can be found by searching for that one word.
- Writing `revealed` straight into a log call or a plain string is an error.

Two secrets compared with `==` take the same time wherever they differ. So checking an API
key a request sends against the configured one, `sent == config.apiKey`, doesn't reveal how
much of a guess was right.

As with any values, two secrets of different types are never equal, so `==` between them is
an error. To compare their text, as a password with its confirmation, use `matches`, which
also takes the same time wherever they differ: `password.matches(confirmation)`.

A secret that arrives from outside, such as a token in an emailed link, is read straight
into its type, so it's a secret from the start: `Token.parse(text)`, or a form field typed
`token: Token`.

A secret never goes into a page. When a link's token is needed again by the form it leads
to, keep it in the session, as its hash, and load the page again without the token in its
address:

```nib
import std.crypto.{Token, TokenHash}
import std.http.{Request, Response, SessionKey, Status}

const RESETTING_PASSWORD = SessionKey<TokenHash>("resettingPassword")

fn showResetPassword(req: Request) -> Response {
	let text = req.query.get("token")
	if text is not null {
		let token = Token.parse(text) catch _ {
			return Response.text("That link isn't valid.", status: Status.GONE)
		}
		req.session.put(RESETTING_PASSWORD, token.hash)
		return Response.redirect(url"/reset-password")
	}
	return Response.text("Choose a new password.")
}
```

The form's handler reads the hash back with `req.session.get(RESETTING_PASSWORD)`. The
token is in the address bar for one request only, and the session never holds the token
itself.
