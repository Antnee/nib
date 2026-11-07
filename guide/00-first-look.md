# A first look

<!-- quotes: ../examples/notes/src/main.nibl -->

This is a whole web app, read from top to bottom: the notes app in `examples/notes/`. It
lists notes, adds one from a form, and shows one on its own page. Each part points to the
chapter that explains it, so you can read this first and come back to it later.

## Starting

```nib
import std.app.{App, Env}
import std.db.{@db, Db, DbError}
import std.forms.{@form, FormState}
import std.html.{Html}
import std.http.{@guard, @path, CsrfToken, Request, Response, Route, Routes, Status, ToResponse}

pub fn main(env: Env) -> App {
	let freshServices = fn() => new Services(env.db("main"))
	return App(http: routes().serve(freshServices))
}
```

- Imports name what the file uses from the standard library ([Modules](08-modules.md)).
- `main` runs once, when the program starts. It returns an `App`, which describes the server
  ([Basics](01-basics.md), [The web](09-web.md#the-app-and-its-routes)).
- `env.db("main")` is the database the manifest declares, a MySQL one here
  ([Configuration and resources](15-host.md)). Each query borrows a connection from a pool
  and gives it back ([Databases](10-databases.md)).
- `freshServices` is a function that makes a new `Services` for each request, so nothing
  built for one request is seen by the next.

## Routes

```nib
fn routes() -> Routes<Services> {
	return Routes(routes: [
		Route.get("/", fn(app) => app.notes.index),
		Route.post("/", fn(app) => app.notes.create),
		Route.group(prefix: "/notes/{noteId}", requiring: fn(app) => app.notes.find, routes: [
			Route.get("", fn(app) => app.notes.show),
		]),
	])
}
```

- Each route names a handler. `fn(app) => app.notes.index` picks the `index` method of that
  request's `notes`, without calling it. The router calls it when the route matches.
- The table is built once, before any request, so there's no `Services` yet to name a
  handler from. Each route's `fn(app) => …` says how to pick one from each request's
  `Services` ([The web](09-web.md#the-app-and-its-routes)).
- The group runs `find`, its guard, before its routes. What `find` returns reaches `show`
  ([Guards](09-web.md#guards)).
- `Route.get("", …)` inside the group is the group's own path, `/notes/{noteId}`.

## Before a handler runs

Every request goes through the same steps, so a handler sees only the requests that get
this far:

1. The router matches the method and the path, and reads `{noteId}` as a `NoteId`. A path
   that matches nothing, such as `/notes/abc`, gets a `404`.
2. `freshServices` makes the request's `Services`.
3. The built-in protections run. A `POST` without a valid CSRF token gets a `403`, and a
   body that's too large gets a `413`.
4. The guards run: `find`, for a path under `/notes/{noteId}`.
5. The handler runs.

When a guard or a handler fails, the router logs the error and sends the response the error
gives ([When something fails](#when-something-fails)). A table can also run middleware,
which this app doesn't have ([The order of work](09-web.md#the-order-of-work-on-a-request)).

## The container

```nib
class Services {
	construct(private db: Db) {}

	lazy notes: NoteHandlers = new NoteHandlers(this.db)
}
```

- A class is built with `new`, and its constructor stores the database as a private field
  ([Types](04-types.md#classes)).
- A `lazy` field is built the first time it's read, so a request builds only what it uses.

## The data

```nib
type NoteId: Int

@db(table: "notes")
record Note {
	id: NoteId
	text: String
}

@form
record NoteForm {
	text: String
}
```

- `type NoteId: Int` is a new type backed by an `Int`, not another name for it. So a note's
  ID can't be passed where another kind of ID, such as an order's, is wanted. It can still
  be used as an `Int`, such as in `${…}`, but it has no arithmetic, since adding to an ID
  means nothing ([Distinct types](04-types.md#distinct-types)).
- A record is a value with fields, and it can't change ([Types](04-types.md)).
- `@db` reads a `Note` from a row of the `notes` table, and `@form` builds a `NoteForm` from
  a submitted form ([Attributes](11-attributes.md), [Forms](09-web.md#forms)).

## The handlers

```nib
class NoteHandlers {
	construct(private db: Db) {}

	fn index(req: Request) -> Response else WebError {
		return Response.html(notesPage(try this.all(), FormState.EMPTY, req.csrf))
	}

	fn create(req: Request) -> Response else WebError {
		let form = req.body.form<NoteForm>() catch err {
			return Response.html(notesPage(try this.all(), err.state, req.csrf), status: Status.UNPROCESSABLE_CONTENT)
		}
		let id = try this.db.insertId<NoteId>(sql"insert into notes (text) values (${form.text})")
		return Response.redirect(url"/notes/${id}")
	}

	fn find(@path noteId: NoteId) -> Note else WebError {
		let note = try this.db.queryOne<Note>(sql"select id, text from notes where id = ${noteId}")
		return note ?? fail WebError.NotFound
	}

	fn show(@guard note: Note) -> Response {
		return Response.html(html"""
			<p>${note.text}</p>
			<a href="/">All notes</a>
			""")
	}

	private fn all() -> List<Note> else DbError {
		return try this.db.query<Note>(sql"select id, text from notes order by id")
	}
}
```

- `-> Response else WebError` says what `index` returns, and what it fails with if something
  breaks ([Errors](06-errors.md)).
- `try this.all()` passes a failure on. `all` fails with a `DbError`, which becomes a
  `WebError` through the `Database(from DbError)` variant at the end of the file
  ([Converting errors](06-errors.md#converting-errors)).
- `catch err { … }` handles a form that doesn't decode, such as one whose `text` is
  empty. It fails with a `FormError`, whose `state` holds what was typed and what's wrong
  with it, so the page is shown again
  ([Handling an error](06-errors.md#handling-an-error-catch)).
- A field of only spaces counts as empty, so a note of spaces is refused too. The text
  that's saved is never trimmed ([Forms](09-web.md#forms)).
- A `POST` is checked for a CSRF token by the router before `create` runs, so the handler
  doesn't check it ([CSRF](09-web.md#csrf)).
- `sql"…"` sends each `${…}` as a parameter, never as text, so it can't be injected
  ([Values](02-values.md)).
- `insertId` runs the insert and gives back the ID the database made for the new note, so
  the redirect can go to the note's page ([Databases](10-databases.md)).
- `find` is the guard. `@path noteId` is the `{noteId}` in the route, read as a `NoteId`.
  `queryOne` gives the note, or `null` when no note has that ID. Then
  `?? fail WebError.NotFound` fails, so `show` never sees a missing one ([Null](05-null.md)).
- `show` asks for the note with `@guard note: Note`. A `@guard` parameter gets the value of
  the guard around the route that gives that type, here `find`.
- `index` and `create` read the request, so they take it first. `find` and `show` don't, so
  they leave it out ([The web](09-web.md#the-app-and-its-routes)).
- `private fn all` is only for this class's own methods.

## The page

```nib
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

- `html"…"` escapes each `${…}` for where it lands, so a note's text can't add markup
  ([Pages](09-web.md#pages)).
- `notes.map(noteItem)` makes a list item for each note. It passes the function `noteItem`
  without calling it, and `map` calls it once for each note
  ([Functions](03-functions.md#functions-as-values)).
- `noteItem` is a component: a function that gives a piece of a page ([Pages](09-web.md#pages)).
- `NoteForm.fields.text` names the form's `text` field, and a misspelt field is a compile
  error ([Forms](09-web.md#forms)).
- `state.problems` holds what's wrong with each field, and `containsKey` asks whether the
  text has a problem. A blank note counts as missing, and that's the only problem its text
  can have, so the page says what to do. The words come from the page, never from the
  handler.
- `Html.EMPTY` is no HTML at all, for when there's nothing to say.
- `csrf.hiddenField` is the hidden field that carries the request's CSRF token.

## When something fails

```nib
enum WebError implements ToResponse {
	Database(from DbError)
	NotFound

	override fn toResponse() -> Response {
		return match this {
			WebError.Database => Response.problem(status: Status.INTERNAL_SERVER_ERROR)
			WebError.NotFound => Response.notFound()
		}
	}
}
```

- An enum lists every way the handlers can fail ([Types](04-types.md#enums)). `match` must
  cover every variant ([Control flow](07-control-flow.md)).
- A variant is written with its enum's name, as `WebError.Database`, in a `match` as
  everywhere else.
- `ToResponse` is an `Error` that can also give a response, so `WebError` writes
  `toResponse()`.
- Every error has a `message`, for logs. An enum that doesn't write one gets its variant's
  name in words, so `WebError.NotFound`'s is `not found`
  ([Errors](06-errors.md#messages)).
- People never see the `message`. They see the page that `toResponse()` chooses: an error
  page for a database failure, and a 404 for a missing note
  ([When a handler fails](09-web.md#when-a-handler-fails)).
- The router logs each failure before it sends that page.
