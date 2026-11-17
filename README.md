# opencode-freepi

[free-pi](https://freepi.ai) for [OpenCode](https://opencode.ai) — a self-contained
plugin that replaces the free-pi CLI. No global binary, no manual config editing.

## What it does

- **Credits meter** — footer slot (only while a `freepi/*` model is selected) showing
  daily allowance + bonus + premium, e.g. `free-pi 15,000+2,651`. Colors: muted normally,
  warning orange when sign-in is required, red when offline or nearly spent.
- **`/freepi-login`** — GitHub device-flow sign-in with a consent step. Stores the token in
  OpenCode's credential store (live, no restart) and mirrors it to `~/.free-pi/agent/credentials.json`.
- **Model catalog sync** — writes free-pi's model catalog into `opencode.json` under
  `providers.freepi` at startup and after every sign-in.
- **Ad parity** — pulls banner/inline ads and reports impressions on the free-pi CLI cadence
  without rendering anything.

## Install

```sh
opencode plugin add github:sovietscout/opencode-freepi
```

Or point at a local copy:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-freepi"]
}
```

Then run `/freepi-login` once. Requires OpenCode ≥ 2.2.0 and a free-pi account.

## Notes

- You sign in once; the token survives restarts and is auto-restored if migrating from the CLI.
- Model changes need a restart — OpenCode's daemon reads config once at startup. The plugin
  tells you when that's the cause ("needs a restart… not a sign-in issue").
- Defense models show their usage multiplier, e.g. `Abliterated Large Flash (defense) (~20x usage)`.

## Environment knobs

| Variable | Default | Purpose |
|---|---|---|
| `FREEPI_METER_POLL_MS` | `60000` | Meter poll interval |
| `FREEPI_AD_INLINE_TURN_FREQUENCY` | `5` | Inline ad every Nth turn (0 disables) |
| `FREEPI_AD_CLIENT_VERSION` | `0.6.22` | `x-client-version` sent to the ad API |
| `FREEPI_CREDS` | `~/.free-pi/agent/credentials.json` | Token mirror path |
| `FREEPI_METER_DEBUG` | unset | Set to `1` to log to `/tmp/freepi-plugin.log` |

## License

MIT
