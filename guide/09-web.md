# The web

The standard library has what a website needs without a framework: requests and responses,
a route table, guards, middleware, forms, sessions, cookies and HTML. This chapter grows the
notes app from [A first look](00-first-look.md): people sign in, and each person sees only
their own notes.

## Requests and responses

A handler is a function from a `Request` to a `Response`:

```nib
import std.http.{Request, Response}
import std.json.{@json}

@json
record Greeting {
	text: String
}

fn greet(req: Request) -> Response {
	let name = req.query.get("name") ?? "world"
	return Response.json(Greeting(text: "Hello, ${name}!"))
}
```

A `Request` is a value that can't change, apart from its session. It has:

- `method` and `path`;
- `query`, `headers` and `cookies`;
- `clientIp`, the client's address, worked out through the proxies the app trusts;
- `body`, read with `form<T>()`, `json<T>()`, `text()`, `bytes()` or `stream()`;
- `session` and `csrf`, which come later in this chapter. Changes to the session are saved
  when the response is sent.

A `Response` is made by one of its static functions:

| Function | Sends |
|----------|-------|
| `Response.html(page)` | an HTML page |
| `Response.json(value)` | JSON, from a `@json` type |
| `Response.text(text)` | plain text |
| `Response.redirect(url"/notes")` | a `303 See Other` to a path on this site |
| `Response.redirectAway(url)` | a `303 See Other` to another site |
| `Response.notFound()` | a `404` |
| `Response.badRequest()` | a `400` |
| `Response.problem(status:)` | an error: problem details for JSON clients, a plain page for browsers |
| `Response.noContent()` | an empty `204` |
| `Response.stream(…)` | a body written a piece at a time |

`html`, `json` and `text` send `200 OK` unless you pass `status:`, such as
`Status.UNPROCESSABLE_CONTENT`. Each status code has a named constant on `Status`.

`redirect` takes a `RelativeUrl`, which has no host. So a `?next=` parameter, read with
`RelativeUrl.parse`, can't send a visitor to another site. Sending someone away takes
`redirectAway`, by name.

## The app and its routes

A server's `main` returns an `App`. Its `http` answers every request, and a route table makes
one:

```nib
import std.app.{App, Env}
import std.db.{Db}
import std.http.{Route, Routes}

pub fn main(env: Env) -> App {
	let freshServices = fn() => new Services(env.db("main"))
	return App(http: routes().serve(freshServices))
}

fn routes() -> Routes<Services> {
	return Routes(routes: [
		Route.group(requiring: fn(app) => app.guards.user, routes: [
			Route.get("/", fn(app) => app.notes.index),
			Route.post("/", fn(app) => app.notes.create),
			Route.group(prefix: "/notes/{noteId}", requiring: fn(app) => app.notes.find, routes: [
				Route.get("", fn(app) => app.notes.show),
			]),
		]),
	])
}

class Services {
	construct(private db: Db) {}

	lazy guards: Guards = new Guards(this.db)
	lazy notes: NoteHandlers = new NoteHandlers(this.db)
}
```

