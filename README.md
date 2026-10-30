# OpenCode OpenAI Quota Plugin

An OpenCode V2 plugin that displays ChatGPT subscription quota only in the bottom prompt footer and refreshes it after successful OpenAI agent executions.

Targets OpenCode V2.2.3 with `@opencode/plugin@2.2.3` and OpenTUI 0.8.0; compatibility with other releases must be verified.

**Limitation:** newer ChatGPT token-sharing sign-ins do not expose numeric quota through the endpoint used here. The plugin shows `—/—` and `/quota` provides the usage-page URL instead.

## Behavior

- Appends `OpenAI: 37%/88% 02:15/4d` only to `prompt.footer.status`, not the home-screen footer; it never replaces the footer or other plugins' contributions.
- Countdown values follow the same primary/secondary order as percentages. Below 24 hours they show `HH:MM` (rounded up to a minute); longer durations show whole remaining days (`4d`). The countdown redraws locally every 30 seconds, without quota requests. At expiry it stays at `00:00` until fresh usage data arrives; percentages are never guessed.
- Reset times come from `reset_at` (Unix seconds), falling back to `reset_after_seconds` relative to fetch time. Missing reset times show `—`; when both are missing (including old caches), the countdown is omitted until the next normal refresh.
- Shows the status and makes quota requests only while the selected model's `providerID` is `openai`.
- Restores the last successful snapshot from server-side plugin storage after restart. A cache read does not call OpenAI.
- Automatically refreshes after successful executions. Requests are single-flight and normally at least 60 seconds apart; if throttled, one trailing refresh is scheduled and re-checks the selected provider before running.
- `/quota` forces a refresh past the normal interval. It still respects an OpenAI `429` `Retry-After` cooldown and never runs for a non-OpenAI selection.
- Stores lightweight private counters (`debug:stats`: attempts, successes, failures, cancellations, last HTTP/error status, and backoff timestamps) in plugin storage for debugging. There is no debug command, file log, token logging, or raw response logging.
- Uses the current OpenAI OAuth connection. API keys are not used for ChatGPT subscription quota.
- New Sign in with ChatGPT token-sharing grants (`chatgpt.tokens.use.direct`) retain `OpenAI: —/—` in the footer. OpenAI does not expose numeric quota for these grants through the legacy usage endpoint; the plugin never sends them there. `/quota` shows https://chatgpt.com/settings/usage without opening a browser; verify the browser is signed into the intended account. Relogin is not required.
- Switching credentials clears the old account's display, loads the new cache and refreshes automatically. Auth failures and automatic backoff are account-scoped; a rotated token clears the old token's auth block. Server-requested `429` cooldowns remain respected across switches.
- HTTP 401 and 403 have distinct diagnostics; forbidden quota access is not presented as proof that a token expired.

The endpoint is an undocumented ChatGPT backend endpoint, so its schema or availability can change without notice.

## Install from a local checkout

Clone this repository and add its absolute directory to `plugins` in your global `~/.config/opencode/opencode.json` (merge with existing entries):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/openai-quota"]
}
```

On Windows, use forward slashes, for example `D:/dev/ai/openai-quota`. One entry loads both server and TUI parts; no `cli.json` entry is needed. Use `/reload` if necessary.

Do not load this checkout alongside a discovered copy of the same plugin.

## Alternative: global plugin discovery

OpenCode V2 automatically discovers global plugins in `~/.config/opencode/plugins/`. Copy this directory there as `openai-quota`:

```text
~/.config/opencode/plugins/openai-quota/index.ts
~/.config/opencode/plugins/openai-quota/tui.ts
~/.config/opencode/plugins/openai-quota/src/...
```

The root `index.ts` and `tui.ts` expose both server and TUI entrypoints. No `plugins` config entry or `cli.json` entry is needed for global discovery. After copying or changing the plugin, reload OpenCode configuration.

## Development

Use Node.js >=26.4.0 for development (required by OpenTUI 0.8.0), or a compatible Bun >=1.3.14 environment. Tests and typechecking were verified with Node.js 26.4.0. OpenCode runs the installed plugin in its own runtime; this does not require replacing your system Node.js.

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm pack --dry-run
```

Tests use generated dummy credentials and mocked HTTP; they do not need an OpenAI account or send usage requests.

## npm publication

This package is not published yet and intentionally retains `private: true`. Before publishing, choose the final available package name and license, add repository metadata, remove `private`, review `npm pack --dry-run`, and test installation of the resulting tarball in OpenCode. npm publication and GitHub publication are separate steps.

## Privacy and security

See [SECURITY.md](SECURITY.md) for credential handling, stored data, and reporting guidance. This is an unofficial integration using an undocumented endpoint, not an OpenAI-supported quota API.
