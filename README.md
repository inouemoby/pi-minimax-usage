# pi-minimax-usage

MiniMax Token Plan (Coding Plan) quota monitor extension for [pi coding agent](https://github.com/earendil-works/pi-mono).

Displays MiniMax's 5-hour rolling window and weekly quota in pi's footer in real time. Also provides a `/minimax` command and `minimax_usage` tool for quota checks.

## Features

- **`/minimax` command**: Detailed quota view (5h / weekly / reset times)
- **`minimax_usage` tool**: Proactively check remaining Coding Plan quota before expensive operations
- **Auto-region**: Picks the right host automatically — `minimax` provider uses `api.minimax.io`, `minimax-cn` uses `api.minimaxi.com`
- **No login needed**: Reads the API key from `auth.json` automatically
- **Graceful empty state**: Shows "no active token plan subscription" instead of erroring when the account has no Coding Plan
- **Per-region caching**: 60s in-memory TTL keeps the footer snappy without re-hitting MiniMax on every keystroke

## Install

```bash
pi install git:github.com/inouemoby/pi-minimax-usage
```

Or add it to `~/.pi/agent/settings.json` under `packages`:

```json
{
  "packages": ["git:github.com/inouemoby/pi-minimax-usage"]
}
```

## Setup

Add your MiniMax Token Plan (Coding Plan) key to `~/.pi/agent/auth.json`:

```json
{
  "minimax-cn": {
    "type": "api_key",
    "key": "eyJhbGciOi..."
  },
  "minimax": {
    "type": "api_key",
    "key": "eyJhbGciOi..."
  }
}
```

Either region is optional — only the one(s) you actually use need a key. The plugin reads `MINIMAX_API_KEY` from the environment first as a fallback.

Get your Subscription Key from [MiniMax Developer Platform (China)](https://platform.minimaxi.com/subscribe/token-plan) or [MiniMax Developer Platform (International)](https://platform.minimax.io/subscribe/token-plan).

## Commands

| Command | Description |
|---------|-------------|
| `/minimax` | Show detailed quota (5h / weekly / reset times) |

## Footer Display

When using a MiniMax-backed model, the footer shows:

```
↑3.2k ↓1.1k 12.5%/1M (auto) 5h:6% 4h28m wk:1% 6d12h    (MiniMax CN) MiniMax-M3 • max
```

- `5h:N% XhYm` — 5-hour rolling window. `!` above 70% used, `!!` above 90% used. Time until reset follows.
- `wk:N% XdYh` — weekly Coding Plan quota with the same pacing flags.
- Provider label `(MiniMax)` for international, `(MiniMax CN)` for China region.

## Tool: minimax_usage

The extension also registers a `minimax_usage` tool that the AI can call:

```
Check MiniMax Token Plan remaining quota
```

Returns structured JSON:

```json
{
  "region": "minimax-cn",
  "ok": true,
  "session5h": { "total": 5000, "used": 1200, "remaining": 3800, "resetAt": "2026-07-23T..." },
  "weekly": { "total": 40000, "used": 4200, "remaining": 35800, "resetAt": "2026-07-29T..." }
}
```

## How It Works

Fetches quota from `GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (or `api.minimax.io` for the international region) using your Coding Plan key as Bearer authentication. Parses `model_remains[]` for entries whose `model_name` starts with `MiniMax-M*` or `coding-plan*`, then picks the entry with the largest `current_interval_total_count` for the 5h view and the largest `current_weekly_total_count` for the weekly view.

The endpoint is undocumented and may change without notice. Status codes handled:

- `0` — success
- `1004` / `2049` — auth/region error (surfaced as `auth error`)
- `2057` — wrong key type (not a Coding Plan key)
- `2062` — no active Token Plan subscription (rendered as an empty state, not an error)

## Related

- [pi-codex-usage](https://github.com/inouemoby/pi-codex-usage) — Same tool for OpenAI Codex / ChatGPT
- [pi-deepseek-balance](https://github.com/inouemoby/pi-deepseek-balance) — Same tool for DeepSeek
- [pi-zai-usage](https://github.com/inouemoby/pi-zai-usage) — Same tool for ZAI (智谱/bigmodel.cn)
- [pi-ollama-usage](https://github.com/inouemoby/pi-ollama-usage) — Same tool for Ollama Cloud
- [pi-kimi-usage](https://github.com/inouemoby/pi-kimi-usage) — Same tool for Kimi For Coding