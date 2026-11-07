# Types

There are two kinds of type with fields, `record` and `class`, plus enums, distinct types
and interfaces. There is no inheritance: shared behaviour comes from interfaces.

## Records

A record is a value: data with no identity of its own.

```nib
record Point {
	x: Int
	y: Int
}

record Line {
	sku: String
	quantity: Int = 1
	unitPrice: Decimal

	get total: Decimal => this.unitPrice * this.quantity.toDecimal()

	fn describe() -> String {
		return "${this.quantity} × ${this.sku}"
	}
}
```

- A record is built by naming its fields in brackets. A field with a default can be left
  out. When a field's value is a local with the same name, write `name:` on its own:

  ```nib
  let origin = Point(x: 0, y: 0)
  let tea = Line(sku: "TEA-01", unitPrice: 4.50)
  let x = 3
  let p = Point(x:, y: 4)
  ```

- Every argument names its field, because a record's field order isn't part of its API.
- Fields are immutable. `with` makes a copy with some fields changed:

  ```nib
  let moved = origin with (x: 5)
  ```

  The fields it doesn't name keep their values. `with` is only for records: a class has
  identity, and changes through its own methods.

- Two records are equal when their fields are equal, so `==` compares their contents.
- A record can be a `Map` key or a `Set` element, as long as all its fields can be.
- `this` is always written: `this.quantity`, never a bare `quantity`.

## Classes

A class has identity: two instances with the same fields are still two different things. A
class can change its own `var` fields:

```nib
class Counter {
	private var count: Int = 0

	get current: Int => this.count

	fn increment() {
		this.count++
	}
}

fn counted() -> Int {
	let counter = new Counter()
	counter.increment()
	return counter.current
}
```

- A class is built with `new`, which runs its constructor. `new` always makes a new object,
  so it's never written for a record, which is a value.
- Only the type itself writes its fields; outside code calls its methods:

  ```nib error
  // Rejected: `count` is private, and only `Counter`'s own code writes its fields.
  fn reset(counter: Counter) {
  	counter.count = 0
  }
  ```

- `let counter = …` means `counter` always refers to the same object. The object itself can
  still change, through its methods.
- A class has no `==` unless it implements `Equatable`. `sameInstance(a, b)` asks whether
  two values are the same object.
- Use a class for a service, a repository or anything else with dependencies, which it
  holds as fields. Use a record for data.

### Constructors

A class's constructor is declared with `construct`. It has parameters and a body, and no
return type, because it always builds the class it's in.

```nib
class Greeter {
	construct(private greeting: String, named private punctuation: String = "!") {}

	private var greeted: Int = 0

	fn greet(name: String) -> String {
		this.greeted++
		return "${this.greeting}, ${name}${this.punctuation}"
	}
}

fn greeters() -> List<Greeter> {
	return [new Greeter("Hello"), new Greeter("Hi", punctuation: "?")]
}
```

- A parameter marked `private`, `internal`, `pub` or `var` is also a field, and it's set
  from the argument before the body runs. Most constructors only store what they're given,
  so their body is empty: `{}`.
- The marker says who can see the field. `private` keeps it inside the class. `internal`
  makes it visible anywhere in the package, which is what a field gets when nothing is
  written. `pub` makes it visible to other packages too. `var` makes it a field that can be
  changed, visible anywhere in the package, and it can follow `private` or `pub`.
- `internal` is written only here, because a parameter without a marker isn't a field.
  Everywhere else, the package-wide visibility is the default, and writing `internal` is an
  error:

  ```nib error
  // Rejected: package-wide is the default, so `internal` is left out here.
  class Counter {
  	internal var count: Int = 0
  }
  ```

- A parameter without a marker is only a parameter. The body uses it to set other fields:

  ```nib
  class Mailbox {
  	construct(private owner: String, domain: String) {
  		this.address = "${owner}@${domain}"
  	}

  	address: String
  }
  ```

- The body sets every field that has no default and isn't declared by a parameter, once,
  on every path. It can't read a field before setting it. It can't call the class's methods
  or hand `this` on until every field is set, because they could read a field that isn't set
  yet. A constructor has no `return`.
- A class has one constructor, or none. A class with none is built with `new Counter()`,
  taking nothing, so each of its fields needs a default. An empty `construct() {}` would say
  the same, so it's left out.
- A constructor can't fail. When building one can, write a static function that checks its
  arguments, returns `Type else Error`, and calls `new`.
