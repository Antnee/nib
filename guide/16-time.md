# Dates and times

`std.time` keeps two things apart: a moment, which is the same everywhere, and the date and
time a clock shows somewhere. A moment becomes a local date and time only when code says
which time zone it means. There's no default zone, not even the server's, so code never
depends on where it runs.

## The types

- `Instant` is a moment, such as when an order was placed.
- `Date` is a calendar day, such as a birthday.
- `Time` is a time of day, such as when a shop opens.
- `TimeZone` is an IANA time zone, such as `Europe/London`.
- `ZonedDateTime` is a moment seen in a zone: the date and time a clock there showed.
- `Duration` is an exact length of time, such as 30 seconds.
- `Period` is a length of calendar time, such as one month.
- `Month` and `Weekday` are enums, so a `match` on one covers every case.

## Moments

Code asks a `Clock` for the time, so a test can give it a fixed one
([Testing](12-testing.md)). A `Duration` is added to an `Instant`:

```nib
import std.time.{Clock, Duration, Instant}

fn linkExpiry(clock: Clock) -> Instant {
	return clock.now().plus(Duration.of(hours: 24))
}
```

- An `Instant` has no time zone.
- `instant.toString()`, and `${instant}`, write it in UTC, such as `2026-09-25T10:15:00Z`.
- A database stores it in UTC too: in a `timestamptz` column on Postgres, and a
  `datetime(6)` column on MySQL.

So storing, comparing and logging moments never needs a zone.

## In a time zone

`instant.in(zone)` gives the date and time a clock in `zone` showed at that moment:

```nib
import std.time.{Clock, Date, Instant, TimeZone}

fn today(clock: Clock, zone: TimeZone) -> Date {
	return clock.now().in(zone).date
}

fn placedLate(placedAt: Instant, zone: TimeZone) -> Bool {
	return placedAt.in(zone).time.hour >= 22
}
```

- Each moment has exactly one date and time in a zone, so `in` can't fail.
- "Today" depends on where you are. At 00:30 in London in summer, it's still yesterday in
  UTC. That's why a clock gives moments, and the date is asked for in a zone.
- `TimeZone.UTC` names UTC, for code that really means it.

A zone usually comes from data, such as a person's settings, so it's read with `parse`:

```nib
import std.time.{TimeZone}

record Settings {
	timeZone: String
}

fn zoneOf(settings: Settings) -> TimeZone else ParseError {
	return try TimeZone.parse(settings.timeZone)
}
```

- A form field or a config value typed `TimeZone` is read the same way.
- So an unknown zone is a problem to show on the form, or an error when the app starts,
  and never a quiet switch to UTC.

A `ZonedDateTime` is for reading and showing. It has no arithmetic. To move in time, add a
`Duration` to its `instant`, or a `Period` to its `date`.

## Calendar arithmetic

A `Period` is added to a `Date`:

```nib
import std.time.{Date, Period}

fn renewalDate(startedOn: Date) -> Date {
	return startedOn.plus(Period.of(months: 1))
}
```

- When the day doesn't exist in the month reached, the result is the month's last day. So
  31 January plus a month is 28 February, or 29 February in a leap year.
- `date.daysSince(earlier)` counts the days between two dates.

A period is never added to an `Instant`. "A day later" isn't always 24 hours, because the
clocks change, so it depends on the zone:

```nib error
// Rejected: a period's length depends on the zone, so it can't be added to an instant.
import std.time.{Instant, Period}

fn dayLater(placedAt: Instant) -> Instant {
	return placedAt.plus(Period.of(days: 1))
}
```

Write it as what it means. Either add exactly 24 hours, as a `Duration`, or take the date in
a zone, move it, and set a time:

```nib
import std.time.{Clock, Instant, Period, Time, TimeZone}

fn tomorrowAtNine(clock: Clock, zone: TimeZone) -> Instant {
	let tomorrow = clock.now().in(zone).date.plus(Period.of(days: 1))
	return tomorrow.at(Time.of(hour: 9), zone).instant
}
```

`date.at(time, zone)` is the one place a local time becomes a moment. When the clocks
change, a local time can be missing or can happen twice:

- A missing time, such as 01:30 on the night the clocks go forward, moves forward by the
  gap, to 02:30.
- A time that happens twice, as 01:30 does when the clocks go back, is the first of the
  two.

Other date libraries and databases follow the same rules.

## Storing

| Type | Database column | JSON and forms |
|------|-----------------|----------------|
| `Instant` | `timestamptz` on Postgres, `datetime(6)` on MySQL | `2026-09-25T10:15:00Z` |
| `Date` | `date` | `2026-09-25` |
| `Time` | `time` | `10:15:00` |
| `TimeZone` | text | `Europe/London` |
| `Duration` | `interval` | `PT10M30S` |
| `Period` | text | `P1M` |

A `ZonedDateTime` isn't stored as one value. Store its instant and its zone in columns of
their own:

```nib
import std.db.{@db}
import std.time.{Instant, TimeZone, ZonedDateTime}

@db
record Delivery {
	arrivesAt: Instant
	timeZone: TimeZone
}

fn arrival(delivery: Delivery) -> ZonedDateTime {
	return delivery.arrivesAt.in(delivery.timeZone)
}
```

An event set for a local time in the future, such as a meeting at 10:00 next March, keeps
its date, time and zone in three columns. A zone's rules can change before then, so the
moment is worked out with `date.at(time, zone)` when it's needed.

## Showing dates to people

`formatted` writes a date or a time the way people in a `Locale` read it. There are four
styles, from short to full, and the locale's own data says what each one looks like:

```nib
import std.locale.{Locale}
import std.time.{DateStyle, Instant, TimeStyle, TimeZone}

fn orderedOn(placedAt: Instant, zone: TimeZone, locale: Locale) -> String {
	let placed = placedAt.in(zone)
	return "Ordered on ${placed.formatted(date: DateStyle.Medium, time: TimeStyle.Short, locale:)}"
}
```

- In `en-GB` that's `Ordered on 4 Nov 2026, 10:15`.
- `date.formatted(DateStyle.Long, locale:)` writes a date alone, such as `4 November 2026`.
- There's no pattern language, such as `d M Y`. Each style is written the way the locale
  expects, so the same code serves every language.
- `toString()` writes the ISO 8601 form, which is for data. The `formatted` text isn't meant
  to be read back.

A locale comes from the person's settings, a form or the app's config, and is read with
`Locale.parse("en-GB")`. There's no default locale either.

## Choosing a time zone

A list of every IANA zone, such as `America/Argentina/Buenos_Aires`, is long and hard to
use. Zone IDs are meant for storing, not for showing. A better page asks for the country
first, then shows only that country's zones:

```nib
import std.locale.{CountryCode, Locale}
import std.time.{TimeZone}

record ZoneChoice {
	zone: TimeZone
	label: String
}

fn zoneChoices(country: CountryCode, locale: Locale) -> List<ZoneChoice> {
	return TimeZone.forCountry(country)
		.map(fn(zone) => ZoneChoice(zone:, label: zone.location?.comment ?? country.name(locale)))
}
```

- Most countries have one zone, and its label is the country's name, such as
  `United Kingdom`.
- A country with several has a comment for each one from the time zone database, such as
  `Pacific` or `Gaza Strip`.
- `country.name(locale)` gives the country's name in the person's language.
- The page stores the chosen zone's ID, so the labels can change without changing the data.
