# Examples

Illustrative code using the syntax agreed in `design/decisions.md`. Every file passes the checker in `tools/nib`, types included
(`node tools/nib/src/cli.ts check examples`). The language itself is explained in
[`guide/`](../guide/README.md).

- `hello/cli.nibl`: hello world as a CLI program
- `hello/web.nibl`: hello world as a web app
- `notes/`: a small web app on MySQL with one table, one form and one guard, between hello
  world and the shop, which is on Postgres
- `logs/summarise.nibl`: a command-line tool that summarises a directory of logs, reading
  files in one task and counting in another, with a channel between them
- `convert/convert.nibl`: a command-line CSV and JSON converter that works in a pipe,
  streaming rows one at a time
- `weather/weather.nibl`: a command-line client for a JSON API, retrying with backoff
- `webhooks/`: a queue worker that delivers signed webhooks, with tests
- `site/build.nibl`: a static blog generator, with pages built from `html"…"` components
- `snippets/`: short, focused examples (`pipes.nibl`)
- `shop/`: the demo app (sign-up, sign-in, password reset, encrypted PII, checkout,
  migrations, components and tests). See `shop/README.md`.