The routes are the first look's, inside a group whose guard, `user`, finds who is signed in
([Guards](#guards)).

- `Services` is the app's container: it says how each part is built. Its `lazy` fields are
  built when they're first read.
- `serve` takes a function that makes a fresh container. It's called once for each request,
  so nothing built for one request is seen by the next.
- Each route's function, such as `fn(app) => app.notes.index`, picks the handler from that
  request's container. It runs only when its route matches.
- The table is built once, in `main`, before any request has a container. So a route can't
  name a handler object itself. It says how to pick one from each request's container,
  which is why every route has the same `fn(app) => …` shape.
- A handler can be a method. `app.notes.index` is the `index` method of that request's
  `NoteHandlers`, so a handler class gets only what its `construct` asks for.
- A handler that reads the request takes it first, as `index(req: Request, …)` does. A
  handler that doesn't read it leaves it out, as `show(@guard note: Note)` does.
- Then come the values it wants from the guards around its route, each marked `@guard`, and
  the route's path parameters, each marked `@path`. Both come later in this chapter.
- A handler returns a `Response`, or fails with an error that implements `ToResponse`.
- Any function or method of that shape is a handler, and nothing else declares it. The
  compiler checks each handler against its route, and an error there names the parameter
  that doesn't fit.

So a handler that doesn't read the request doesn't take it as `_`:

```nib error
// Rejected: `home` doesn't read the request, so it leaves it out, as `fn home() -> Response`.
import std.http.{Request, Response, Route, Routes}

class Greeter {
	fn home(_: Request) -> Response {
		return Response.text("Hello")
	}
}

class Greeting {
	construct(pub greeter: Greeter) {}
}

fn greetingRoutes() -> Routes<Greeting> {
	return Routes(routes: [Route.get("/", fn(app) => app.greeter.home)])
}
```

There's a function for each method: `Route.get`, `post`, `put`, `patch` and `delete`.
`Route.on` takes a list of methods. The router also answers `HEAD` for every `GET` route,
and `OPTIONS`. A path that matches with the wrong method gets
`405 Method Not Allowed`.

### Path parameters

A pattern's `{name}` matches one segment of the path, and `{name...}` matches the rest of it.
The handler or guard receives each one as a parameter marked `@path`, with the same name. Here
are the first look's handlers, now that each note has an owner:

```nib
import std.codec.{Case}
import std.db.{@db, Db, DbError}
import std.forms.{FormState}
import std.http.{@guard, @path, Request, Response, Status}

type NoteId: Int

@db(table: "notes", columns: Case.Snake)
record Note {
	id: NoteId
	ownerId: UserId
	text: String
}

class NoteHandlers {
	construct(private db: Db) {}

	fn index(req: Request, @guard user: User) -> Response else WebError {
		return Response.html(notesPage(try this.all(user), FormState.EMPTY, req.csrf))
	}

	fn create(req: Request, @guard user: User) -> Response else WebError {
		let form = req.body.form<NoteForm>() catch err {
			let page = notesPage(try this.all(user), err.state, req.csrf)
			return Response.html(page, status: Status.UNPROCESSABLE_CONTENT)
		}
		let insert = sql"insert into notes (owner_id, text) values (${user.id}, ${form.text})"
		let id = try this.db.insertId<NoteId>(insert)
		return Response.redirect(url"/notes/${id}")
	}

	/// The guard: the signed-in user's note in the path, or a 404.
	fn find(@guard user: User, @path noteId: NoteId) -> Note else WebError {
		let query = sql"select * from notes where id = ${noteId} and owner_id = ${user.id}"
		return try this.db.queryOne<Note>(query) ?? fail WebError.NotFound
	}

	fn show(@guard note: Note) -> Response {
		return Response.html(notePage(note))
	}

	private fn all(user: User) -> List<Note> else DbError {
		return try this.db.query<Note>(sql"select * from notes where owner_id = ${user.id} order by id")
	}
}
```

- `Note` has an `ownerId`, the user who wrote it, so `index` lists only that user's notes.
- The column is `owner_id`. A field reads the column with exactly its name, so
  `columns: Case.Snake` says this table's columns are the fields' names in snake case
  ([Reading rows](10-databases.md#reading-rows)).
- A path parameter has a type. A segment that doesn't parse as that type means the route
  doesn't match, so `/notes/abc` is a `404` before any of your code runs.
- When two patterns match, the more specific one wins, whatever their order in the table.
- The compiler checks each handler and guard against its route's pattern: the names, the
  order, and that each type can be parsed.

```nib error
// Rejected: the pattern names `{id}`, but `find`'s path parameter is called `noteId`.
import std.http.{Route, Routes}

fn misnamedRoutes() -> Routes<Services> {
	return Routes(routes: [
		Route.group(requiring: fn(app) => app.guards.user, routes: [
			Route.group(prefix: "/notes/{id}", requiring: fn(app) => app.notes.find, routes: [
				Route.get("", fn(app) => app.notes.show),
			]),
		]),
	])
}
```

## When a handler fails

A handler can fail with any error that implements `ToResponse`. The router logs the error and
sends the response that its `toResponse()` gives. So a handler can use `try` freely. This is
the first look's `WebError`, with one more variant for the sign-in guard:

```nib
import std.db.{DbError}
import std.http.{Response, Status, ToResponse}

enum WebError implements ToResponse {
	Database(from DbError)
	SignInRequired
	NotFound

	override fn toResponse() -> Response {
		return match this {
			WebError.Database => Response.problem(status: Status.INTERNAL_SERVER_ERROR)
			WebError.SignInRequired => Response.redirect(url"/sign-in")
			WebError.NotFound => Response.notFound()
		}
	}
}
```

- Its `message`, for logs, is each variant's name in words, such as `sign in required`.
  People never see it ([Messages](06-errors.md#messages)).
- The router logs every error a handler fails with, with its trace: the places the failure
  passed through. So `toResponse()` doesn't log it again.
- `toResponse()` chooses what the visitor sees. Here a database failure is a plain error
  page, which carries a request ID and nothing about the cause.
- Keep the error enum for failures the visitor can do nothing about, and for a guard's
  answers, such as `SignInRequired`. Deal with anything a page should answer, such as a
  refusal or an expired link, in the handler, where it happens. Then a `try` in a handler
  only ever means "this broke".
- So a missing note is answered two ways, by who finds it. A handler returns
  `Response.notFound()` itself. A guard can't return a response, so it fails with
  `WebError.NotFound`, whose `toResponse()` gives the same `404`.
- A route table's `onError` is called with every handler error before it becomes a response,
  such as to send it, with its `trace`, to an error tracker.

## Guards

A guard runs before the routes in a group. It either produces a value, which each handler in
the group receives, or fails, and its error becomes the response. The app's outer guard finds
who is signed in:

```nib
import std.db.{@db, Db}
import std.http.{Request, SessionKey}

type UserId: Int

const SIGNED_IN = SessionKey<UserId>("userId")

@db(table: "users")
record User {
	id: UserId
	name: String
}

class Guards {
	construct(private db: Db) {}

	/// The signed-in user, or a redirect to the sign-in page.
	fn user(req: Request) -> User else WebError {
		let id = req.session.get(SIGNED_IN) ?? fail WebError.SignInRequired
		return try this.db.queryOne<User>(sql"select * from users where id = ${id}") ?? fail WebError.SignInRequired
	}
}
```

- `Route.group(requiring:)` names the guard. Its result type says what it checked: a
  handler that receives a `User` knows someone is signed in.
- A `@guard` parameter is matched by type. It gets the value of the guard around the route
  that gives that type, so `index`'s `@guard user: User` is what `user` gave.
- Guards nest. `find`, the inner guard, runs only once `user` has succeeded, and asks for the
  `User`. A handler can ask for the value of any guard around it: `show` could also take
  `@guard user: User`.
- A `@path` parameter is matched by name to a `{name}` anywhere in the route's full
  pattern, prefixes included. Each one is taken by the handler or by a guard around it.
  `find` takes `noteId`, so `show` needn't, though it could.
- A handler's or guard's parameters come in one order: the request, then its `@guard`
  parameters, in the order their guards run, then its `@path` parameters, in the pattern's
  order.
- A group can have a `prefix` without a guard, for routes that only share a path.
- A route's pattern inside a group is added to the prefix. So `Route.get("", …)` is the
  prefix itself: `show`'s page is `/notes/{noteId}`.

Because the inner guard needs the outer one's value, nobody can reach another person's notes.
`find` looks only among the signed-in user's own, so anyone else gets a `404`, and can't tell
whether the note exists.

A guard's result type says what it proved, and it's how a handler finds it. So two guards
around the same routes can't give the same type:

```nib error
// Rejected: `user` and `admin` both give a `Visitor`, so a `@guard` parameter couldn't tell them apart.
import std.http.{@guard, Response, Route, Routes}

record Visitor {
	name: String
}

class AdminGuards {
	fn user() -> Visitor {
		return Visitor(name: "Ann")
	}

	fn admin(@guard user: Visitor) -> Visitor {
		return user
	}
}

class AdminHandlers {
	fn home(@guard user: Visitor) -> Response {
		return Response.html(html"<h1>Hello, ${user.name}</h1>")
	}
}

class AdminServices {
	construct(pub guards: AdminGuards, pub pages: AdminHandlers) {}
}

fn adminRoutes() -> Routes<AdminServices> {
	return Routes(routes: [
		Route.group(requiring: fn(app) => app.guards.user, routes: [
			Route.group(requiring: fn(app) => app.guards.admin, routes: [
				Route.get("/admin", fn(app) => app.pages.home),
			]),
		]),
	])
}
```

Give the inner one a type of its own that says what it checked, such as `type Admin: Visitor`.

## Middleware

Middleware runs around the handlers it's attached to. It implements `Middleware`, whose
`handle` gets the request and `next`, the rest of the chain:

```nib
import std.http.{Middleware, Next, Request, Response}
import std.log

class RequestLog implements Middleware {
	override fn handle(req: Request, next: Next) -> Response {
		let response = next(req)
		log.info("request", fields: ["path": req.path, "status": response.status])
		return response
	}
}
```

- Code before `next(req)` runs before the handler. Code after it runs with the response.
- Returning without calling `next` stops the request there.
- `next` returns a `Response`, never an error. By the time it returns, a handler's error has
  already become a response.
- A `Request` can't change, so middleware that adds a header passes on a copy:
  `next(req.withHeader("X-Request-Source", "internal"))`.

Middleware is attached with `using:`, in three places: the whole table, a group, or one
route. Each takes a list of functions that pick the middleware from the container, as routes
pick handlers: `Routes(using: [fn(app) => app.requestLog], routes: […])`.

## The order of work on a request

Every request goes through the same steps, in this order:

1. The router matches the method and the path, and parses the path parameters. If nothing
   matches, the answer is a `404`, before anything else is built.
2. It makes a fresh container.
3. The middleware runs: the table's, then the group's, then the route's.
4. The built-in protections run. A body that's too large gets a `413`, and an unsafe request
   without a valid CSRF token gets a `403`.
5. The guards run, outermost first.
6. The handler runs.

The protections come after your middleware, so a request log sees the requests they turn
away. They come before the guards, so a forged or oversized request never reaches code that
reads the session or the database.

## Forms

A form is a record marked `@form`. `req.body.form<T>()` builds one from the submitted fields,
each through its type's `parse`. The notes page shows the form, and `create`, in
`NoteHandlers` above, reads it:

```nib
import std.forms.{@form, FormState}
import std.html.{Html}
import std.http.{CsrfToken}

@form
record NoteForm {
	text: String
}

fn notesPage(notes: List<Note>, state: FormState, csrf: CsrfToken) -> Html {
	return html"""
		<ul>${notes.map(noteItem)}</ul>
		<form method="post">
			${csrf.hiddenField}
			<textarea name="${NoteForm.fields.text.name}">${state.values.get(NoteForm.fields.text) ?? ""}</textarea>
			${state.problems.containsKey(NoteForm.fields.text) ? html"<p>Write something first.</p>" : Html.EMPTY}
			<button>Add</button>
		</form>
		"""
}

fn noteItem(note: Note) -> Html {
	return html"""
		<li><a href="/notes/${note.id}">${note.text}</a></li>
		"""
}
```

- A form that doesn't decode fails with a `FormError`. Its `state`, a `FormState`, holds what
  was submitted and the problem with each field, ready to show the form again. A
  `FormState` is plain data: its `values` and `problems` are maps keyed by field, and
  `FormState.EMPTY` is a form before it's submitted.
- A `FormError` is caught where the form is read, never passed on with `try`, because a form
  with a problem is shown again, not turned into an error page
  ([Errors handled at the call](06-errors.md#errors-handled-at-the-call)).
- `NoteForm.fields` is the form's schema, which the compiler writes: a `FormField` for each
  field. `NoteForm.fields.text` names the `text` field, for an input's `name` and for the
  form's state, and a misspelt field is a compile error.
- A field whose text is empty or only spaces counts as not submitted. So a note of spaces is
  `Missing`, as an empty one is, and the page shows the same words for both.
- Nothing trims what was typed, so a note keeps its spaces, as pasted code needs. A field's
  type can trim in its own `parse`, as an email address should. A password never should.
- A problem found while decoding says what's wrong, such as `Missing`, and the page chooses
  the words people see.
- A problem the handler finds afterwards, such as a wrong password, comes with its words:
  `FormState.of(form).explaining(field, text: …)` gives the state to show.
- If the insert fails, `try` turns the `DbError` into a `WebError`, through its
  `Database(from DbError)` variant. The router then sends what `toResponse()` chooses: a
  plain error page.
- A field marked `@sensitive`, such as a password, is never kept in a `FormState`, so it's
  never sent back to the browser.
- `req.query.form<T>()` reads a form submitted with `GET`.

```nib error
// Rejected: `NoteForm` has no field `txt`.
import std.forms.{FormState}

fn badPage(state: FormState) -> String {
	return state.values.get(NoteForm.fields.txt) ?? ""
}
```

### CSRF

The router rejects a `POST`, `PUT`, `PATCH` or `DELETE` that doesn't send back the request's
CSRF token. A form sends it in a hidden field, `req.csrf.hiddenField`, as above. A
route that another server calls, such as a webhook, turns the check off with
`csrf: Csrf.Off`.

## Sessions

`req.session` is the visitor's session. Each thing it holds has a key, declared once, which
fixes the type of its value:

```nib
import std.http.{Request, Response, SessionKey}

const NOTICE = SessionKey<String>("notice")

fn signIn(req: Request, user: User) -> Response {
	req.session.regenerate()
	req.session.put(SIGNED_IN, user.id)
	req.session.flash(NOTICE, "Welcome back, ${user.name}.")
	return Response.redirect(url"/")
}
```

- `get`, `put` and `remove` read, store and remove a value.
- `flash` stores a value until it's next read with `takeFlash`, typically on the next page.
- `regenerate()` gives the session a new ID and keeps its values. Do this on sign-in.
- `destroy()` removes the session, as on sign-out.
- Changes are saved when the response is sent, even when it's the response for an error.
  So write to the session after the last step that can fail. Or, to undo a write if a later
  step fails, follow it with `defer else`.
- A session holds small values: numbers, text, `Bool`, backed enums, distinct types of
  those, and stdlib types that allow it, such as `TokenHash`. Keep anything bigger in the
  database, and put its ID in the session.

## Cookies

A `Cookie` is sent with `withCookie`, and read back with `req.cookies.get`:

```nib
import std.http.{Cookie, Request, Response}
import std.time.{Duration}

fn saveTheme() -> Response {
	let theme = Cookie(name: "theme", value: "dark", maxAge: Duration.of(days: 365), httpOnly: false)
	return Response.redirect(url"/").withCookie(theme)
}

fn currentTheme(req: Request) -> String {
	return req.cookies.get("theme") ?? "light"
}
```

- A cookie's defaults are the safe choice: sent only over HTTPS (`secure`), hidden from the
  page's scripts (`httpOnly`), not sent with forms posted from other sites
  (`SameSite.Lax`), and for the whole site (`path`). Each is turned off by name.
- Here `httpOnly: false` lets the page's scripts read the theme.
- Without `maxAge`, a cookie lasts until the browser closes.
- `withCookieRemoved("theme")` tells the browser to remove it.
- The value is encoded for you, so any text works.

A signed cookie can be read by the browser but not changed. An encrypted one can't be read
either. Both take the keyring that signs or encrypts them:

```nib
import std.crypto.{Keyring}
import std.http.{Cookie, Request, Response}

fn rememberNote(note: Note, keys: Keyring) -> Response {
	let cookie = Cookie.signed(name: "lastNote", value: "${note.id}", keyring: keys)
	return Response.redirect(url"/notes/${note.id}").withCookie(cookie)
}

fn lastNote(req: Request, keys: Keyring) -> String? {
	return req.cookies.verified("lastNote", keyring: keys)
}
```

- `verified` gives `null` for a cookie that's missing or has been changed, so a forged
  cookie is treated as no cookie. `decrypted` reads an encrypted one the same way.
- Any key in the keyring is accepted, so adding a new key doesn't sign everyone out.
- A cookie the browser would silently drop is a bug, so the host stops the request rather
  than send it. That's a cookie over 4,096 bytes, or one with `SameSite.None` that isn't
  `secure`. The compiler catches the second when it's written out:

```nib error
// Rejected: browsers drop a `SameSite.None` cookie that isn't secure.
import std.http.{Cookie, SameSite}

const EMBED = Cookie(name: "embed", value: "1", sameSite: SameSite.None, secure: false)
```

## Pages

An `html"…"` literal makes `Html`. Each `${…}` in it is escaped for where it lands: text, a
quoted attribute, a URL attribute, or a `<script>`. An `Html` value, or a `List<Html>`, goes
in as it is, so pages are built from functions:

```nib
import std.html.{Html}

fn layout(title: String, content: Html) -> Html {
	return html"""
		<!doctype html>
		<title>${title}</title>
		<main>${content}</main>
		"""
}

fn notePage(note: Note) -> Html {
	return layout("Note", html"""
		<p>${note.text}</p>
		<a href="/">All notes</a>
		""")
}
```

- A function that returns `Html` is a component. An `Html` parameter, such as `content`, is
  a slot.
- A `${…}` where no escaping is safe, such as in a tag's name or an unquoted attribute, is a
  compile error.
- `Html.EMPTY` is no HTML, for a part of a page with nothing to show. It's the only way to
  write it, so an empty `html""` is a compile error.

Most layouts need something from the request, such as the CSRF token for a form in the
header, or a notice to show once. A guard can make that once for a group of pages:

```nib
import std.http.{CsrfToken, Request}

record PageContext {
	csrf: CsrfToken
	notice: String?
}

class Pages {
	fn context(req: Request) -> PageContext {
		return PageContext(csrf: req.csrf, notice: req.session.takeFlash(NOTICE))
	}
}
```

With `Route.group(requiring: fn(app) => app.pages.context, routes: […])`, each page in the
group takes `@guard page: PageContext`. A guard inside that group receives it too. So a guard
that finds the signed-in user can take it, and give its pages both, as one record.

## Time limits

Each request has a deadline, 30 seconds unless its route says otherwise:

```nib
Route.get("/notes.csv", fn(app) => app.notes.export, timeout: Duration.of(minutes: 5))
```

When the deadline passes, the request is cancelled. [Concurrency](13-concurrency.md#cancellation)
says what cancelling does, and when a client going away cancels a request too.

Work that can wait until the response has gone goes in the response's `onSent`, such as
recording an analytics event:

```nib standalone
import std.http.{Response}
import std.log

interface Analytics {
	fn track(name: String) else Error
}

class SignUpHandlers {
	construct(private analytics: Analytics) {}

	fn signUp() -> Response {
		return Response.redirect(url"/check-email").onSent(fn() {
			this.analytics.track("signed up") catch err {
				log.warn("analytics event not sent", fields: ["error": err])
			}
		})
	}
}
```

- It runs only if the response was sent, and it can't fail, so it handles its own errors.
- The request's services stay alive until it has finished, so it can use what the handler
  used.
- It has 10 seconds of its own, from when the response is sent, and is cancelled when they
  pass.
- When the host shuts down, it waits for this work before it exits.
- It's best effort, so anything that must happen goes on a queue.

## Connections that stay open

Most routes answer once. Two kinds keep the connection open: server-sent events, for a page
that shows live updates, and WebSockets, for messages both ways. Each needs a `timeout:`,
with no default, so no connection stays open for ever:

```nib
Route.events("/notes/added", fn(app) => app.events.added, timeout: Duration.of(hours: 1))
Route.websocket("/echo", fn(app) => app.echo.echo, timeout: Duration.of(hours: 1))
```

Their handlers take the request, then where to send, then `@guard` and `@path` parameters as
any handler does. They return nothing: the connection closes when the handler returns.

### Server-sent events

An events handler sends through an `EventSink`:

```nib standalone
import std.http.{EventSink, Request, SocketError}
import std.json.{@json}

@json
record NoteAdded {
	id: String
	text: String
}

interface NoteFeed {
	fn added(named after: String?) -> List<NoteAdded>
}

class NoteEvents {
	construct(private feed: NoteFeed) {}

	fn added(req: Request, events: EventSink) else SocketError {
		for note in this.feed.added(after: req.lastEventId) {
			try events.send(json: note, event: "note", id: note.id)
		}
	}
}
```

- `event` names the event, for the browser's `addEventListener`.
- When the connection drops, the browser reconnects by itself, and `req.lastEventId` gives
  the `id` of the last event it received, so the handler can carry on from there.
- `send` fails with `SocketError.Closed` once the browser has gone.
- The host sends a keep-alive every 15 seconds, and sets the headers so proxies don't buffer
  the stream.

### WebSockets

A WebSocket handler reads and sends through a `WebSocket`:

```nib standalone
import std.http.{SocketError, SocketMessage, WebSocket}

class Echo {
	fn echo(socket: WebSocket) else SocketError {
		while true {
			let message = try socket.receive() ?? return
			match message {
				SocketMessage.Text(text:) => try socket.send(text: text)
				SocketMessage.Binary => return
			}
		}
	}
}
```

- `receive()` gives `null` once the client has closed the socket.
- Guards run once, when the connection opens, and read the session cookie as on any route.
- Browsers don't apply CORS to WebSockets, so the host refuses a connection from a page on
  another origin. A route that should accept one lists it in `origins:`.
- To read and send at the same time, `start` a task that reads while the handler sends
  ([Concurrency](13-concurrency.md#start)).

## Calling other services

`env.http` makes HTTP calls. An integration that talks to one service makes a client for it,
with the service's address and credentials:

```nib standalone
import std.app.{Env}
import std.http.{ApiClient, Network, Url}

fn paymentsApi(env: Env, base: Url, apiKey: Secret) -> ApiClient {
	return env.http.client(base:, authorization: secret"Bearer ${apiKey}")
}

fn stockApi(env: Env, base: Url) -> ApiClient {
	return env.http.client(base:, network: Network.Private)
}
```

- Every call has a timeout, and ends at the deadline of the request it's made for.
- A response outside 200 to 299 is an `HttpError.UnexpectedStatus`, unless the call lists
  its status in `allow:`.
- A client reaches only public addresses. A URL can come from anyone, such as a webhook's
  target, and one that points inside the app's network could reach services that were never
  meant to be public. A call to a private, loopback or link-local address fails with
  `HttpError.Refused`.
- A client for a service inside the app's own network, such as `stockApi`, says
  `network: Network.Private`.

The files a site serves as they are, such as stylesheets, are covered in
[Configuration and resources](15-host.md#files-that-ship-with-the-build).
