# Functions

## Declaring a function

```nib
fn square(n: Int) -> Int {
	return n * n
}

fn greet(name: String) {
	print("Hello, ${name}")
}
```

Parameters and the result always have types. A function with no `->` returns nothing
(`Void`). One that returns nothing but can fail writes `else` straight after its
parameters, as in `fn save(order: Order) else DbError`. A function that returns a value always
says `return`: the last expression is never returned by itself.

## Arguments and labels

Arguments are passed in the order of the parameters:

```nib
fn column(text: String, width: Int) -> String {
	return text.padEnd(width)
}

fn heading() -> String {
	return column("Total", 10)
}
```

A parameter marked `named` is labelled at every call, and only a `named` parameter is
labelled. So each function is called the same way everywhere. Use `named` where a bare value
wouldn't say what it is: `resize(photo, 800, 600)` doesn't say which number is the width.

```nib
fn resize(image: String, named width: Int, named height: Int) -> String {
	return "${image}@${width}x${height}"
}

fn thumbnail() -> String {
	return resize("photo.jpg", width: 800, height: 600)
}
```

Arguments without labels come first, in order, and the labelled ones follow. A parameter
marked `@callerLocation` comes last, after any `named` ones, because the caller never
passes it: the compiler does ([Attributes](11-attributes.md#the-compilers-attributes)).

```nib error
// Rejected: `width` isn't a `named` parameter, so the call doesn't label it.
fn footer() -> String {
	return column("Sum", width: 10)
}
```

The checker warns about a `Bool` parameter that isn't `named`, unless it's the first. A call
such as `send(message, true)` doesn't say what `true` means. It also warns about two numbers
of the same type side by side that aren't `named`, as in `resize(photo, 800, 600)`.

Only a `named` parameter can have a default. So when a call changes a default, the label
shows which one. The default is worked out afresh at each call:

```nib
fn connect(host: String, named port: Int = 5432, named timeoutSeconds: Int = 30) -> String {
	return "${host}:${port} (${timeoutSeconds}s)"
}

fn database() -> String {
	return connect("db.internal", timeoutSeconds: 5)
}
```

Labelled arguments may come in any order. The formatter puts them in the order the
parameters are declared.

When you pass a local that has the same name as the parameter, `name:` on its own is enough:
`port:` means `port: port`.

```nib
fn local() -> String {
	let port = 6543
	return connect("db.internal", port:)
}
```

### Overloads

Functions may share a name when they differ in their number of parameters or in their
`named` parameters, never only in their types:

```nib
fn price(amount: Decimal) -> String {
	return "£${amount}"
}

fn price(amount: Decimal, named currency: String) -> String {
	return "${amount} ${currency}"
}
```

When one operation needs to accept different types, use one of these instead:

- an interface, when the types share behaviour;
- an enum, when there's a closed set of cases;
- a label, when the label says how the value is used: `post(url, json: body)` and
  `post(url, form: body)`;
- a different name, when the operations mean different things: `redirect` stays on the
  site, and `redirectAway` leaves it.

That way a reader always knows which function a call means, without working out the
argument types.

## Closures

```nib
let double = fn(n: Int) -> Int => n * 2
let names = ["ann", "bob"].map(fn(name) => name.toUpperCase())
let evens = [1, 2, 3, 4].filter(fn(n) {
	return n mod 2 == 0
})
```

`fn(…) => expression` returns the expression. A block body uses `return`. A closure that
can fail says so as a declared function does: `fn(text: String) -> Int else ParseError`, or
`fn(out: Writer) else IoError { … }` for one that returns nothing.

A closure's parameter types come from where it's passed: `map` on a `List<String>` passes
each `String`. When nothing tells the closure its types, as for `double`, which is just
stored in a `let`, write them.

A closure can read the variables around it, but it gets their values as they were when the
closure was made, and it can't change them. To let it change a `var`, name that `var` in
`use (mut …)`:

```nib
fn countLong(words: List<String>) -> Int {
	var count = 0
	let tally = fn(word: String) use (mut count) {
		if word.length > 5 {
			count++
		}
	}
	for word in words {
		tally(word)
	}
	return count
}
```

```nib error
// Rejected: the closure changes `count` without naming it in `use (mut count)`.
fn countAll(words: List<String>) -> Int {
	var count = 0
	let tally = fn(word: String) {
		count++
	}
	for word in words {
		tally(word)
	}
	return count
}
```

A closure made inside a method can use `this`, as the code around it can. It holds that
object, not a copy, so when the closure runs later, `this` is still the same object.

`return`, `try` and `fail` inside a closure leave the closure, not the function around it.

## Functions as values

A function's type is written like its signature: `fn(Int) -> Int`, or
`fn(String) -> Email else EmailError` for one that can fail. These can be passed as values:

- a function, by name: `check(isValid)`;
- a static function: `texts.map(Email.parse)`;
- a closure;
- a method bound to its value: `formatter.format`.

A method that changes its value (`mut fn`) can't be passed bare, because the mutation would
be hidden. Wrap it in a closure with `use (mut …)`, which shows it.

A function can return a function. Then `else` belongs to the nearest function type, the
inner one: in `fn(S) -> fn(T) -> Ack else E`, it's the inner function that can fail with `E`.
Parentheses make that plain, and are worth writing: `fn(S) -> (fn(T) -> Ack else E)`.

A function that can't fail can be passed where one that can fail is expected: a
`fn(Request) -> Response` fits a `fn(Request) -> Response else ToResponse`. It simply never
fails.

A parameter the function doesn't use can be named `_`, to show that it's unused:
`fn vote(user: User, _: Action) -> Vote`. A route's handler is the exception: one that
doesn't read the request leaves it out ([The web](09-web.md#the-app-and-its-routes)). In a member that implements an interface, a `named`
parameter keeps the interface's name, because callers label it with that name.

Functions are declared at the top level, or as members of a type. Inside a body, a function
is a closure, `let name = fn(…) => …`, so there's one way to write one. A function that calls
itself, or a generator, is a declared function or method, never a closure, because it's named
before its body is read:

```nib
fn factorial(n: Int) -> Int {
	return n <= 1 ? 1 : n * factorial(n - 1)
}
```

```nib error
// Rejected: a function can't be declared inside another; use a closure.
fn total(prices: List<Int>) -> Int {
	fn double(n: Int) -> Int {
		return n * 2
	}
	return prices.map(double).sum()
}
```

## Pipes

`|>` passes the value on its left to the function on its right. Use it to chain functions
from different modules, where there's no method to call:

```nib
let bytes = rows |> csv.encode |> gzip.compress
```

That's the same as `gzip.compress(csv.encode(rows))`, written in the order it happens.

Each step must be a function that takes exactly one argument. When a function needs more,
write a closure that supplies them: `rows |> fn(r) => csv.encode(r)`. The value is never
slipped into an argument list for you.

Methods come from their type, so `x.f()` always means a member of `x`'s type. To chain free
functions, use a pipe.
