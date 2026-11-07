# Basics

## A program

```nib
import std.app.{Env}

pub fn main(env: Env) {
	let name = env.args.get(1) ?? "world"
	print("Hello, ${name}!")
}
```

A program starts at `main`, and no other code runs by itself. `main` is `pub` because the
host calls it from outside the package, and only `pub` names can be reached from there.
`env.args` holds the command line, starting with the program's own name, so `args.get(1)` is
the first word typed after it. For `nib run examples/hello/cli.nibl Anthony`, `args[0]` is
`examples/hello/cli.nibl` and `args[1]` is `Anthony`. A command-line program's `main` can also return a number, the
exit code, as `pub fn main(env: Env) -> Int` does ([Streams](14-streams.md)).

A file holds only declarations: functions, types, constants, tests and imports. Importing a
module never runs any of its code.

`Env` gives `main` what the host provides: command-line arguments, configuration, the
database and the HTTP client. `print` writes a line to standard output. It's in the prelude,
so it needs no import.

A web app's `main` runs once per process and returns the app's configuration as data. The
host then calls the handler once per request:

```nib standalone
import std.app.{App, Env}
import std.http.{Request, Response}

pub fn main(env: Env) -> App {
	return App(http: hello)
}

fn hello(req: Request) -> Response {
	let name = req.query.get("name") ?? "world"
	return Response.html(html"<h1>Hello, ${name}!</h1>")
}
```

A script may start with a `#!` line. It still needs a `main`.

## Comments

```nib
// A line comment.

/* A block comment. /* They nest, */ so code that has comments can be commented out. */

/// A doc comment, written in CommonMark. Code examples in it are checked but not run.
///
/// ```
/// let sum = add(2, 3)
/// ```
fn add(a: Int, b: Int) -> Int {
	return a + b
}
```

Comments say why, not what. They never change what the code does.

An example in a doc comment is checked like code, but it may use names the reader is
assumed to have, such as a `db` or `this`, without declaring them. It can use a standard
library type without importing it. Anything else it gets wrong is an error, such as a
function that doesn't exist or a label the function doesn't have.

## Bindings

```nib
let total = 10
var count = 0
count += 1
count++
const MAXIMUM_ATTEMPTS = 5
```

- `let` binds a value once.
- `var` can be assigned again.
- `const` is a value known at compile time, named in `UPPER_SNAKE_CASE`, at the top level
  or inside a type.

Everything is immutable unless it says `var`: bindings, fields, parameters, records,
strings and collections. The exception is a handle to something outside the program, such
as a web request's session, which changes through its own methods.

Changing a `var` is a statement of its own: `=`, `+=` and the other compound forms, `++` and
`--`. None of them gives a value, so they can't be used inside an expression, and
`let x = count++` doesn't parse.

A binding's type is worked out from its value. Write it yourself when the value doesn't make
it obvious:

```nib
let limit: Int = 100
```

A choice between two values is one expression, with the ternary:

```nib
fn label(count: Int) -> String {
	let word = count == 1 ? "item" : "items"
	return "${count} ${word}"
}
```

A `let` can also be declared with its type and no value, then set later. This is for a
value that takes more than one expression to work out:

```nib
fn postage(weightKg: Int) -> Int {
	let pence: Int
	if weightKg > 20 {
		print("heavy parcel: ${weightKg} kg")
		pence = 900
	} else {
		pence = 450
	}
	return pence
}
```

- It has to be set exactly once on every path before it's read.
- A path that leaves the function, with `return` or `fail`, doesn't need to set it.
- It can't be set in a loop, which could set it more than once.
- `if` is a statement, and a block never gives a value. When the work is longer than a step
  or two, give it a function of its own, which names it and returns the value.
  [Control flow](07-control-flow.md#why-a-block-arm-doesnt-give-a-value) says why.

```nib error
// Rejected: `pence` is set only when the parcel is heavy, so it may not be set when it's read.
fn smallPostage(weightKg: Int) -> Int {
	let pence: Int
	if weightKg > 20 {
		pence = 900
	}
	return pence
}
```

Signatures always state their types (parameters and results), so a function can be
understood without reading its body.

## Names

The compiler enforces case, so the first letter tells you what a name is:

| Kind | Case | Example |
|------|------|---------|
| types, enum variants, type parameters | PascalCase | `HttpClient`, `T` |
| functions, methods, fields, variables, parameters, attributes | camelCase | `userId`, `@sensitive` |
| constants | UPPER_SNAKE_CASE | `MAXIMUM_ATTEMPTS` |
| modules | lowercase letters and digits | `payments` |

Acronyms are written as words: `HttpClient`, `userId`, never `HTTPClient`. The unsigned
integer types, `UInt` and `UInt8` to `UInt32`, and their conversions (`toUInt()`) are the one
exception.

A capital letter before a dot always means a type: `Status.NOT_FOUND`, `Email.parse(text)`.

A local or parameter can't reuse the name of another local or parameter that's in scope. It
can reuse the name of a top-level declaration or a prelude name, but that gives a warning.

### Reserved words

These words are the language's own:

`alias` `and` `as` `break` `catch` `class` `const` `continue` `defer` `div` `do` `else` `enum` `fail`
`false` `fn` `for` `if` `implements` `import` `in` `interface` `is` `lazy` `let` `match` `mod`
`mut` `new` `not` `null` `or` `private` `pub` `record` `return` `start` `static` `this` `This`
`true` `try` `type` `use` `var` `when` `while` `with` `yield`

A reserved word can't name a variable, a parameter, a type, a module or a top-level function,
where it would read as the word itself. Each one starts something the language has: `start`
runs a task, `use` names what a closure may change, `type` declares a distinct type, and
`with` copies a record. Name a variable for what it holds instead, such as `startsAt` or
`kind`.

It can name a member: a field, a getter, a method, or an enum variant's payload. A member's
name always comes after `.`, `fn` or `get`, or before `:`, and no reserved word can stand
there, so it's never ambiguous:

```nib
record Event {
	id: String
	type: String
}

