# opencode-freepi

[free-pi](https://freepi.ai) for [OpenCode](https://opencode.ai) — a single self-contained
plugin that replaces the free-pi CLI. No global binary, no manual config editing.

## What it does

| Feature | Details |
|---|---|
| **Credits meter** | Footer slot (only while a free-pi model is selected) showing your daily allowance + bonus + premium pools, e.g. `free-pi 15,000+2,651`. Theme-colored: muted gray normally, warning orange when a sign-in is required, error red when offline or the daily allowance is nearly spent. Updates after every turn and every 60 s. |
| **`/freepi-login`** | GitHub device-flow sign-in with a consent step (ads + training disclosure). Stores the token in OpenCode's credential store (applies live, no restart) and mirrors it to `~/.free-pi/agent/credentials.json`. |
| **Model catalog sync** | Fetches free-pi's model catalog at startup and after every sign-in and writes it into `opencode.json` under `providers.freepi` — models are plugin-maintained, never manual. |
| **Ad parity** | Pulls banner/inline ads and reports impressions on the same cadence as the free-pi CLI (launch + every user turn, inline every 5th turn end, 60 s banner throttle, launch dedupe) — without rendering anything, so the server counts you as a supported client. |

## Install

**From npm** (once published):

```sh
opencode plugin add opencode-freepi
```

**From GitHub:**

```sh
opencode plugin add github:ritobhash/opencode-freepi
```

**Manual:** clone or copy this directory anywhere and add it to your OpenCode config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/path/to/opencode-freepi"
  ]
}
```

Then run `/freepi-login` inside OpenCode once. Done.

## Notes & troubleshooting

- **You sign in once.** The token lives in OpenCode's credential database and survives
  restarts; the plugin auto-restores it if you migrate from the free-pi CLI.
- **Model changes need a restart.** OpenCode's background service daemon reads the config
  once at startup and never reloads it. After a catalog update the plugin tells you:
  *"opencode needs a restart to pick up model changes (not a sign-in issue)"*.
- Defense models are listed with their usage multipliers, e.g.
  `Abliterated Large Flash (defense) (~20x usage)`.
- The meter only renders while a `freepi/*` model is selected.

## Environment knobs

| Variable | Default | Purpose |
|---|---|---|
| `FREEPI_METER_POLL_MS` | `60000` | Meter poll interval |
| `FREEPI_AD_INLINE_TURN_FREQUENCY` | `5` | Inline ad every Nth turn (0 disables) |
| `FREEPI_AD_CLIENT_VERSION` | `0.6.22` | `x-client-version` sent to the ad API |
| `FREEPI_CREDS` | `~/.free-pi/agent/credentials.json` | Token mirror path |
| `FREEPI_METER_DEBUG` | unset | Set to `1` to log to `/tmp/freepi-plugin.log` |

## Requirements

- OpenCode ≥ 2.2.0 (developed and tested on 2.2.7)
- A free-pi account (sign in via `/freepi-login`)

## License

MIT