- A `private` constructor means only the class's own code can call `new`, so everyone else
  goes through its static functions:

  ```nib
  record TooManySeats implements Error {
  	maximum: Int

  	override get message: String => "more than ${this.maximum} seats"
  }

  class Booking {
  	private construct(private seats: Int) {}

  	static fn of(seats: Int) -> Booking else TooManySeats {
  		if seats > 8 {
  			fail TooManySeats(maximum: 8)
  		}
  		return new Booking(seats)
  	}
  }
  ```

```nib error
// Rejected: nothing sets `name`, and it has no default.
class Welcome {
	construct(private greeting: String) {}

	private name: String
}
```

```nib error
// Rejected: a record is a value, built from its fields without `new`.
record Point {
	x: Int
	y: Int
}

fn origin() -> Point {
	return new Point(x: 0, y: 0)
}
```

### `lazy` fields

A `lazy` field is built the first time it's read, then kept:

```nib
class Services {
	private lazy greeting: String = "hello from ${this.name}"
	name: String = "the shop"
}
```

`lazy` fields can be declared in any order. Two that depend on each other in a cycle are a
compile error. The expression that builds one can't fail.

## Members

| Member | Written | Read |
|--------|---------|------|
| field | `quantity: Int` | `line.quantity` |
| getter | `get total: Decimal => …` | `line.total` |
| method | `fn describe() -> String { … }` | `line.describe()` |
| constructor | `construct(private x: Int) { … }` | `new Counter(…)` |
| static function | `static fn origin() -> Point { … }` | `Point.origin()` |
| constant | `const ORIGIN: Point = …` | `Point.ORIGIN` |

A method whose body is more than one expression uses a block with `return`, like a
function. A getter's body is always one expression, after `=>`.

**A getter is for what a value is or has**, such as `length`, `isEmpty` or `total`. A getter:

- is read without brackets, so it takes no arguments;
- can't fail, and can't change anything;
- is cheap: one expression over the value's fields.

```nib error
// Rejected: a getter's body is one expression. Adding up the lines is a method's job.
class Basket {
	construct(private prices: List<Int>) {}

	get total: Int {
		var sum = 0
		for price in this.prices {
			sum += price
		}
		return sum
	}
}
```

**A method is for what a value does**:

- work over many items: `sum()`, `sorted()`;
- conversions: `toDecimal()`;
- anything with an effect, or that can give a different answer each time: `now()`;
- anything that takes arguments.

