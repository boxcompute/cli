# Changelog

This file records user-visible changes to the BoxCompute CLI. GitHub Releases
use the same notes and bind them to the exact source commit.

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
