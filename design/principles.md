# Principles

These are the ideas every decision about Nib is judged against. When two options are both
workable, the one that fits these better wins. Each comes with a decision it settled, so
you can see what it means in practice.

## 1. Clear over clever

A reader, human or agent, should be able to tell what a line does without knowing hidden
rules.

Records used to be built with braces, `Point { x: 1, y: 2 }`, which looked like a block.
They're now built with brackets, `Point(x: 1, y: 2)`, so braces only ever mean a body
(#275).

## 2. Readable as plain text

Code must make sense with no language server, highlighting or hover. Not everyone has the
tools installed, and an agent often has none. "The editor shows it" is not a reason to
accept code that's hard to read without one.

A leading-dot shorthand, `lines.map(.total)`, was removed for this reason. Readers took
`.auth.signIn` in a route table for an enum value, and only a tool could say what the dot
belonged to. A closure says it in plain text: `fn(line) => line.total` (#239).

## 3. Magic only where it pays for itself

Every implicit behaviour has to justify itself. "Language X does it" is not a reason on its
own.

A class once got a constructor generated from its fields. Readers went looking for a
`construct` they couldn't find, so it was removed. A constructor is now always written,
and a parameter becomes a field only when it's marked (#267, #276).

## 4. One obvious way

Fewer equivalent spellings mean more consistent code, from people and from models.

`internal` names the package-wide visibility, but it's written only on a constructor's
parameter, where leaving it out means something else. Anywhere else it's an error, so
each visibility has one spelling in each place (#277).

## 5. Safe by default, explicit to opt out

The safe choice costs nothing to write. The risky one has to be asked for by name.

A literal such as `3.95` is a `Decimal`, so money adds up exactly. `Float` is there for
speed, when you write it (#230). The same rule gives secrets that can't be logged, CSRF
checks that are on unless a route turns them off, and an HTTP client that refuses private
addresses.

## 6. Start small, widen later

Removing a feature breaks code that uses it, and adding one doesn't. So when we're unsure
whether something is needed, we leave it out and add it when real code asks for it.

Testing an interface value for a concrete class, as PHP's `instanceof` does, was left out
for now (#234). Code that needs the cases uses an enum, where `match` checks that every case
is handled. The test can be added later without breaking anything. Taking it out later
would break code.

## 7. DX and AX together

Agent experience (AX) gets the same weight as developer experience (DX):

- **Diagnostics a machine can read**, each saying what to do, not just what's wrong.
- **Predictable APIs**: the same shapes and names across the standard library.
- **One canonical format.** Code should read the same whoever wrote it, as Go's does. `nib fmt`
  writes it, and `nib check` warns about a file that isn't in it (#284).

The checker's errors are written to be acted on: "`map` on an `Iterable` is lazy, so its
function can't fail. Collect the items with `toList()` first, or write a generator."
