# BoxCompute CLI

Connect Claude Code, Codex, Amp, OpenCode, and other local coding agents to
isolated BoxCompute sandboxes.

## Install

```sh
npm install --global @boxcompute/cli
bxc login
```

`bxc login` opens BoxCompute in your browser. After you approve the device, the
CLI stores its credential outside the project under `~/.config/boxcompute` with
restrictive file permissions. The credential is never included in the agent
skill.

For a self-hosted BoxCompute deployment, provide its web origin:

```sh
bxc login --url https://boxcompute.example.com
```

## Install the agent skill

```sh
bxc skill detect
bxc skill install
```

The installer checks known configuration directories and executables for
compatible coding harnesses. It does not recursively scan your home directory.
Use `bxc skill install all` to target every supported harness, or name one or
more explicitly. Run `bxc skill remove --yes` to uninstall matching copies.

Skills installed by `bxc` are managed copies. A global CLI upgrade refreshes an
untouched managed copy during installation, with a safe retry on the next
normal `bxc` command if package lifecycle scripts were disabled. Locally
modified skills are never overwritten; the CLI reports the path and leaves
replacement behind the explicit `bxc skill install --force` command. Start a
new agent session after the CLI reports that a skill was updated.

## Use sandboxes

```sh
bxc doctor
bxc workspaces
bxc sandboxes
bxc sandbox start WORKSPACE_ID
# Use the returned sandbox instance ID for later commands.
bxc sandbox logs SANDBOX_ID --source execute
bxc sandbox exec SANDBOX_ID -- python -m pytest
```

Run `bxc` or `bxc --help` for the complete command reference. The previous
`bcompute` executable remains available as a compatibility alias.

## Upgrade rollout

Deploy the server release with both Sandbox API v1 and v2 before publishing CLI
0.2. Existing CLI 0.1 clients remain on the legacy v1 workspace-sandbox
contract. After that, clients need only upgrade the package:

```sh
bxc update
```

`bxc up` is the short alias. If the automatic update cannot invoke npm, use
`npm install --global @boxcompute/cli@latest` manually. Updating preserves the
saved BoxCompute credential and refreshes untouched managed skills before the
client's next agent session. The new CLI uses v2 for multi-instance sandboxes
and gives a server-first upgrade message if it reaches an older deployment.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run lint
bun run build
```

The application-side authentication and customer Sandbox API implementations
live in the private `boxcompute/web-agent` repository. Changes to either side of
that contract must remain backward compatible during rollout: deploy the server
first, then publish the CLI.

## Releases

Every user-visible change is recorded in [CHANGELOG.md](CHANGELOG.md). Releases
use semantic `vMAJOR.MINOR.PATCH` tags and are published from `main` by the
protected `Publish BoxCompute CLI` workflow. npm trusted publishing supplies a
short-lived release credential; the repository stores no npm token.

## License

Copyright © 2026 BoxCompute. All rights reserved. The source is publicly
visible, but it is not offered under an open-source license.
