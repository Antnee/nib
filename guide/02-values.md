# Values

## Numbers

| Type | What it is |
|------|------------|
| `Int` | 64-bit signed integer, the usual one |
| `Int8`, `Int16`, `Int32` | smaller signed integers |
| `UInt` | 64-bit unsigned integer |
| `UInt8`, `UInt16`, `UInt32` | smaller unsigned integers |
| `Decimal` | exact base-10 number, for money and anything that must not drift |
| `Float`, `Float32` | binary floating point (IEEE 754) |

A number literal has no fixed type. It takes the type its place expects: the parameter,
field or annotation it goes into, or the other side of an operator. When nothing expects a
particular type, a whole number is an `Int`, and a number with a point is a `Decimal` (not a
`Float`):

```nib
let count = 3            // Int
let vat = 0.20           // Decimal, so 0.10 + 0.20 == 0.30 exactly
let ratio: Float = 0.5   // Float, because it says so
```

An integer type without a width is the 64-bit one, signed or unsigned, so each type has one
name.

An integer literal must fit its type: `300` can't be a `UInt8`. Arithmetic that overflows
panics, in every build.

Only literals adapt like this. A value that already has a type never converts to another
type by itself, even when nothing would be lost. The one exception is a distinct type, which
can be passed where its base is wanted, as an `OrderId` can where an `Int` is
([Types](04-types.md#distinct-types)). You write the conversion where it happens:

```nib
fn lineTotal(quantity: Int, unitPrice: Decimal) -> Decimal {
	return unitPrice * quantity.toDecimal()
}
```

A conversion that can lose information says so in its result type:

- `big.toInt8()` gives an `Int8?`, which is `null` when the value doesn't fit in an `Int8`.
- A number converted to a smaller or whole type gives `null` when it doesn't fit, since
  there's only one way that can go wrong.
- Text is read with the type's `parse`: `Int.parse("42")` can fail in several ways, so it
  fails with a `ParseError` that says which (see [Errors](06-errors.md)). There's no
  `"42".toInt()`, so reading text always looks the same.

### Division

`/` is for `Float` only. Integers use `div` for division and `mod` for the remainder. So
`7 / 2` never quietly gives `3`: division that drops the remainder is asked for by name, as
`7 div 2`.
`Decimal` has no `/`, because most divisions have no exact answer. Instead, the `dividedBy`
method says how many places to keep and how to round:

```nib
fn share(total: Decimal, people: Int) -> Decimal {
	return total.dividedBy(people.toDecimal(), places: 2, rounding: Rounding.HalfToEven)
}
```

```nib error
// Rejected: `Decimal` has no `/`. Say where to stop and how to round, with `dividedBy`.
fn half(price: Decimal) -> Decimal {
	return price / 2
}
```

Every `Decimal` operation that may round takes a `Rounding`, with no default: `HalfToEven`,
`HalfAwayFromZero`, `HalfTowardZero`, `AwayFromZero`, `TowardZero`, `Ceiling` or `Floor`.
People and programs disagree about which way halves go, so the choice is always visible.

To split an amount without losing a cent, `total.allocate(into: 3, places: 2)` gives parts
that add up to the total exactly.

### Formatting

There are no format strings. Each number type has `formatted(…)`, with named arguments, for
use inside interpolation:

```nib
let id = 42
let total = 1234.5
print("Order ${id.formatted(width: 6, fill: "0")}")   // Order 000042
print("Total ${total.formatted(places: 2, rounding: Rounding.HalfToEven, grouping: true)}")
```

### Money

An amount of money is a `Money` from `std.money`: a `Decimal` amount and a `Currency`. It has
no operators, because adding two amounts fails when their currencies differ:

```nib
import std.locale.{Locale}
import std.money.{Currency, CurrencyMismatch, Money}

fn orderTotal(subtotal: Money, shipping: Money, locale: Locale) -> String else CurrencyMismatch {
	let total = try subtotal.plus(shipping)
	return "Total ${total.formatted(locale:)}"
}

fn deliveryCharge() -> Money {
	return Money(amount: 3.95, currency: Currency.of("GBP"))
}
```

- `Currency.of("GBP")` is for a code written in the code, and panics on one that doesn't
  exist. A code that comes from data is read with `Currency.parse`.
- `times(factor, rounding:)` multiplies, such as by a tax rate, and takes a `Rounding`, as
  `Decimal` does.
- `allocate(by: [1, 2])` splits an amount in proportion, and the parts add up to the total
  exactly.
- `toMinorUnits()` gives the amount in pence or cents, as payment providers expect.
- `formatted(locale:)` writes it as people there do: `£3.95` in `en-GB`. There's no default
  locale, as for dates.
- Converting to another currency is an `ExchangeRate`'s job, never `Money`'s.

## Booleans

`Bool` is `true` or `false`, combined with `and`, `or` and `not`.

Only a `Bool` can be a condition. An empty string, `0` and `null` aren't false, so test for
what you mean: `name.isEmpty`, `count == 0`, `user is null`.

Comparisons don't chain. `a < b < c` is an error; write `a < b and b < c`, or `b in a..c`.

## Text

A `String` is UTF-8 and immutable. Its `length` counts what a reader sees as characters
(graphemes). `byteLength` counts bytes, and `codePointLength` counts Unicode code points.
`slice` and `indexOf` count positions in graphemes too. `trim`, `split`, `lines` and
`replace("-", by: "+")` do what they say. Each one gives a new string, because a string never
changes.

Text is built by interpolation, never by `+`:

```nib
fn greeting(name: String, unread: Int) -> String {
	return "Hello, ${name}. You have ${unread} new messages."
}
```

```nib error
// Rejected: there is no `+` on text. Interpolate: "Hello, ${name}".
fn greet(name: String) -> String {
	return "Hello, " + name
}
```

`${…}` takes any expression whose type is `Stringable`. These types are `Stringable`
already:

- the built-in scalars (numbers, `Bool`, `String`);
- backed enums, which give their value;
- distinct types over any of these.

Any other type can implement `Stringable` itself. Without it, a record can't be turned into
text by accident.

A value that may be `null` can't go into `${…}` either. Give it a fallback first:
`${nickname ?? name}`.

```nib
let poem = """
	Roses are red,
	text is UTF-8.
	"""
let quote = """She said "hi"."""
let folder = r"C:\Users\ann"
```

- `"…"` can't span lines. `"""` can: the opening `"""` ends its line, and the closing `"""`
  starts a line of its own, though code may carry on after it, as in `""")`. However far
  the closing `"""` is indented, that much indentation is removed from every line.
- A one-line `"""…"""` holds `"` without escaping.
- `r"…"` is raw: no escapes and no interpolation.
- Escapes: `\n`, `\t`, `\r`, `\0`, `\\`, `\"`, `\$` and `\u{1F600}`.

### Typed literals

A tag before the quote says what the text is for, and decides what happens to each value
interpolated into it:

```nib
let page = html"<p>Hello, ${name}</p>"
let query = sql"select id from users where email = ${email}"
let link = url"/orders/${orderId}"
let file = path"reports/${day}.csv"
let auth = secret"Bearer ${apiKey}"
```

| Tag | Result | What happens to `${value}` |
|-----|--------|-----------------------------|
| `html` | `Html` | escaped for where it lands: text, an attribute, a URL, `<script>`; an `Html` or a `List<Html>` goes in as it is |
| `sql` | `Sql` | sent as a bound parameter, never put into the SQL text; the query is checked against the schema |
| `url` | `Url` with a scheme (`https:`), otherwise `RelativeUrl` | percent-encoded, so it can't add a path segment or a query |
| `path` | `Path` | only types that can't hold `/`, `..` or NUL are accepted |
| `secret` | `Secret` | the result stays secret; it's the only literal a secret can go into (see [Attributes and secrets](11-attributes.md)) |

`secret` can also go before `url` or `html`, as in `secret url"confirm?token=${token}"`, for
a link or markup that holds a secret.

A `RelativeUrl` has no host, so it always stays on the same site: `Response.redirect` takes
one, which means a redirect can't be pointed at another site. A `url"//…"` literal, with a
host but no scheme, is an error.

An API that runs SQL takes an `Sql`, and one that opens files takes a `Path`, so a plain
string can't reach them. The injection-safe form is the only form.

These five, and `r` for raw text, are the only tags. A tag is there because a value put into the text could break
out of it, so each one encodes what goes in. Other text with a format of its own, such as a
time zone or a language tag, is a type with a `parse`: `TimeZone.parse("Europe/London")`.

## Collections

```nib
let primes = [2, 3, 5, 7]
let ages = ["Ann": 34, "Bob": 27]
let nothing: Map<String, Int> = [:]
```

A `Set` is written like a list, and takes its type from where it goes, as a number does:
`let tags: Set<String> = ["tea", "green"]`, and `[]` for an empty one.

`List`, `Map` and `Set` are values, like numbers. A `Map` keeps its keys in the order they
were added.

A collection held in a `let` can't change. One held in a `var` can, and the change affects
only that variable, never another variable that was given the same collection. (Behind the
scenes, a copy is made only when one is changed.)

```nib
var basket = ["tea"]
basket.push("milk")
```

`push` is a `mut fn`, so it can only be called through a `var`.

Indexing works the same way for every collection. `list[i]` and `map[key]` panic when the
index or key is missing. `get` returns `null` instead:

```nib
let first = primes[0]
let age = ages.get("Cy") ?? 0
```

`map`, `filter`, `firstMatch`, `containsMatch` and `allMatch` take a function; `sorted()`, `sum()` and
`join(", ")` work on the items themselves. `reversed()`, `distinct()` and
`groupBy(fn(order) => order.country)` give new collections. `zip` pairs two lists of the
same length item by item, and panics if their lengths differ, so no item is lost unseen. `indexed()` pairs each item with
its position, for a loop that needs both:

```nib
for (i, name) in ["Ann", "Bob"].indexed() {
	print("${i + 1}. ${name}")
}
```

The standard library's common predicates come in pairs, `isEmpty` and `isNotEmpty`,
`contains` and `doesNotContain`, so the usual conditions read without a `not`. `not` is there for the rest, as in `if not password.matches(other)`.

## Tuples

A tuple groups a few values without naming them, and is taken apart with `let`:

```nib
fn bounds(values: List<Int>) -> (Int, Int) {
	return (values.min() ?? 0, values.max() ?? 0)
}
```

```nib
let (low, high) = bounds([3, 1, 4])
```

Use a record as soon as the parts deserve names.

## Ranges

`1..10` includes both ends. `0..<n` stops before `n`. A range is a value, used in loops and
with `in`:

```nib
for i in 0..<3 {
	print("${i}")
}
let valid = age in 18..65
```
