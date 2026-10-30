# Security and privacy

## Credential handling

- The server resolves the active OpenAI OAuth credential through OpenCode. It does not read browser cookies, `.env` files, or a separate credential file.
- The access token is sent in the Authorization header to `https://chatgpt.com/backend-api/wham/usage`. HTTP redirects are rejected.
- Token-sharing credentials with the `chatgpt.tokens.use.direct` scope are not sent to that endpoint.
- Raw credentials, account IDs, and endpoint response bodies are not intentionally logged or persisted by this plugin. Exception details are not returned to the UI.
- Persistent OpenCode plugin storage holds quota percentages, reset/fetch timestamps, diagnostic counters, retry state, and SHA-256-derived account/token identifiers. These are account-related metadata, not anonymous data; protect your OpenCode data directory.
- The TUI receives quota snapshots and fixed diagnostic messages over OpenCode RPC, not OAuth tokens.
- No telemetry or third-party analytics is included.

JWT claims are decoded only to select account metadata and detect unsupported scopes. This is not signature verification or an authentication boundary; OpenCode supplies the credential.

## Limitations

The usage endpoint is undocumented and may change or stop accepting credentials. Newer ChatGPT token-sharing grants do not provide numeric quota through this endpoint. This plugin does not attempt to bypass that restriction.

Dependency audits and code review are point-in-time checks, not a guarantee that the plugin or its dependencies are free of vulnerabilities.

## Reporting

Do not post tokens, cookies, raw credential records, or unredacted OpenCode storage/logs in public issues. Report sensitive findings privately to the repository owner through an available private contact or GitHub private vulnerability reporting when enabled.
