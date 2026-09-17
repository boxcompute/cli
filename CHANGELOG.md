# Changelog

This file records user-visible changes to the BoxCompute CLI. GitHub Releases
use the same notes and bind them to the exact source commit.

## [0.5.0] - 2026-09-17

Choose a larger VM profile with `bxc sandbox start --size small|large`.

### CLI users

- `bxc sandbox start WORKSPACE_ID` now sends `size` in the create request. The
  default is `--size small` (0.5 CPU, 1024 MiB memory), which matches the
  profile every earlier release created.
- `--size large` requests the 3x profile (1.5 CPU, 3072 MiB memory). It is VM
  only: the gVisor container runtime ignores `small` and rejects `large`
  before contacting the server. VM sizing and `--cpu` remain mutually
  exclusive because `--cpu` selects gVisor.
- Servers that do not know `size` discard it, so an older deployment keeps
  working with the default profile; upgrade the server to use `large`.

### Security

No security-relevant changes.

## [0.4.0] - 2026-09-13

Create VM sandboxes (now the default runtime) and transfer files with the
authenticated CLI.

### CLI users

- Upgrade with `bxc update`. `sandbox start WORKSPACE_ID` uses the server's
  default runtime (VM) and waits up to 180 seconds for a pending sandbox to
  reach running, reporting the sandbox and its state either way.
- `--gvisor` explicitly selects a container sandbox; `--cpu` implies it, since
  only container sandboxes support CPU selection. `--vm` explicitly selects a
  VM and still requires `--idempotency-key`, reused with the same options on
  retry. `--no-wait` returns the creation receipt immediately.
- `sandbox upload SANDBOX_ID LOCAL REMOTE` uploads up to 8 MiB of raw bytes.
  `sandbox download SANDBOX_ID REMOTE LOCAL` follows file cursors to EOF and
  creates a new local file only after the complete download succeeds.
- Creation accepts optional `--name` and `--idempotency-key` for ordinary
  sandboxes too. Status supports `pending`, `expired`, and `vmSandbox`.
- The bundled VM guide and agent skill cover offline tests, recovery, cleanup,
  and Hermes limitations. VM access no longer requires approval.

### Security

- New create/file requests reject redirects and have bounded timeouts. The CLI
  does not automatically retry mutations or replace unavailable VMs.
- Downloads validate range metadata and byte counts, discard partial files on
  failure, and refuse to overwrite existing destinations. Local output has
  owner-only permissions. Uploads are bounded even if the source file grows.

## [0.2.5] - 2026-09-12

Sandbox creation can now request a per-sandbox scheduler CPU allocation.

### CLI users

- Pass `--cpu CPU` to `bxc sandbox start WORKSPACE_ID` to request any value
  from 0.1 through 4 CPUs.
- Omitting `--cpu` preserves the server's default scheduler CPU allocation.

### Security

No security-relevant changes.

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
