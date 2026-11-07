# Null

A type can't hold `null` unless it says so with `?`. A `String` is always text; a `String?`
is text or `null`.

```nib
record Profile {
	name: String
	nickname: String?
}
```

Use `T?` for something that might not be there:

- a lookup that finds nothing: `map.get(key)`, `repository.find(id)`;
- an optional field;
- a conversion whose value doesn't fit: `big.toInt8()`.

Failure is a different thing, with its own syntax (see [Errors](06-errors.md)).

## Testing for null

Test for `null` with `is null` and `is not null`. Writing `== null` or `!= null` is an
error that points to them, so there's one way to write it.

Comparing a `T?` with a `T` is fine: `nickname == "Ann"` is `false` when `nickname` is
`null`.

```nib
fn label(nickname: String?) -> String {
	if nickname is not null {
		return nickname.toUpperCase()
	}
	return "anonymous"
}
```

## `??`

`a ?? b` gives `a` when it has a value, and `b` when `a` is `null`. It's how a `T?` becomes a
`T`, with a fallback:

```nib
fn shortName(profile: Profile) -> String {
	return profile.nickname ?? profile.name
}
```

The right side can also leave the function: `?? return …`, `?? fail …` or `?? panic(…)`.
When the left side is `null`, the function leaves. Otherwise you get the left side's value,
as a plain `T`:

```nib
fn initial(profile: Profile) -> String {
	let first = profile.name.first ?? return "?"
	return first.toUpperCase()
}
```

The right side can be a block, to run some statements first. The block has to leave: with
`return`, `fail` or `panic`, or, inside a loop, with `break` or `continue`. A block that
would only leave is written on the line instead, as `?? return "?"` is above:

```nib
fn greeting(profile: Profile) -> String {
	let name = profile.nickname ?? {
		print("no nickname for ${profile.name}")
		return "Hi"
	}
	return "Hi, ${name}"
}
```

The block is a way out, not a value: it's a longer `?? return …`, so it still keeps the rule
that a block never gives a value. To work out a fallback in several steps, declare the
binding first with `let name: Type` and set it with `if`
(see [Bindings](01-basics.md#bindings)).

A `?? { … }` block can't go in the condition of an `if`, `while` or `match`, because it would
be hard to tell apart from the statement's own block. Bind the value with `let` first.

## `?.`

`a?.b` reads `b` from `a`, as `a.b` does, but only when `a` has a value. When `a` is `null`,
there's nothing to read `b` from, so the whole expression gives `null` instead.

So `profile?.nickname` is the profile's nickname when there is a profile, and `null` when
`profile` is `null`. Each `?.` in a chain does the same, so `order?.customer?.email` is
`null` if either the order or its customer is missing. The result can be `null`, so its type
ends in `?`, and `??` gives a fallback:

```nib
fn nicknameLength(profile: Profile) -> Int {
	return profile.nickname?.length ?? 0
}
```

Here `nickname` may be `null`. `?.length` gives its length when there is one and `null` when
there isn't, and `?? 0` turns that `null` into `0`.

## Narrowing

Once a local or parameter has been tested, it's trusted. After `x is not null`, the code that
runs only when the test held can use `x` as a plain `T`, with no `?`.

That works in each of these places:

- inside the `if` block whose condition tested it;
- on the right of `and`, after the test on its left (and the same for `or`, `not` and
  `? :`);
- inside a `while` loop whose condition tested it;
- after an `if` whose block always leaves, as here:

```nib
fn describe(nickname: String?) -> String {
	if nickname is null {
		return "no nickname"
	}
	return "known as ${nickname}"
}
```

Assigning a value to a `var` also counts: after `name = "Ann"`, `name` is known not to be
`null`.

Some things are never trusted after a test, because something else could change them between
the test and the use:

- **Fields and getters.** Another method could change a field, or another task could, while
  this one waits on I/O. A getter can give a different answer each time it's read.
- **A `var` that a closure can change** (one captured with `use (mut …)`).
- **A test made before a loop that assigns the `var`.** The next time round it may be `null`
  again. The loop's own condition is tested each time round, though, so
  `while next is not null` can trust `next` inside the loop.

For these, put the value in a `let` first, and test that:

```nib
class Session {
	var user: String? = null

	fn welcome() -> String {
		let name = this.user
		if name is not null {
			return "Welcome back, ${name}"
		}
		return "Welcome"
	}
}
```

A `let` can't change, so the test narrows it. That's the one form: `is not null` names
nothing, and a value that needs a name gets one from a `let`.

```nib error
// Rejected: a field isn't narrowed, because it could change between the test and the use.
class Greeter {
	var name: String? = null

	fn hello() -> String {
		if this.name is not null {
			return "Hello, ${this.name}"
		}
		return "Hello"
	}
}
```

## `?:`

`a ?: b` is for things that can be empty rather than `null`, such as strings and
collections. It gives `a` when `a` has something in it, and `b` when `a` is empty.

```nib
fn title(heading: String) -> String {
	return heading ?: "Untitled"
}
```

`0` and `false` don't count as empty. `?:` works only on types that have `isEmpty`.
