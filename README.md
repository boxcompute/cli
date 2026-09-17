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
# Optionally request 0.1–4 scheduler CPUs for this sandbox.
bxc sandbox start WORKSPACE_ID --cpu 2
# Use the returned sandbox instance ID for later commands.
bxc sandbox logs SANDBOX_ID --source execute
bxc sandbox exec SANDBOX_ID -- python -m pytest
```

When `--cpu` is omitted, BoxCompute uses the server's default scheduler CPU
allocation.

### VM sandboxes

Any authenticated account can create a VM; VM is the default runtime, so a
plain start returns a VM sandbox once it is running:

```sh
# Default runtime (VM). Start waits up to 180 seconds for running.
bxc --json sandbox start WORKSPACE_ID
# Explicit VM creation with your own retry key; --no-wait returns the receipt.
bxc --json sandbox start WORKSPACE_ID --vm --idempotency-key SAVED_UNIQUE_KEY --no-wait
# Triple the default VM profile (1.5 CPU, 3072 MiB). VM only.
bxc --json sandbox start WORKSPACE_ID --vm --idempotency-key SAVED_UNIQUE_KEY --size large
bxc --json sandbox status SANDBOX_ID
# Container sandbox instead (supports --cpu); explicit gVisor opt-out.
bxc sandbox start WORKSPACE_ID --gvisor --cpu 2
bxc sandbox upload SANDBOX_ID fixture.txt /workspace/fixture.txt
bxc sandbox exec SANDBOX_ID --timeout 10 -- /bin/cat /workspace/fixture.txt
bxc sandbox download SANDBOX_ID /workspace/fixture.txt downloaded.txt
bxc sandbox delete SANDBOX_ID --yes
```

See [Test tools in a VM sandbox](docs/vm-sandbox-beta.md) for the CLI and API
walkthroughs, retry recovery, and Hermes limitations. VMs default to the
`small` profile (0.5 CPU, 1024 MiB memory, 10 GiB workspace) and `--size large`
selects the 3x profile (1.5 CPU, 3072 MiB memory). Sizing is VM only: the
gVisor runtime ignores `small` and rejects `large`. VMs have outbound Internet
access by default, no automatic lifetime expiry, and no SSH access; delete them
when done because active VMs keep billing. Uploads are limited to 8 MiB;
downloads read to EOF and refuse to overwrite local files.

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
