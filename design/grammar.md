# Grammar

The syntax of Nib as the checker in `tools/nib` implements it. This file is the
specification: when it and the parser disagree, one of them has a bug, and the fix goes into
both. Rules that come from a decision cite it, as in `decisions.md`.

Notation (EBNF): `a b` is a sequence, `a | b` a choice, `[ a ]` optional, `{ a }` zero or
more, `"x"` a literal token, `NAME` a token class. `sep(x, ",")` is a comma-separated list of
`x` that may end with a trailing comma (#145).

## 1. Lexical structure

### Source text

Source is UTF-8. Identifiers and keywords are ASCII. A file may start with a `#!` line (#59),
which is ignored.

### Whitespace, newlines and comments

Spaces, tabs and carriage returns separate tokens. Newlines are significant (section 3).

- `// …` runs to the end of the line.
- `/// …` is a doc comment (CommonMark). Its code examples illustrate and aren't run (#243), but they must parse, so
  the checker parses them: fenced blocks marked `nib` (or unmarked) and indented blocks.
- `/* … */` nests, so code that already contains block comments can be commented out (#59).

### Names

```
NAME = letter { letter | digit | "_" } ;      letter = "A"…"Z" | "a"…"z" | "_"
```

The compiler enforces case (#54), so the first letter says what a name is:

| Kind | Case | Example |
|------|------|---------|
| types, enum variants, type parameters | PascalCase | `HttpClient`, `T` |
| functions, methods, fields, getters, variables, parameters, labels, attributes | camelCase | `userId`, `@mustUse` |
| constants (`const`) | UPPER_SNAKE_CASE | `MINIMUM_PASSWORD_LENGTH` |
| modules (directories) | lowercase letters and digits | `payments` |

Acronyms are written as words: two capitals in a row are an error (`HTTPClient` must be
`HttpClient`). The one exception is the unsigned integer types, `UInt` and `UInt8` to `UInt32`,
and their conversions (`toUInt()`), where `U` is a word (#209). `_` on its own means "ignore" and only appears where a name would be bound
(#160).

### Keywords

Reserved:

```
alias and as break catch class const continue defer div do else enum fail false fn for if
implements import in interface is lazy let match mod mut new not null or private pub
record return start static this This true try type use var when while with yield
```

A reserved word can't name a variable, a parameter, a label, a type, a module or a
top-level function, because there it would be read as the keyword. It can name a
**member** (#198), because a member name always comes after `.`, `fn` or `get`, or before
`:`, and no keyword can appear there:

- a field, getter or method: `use: String?`, `get match: Bool`, `fn new() -> Range`;
- a member access: `range.from`, `factory.new()`;
- a named argument (a record's field, when building one) or a named pattern field:
  `@deprecated(since: "1.4", use: "orders.place")`, `Range(in: true)`,
  `Moved(from: 0, to: t)`.

A punned argument (`f(use:)`) still fails, since it names a variable.
To keep these positions free, the language never adds a keyword that follows `.` (like
Rust's `.await`) or is followed by `:`.

Contextual (keywords only in the position shown, ordinary names elsewhere): `get` (a getter
member), `from` (a wrapped error in a variant, #52b), `named` (a parameter modifier, #166),
`secret` (before a tagged string, #271),
`attribute` (a declaration, #116), `test` and `expect` (in `.test.nibl` files, #62).
Keywords added after version 1 are contextual, so they never break existing code.

### Numbers

```
INT     = digit { digit | "_" } | "0x" hexdigit { hexdigit | "_" } | "0b" bit { bit | "_" } ;
DECIMAL = digit { digit | "_" } "." digit { digit | "_" } ;
```

A fraction needs a digit after the dot, so `1..10` is a range. A literal takes its type
from context (#6, #230): an `INT` can be any integer type, `Float`, `Float32` or `Decimal`,
and a `DECIMAL` a `Decimal`, `Float` or `Float32`. With no context, an `INT` is an `Int` and
a `DECIMAL` is a `Decimal`.

### Strings

```
STRING = [ TAG ] ( '"' { char | escape | interp } '"'
                 | '"""' { char | escape | interp } '"""'          (one line)
                 | '"""' newline { line } indent '"""' )            (multi-line)
         | 'r"' { char } '"' | 'r"""' … '"""' ;                     (raw: no escapes or ${})
TAG    = "html" | "sql" | "url" | "path" | "secret" ;     written directly before the quote
secretLiteral = "secret" ( 'url' | 'html' ) STRING ;      (#271: a `Secret<Url>` or `Secret<Html>`)
interp = "${" expr "}" ;
escape = "\n" | "\t" | "\r" | "\0" | "\\" | '\"' | "\$" | "\u{" hexdigits "}" ;
```

- `"…"` can't contain a newline; use `"""` (#43).
- A one-line `"""…"""` exists so that a literal containing `"` needs no escaping (#129).
- In a multi-line `"""`, the opening `"""` ends its line and the closing `"""` starts a
  line of its own (code may follow it, as in `""")`). Its indentation is removed from every
  line, and a non-blank line that is
  less indented is an error. The newline before the closing `"""` isn't part of the string
  (#43, as in PHP 7.3 heredocs and C# raw strings).
- `${…}` holds any expression, including other string literals (#140).
- `$` not followed by `{` is an ordinary character (`"$"`).
- Single quotes and backticks aren't used (#43).

### Operators and punctuation

```
( ) [ ] { } , : . ?. ? ?? ?: = == != < <= > >= + - * / & | ^ ~ << >> |> .. ..< => -> @
+= -= *= /= ++ --
```

`>>` is read as two `>` tokens with nothing between them, so `List<List<T>>` closes cleanly.
The checker explains the usual mistakes from other languages: `;`, `&&`, `||`, `!`, `%`, `$x`.

## 2. Files and declarations

```
file        = { import } { declaration } ;
import      = "import" path [ "." "{" sep(importName, ",") "}" | "with" "{" sep(importName, ",") "}" ]
              [ "as" NAME ] ;
path        = NAME { "." NAME } ;
importName  = NAME | "@" NAME ;

declaration = test | { attribute } [ visibility ] ( function | typeDecl | enumDecl
              | distinctDecl | aliasDecl | constDecl | attributeDecl ) ;
visibility  = "pub" | "private" ;
attribute   = "@" NAME [ "(" sep(argument, ",") ")" ] ;
```

Each declaration starts on a new line. Top level holds only declarations (#81).

### Imports (#80, #192)

- `import std.http` brings in the module, used by its last segment (`http.get(…)`), or by
  the name after `as`.
- `import shop.orders.{Order, OrderStatus}` brings in types by name. Constants may be
  imported by name too (#202). Functions never are: they are called through their
  module.
- `import shop.ui with {SignUpForm}` brings in the module and names from it (#337). `fmt`
  merges a module import and a names import of the same module into it. `as` doesn't go
  with it.
- An attribute is imported with `@`: `import std.db.{@db, Db}`. The prelude's checked
  attributes need no import: `@pure`, `@mustUse`, `@callerLocation`,
  `@deprecated`, `@sensitive`, `@opens`.
- The first segment is `std`, the package's own root, or a dependency's key in
  `nib.toml`.
- Unused imports are warnings (#80a).

### Functions

```
function    = "fn" NAME [ typeParams ] params [ "->" type ] [ "else" type ] [ when ] block ;
                                        (`else` with no `->` returns nothing, #297)
params      = "(" sep(param, ",") ")" ;
param       = { attribute } [ "named" ] [ visibility | "internal" ] [ "var" ] [ "mut" ] ( NAME | "_" ) ":" type [ "=" expr ] ;
typeParams  = "<" sep(typeParam, ",") ">" ;
typeParam   = NAME [ ":" type { "and" type } ] [ "=" type ] ;     (defaults come last, #216)
when        = "when" sep(NAME ":" type { "and" type }, ",") ;
```

Only a `named` parameter may have a default (#211), so a call that changes it always says
so; the default is evaluated at each call. Overloads may not differ only in parameters with
defaults. A visibility or `var` on a parameter is allowed only in a class's constructor, where it
makes the parameter a field too (#276). `<const N: Int>` is reserved
(#68d). `-> T else E` is the result type (#9c). `when` adds constraints to one method of a
generic type (#73).

### Types

```
typeDecl     = ( "record" | "class" | "interface" ) NAME [ typeParams ] [ implements ] body ;
enumDecl     = "enum" NAME [ typeParams ] [ ":" type ] [ implements ] body ;
distinctDecl = "type" NAME [ typeParams ] ":" [ "private" ] type [ implements ] [ body ] ;
                                        (`:` as a backed enum's, since `=` means the same type, #303)
aliasDecl    = "alias" NAME [ typeParams ] "=" type ;
attributeDecl= "attribute" NAME [ implements ] body ;
constDecl    = "const" NAME [ ":" type ] "=" expr ;
implements   = "implements" sep(type, ",") ;

body         = "{" { member newline } "}" ;
member       = { attribute } [ visibility ] [ "override" ]
               ( [ "static" | "mut" ] function          (no block: an interface requirement)
               | constructor                            (classes only, at most one, #276)
               | [ "static" ] "get" NAME ":" type [ "=>" expr ]  (one expression, #273)
               | [ "lazy" | "var" ] NAME ":" type [ "=" expr ]
               | constDecl
               | variant ) ;                             (enums only)
variant      = NAME [ "(" ( "from" type | type | sep(NAME ":" type [ "=" expr ], ",") ) ")" ] [ "=" expr ] ;
                                                        (`Ok(T)`: one value without a name, #292)
constructor  = "construct" params [ block ] ;          (no block only in a `.d.nibl` file)
```

A constructor (#276) has no return type and can't fail: it builds the class it's in, and
creation that can fail is a static function that calls `new`. A parameter marked `private`,
`internal`, `pub` or `var` is also a field, set before the body runs; the body sets every other field
without a default, once on every path, before it reads that field, calls a method on `this`
or hands `this` on, and it has no `return`. Its visibility decides who may call `new`. A
class without one can't be built. `construct` is contextual: it starts a constructor only
before `(` in a class body.

`internal` (#277) names the default, package-wide visibility. It's written only on a
constructor's parameter, where leaving the visibility out means the parameter isn't a field;
anywhere else it's an error, so each visibility has one spelling in each place. `internal
var` is an error too, because `var` alone already gives a package-wide field. The word is
contextual: it's a marker only before a name or keyword, so a field or variable can be
called `internal`.

Members are separated by newlines, never commas (#145). An interface's function or getter
may have a body, which is its default (#227); one without a body must be defined by every
implementing type. `override` (contextual) marks a method, getter or field that implements
an interface member, and only those: it's required on each. Enums and distinct types have no stored fields. A `lazy` field needs
its `= …` (#105).

An attribute's `implements` lists interfaces that every type marked with it implements, which
is how a codec attribute makes a type codable: `attribute json implements Codable<JsonCodec>`
(#217).

```
type     = typeAtom { "?" } ;                           ("?" directly after the type)
typeAtom = path [ "<" sep(type, ",") ">" ]
         | "fn" "(" sep(type, ",") ")" [ "->" type [ "else" type ] ]
         | "(" type "," sep(type, ",") ")"              (a tuple)
         | "(" type ")" ;                               (grouping: `(fn() -> Int)?`)
```

- In a function type that returns a function type, `else` belongs to the nearest one, the
  inner type (#259), as `else` pairs with the nearest `if`. Write the parentheses anyway:
  `fn(S) -> (fn(T) -> Ack else E)`.

### Tests (#62)

```
test = "test" STRING [ "for" pattern "in" expr ] block ;     (only in .test.nibl files)
```

### Declaration files (#207)

A `.d.nibl` file declares an API without implementing it: the same declarations as any
other file, but functions, methods and getters have no body, and there are no tests. The
exception is an interface member's default, which keeps its body because the default is
part of the API (`get transactional: Bool => true`). A type may leave out the members its
`implements` already promises.
Fields keep their defaults, since they're part of the API. A constant keeps its value when
the value is part of the API (`const NOT_FOUND: Status = Status(404)`), and may give just its
type when it isn't (`const EPOCH: Instant`).
The stdlib is written this way in `std/src/`, one directory per module; the file directly in
`std/src/`, `prelude.d.nibl`, is the prelude.

```nib
/// A point in time, independent of any time zone.
pub record Instant implements Comparable {
	const EPOCH: Instant
	static fn parse(text: String) -> Instant else ParseError
	get iso: String
}
```

## 3. Newlines

A newline ends a statement, a member or a `match` arm, with four exceptions:

1. Inside `( )`, `[ ]`, and the braces of import lists, newlines
   are whitespace. (A block inside them, such as a closure body, has its own lines again.)
2. A line that ends in the middle of an expression (after an operator, `,`, `=`, `=>`, `->`,
   or an opening bracket) continues on the next line.
3. A line that starts with `.`, `?.`, `|>`, `??`, `?:`, `catch` or `else` continues the line before (`??` and `?:` since #296, `catch` since #299):

   ```
   let access = new Access()
       .register(new CartOwnerVoter())

   let available = this.db
       .scalar<Int>(sql"select …")
       catch err { fail InventoryError.Storage(RepositoryError.Database(err)) }
   ```

4. Two statements may not share a line.

So a `(`, `[` or `{` that starts a line never continues the line before: `f` then `(x)` on
the next line is two statements. A `.name` can't start an argument or follow `=` or `=>`:
there is no member shorthand (#239), so the parser says to write a closure.

These are #21a's rules, rewritten from how the examples break lines (the original text of
R1–R4 was never copied into the repo) and confirmed in #203.

## 4. Statements

```
block     = "{" { statement newline } "}" ;
statement = ( "let" ( NAME | "_" | tuplePattern ) | "var" NAME ) [ ":" type ] "=" expr
          | "let" NAME ":" type                          (set later, once on every path, #251)
          | constDecl
          | "return" [ expr ] | "fail" expr | "yield" expr
          | "break" [ NAME ] | "continue" [ NAME ]
          | "defer" [ "else" ] expr
          | "if" condition block [ "else" ( if | block ) ]
          | [ NAME ":" ] "for" pattern "in" condition block
          | [ NAME ":" ] "while" condition block
          | [ NAME ":" ] "do" block "while" condition
          | "expect" expr                                 (in .test.nibl files)
          | target ( "=" | "+=" | "-=" | "*=" | "/=" ) expr
          | target ( "++" | "--" )
          | expr ;
target    = NAME | expr "." NAME | expr "[" expr "]" ;
```

- Assignment, `++` and `--` are statements, never expressions (#48b).
- A block never gives a value (#251). In a `match` that gives a value, a block arm has to
  leave, with `return` or `fail`; a `?? { … }` block always has to leave.
- `let name: Type` with no value is set later (#251): exactly once on every path before it's
  read (a path that leaves needn't set it), never in a loop or a closure.
- `yield` gives a generator's next item (#250). A function whose body yields (outside any
  closure in it) is a generator: it returns `Iterable<T>` or
  `Iterable<T, E>`, its `try` and `fail` end it with an `E`, and its `return` takes no value.
  A closure can't yield.
- Functions are declared only at the top level, or as members (#265). Inside a body, a
  function is a closure: `let name = fn(…) => …`.
- `defer start …` is an error (#113c).
- A block can't stand on its own as a statement.

### Conditions

The expression after `if`, `while`, `for … in` and `match` is a *condition*, which may not
contain, outside parentheses:

- a `catch` handler or a `?? { … }` block (#172): bind the value with `let` first.

## 5. Expressions

From loosest to tightest:

| Level | Forms | Notes |
|-------|-------|-------|
| 1 | `e catch [NAME \| _] block` | handles the error (#9d, #170, #299); not in a condition, and not after `try` |
| 2 | `c ? a : b` | nested ternaries need parentheses (#49) |
| 3 | `a ?? b`, `a ?: b` | right-associative; `??` may take a block (#161), `?:` is Elvis (#53) |
| 4 | `a \|> f` | left-associative (#65) |
| 5 | `a or b` | |
| 6 | `a and b` | |
| 7 | `not e` | |
| 8 | `== != < <= > >=`, `e is [not] pattern`, `a in b` | never chained (#72) |
| 9 | `a..b`, `a..<b` | (#48a) |
| 10 | `\|` | then `^`, then `&`, then `<< >>` (#6c) |
| 11 | `+ -` | |
| 12 | `* / div mod` | (#36b) |
| 13 | `-e`, `~e`, `try e`, `start e` | `try` unwraps one call's result; another fallible call inside needs its own `try` (#241) |
| 14 | postfix: `.name`, `?.name`, call (which builds a record), `[index]`, `<T>` arguments, `with ( … )` | |

```
primary = INT | DECIMAL | STRING | "true" | "false" | "null" | "this" | NAME
        | "(" expr ")" | "(" expr "," sep(expr, ",") ")"
        | "[" [ sep(expr, ",") ] "]" | "[" sep(expr ":" expr, ",") "]" | "[" ":" "]"   (#139)
        | "fn" "(" sep(NAME [ ":" type ], ",") ")" [ "->" type ] [ "else" type ]
              [ "use" "(" sep("mut" NAME, ",") ")" ] ( "=>" expr | block )            (#27, #63)
        | "match" condition "{" { pattern [ "if" expr ] "=>" ( expr | block | target "=" expr | target ( "++" | "--" ) ) newline } "}"
                                                      (an assignment arm only in a statement `match`, #251)
        | "new" type "(" [ sep(argument, ",") ] ")"    (a class, through its constructor, #276)
        | "new" type body                             (an inline implementation, #167)
        | "fail" expr | "return" [ expr ] ;           (as expressions they have type Never, #133)

argument = [ NAME ":" ] [ expr ] ;   (a bare `name:` passes the local of that name, #135)
with     = expr "with" "(" sep(NAME ":" [ expr ], ",") ")" ;   (every field named, #275)
```

- Arguments: positional ones come first (#166).
- A call's `(`, an index's `[` and type arguments' `<` must follow the callee directly, with no
  space.
- `name<T>(…)` is a call with type arguments, because chained comparisons are errors (#72):
  `<` after a name is read as a type argument list if it closes and is followed by `(` or `.`
  directly.
- A call writes all of its type arguments, except those with defaults, or none (#218); there
  is no `_` placeholder. Checked by the type stage, not yet by the checker.
- An argument is labelled exactly when its parameter is `named` (#286); positional
  arguments fill the other parameters in order. A variant's payload is labelled like a
  record's fields; the one value of a `from` variant, or of one like `Ok(T)`, isn't. Checked by the type stage.
- A record is built by calling its type with every field named: `Money(amount:, currency:)`
  (#275). A class is built with `new` (#276), and calling a class's name is an error that
  says so, as `Type { … }` is.
- `if` is not an expression; use `c ? a : b` (#49).
- A closure body after `=>` extends as far as an expression can.

## 6. Patterns

```
pattern = alternative { "or" alternative } ;           (`or` only in match arms, #50, #143)
alternative = "_" | literal | NAME                     (a lower-case name binds)
            | path [ "(" ( pattern | sep(NAME ":" [ pattern ], ",") ) ")" ] [ NAME ]
            | "(" sep(pattern, ",") ")" ;
```

- `Declined` matches a variant, whatever it holds; `Declined(_)` is an error that says so.
  A variant is written with its enum's name, `PaymentError.Declined` (#316, replacing #142's
  bare names); a bare one is an error that shows the qualified spelling.
- A pattern names a variant's values, as building one does (#292): `RateLimit.Limited(retryAfter:)`
  binds `retryAfter`, `Shape.Rectangle(width: w)` binds `w`, and values it doesn't name are
  ignored. A variant holding one value without a name (`from`, or `Ok(T)`) takes one
  pattern, unnamed: `Result.Ok(response)`.
- `x is not null` names nothing (#315, replacing #304's `x is not null name`): a name after
  it is a parse error that says to put the value in a `let` first. `x is User user`, where `x`
  is a `User?`, only tests for `null`, so it's an error that says to write `is not null`.
- `Status.NOT_FOUND` matches a constant (#185).
- Every alternative of an `or` pattern binds the same names (#143).

A name bound by `is` is in scope in the code that runs only when the test succeeded: the
`if` block, the right side of `and`, the true branch of `?:`.

## 7. What the checker checks beyond the grammar

- Names: every name and type resolves to a local, parameter, declaration in the module,
  import or prelude name. Imports from the package and the stdlib name modules and members
  that exist, and so does a `.name` after an imported module.
- Static members: `Type.name` (and `module.Type.name`, and the same in patterns) must be a
  static function or getter, a constant or a variant of that type or of an interface it
  implements. Misspellings get a "did you mean" hint.
- Scope: locals and parameters can't shadow each other (#12); a local can't take an imported
  module's name (#104); shadowing a module-level or prelude name is a warning (#153).
- `this` only in instance methods, getters and `lazy` fields; labels for `break` and
  `continue` exist.
- Visibility: a `private` top-level declaration is used only in its own file (#22);
  test files' declarations are visible to every test file in the package and to no other
  file (#156, #261); a module listed in the manifest's `[testing] modules` is imported only
  by test files and by other test-only modules (#261).
- Declarations: no duplicate names except function overloads; naming case (#54).
- Interfaces (#227): a member that shares a name with a member of an interface the type
  implements is marked `override`, and an `override` member matches one ("did you mean").
  Every interface member without a default is defined (outside declaration files, and
  except what the compiler derives); two defaults for one member mean the type defines it.
  The same holds for a one-off `new Interface { … }`.
- Errors (#228): in an enum that implements `Error`, a `from` payload implements `Error`
  too. An error's `message` that reads another `.message` is a warning.
- Attributes are imported or in the prelude (#192); string tags are known.
- Code examples in doc comments parse (#59).

The type stage (`tools/nib/TYPE-STAGE.md`) checks types on top of this; what neither
checks yet is listed in `tools/nib/PENDING-CHECKS.md`.

## 8. The prelude (#201)

The prelude holds the names nearly every file needs, and the types its own signatures use.
Syntax can produce a value whose type isn't in the prelude: `url"…"` needs no import, but
writing the name `Url` in a signature, field or annotation does.

Available in every file without an import:

- Types: `Int`, `Int8`, `Int16`, `Int32`, `UInt`, `UInt8`, `UInt16`, `UInt32`,
  `Float`, `Float32`, `Decimal`, `Bool`, `String`, `Bytes`, `List`, `Map`, `Set`, `Result`,
  `Void`, `Never`.
- Interfaces: `Error`, `Stringable` (#215), `Sensitive` (#240), `Iterable` and `Iterator` (#216), `Parseable`, `BackedEnum` (every backed enum has it, #208), `Equatable`, `Comparable`, `Hashable`, `Numeric`,
  `Emptiable`.
- Other types: `ParseError` (built-in conversions fail with it, #56), `Ordering` (#71),
  `Rounding` (#225), `Sign` and `Notation` (#226),
  `SourceLocation` (#107).
- Functions: `print` (#120), `panic`, `assert` (#83), `todo` (#111), `sameInstance` (#71),
  and in test files `expectPanic` (#62).
- Attributes: `@pure`, `@mustUse`, `@callerLocation`, `@deprecated`,
  `@sensitive`, `@opens`.
