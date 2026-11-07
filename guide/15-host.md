# Configuration and resources

A program gets everything from outside through `Env`: configuration, such as an API key, and
named resources, such as a database. The package's manifest, `nib.toml`, lists every one of
them. So the compiler can check each name the code asks for, and the host can check a
deployment before the program starts.

## Declaring what a program needs

```toml
[config]
BASE_URL = {}
SMTP_PORT = {}
API_KEY = { secret = true }
DATABASE_URL = { secret = true }
EXPORT_DIR = {}

[databases.main]
engine = "postgres"
from = "DATABASE_URL"

[queues.emails]
database = "main"

[directories.exports]
access = "write"
from = "EXPORT_DIR"

[files.assets]
path = "assets"
```

`[config]` lists the configuration variables. Each environment sets them: a server's host
from its own settings, and a developer's machine from a `.env` file. A variable marked
`secret = true` holds something that must stay out of logs.

Each resource says where it comes from with `from`, which names a variable from `[config]`.
So the manifest never holds a password or an address, and the same manifest works in every
environment.

| Section | Declares | Settings |
|---------|----------|----------|
| `[config]` | configuration variables | `secret`, if it must stay out of logs |
| `[databases.NAME]` | a database pool | `engine` (`"postgres"`, `"mysql"` or `"sqlite"`), `from`, `migrations`, the module that holds them, and `pool-size-from`, a variable holding the pool's size ([Databases](10-databases.md#connections)) |
| `[queues.NAME]` | a durable queue | `from`, a variable holding the queue's URL; or `database`, to keep it in a database |
| `[caches.NAME]` | a cache shared by every instance, `env.cache(name)` | `from`, a variable holding the store's URL |
| `[rate-limiters.NAME]` | a rate limiter, `env.rateLimiter(name)` | `from`, a variable holding the store's URL |
| `[directories.NAME]` | a directory | `access` (`"read"` or `"write"`), and `from` |
| `[files.NAME]` | files that ship with the build | `path`, a directory in the package |

A resource's URL picks its back end. A queue at `sqs://…` is on Amazon SQS, and one at
`amqp://…` is on RabbitMQ. A queue kept in a database, with `database = "main"`, commits in
the same transaction as the rest of the work, so a message is sent only if the work is saved.

## Reading configuration

The code says what kind of value a variable holds, by how it reads it:

```nib
import std.app.{ConfigError, Env}
import std.http.{Url}

record Config {
	baseUrl: Url
	smtpPort: Int
	apiKey: Secret
}

fn config(env: Env) -> Config else ConfigError {
	return Config(
		baseUrl: try env.url("BASE_URL"),
		smtpPort: try env.int("SMTP_PORT"),
		apiKey: try env.secret("API_KEY"),
	)
}
```

Resources are asked for by name in the same way, and each name is checked against its
table: `env.db("main")`, `env.queue(EMAILS)`, `env.dir("exports")`.

The compiler checks every name against the manifest:

- A name that isn't declared is an error.
- A secret is read only with `env.secret`, which gives a `Secret` rather than a `String`. So
  a key can't end up in a log by accident.
- A variable is read as one kind everywhere. If one file reads `SMTP_PORT` with `env.int`,
  another can't read it with `env.string`.
- The name is a string, or a constant holding one, so the compiler can read it.

```nib error
// Rejected: `API_KEY` is a secret, so `env.string` can't read it.
import std.app.{ConfigError, Env}

fn apiKey(env: Env) -> String else ConfigError {
	return try env.string("API_KEY")
}
```

```nib error
// Rejected: there's no database called `mian` in the manifest.
import std.app.{Env}
import std.db.{Db}

fn database(env: Env) -> Db {
	return env.db("mian")
}
```

Before `main` runs, the host checks that every declared variable is set, and reports all
the missing ones at once. It also connects to each database. So `env.db` can't fail.
Reading a value can still fail, if it's set but isn't a URL or a number, so read
configuration in `main`. A bad value then stops the program as it starts, not halfway
through a request.

## Files that ship with the build

A directory comes from the host, and each environment can point it somewhere else. Files
such as a site's stylesheets and scripts are different: they belong to the build. They have
to match the code that links to them, and they're the same everywhere. `[files]` declares
them, with `path` naming a directory in the package, and `env.files` gives them to the
program:

```nib
import std.app.{Env}
import std.http.{Route}

fn assets<S>(env: Env) -> Route<S> {
	return Route.files("/assets", env.files("assets"))
}
```

`Route.files` serves each file beneath the prefix: `/assets/app.css` is the file `app.css`.
It serves only files in the set, so a path can't reach anything else, and it never lists a
directory. Each answer carries an ETag, so a browser that already has the file gets a short
`304 Not Modified`.

The host decides how the files ship:

- A single program, or a WebAssembly build, can carry them inside it.
- A container can hold them as a directory beside the program.
- A development run reads them from the package, so an edit shows without a rebuild.

The code is the same in each case, and the files are always the ones built with it.

## Caches

A cache declared as `[caches.NAME]` is shared by every instance of the app, and
`env.cache(name)` gives it. `remember` gives the value stored under a key, or computes and
stores it:

```nib
import std.cache.{Cache}
import std.http.{HttpError}
import std.json.{@json}
import std.time.{Duration}

@json
record Rates {
	gbpToEur: Decimal
}

interface Bank {
	fn rates() -> Rates else HttpError
}

class RatesService {
	construct(private cache: Cache, private bank: Bank) {}

	fn current() -> Rates else HttpError {
		return try this.cache.remember("rates", ttl: Duration.of(minutes: 10), compute: fn() => try this.bank.rates())
	}
}
```