The compiler tells you when a getter is called with brackets, or when a method is read
without them and then used as if it were its result (`cart.subtotal.formatted`). A method
named without brackets on purpose is a function value: see
[Functions as values](03-functions.md#functions-as-values).

A member is visible to the whole package, unless it's marked `private`, which makes it
visible only inside its type. See [Modules and packages](08-modules.md) for `pub`.

### Mutating values

A record, a collection or a distinct type is a value, so changing one means replacing it
with a new one. A method that does that is marked `mut fn`. It can only be called through a
`var`, so a reader can see that the variable will change. The fields it changes say `var`
too, as they do in a class:

```nib
record Tally {
	var count: Int

	mut fn add(n: Int) {
		this.count += n
	}
}
```

```nib
var tally = Tally(count: 0)
tally.add(2)
```

```nib error
// Rejected: `add` changes the tally, so it needs a `var`.
fn total() -> Int {
	let tally = Tally(count: 0)
	tally.add(2)
	return tally.count
}
```

Classes don't need `mut`: changing their own fields is what they're for.

## Enums

```nib
enum OrderStatus: String {
	Pending = "pending"
	Paid = "paid"
	Shipped = "shipped"
}

enum Shape {
	Circle(radius: Decimal)
	Rectangle(width: Decimal, height: Decimal)

	get isRound: Bool => match this {
		Shape.Circle => true
		Shape.Rectangle => false
	}
}
```

- A variant can carry values, as `Circle(radius:)` does. They're named like a record's
  fields, both when it's built and in a pattern: `Shape.Circle(radius: 2)` and
  `Shape.Circle(radius:) =>`.
- A variant can instead hold one value without a name, as `Result`'s `Ok(T)` does. Then the
  value isn't named anywhere: `Result.Ok(42)` and `Result.Ok(n) =>`.
- An enum with a type after its name (`: String`) is **backed**: each variant has a value,
  for storing or sending.
  - `OrderStatus.Paid.value` is `"paid"`.
  - `OrderStatus.fromValue("paid")` gives an `OrderStatus?`, which is `null` for a value
    that matches no variant.
- A variant is always written with its enum's name: `OrderStatus.Paid`,
  `Shape.Circle(radius: 2)`, and in a pattern `Shape.Circle(radius:) =>`.
- `match` over an enum must cover every variant (see [Control flow](07-control-flow.md)).
- Enums can have getters and methods.

## Distinct types

`type` makes a new type from an existing one. `type OrderId: Int` reads "an `OrderId`, backed
by an `Int`", as a backed enum's `: String` does. It isn't an alias: a `UserId` is not an
`OrderId`, although both are `Int`s underneath.

```nib
type UserId: Int
type OrderId: Int

fn findOrder(id: OrderId) -> String {
	return "order ${id}"
}

fn example() -> String {
	return findOrder(OrderId(42))
}
```

- `OrderId(42)` builds one. A `UserId` passed where an `OrderId` is wanted is an error.
- Comparing a `UserId` with an `OrderId` is an error too. Values of different types are never
  equal, so `==` between them is always a mistake.

  ```nib error
  // Rejected: a `UserId` and an `OrderId` are different types, so they're never equal.
  type UserId: Int

  fn isSameNumber(user: UserId, order: OrderId) -> Bool {
  	return user == order
  }
  ```

- A distinct type is a kind of its base type, so it can be passed where the base is wanted.
  Above, `id` goes into `${…}` as an `Int`. To keep an ID out of a quantity, give the
  quantity a type of its own too.
- It keeps what its base can do: an `OrderId` can be compared with `<`, used as a map key,
  and read from a path or a form.
- It has no arithmetic, because most distinct types are identities, and adding to an ID
  means nothing. A distinct type that is a number says so with `implements Numeric`:

  ```nib
  type Qty: Int implements Numeric

  fn restock(stock: Qty, delivered: Qty) -> Qty {
  	return stock + delivered
  }
  ```

  ```nib error
  // Rejected: an `OrderId` is an identity, not a number, so it has no `+`.
  fn nextOrder(id: OrderId) -> Int {
  	return id + 1
  }
  ```

- `+` and `-` between two values of one such type, or one and a literal, give that type:
  `stock + delivered` and `stock - 1` are `Qty`s. `*`, `/`, `div` and `mod` give the base,
  so `stock * 2` is an `Int`, since a quantity times a quantity isn't a quantity. With a
  plain `Int`, the answer is an `Int`, the type that holds both.
- Two different distinct types never mix: `cents + qty` is an error, as `==` between them is.
- A distinct type can take type parameters that only the compiler uses. `SessionKey<UserId>`
  is a `String` underneath, the key's name, but the type parameter says what's stored under
  it, so a read gives back a `UserId`.
- With `private`, only the type's own functions can build one, so validation can't be
  skipped:

  ```nib
  type Email: private String implements Parseable {
  	override static fn parse(text: String) -> Email else EmailError {
  		if text.doesNotContain("@") {
  			fail EmailError.Invalid
  		}
  		return Email(text.trim().toLowerCase())
  	}
  }

  enum EmailError implements Error {
  	Invalid

  	override get message: String => "not an email address"
  }
  ```

  ```nib error
  // Rejected: `Email("…")` is private to `Email`, so `parse` is the only way in.
  fn sneak() -> Email {
  	return Email("not checked")
  }
  ```

- A distinct type can have methods and getters as well as static functions. Inside one,
  `this` is the value, and it can be passed where its base is wanted.
- A distinct type such as `type CartId: Int` is read from a path, a form or a query through
  its base type, so it needs nothing more. `implements Parseable` is for a type that writes
  its own `parse`. A type with a `private` constructor must write one, because validating is
  the reason it exists.
- `alias Handler = fn(String) -> String` gives an existing type a second name; the two are
  interchangeable. So `=` means the same type, and `:` means a new type backed by another.

  ```nib error
  // Rejected: `=` would mean the same type, so a distinct type is written with `:`.
  type AccountId = Int
  ```
- A type marked `@sensitive` is different: it doesn't convert to its base at all (see
  [Attributes and secrets](11-attributes.md)).

## Interfaces

```nib
interface Notifier {
	fn send(to: String, text: String) -> Bool

	fn sendAll(to: List<String>, text: String) -> Int {
		return to.filter(fn(address) => this.send(address, text)).length
	}
}

class ConsoleNotifier implements Notifier {
	override fn send(to: String, text: String) -> Bool {
		print("to ${to}: ${text}")
		return true
	}
}
```

