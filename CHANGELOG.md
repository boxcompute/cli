# Changelog

This file records user-visible changes to the BoxCompute CLI. GitHub Releases
use the same notes and bind them to the exact source commit.

## [0.4.0] - 2026-09-13

Create approval-only VM sandboxes and transfer files with the authenticated CLI.

### CLI users

- Upgrade with `bxc update`. Use `sandbox start WORKSPACE_ID --vm
  --idempotency-key KEY` to request a VM; keep the key and options unchanged on
  retry. Start returns the creation receipt; use `sandbox status` for readiness.
- `sandbox upload SANDBOX_ID LOCAL REMOTE` uploads up to 8 MiB of raw bytes.
  `sandbox download SANDBOX_ID REMOTE LOCAL` follows file cursors to EOF and
  creates a new local file only after the complete download succeeds.
- Creation accepts optional `--name` and `--idempotency-key` for ordinary
  sandboxes too. Status supports `pending`, `expired`, and `vmSandbox`.
- The bundled VM guide and agent skill cover offline tests, expiry, recovery,
  cleanup, and Hermes limitations. VM beta access still requires approval.

### Security

- New create/file requests reject redirects and have bounded timeouts. The CLI
  does not automatically retry mutations or replace unavailable VMs.
- Downloads validate range metadata and byte counts, discard partial files on
  failure, and refuse to overwrite existing destinations. Local output has
  owner-only permissions. Uploads are bounded even if the source file grows.

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
