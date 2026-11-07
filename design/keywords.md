# Reserved words

The words used in examples so far. A word is final only when every decision that uses it is
**agreed** in `decisions.md`. **Contextual** words are keywords only in the position shown,
and stay usable as ordinary names everywhere else. Every reserved word can still name a
member, after `.`, `fn` or `get` or before `:` (`use: String?`, `factory.new()`, #198).

| Word | Used for | Decision |
|------|----------|----------|
| `alias` | interchangeable type name | #37 |
| `and` `or` `not` | logical operators; `or` also joins match alternatives | #6b, #50 |
| `as` | import alias | #80 |
| `class` `record` `interface` `enum` `type` | type declarations | #10, #11, #37 |
| `const` `let` `var` | bindings; `const` also marks a const generic parameter (reserved) | #7, #68d |
| `defer` | deferred cleanup, including `defer else` | #46 |
| `div` `mod` | integer division and remainder | #36b |
| `else` `if` `match` `return` | control flow; `else` also marks the error type and `let … else` | #44, #49, #50 |
| `fail` `try` | error propagation | #52 |
| `false` `true` `null` | literals | |
| `fn` `static` | functions | #27, #34 |
| `for` `in` `while` `do` `break` `continue` | loops; `in` also tests range membership | #48 |
| `get` | contextual: a computed read-only property, `get total: Money => …`; an ordinary name elsewhere (`map.get(key)`) | #13, #198 |
| `implements` | interface conformance | #10b |
| `import` | modules | #18 |
| `is` | pattern test | #31 |
| `lazy` | field built on first read | #105 |
| `new` | a new object: a class through its constructor, `new Mailer(…)`, or an inline interface implementation, `new ShippingRates { … }` | #62a, #167, #276 |
| `mut` | mutating methods, parameters and captures | #10f, #63 |
| `private` `pub` | visibility | #22 |
| `start` | begin a concurrent task | #113 |
| `this` / `This` | the current instance / the implementing type | #10e, #69 |
| `use` | by-reference capture (`use (mut x)`) | #63 |
| `when` | conditional methods | #73 |
| `with` | record copy-with-changes | #242 |
| `yield` | a generator's next item | #250 |
| `from` | contextual: an enum variant's wrapped error, `Cart(from CartError)` | #52b |
| `test` `expect` | contextual: test blocks and assertions in `.test.nibl` files | #62 |
| `named` | contextual: a parameter that must be labelled at every call | #166 |
| `attribute` | contextual: declares an attribute, `attribute deprecated { … }` | #116 |
| `override` | contextual: a member that implements an interface member, `override fn apply(db: Db) …`; an ordinary name elsewhere | #227 |
| `construct` | contextual: a class's constructor, `construct(private db: Db) {}`, only before `(` in a class body | #276 |
| `internal` | contextual: a constructor parameter that becomes a package-wide field, `construct(internal from: Email)`; written nowhere else | #277 |
| `secret` | contextual: before a typed literal, `secret url"…"`, makes its value a secret | #271 |

`_` is not a word, but it is reserved with one meaning, "ignore", wherever a name would be bound: patterns, `let _ =`, `else _` and unused parameters (#160). There is no leading-dot member shorthand: write a closure, `fn(line) => line.total` (#239).
`panic`, `assert` and `expectPanic` are ordinary functions, not keywords.

Dropped: `module` (files carry no module header, #77).

The parser in `tools/nib` uses this list; `design/grammar.md` section 1 is the canonical copy.
