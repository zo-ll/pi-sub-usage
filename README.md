# pi-sub-usage

A [Pi](https://pi.dev) extension that shows **subscription plan usage** for
`opencode-go`, OpenAI (ChatGPT), and Claude (Anthropic) — from inside Pi.

No API spend dashboards. No billing keys. The extension reads the credential Pi
already stores and calls the provider's own usage endpoint.

```
╭─ Subscription usage ─────────────────────────────────╮
│                                                      │
│  OpenCode Go · Go                                    │
│     5h  ░░░░░░░░░░░░   1%  resets in 3h              │
│     7d  ░░░░░░░░░░░░   1%  resets in 5d              │
│    30d  ███████░░░░░  60%  resets in 7d              │
│                                                      │
│  OpenAI (ChatGPT) · Plus · you@example.com           │
│     5h  ░░░░░░░░░░░░   0%  resets in 5h              │
│     7d  ░░░░░░░░░░░░   3%  resets in 6d              │
│                                                      │
│  Claude                                              │
│     not signed in                                    │
│                                                      │
│  r refresh · q/esc close                             │
╰──────────────────────────────────────────────────────╯
```

## Install

From git:

```bash
pi install git:github.com/zo-ll/pi-sub-usage
```

Try it without installing:

```bash
pi -e git:github.com/zo-ll/pi-sub-usage
```

Or copy `extensions/index.ts` into `~/.pi/agent/extensions/pi-sub-usage/`.

Pi loads the extension on the next session. Run `/reload` to load it in the
current session.

## Usage

| Command | Action |
| --- | --- |
| `/usage` | Show the panel for every signed-in plan. |

| Key | Action |
| --- | --- |
| `r` | Fetch fresh data. |
| `q` / `Esc` | Close the panel. |

Pi also shows a compact `usage` item in the footer. The item refreshes every
five minutes.

## Providers

| Provider | Credential | Usage endpoint |
| --- | --- | --- |
| `opencode-go` | Stored API key | `https://opencode.ai/zen/go/v1/usage` |
| `openai-codex` | OAuth | `https://chatgpt.com/backend-api/wham/usage` |
| `anthropic` | OAuth | `https://api.anthropic.com/api/oauth/usage` |

Sign in first:

```text
/login openai-codex     # OpenAI ChatGPT Plus/Pro
/login anthropic        # Anthropic Claude Pro/Max
```

`opencode-go` uses the API key that Pi stores for the `opencode-go` provider.

The Anthropic path needs the OAuth login. An Anthropic **API key** has no
subscription windows, and the extension says so.

## Security

- The extension is read-only. It never writes a credential.
- It sends a credential only to that provider's own usage endpoint.
- It refuses HTTP redirects on every request.
- It never prints a token to the transcript, the panel, or the status line.

Pi extensions run with your user permissions. Review the source before you
install a third-party extension.

## Notes

- Window labels follow the provider: `5h` is the rolling window, `7d` is the
  weekly window, and `30d` is the OpenCode Go monthly window.
- Pi refreshes an expired OAuth access token before each request.
- The provider endpoints are not documented. The extension reports
  `unavailable` when a response no longer contains usage data.
- Results are cached for 60 seconds, so `/usage` and the footer do not hammer
  the provider.

## Development

The extension is one TypeScript file: [`extensions/index.ts`](extensions/index.ts).
Pi loads it with `jiti`, so there is no build step.

```bash
pi -e ./extensions/index.ts
```

## License

MIT