- A type says which interfaces it implements, and only on its own declaration:
  `implements Notifier, Comparable`. The exceptions are the few the compiler gives a type by
  itself: `Equatable` and `Hashable` (see below), and `Loggable`, which lets a value go in a
  log ([Where logs go](15-host.md#where-logs-go)).
- Every member that implements an interface member is marked `override`. If the interface
  renames that member, the `override` no longer matches anything, so the mistake is caught.
  It also shows a reader which members are there for an interface.
- An implementation keeps which parameters are `named`, and their names, because a call
  labels them whichever type it calls through. Other parameters can take names that suit
  the implementation.
- A parameter the implementation doesn't use can be named `_`. If it's `named`, callers
  still label it with the interface's name.
- An implementation may fail with less than the interface member allows, or not fail at all.
  A caller through the interface still handles the interface's failure. A member declared
  `-> Response else ToResponse` can be implemented as `-> Response`.
- An interface member with a body is a default, which an implementing type may replace.
- An interface can require a getter, such as `get users: UserRepository`. A type can meet it
  with a field or a getter, and its type may be more specific: a field
  `override users: InMemoryUserRepository` meets it, because an `InMemoryUserRepository` is
  a `UserRepository`.
- A value converts by itself to any interface its type implements, so an `HttpError` can be
  passed where an `Error` is wanted.
- An interface can require a static function, such as
  `static fn parse(text: String) -> This else Error`. `This` means the implementing type.
- If two interfaces need the same member name with different types, a type can't implement
  both. Wrap it: a small adapter implements the second.

```nib error
// Rejected: `text` isn't `named` in `Notifier.send`, so it isn't here either.
class SmsNotifier implements Notifier {
	override fn send(number: String, named text: String) -> Bool {
		print("sms ${number}: ${text}")
		return true
	}
}
```

For a one-off implementation, usually in a test, `new` builds one inline:

```nib
fn silent() -> Notifier {
	return new Notifier {
		override fn send(to: String, text: String) -> Bool {
			return true
		}
	}
}
```

Either way, `new` makes a new object: of a named class, through its constructor, or of a
one-off implementation, from the members written with it.

### Equality and order

Records, enums and distinct types are `Equatable` and `Hashable` automatically when their
fields are. Ordering is opt-in, through `Comparable`, which gives `<`, `<=`, `>` and `>=`,
sorting, `min` and `max`:

```nib
record Version implements Comparable {
	major: Int
	minor: Int

	override fn compare(other: Version) -> Ordering {
		if this.major != other.major {
			return this.major < other.major ? Ordering.Less : Ordering.Greater
		}
		if this.minor == other.minor {
			return Ordering.Equal
		}
		return this.minor < other.minor ? Ordering.Less : Ordering.Greater
	}
}
```

### Arithmetic

The arithmetic operators, `+`, `-`, `*` and `/`, are for numbers only, and `/` only for
`Float`. Every other type
names its arithmetic as methods, and the standard library does the same:

| Operator | Method |
|----------|--------|
| `+` | `plus` |
| `-` | `minus` |
| `*` | `times` |
| `/` | `dividedBy` |

```nib
import std.time.{Clock, Duration, Instant}

fn expiry(clock: Clock) -> Instant {
	return clock.now().plus(Duration.of(hours: 24))
}
```

A method can fail where an operator can't. Adding two amounts of money in different
currencies is an error, so `std.money`'s `Money` declares `fn plus(other: Money) -> Money else
CurrencyMismatch`, and a caller writes `try price.plus(shipping)`.

There's no operator overloading, so your own types can't define `+` either.

```nib error
// Rejected: `+` is for numbers only. Times and durations use `plus`.
import std.time.{Clock, Duration, Instant}

fn expiry(clock: Clock) -> Instant {
	return clock.now() + Duration.of(hours: 24)
}
```

## Generics

```nib
record Page<T> {
	items: List<T>
	number: Int
}

fn largest<T: Comparable>(items: List<T>) -> T? {
	return items.max()
}
```

- Type parameters go in angle brackets. A constraint names an interface the type must
  implement: `<T: Comparable>`, `<K: Hashable and Comparable>`.
- A call's type arguments are worked out from its arguments, or from a type written in the
  same statement. That type can be a `let`'s, as in `let page: Page<User> = …`, or that of
  the parameter the call is passed to: `checkout(access: new Access())` builds an
  `Access<User>` when `checkout` takes one. In a chain such as
  `new Access().register(voter)`, the type the whole chain is given fills in the first
  call's. When nothing says, the call writes them all:
  `body.json<Quote>()`.
- A method can ask more of a type parameter than its type does. `List<T>` works with any
  `T`, but its `sorted()` is declared `when T: Comparable`. Calling `sorted()` on a list of
  something that isn't `Comparable` is an error that says so.
- `List<Cat>` is not a `List<Animal>`, even if `Cat` implements `Animal`. Convert it with
  `cats.map(fn(c) => c)`.
- A type parameter can have a default, last in the list: `Iterator<T, E = Never>`.
