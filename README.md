# World Cup Next Match

A GNOME Shell extension that shows the next 2026 FIFA World Cup match for a team
you pick, in the top bar.

The top bar shows the fixture and a countdown, for example `Spain vs Croatia in
2d 4h`. Minutes are shown only inside the final hour. During a match the
countdown is replaced with `LIVE`. If the selected team is eliminated, the top
bar says so instead.

Flags are shown next to team names. If flag emoji don't render on your system,
turn them off in Preferences.

## Install locally

```sh
glib-compile-schemas schemas
gnome-extensions enable world-cup-next-match@diegovoo.github.io
```

If a newly added local extension doesn't show up, log out and back in, or
restart GNOME Shell on X11.

## Schedule data

The group-stage schedule is bundled and works offline. Knockout fixtures depend
on group results, so they aren't bundled. When auto-update is on, the extension
fetches a JSON schedule feed (at most once every six hours) and caches it. If
the fetch fails, the bundled schedule is used.

The default feed URL is:

```text
https://raw.githubusercontent.com/diegovoo/world-cup-next-match/main/data/matches.json
```

Publishing an updated file at that URL adds knockout matches during the
tournament. A match with the same `id` as a bundled one replaces it; a new `id`
is added.

To mark a team as eliminated explicitly, list it under `eliminatedTeams`:

```json
{
  "eliminatedTeams": ["Spain"],
  "matches": []
}
```

The extension can also infer elimination once the next knockout stage is fully
published. For example, if all Round of 32 fixtures are present and the selected
team is absent, it shows the eliminated state after that team's final group
match has finished.

A knockout match uses the same fields as a bundled match, plus a `stage`:

```json
{
  "id": 73,
  "stage": "round-of-32",
  "home": "Mexico",
  "away": "Croatia",
  "kickoffUtc": "2026-06-28T19:00:00Z",
  "venue": "Example Stadium"
}
```

Recognized stage values: `round-of-32`, `round-of-16`, `quarterfinals`,
`semifinals`, `third-place`, `final`.

## License

MIT. See `LICENSE`.
