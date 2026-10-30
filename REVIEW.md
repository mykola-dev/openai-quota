# Initial code and privacy review

Date: 2026-10-30. Scope: all plugin source files, tests, package metadata, lockfile, and repository documentation. This is a manual review plus targeted automated checks, not an independent security audit.

## Sensitive data

- No embedded real credentials, private keys, personal filesystem paths, email addresses, or account identifiers were found in the reviewed project files.
- Tests generate synthetic JWT-shaped strings; no captured production response fixtures are included.
- A targeted pattern scan checked private-key headers, common OpenAI/GitHub tokens, literal JWTs, personal paths, and credential-bearing URLs. No matches were found. Pattern scans cannot prove the absence of every possible secret.
- Global configuration, credential stores, `node_modules`, and local environment files are excluded from the repository.
- Runtime storage contains account-related quota metadata and hashed identifiers; it should not be published. See SECURITY.md.

## Fixed during review

1. Every caller joining an in-flight request now re-checks the active credential before receiving a snapshot, preventing an old account's result from being returned to a joined caller after a credential switch.
2. Cancellation during asynchronous stats writes is checked before starting HTTP, rather than relying only on a later abort event.
3. Quota HTTP requests reject redirects instead of following them with account-related request headers.
4. Cached quota percentages must be finite and within 0–100; fetch timestamps must be nonnegative safe integers.
5. TUI cleanup invalidates pending asynchronous work before aborting the active request.
6. The RPC and parser snapshot type now share one definition.
7. Lockfile updates removed reported vulnerabilities in seroval and undici. The SDK was subsequently upgraded from 2.0.18 to 2.2.3 (matching the running OpenCode), removing the vulnerable zod dependency chain. OpenTUI was upgraded to 0.8.0 and plugin/RPC definitions now use the SDK's documented helpers.

## Remaining limitations / release preparation

- **Compatibility:** tests and typechecking pass on Node 26.4.0, satisfying OpenTUI 0.8.0's declared Node requirement. The system Node installation was not changed.
- **Runtime coverage:** the running OpenCode 2.2.3 service reports the local checkout active, with server/TUI/RPC entrypoints recognized. Calling the `cached` RPC succeeded and restored an existing snapshot without a quota HTTP request. No interactive visual TUI test or live usage HTTP request was performed; mocked tests do not prove actual footer rendering or credential-event delivery.
- **Maintenance:** the plugin uses an undocumented ChatGPT endpoint. Newer token-sharing sign-ins cannot return numeric quota through it; placeholders are intentional, not an installation failure.
- **Release metadata:** the package remains private until the final npm name, license, and publication plan are chosen. No license grant has been assumed.

## Checks

- `npm test`: 18 tests passed (all network requests mocked), including execution with Node 26.4.0.
- `npm run typecheck`: passed, including execution with Node 26.4.0.
- `npm audit`: zero reported vulnerabilities after the SDK/UI dependency upgrade.
- `npm pack --dry-run`: inspected the allowlisted package contents; no dependency tree, lockfile, tests, or local environment files are included in the npm archive.

The global configuration now points to this checkout. The legacy auto-discovered copy is removed after confirming successful loading. Global configuration and migration backups are not part of this repository.
