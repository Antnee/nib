# Shop: the Nib demo app

A small but realistic web app, written to stress-test the design in `design/decisions.md`.
Nothing here has run: there is no compiler yet, though every file passes the checker in
`tools/nib`. The stdlib APIs it calls (`std.http`, `std.db`, `std.forms`, `std.queue`,
`std.crypto` and so on) are declared in `std/`, as signatures with docs.

## What it does

- **Sign up**, with a confirmation email sent through the database-backed queue. The form
  never reveals whether an address already has an account.
- **Sign in**, with rate limiting, session regeneration and silent upgrading of legacy
  bcrypt hashes to Argon2id.
- **Password reset** with single-use, hashed, expiring tokens.
- **Personal data encrypted at rest**: the email column is ciphertext, found through a blind
  index.
- **Checkout** as a saga: shipping, tax and stock checks run concurrently, the card is
  charged with an idempotency key, the order and cart update in one unit of work, and the
  charge is refunded if that fails.
- **Migrations** in Nib, including a backfill, plus the schema snapshot the type checker
  reads.
- **Layouts, components, pages and emails** as functions returning `Html`.
- **Tests** with in-memory fakes and anonymous implementations.

## Layout

```
nib.toml               manifest: dependencies (stripe, smtp) and the migrations module
schema.sql               schema snapshot written by `nib db migrate`
assets/                  the stylesheet and checkout script, shipped with the build
src/
	main.nibl           entry point: config, log routes, HTTP and queue wiring
	app/                 Config, the typed container (Services) and the route table: the composition root
	core/                RepositoryError, the UnitOfWork port
	users/               User, Email, Password, Accounts, AccountsWork, tokens, email jobs, fakes, tests
	orders/              Cart, Order, ports, OrdersWork, CheckoutService, fakes, tests
	storage/             SQL repositories (with encryption and blind indexes), units of work
	integrations/        shipping API, flat tax, Stripe, analytics
	mail/                Mailer, SMTP adapter and its settings, EmailDelivery and templates
	ui/                  forms, components and pages
	web/                 handler classes, Pages, WebError
	migrations/          one migration per file, applied in file-name order
```

## Reading order

1. `src/users/user.nibl`, `src/users/accounts.nibl` and `src/users/work.nibl`: the account
   rules and the unit of work they write through, with no web or database in sight.
   `src/users/repository.nibl` declares what the repositories return, such as
   `createIfAbsent`'s outcome.
2. `src/app/routes.nibl`, `src/web/support.nibl`, then `src/web/auth.nibl`: one request
   from form to `Accounts`. `src/ui/components.nibl` turns a form's problems into words.
3. `src/storage/work.nibl`, after `src/users/work.nibl` from step 1: how a unit of work
   is made atomic.
4. `src/orders/checkout.nibl`: concurrency, payments and the saga.
5. `src/users/accounts.test.nibl` and `src/orders/checkout.test.nibl`.
6. `src/main.nibl` and `src/app/services.nibl`: how the app is wired. Look things up in
   them as you need to; they're the densest files, so read them in full last.
7. `src/migrations/2026_10_02_0900_add_order_numbers.nibl`: a migration with a backfill.
