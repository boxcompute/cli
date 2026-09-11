# Changelog

This file records user-visible changes to the BoxCompute CLI. GitHub Releases
use the same notes and bind them to the exact source commit.

## [0.3.0] - 2026-09-11

`bxc` can open an experimental, short-lived SSH byte stream to an
operator-enabled BoxCompute sandbox using the Tailcat transport.

### CLI users

- Set `BOXCOMPUTE_ENABLE_SSH=1`, then run
  `bxc sandbox ssh SANDBOX_ID` on Linux or macOS (x64 or arm64).
- The CLI creates ephemeral SSH and Tailcat keys, pins the returned SSH host
  key, limits the lease to at most 30 seconds, and requests cleanup on exit.
- `--reconnect` exercises one same-envelope reconnect. `--revoke ENDPOINT_ID`
  requests best-effort cleanup after an uncertain client exit.
- The command is available only for sandboxes selected by the BoxCompute
  operator while the cooperative SSH rollout remains experimental.

### Security

- Cooperative mutations are never retried, redirects are rejected, response
  bodies are bounded, and local private material is kept in owner-only
  temporary files and removed after the session.
- Cleanup and revocation are explicitly unconfirmed; server lease expiry is
  the fallback after an ambiguous failure.
- The npm package includes client-only Tailcat proxy binaries for Linux and
  macOS on x64 and arm64, plus their dependency license inventory.

## [0.2.4] - 2026-09-09

`bxc sandbox exec` now leaves arguments after `--` entirely to the program
running inside the sandbox.

### CLI users

- Commands such as `bxc sandbox exec SANDBOX_ID -- python --version --json`
  now pass `--version` and `--json` to Python instead of treating them as
  global `bxc` options.
- No configuration changes are required. Upgrade normally with `bxc update`.

### Security

No security-relevant changes.

## [0.2.3] - 2026-09-06

- Added access to retained sandbox logs after runtime deletion.

## [0.2.2] - 2026-09-05

- Added `bxc update` and its `bxc up` alias.

## [0.2.1] - 2026-09-05

- Improved release validation and managed skill updates.

## [0.2.0] - 2026-09-04

- Added the multi-instance Sandbox API v2 commands.

## [0.1.1] - 2026-09-04

- Initial public npm release with browser login and managed agent skills.
