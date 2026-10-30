# Changelog

## [Unreleased]

- Upgrade to the OpenCode 2.2.3 SDK and OpenTUI 0.8.0, use the supported Plugin/Rpc definition helpers, and refresh dependencies to clear all reported npm audit advisories.
- Verify tests and typechecking on Node.js 26.4.0 and validate local-plugin loading on the running OpenCode 2.2.3 service.
- Prepare a standalone repository with local-checkout installation instructions and a security/privacy policy.
- Reject HTTP redirects, handle cancellation during storage writes, validate cached percentages, and re-check credentials for every caller sharing an in-flight request.
- Add regression tests for credential isolation, cancellation, credential persistence, parsing, and countdown formatting.
- Preserve quota placeholders for new ChatGPT sign-ins, explain unavailable quota via `/quota` instead of misleading auth errors, and refresh account-isolated quota state after switching credentials.