fn describe(event: Event) -> String {
	return "${event.type} ${event.id}"
}
```

```nib error
// Rejected: `type` is a reserved word, so it can't name a variable.
fn kind() -> String {
	let type = "order.paid"
	return type
}
```

A few more words are keywords only in one position, and ordinary names everywhere else:
`get`, `from`, `named`, `override`, `attribute`, `construct` (in a class), `internal` (on a
constructor's parameter), `secret` (directly before a string), and in test files `test` and
`expect`. So `map.get(key)` and a parameter called `from` are fine.

## Lines

There are no semicolons. A newline ends a statement, except:

1. inside `( )` and `[ ]`, where newlines are spaces;
2. when a line ends in the middle of an expression, after an operator, a comma, `=`, `=>`
   or `->`;
3. when the next line starts with `.`, `?.`, `|>`, `??`, `?:`, `catch` or `else`, which
   continues the line before:

```nib
let names = users.filter(fn(user) => user.isActive and user.hasConfirmedEmail)
	.map(fn(user) => user.displayName)
	.sorted()
```

Two statements can't share a line.

A list of arguments, parameters or items may end with a comma. When a list is spread over
several lines, the formatter adds that comma.

## Formatting

There is one format, with no options: tabs for indentation, and no alignment. `nib fmt`
puts code in it, and `nib check` warns about a file that isn't.

Lines should fit in 120 columns, and must fit in 150. Both are measured counting a tab as four
columns, whatever width your editor shows tabs at. A longer line than 120 gets a warning, and
one longer than 150 is an error. A signature that doesn't fit in 120 puts one parameter per
line:

```nib
fn invite(
	email: String,
	named role: String,
	named message: String? = null,
	named sendCopyToInviter: Bool = false,
) -> Bool {
	return true
}
```