- The value is stored as JSON, so its type must be one the JSON codec can write.
- When one instance is computing a key, the others wait for its value, so a busy key that
  expires is computed once.
- A cache that can't be reached doesn't fail the call: `compute` runs, and the host logs a
  warning. A cache only makes things faster, so `remember` fails only as `compute` does.
- `forget(key)` removes a key, so the next `remember` computes it again, such as after the
  data has changed.
- Tests use `InMemoryCache` from `std.testing`, which expires values by a `FakeClock`.

## Rate limits

A rate limiter declared as `[rate-limiters.NAME]` counts attempts across every instance of
the app, and `env.rateLimiter(name)` gives it. Each limit is declared once, as a constant:
how many attempts, over how long, and the type of key it counts by.

```nib
import std.cache.{CacheError, Limit, RateLimit, RateLimiter}
import std.http.{IpAddress}
import std.time.{Duration}

const SIGN_INS_BY_IP = Limit<IpAddress>(name: "sign-in-ip", max: 5, per: Duration.of(minutes: 1))

fn mayTry(limiter: RateLimiter, ip: IpAddress) -> Bool else CacheError {
	let result = try limiter.hit(SIGN_INS_BY_IP, ip)
	return result is RateLimit.Allowed
}
```

- `hit` records one attempt by the key, and gives `Allowed`, or `Limited(retryAfter:)` with
  how long until the key is allowed again.
- The key's type is part of the limit, so an email address can't be counted against a limit
  on IP addresses.
- The limit's `name` comes before each key in the store. Two limits with the same name in a
  package would share a counter, so that's an error.
- A limiter that can't be reached fails with a `CacheError`, unlike a cache. A limit is
  never skipped unless the code catches the error and says so.
- Tests use `InMemoryRateLimiter` from `std.testing`, which counts by a `FakeClock`.

```nib error
// Rejected: both limits are named "password-reset", so they'd share one counter.
import std.cache.{Limit}
import std.time.{Duration}

const RESETS_BY_USER = Limit<Int>(name: "password-reset", max: 3, per: Duration.of(hours: 1))
const RESETS_BY_TEAM = Limit<Int>(name: "password-reset", max: 30, per: Duration.of(hours: 1))
```

## Where logs go

Code that logs never says where its events go. `log.info(…)` writes to the default channel,
named after the package: `shop` for a package called `antnee/shop`. A program without a
manifest uses its file name. `log.channel("security")` names another channel, so its events
can go somewhere of their own. A log call's `fields` hold values that are `Loggable`, which
the compiler writes in a log form of its own:

- numbers, text and the standard library's types, as what they are;
- enums and distinct types, when what they hold is loggable;
- an error, as its chain of messages and its trace;
- a secret, as `[redacted]`;
- a record or class of your own only when it's marked `@loggable`, from `std.log`.

A record of your own can hold personal data, such as a user's email address, so it doesn't
go into a log by accident. Log what you need from it, such as its ID:

```nib
import std.log

record Customer {
	id: Int
	email: String
}

fn welcome(customer: Customer) {
	log.info("welcomed", fields: ["customerId": customer.id])
}
```

```nib error
// Rejected: a `Shopper` holds an email address, so it's logged only if it's marked `@loggable`.
import std.log

record Shopper {
	id: Int
	email: String
}

fn greet(shopper: Shopper) {
	log.info("greeted", fields: ["shopper": shopper])
}
```

A server's `main` routes channels to sinks:

```nib standalone
import std.app.{App, Env}
import std.log

pub fn main(env: Env) -> App {
	return App(logRoutes: [log.Route(channel: "shop", minLevel: log.Level.Info, sink: log.Stdout.json())])
}
```

An event that no route takes goes to standard error as text if it's `Info` or above. A
`Debug` event without a route is dropped. So a script or a new app shows its logs with no
setup, and a warning on a channel nobody routed isn't lost.

## Following a piece of work

The host gives each piece of work an ID and a trace: each request, each queue message
handled, and each run of a command. Logging, the HTTP client, queues and the database read
them by themselves. So every log line carries the ID, an outgoing call or a queued message
carries the trace, and a trace can be followed across services. Nothing is passed from
function to function for this.

Code that needs the ID itself, such as to show it on an error page, reads it from
`std.context`:

```nib
import std.context

fn supportReference() -> String {
	return "Quote ${context.current().id} if you contact us."
}
```

`traceparent` gives the trace, in the W3C format. Code can read the context but never
replace it.

## In development: `.env`

`nib run` and `nib test` read a file called `.env` beside the manifest, if there is one:

```
# Local settings. Never commit this file.
BASE_URL=http://localhost:8080
SMTP_PORT=1025
API_KEY="test-key"
DATABASE_URL=postgres://localhost/shop
EXPORT_DIR=./exports
```

- Each line is `NAME=value`. Lines starting with `#` are comments.
- A value can be in single or double quotes. Nothing in it is expanded: `$HOME` is just
  text.
- A variable that's already set in the environment wins over the file.
- A line that doesn't follow these rules is an error that names the line, rather than a
  guess.

A deployed program never reads `.env`. Its host sets the variables. That way, a stray `.env`
copied to a server is never used.

`nib env example` writes `.env.example` from the manifest: every variable, with the secrets
left blank. Commit that one, so a new developer knows what to set.

## Programs without a manifest

A single-file program has no manifest, so nothing checks its names. It's given directories
on the command line:

```
nib run --dir logs=/var/log/shop summarise.nibl --top 10
```

Options before the file are for `nib`, and arguments after it are the program's own, in
`env.args`. A program that needs a database or a queue should become a package.
