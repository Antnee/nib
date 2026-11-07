# Control flow

## `if`

```nib
fn size(n: Int) -> String {
	if n < 10 {
		return "small"
	} else if n < 100 {
		return "medium"
	} else {
		return "large"
	}
}
```

The condition must be a `Bool`, and needs no brackets around it.

`if` is a statement, so it doesn't give a value. For a value, use `condition ? a : b`. A
`? :` inside another one needs brackets.

## `match`

`match` runs the first arm whose pattern fits. Its arms must cover every case. It can give a
value:

```nib
enum Payment {
	Card(last4: String)
	Transfer(reference: String)
	Voucher
}

fn describe(payment: Payment) -> String {
	return match payment {
		Payment.Card(last4:) => "card ending ${last4}"
		Payment.Transfer(reference:) => "bank transfer ${reference}"
		Payment.Voucher => "voucher"
	}
}
```

Leaving out a variant is an error. So when you add a variant to an enum, the compiler shows
every `match` that has to handle it:

```nib error
// Rejected: `Voucher` isn't covered.
fn icon(payment: Payment) -> String {
	return match payment {
		Payment.Card => "💳"
		Payment.Transfer => "🏦"
	}
}
```

`_` matches anything. Using `_` for the variants of an enum from your own package gives a
warning, because a variant added later would then be caught by `_` without anyone noticing.

### Patterns

| Pattern | Matches |
|---------|---------|
| `Payment.Voucher`, `Payment.Card` | a variant, whatever it holds |
| `Payment.Card(last4:)` | a variant, binding its `last4` to a name of the same name |
| `Payment.Card(last4: digits)` | the same, binding it to `digits` |
| `PasswordError.TooShort(minimum: 12)` | a variant whose `minimum` is 12 |
| `WebError.Storage(err)` | a variant that holds one value without a name, such as `Result.Ok(T)` |
| `CheckoutError.PaymentFailed(PaymentError.Declined(reason:))` | patterns inside patterns |
| `200`, `"GBP"`, `true` | a literal |
| `Status.NOT_FOUND` | a constant |
| `null` | `null`; after `is not`, a value that isn't `null` |
| `name` | anything, bound to `name`; after a `null` arm, it isn't `null` |
| `(hour, count)` | a tuple, binding each part; against a `(Int, Int)?`, one that isn't `null` |
| `Payment.Card or Payment.Voucher` | either; each alternative binds the same names |
| `_` | anything |

A pattern names a variant's values, as building the variant does, and names only the ones it
needs. So `Shape.Rectangle(width:)` matches every rectangle and binds its `width`. A variant
that holds one value without a name, such as `Result`'s `Ok(T)` or a `from` variant, takes a
pattern for it in brackets: `Result.Ok(response)`.

A variant is written with its enum's name in a pattern, as it is everywhere else, so a line
says what it tests without the type in view. `if outcome is LinkOutcome.Expired` can't be
mistaken for a constant or a type.

Against an optional value, every pattern except `null`, `_` and a bare name also checks that
the value isn't `null`. So `if busiest(hours) is (hour, count)` runs only when there was a
busiest hour.

An arm can add a condition with `if`, which must also hold for the arm to run:

```nib
fn shipping(weightGrams: Int, named express: Bool) -> String {
	return match weightGrams {
		0 => "nothing to send"
		_ if express => "courier"
		_ => "post"
	}
}
```

An arm can be a block, to run some statements. A block never gives a value. So an arm that
needs a block goes in a `match` used as a statement, where each arm does its own work:

```nib
fn summary(payment: Payment) -> String {
	match payment {
		Payment.Card(last4:) => {
			print("card payment")
			return "card ${last4}"
		}
		Payment.Transfer or Payment.Voucher => return "other"
	}
}
```

Inside an arm, `return` and `fail` leave the function, as they do anywhere else.

When an arm needs a few steps to work out its value, give the steps a function of their own,
and the arm calls it:

```nib
fn fee(payment: Payment) -> Int {
	return match payment {
		Payment.Card => cardFee()
		Payment.Transfer or Payment.Voucher => 0
	}
}

fn cardFee() -> Int {
	print("card fee")
	return 20
}
```

Or declare a binding first with its type, then set it in each arm:

```nib
fn surcharge(payment: Payment) -> Int {
	let pence: Int
	match payment {
		Payment.Card => {
			print("card surcharge")
			pence = 20
		}
		Payment.Transfer or Payment.Voucher => pence = 0
	}
	return pence
}
```

The checker makes sure every arm sets it, or leaves the function. An arm can also change a
`var`, as `Transfer => count++`.

In a `match` that gives a value, each arm is a value, or leaves with `return` or `fail`:

```nib error
// Rejected: this `match` gives a value, and a block arm never gives one.
fn summary(payment: Payment) -> String {
	return match payment {
		Payment.Card(last4:) => {
			print("card payment")
		}
		Payment.Transfer or Payment.Voucher => "other"
	}
}
```

### Why a block arm doesn't give a value

A block that gave a value would need a way to say which line is the value. A last line that
counts by itself would sit beside functions, which always say `return`. A keyword for it
would be one more thing to learn, and `return` there would leave the arm rather than the
function. So there are two ways to work a value out in steps, both ordinary code:

- Give the arm a function of its own, as `fee` does above with `cardFee()`. This suits most
  arms, and gives the work a name.
- Declare the binding first and set it in each arm, as `surcharge` does. This suits an arm
  that does one small thing first, such as logging.

PHP's `match` works the same way: each arm is one expression.

### `is`

`is` tests one pattern and gives a `Bool`, so it works in a condition or anywhere else a
`Bool` is wanted. Names the pattern binds exist only in the code that runs when the test
held:

```nib
fn lastFour(payment: Payment) -> String? {
	if payment is Payment.Card(last4:) {
		return last4
	}
	return null
}
```

`is` tests any pattern a `match` arm can have, from the table above. It can't ask which
class is behind an interface value. Instead, give the interface a method for what you need, or use an enum,
whose `match` the compiler checks for every case.

## Loops

```nib
fn loops(names: List<String>) {
	for name in names {
		print(name)
	}

	var n = 3
	while n > 0 {
		n--
	}

	do {
		n++
	} while n < 3

	outer: for a in 1..3 {
		for b in 1..3 {
			if a * b == 4 {
				break outer
			}
		}
	}
}
```

- `for x in source` goes through anything `Iterable`: lists, sets, maps (as
  `(key, value)` tuples) and ranges.
- The loop variable can't be assigned.
- The loop goes through a collection as it was when the loop started, even if the variable
  holding it changes during the loop.
- There's no C-style `for (i = 0; …)`: use a range, `for i in 0..<n`.
- `break` and `continue` take an optional label.

## `defer`

`defer` runs an expression when the block it's in ends, however it ends:

```nib
interface Transaction {
	fn commit() else StorageError
	fn rollback()
}

enum StorageError implements Error {
	Lost

	override get message: String => "the connection was lost"
}

fn transfer(tx: Transaction) else StorageError {
	defer tx.rollback()
	print("moving money")
	try tx.commit()
}
```

- It runs at the end of the **block** it's in, not the end of the function.
- It runs however the block ends: normally, with `return`, or with `fail`. It doesn't run
  on a panic, where the host cleans up instead.
- Several `defer`s run in reverse order.
- `defer tx.rollback()` is the usual way to handle a transaction. `rollback` does nothing
  after `commit`, so the transaction is rolled back on every path except success.
- `defer else …` runs only when the block doesn't finish normally: on a `fail`, or when the
  work is cancelled. Use it to undo work that isn't in a transaction.
- A deferred call that can fail handles its own error.
