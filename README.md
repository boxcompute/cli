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
# Forward VM port 3000 to local loopback for up to one hour.
bxc sandbox expose SANDBOX_ID --port 3000
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
# Resume the same stopped sandbox, retaining its disk and files.
bxc --json sandbox resume SANDBOX_ID
# Stop a running VM now; its disk and files stay for the next resume.
bxc --json sandbox stop SANDBOX_ID
# Container sandbox instead (supports --cpu); explicit gVisor opt-out.
bxc sandbox start WORKSPACE_ID --gvisor --cpu 2
bxc sandbox upload SANDBOX_ID fixture.txt /workspace/fixture.txt
bxc sandbox exec SANDBOX_ID --timeout 10 -- /bin/cat /workspace/fixture.txt
bxc sandbox download SANDBOX_ID /workspace/fixture.txt downloaded.txt
bxc sandbox delete SANDBOX_ID --yes
```

See [Test tools in a VM sandbox](docs/vm-sandbox-beta.md) for the CLI and API
walkthroughs, retry recovery, and Hermes limitations. VMs default to the
`small` profile (0.5 CPU, 1024 MiB memory) and `--size large` selects the 3x
profile (1.5 CPU, 3072 MiB memory). Both use a 30 GiB thin-provisioned
workspace. Sizing is VM only: the
gVisor runtime ignores `small` and rejects `large`. VMs have outbound Internet
access by default, no automatic lifetime expiry, and no SSH access. A running
VM bills until it stops: stop it when done if you will reuse it, or delete it
when its files are no longer needed. Uploads are limited to 8 MiB; downloads
read to EOF and refuse to overwrite local files.

`sandbox resume` starts an existing sandbox and resumes compute billing. It
keeps its ID, disk and files. Add `--no-wait` to return the start receipt, or
`--idempotency-key KEY` to retain a retry key. Inspect status after an uncertain
response; the CLI never automatically retries or creates a replacement VM.

`sandbox stop` (server 0.62.0+) stops a running VM now and keeps its disk and
files; `stopped: false` means it was not running. It never wakes a stopped VM
and is safe to repeat; on HTTP 409 the VM is still starting, stopping or in
use, so try again in a moment. Without it, a VM stops by itself 30 minutes
after its last resume, exec, upload, download or preview. Status, logs,
analytics, costs and processes running inside the VM do not count as activity.

### Expose VM services

To reach a TCP service running inside a network-enabled VM, keep a foreground
tunnel open locally:

```sh
# 127.0.0.1:3000 -> VM port 3000
bxc sandbox expose SANDBOX_ID --port 3000
# 127.0.0.1:8080 -> VM port 80, plus a second unchanged mapping
bxc sandbox expose SANDBOX_ID --port 8080:80 --port 5432
```

Only `127.0.0.1` is bound. A tunnel selects at most eight unique TCP ports,
expires after one hour, never renews automatically, and attempts revocation
when the command exits. It does not create a public URL or expose UDP.

### Browser previews

To share an HTTP or WebSocket service without a local tunnel, open a one-hour
preview URL for one port of a running, network-enabled VM:

```sh
bxc sandbox preview SANDBOX_ID --port 3000
bxc sandbox preview SANDBOX_ID --close PREVIEW_ID
```

The URL is a bearer link: anyone who has it can reach that port until it
expires or is closed. Each VM has at most one preview at a time.

### Account, costs, and history

```sh
# Remaining credits, settled spending, reservations and running estimates.
bxc credits
bxc --json billing
# Filter and page wallet transactions.
bxc billing transactions --kind usage_charge --limit 20
# Activity counts for the last 30 days.
bxc usage --days 30
# Confirm which account and API key the saved credential belongs to.
bxc whoami
# Settled and in-progress compute cost per sandbox (default: last 30 days).
bxc costs --from 2026-10-01T00:00:00Z
bxc sandbox costs SANDBOX_ID
# Lifecycle, operation, and resource analytics; use --json for time series.
bxc sandbox analytics SANDBOX_ID --resolution 60
# Deleted sandboxes keep read-only logs and cost history.
bxc deleted list
bxc deleted logs DELETED_ID --source execute
bxc deleted costs DELETED_ID
# Page the account's API audit log, newest first.
bxc audit --outcome error
```

`DELETED_ID` is the first column of `bxc deleted list`, not the original
sandbox ID.

### Experimental Tailcat SSH

Operator-enabled sandboxes can accept a short-lived, non-PTY SSH connection
without exposing an SSH port publicly:

```sh
BOXCOMPUTE_ENABLE_SSH=1 bxc sandbox ssh SANDBOX_ID
```

This feature currently supports Linux and macOS on x64 and arm64. Each grant
lasts at most 30 seconds, uses ephemeral client keys and a pinned SSH host key,
and requests best-effort cleanup when the client exits. It does not provision
or start a sandbox, retry mutations, provide arbitrary port forwarding, or
guarantee immediate cleanup. If revocation is uncertain, the CLI prints the
exact `--revoke` command; the server-side lease still expires naturally.

Run `bxc` or `bxc --help` for the complete command reference. The previous
`bcompute` executable remains available as a compatibility alias.

## Run chats on your own machine (`bxc runner`)

`bxc runner` lets the BoxCompute agent work on a computer you control. It
opens an outbound WebSocket to BoxCompute, so the machine needs no open ports,
and runs the agent's shell and file commands for chats that use this runner in
one Docker container per chat. Each chat's `/workspace` is a Docker volume on
this machine that stays until BoxCompute deletes the chat's sandbox.

Requirements: Docker (`docker version` must work for your user) and Node.js 22
or newer. The other `bxc` commands still run on Node.js 20.

### Set up a runner

1. In BoxCompute, open Settings → Runners, create a runner and copy its token.
2. On the machine that should run the commands:

   ```sh
   export BOXCOMPUTE_RUNNER_TOKEN=bxr_...
   npx -y @boxcompute/cli@latest runner
   ```

   To keep the token out of your shell history, type it at a prompt instead:
   `read -rs BOXCOMPUTE_RUNNER_TOKEN && export BOXCOMPUTE_RUNNER_TOKEN`.

   The runner prints `Connected as "<runner name>"` and then one line per
   operation. Leave it running; Ctrl-C disconnects it.
3. In BoxCompute, choose the runner for a chat in the composer. While the
   runner is connected, that chat's commands run in a container here.

The token is read only from `BOXCOMPUTE_RUNNER_TOKEN`, never from a command-line
option, because other users on the machine can read process arguments.

```sh
# Another image; it needs bash and python3 (default: node:22-bookworm).
bxc runner --image python:3.13
# Stop a chat's container after 2 hours without commands; 0 never stops it.
bxc runner --idle-stop 2h
# A self-hosted BoxCompute (default: your `bxc login` URL, else app.boxcompute.ai).
bxc runner --url https://boxcompute.example.com
# Also log each command's arguments.
bxc runner --verbose
```

Each container is named after the chat's sandbox (`bxs-…`), labelled
`com.boxcompute.runner` and `com.boxcompute.sandbox`, runs with `--init`, and
mounts the volume `bxs-…-workspace` at `/workspace`. List them with
`docker ps -a --filter label=com.boxcompute.runner`.

**Idle stop.** A container this runner has used stops after 30 minutes without
commands (`--idle-stop`). Its volume and files stay, and the next command
starts it again.

**Disconnects.** The runner reconnects by itself, backing off up to 30 seconds.
Commands that were running when the connection dropped are stopped; BoxCompute
reports them as failed. Ctrl-C (or SIGTERM) also stops running commands but
keeps every container and its files. The runner exits instead of reconnecting
when BoxCompute rejects the token, runners are not available on the account, or
another `bxc runner` connects with the same token.

### Custom dispatch

`--dispatch PROGRAM` hands every operation to your own program instead of the
built-in Docker dispatch, for example to use Podman, a VM or a remote host. The
runner starts `PROGRAM` without a shell for each operation, with the runner's
environment minus `BOXCOMPUTE_RUNNER_TOKEN`, plus:

| Variable | Value |
| --- | --- |
| `BOXCOMPUTE_OPERATION` | `ensure`, `exec` or `delete` |
| `BOXCOMPUTE_SANDBOX_ID` | The chat's sandbox, `bxs-` and 16 hex digits |
| `BOXCOMPUTE_RUNNER_ID` | This runner's ID |
| `BOXCOMPUTE_IMAGE` | The `--image` value (default `node:22-bookworm`) |

- **ensure** creates the sandbox if it is missing, with an empty `/workspace`,
  or starts it if it is stopped, and exits 0 once commands can run. It must be
  safe to repeat.
- **exec** receives the command's argv as its arguments. The runner writes the
  command's stdin (often empty) and closes it, streams stdout and stderr, and
  reports the program's exit code as the command's.
- **delete** removes the sandbox and its storage. An already missing sandbox is
  a success.

When ensure or delete exits non-zero, the last non-empty line of its stderr is
shown in BoxCompute as the error. A cancelled exec gets SIGKILL for the
program's whole process group; work it started elsewhere, such as through
`docker exec`, can keep running. There is no idle stop in this mode.

This `dispatch.sh` does what the built-in Docker dispatch does, without idle
stop:

```sh
#!/bin/sh
# bxc runner --dispatch ./dispatch.sh
set -eu
id="$BOXCOMPUTE_SANDBOX_ID"
fail() { echo "$1" >&2; exit 1; }

case "$BOXCOMPUTE_OPERATION" in
  ensure)
    state=$(docker inspect --type container --format '{{.State.Running}}' "$id" 2>/dev/null || true)
    case "$state" in
      true) ;;
      false) docker start "$id" >/dev/null || fail "Could not start $id" ;;
      *)
        docker run -d --name "$id" --init -w /workspace \
          --label "com.boxcompute.runner=$BOXCOMPUTE_RUNNER_ID" \
          --label "com.boxcompute.sandbox=$id" \
          -v "$id-workspace:/workspace" \
          "$BOXCOMPUTE_IMAGE" sleep infinity >/dev/null \
          || fail "Could not create $id from $BOXCOMPUTE_IMAGE"
        docker exec "$id" sh -c 'command -v bash && command -v python3' >/dev/null \
          || fail "The image $BOXCOMPUTE_IMAGE needs bash and python3"
        ;;
    esac
    ;;
  exec)
    exec docker exec -i "$id" "$@"
    ;;
  delete)
    if docker inspect --type container "$id" >/dev/null 2>&1; then
      docker rm -f "$id" >/dev/null || fail "Could not remove $id"
    fi
    docker volume rm -f "$id-workspace" >/dev/null || fail "Could not remove $id-workspace"
    ;;
  *)
    fail "Unsupported operation: $BOXCOMPUTE_OPERATION"
    ;;
esac
```

Make it executable with `chmod +x dispatch.sh`. `--idle-stop` cannot be combined
with `--dispatch`.

### Security

- The agent's commands run on this machine, inside containers that have this
  machine's network access, including your local network. Docker separates
  their files from yours, but treat it as running the agent here. BoxCompute
  approvals still apply.
- Anyone with the runner token can connect as this runner and receive its
  chats' commands and files. Keep it secret. `bxc runner` never prints it,
  sends it only in the first WebSocket message (not in a URL or header), and
  does not pass it to Docker, containers or a dispatch program.
- The connection uses TLS (`wss://`). Plain `ws://` is refused except to a
  loopback development server.
- Delete the runner in Settings → Runners to revoke its token. Stopping
  `bxc runner` does not remove containers or volumes; remove them with
  `docker rm -f` and `docker volume rm` when you no longer need their files.

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
bun run test:native
bun run lint
bun run build
npm pack --dry-run
```

Building the npm package requires Go 1.27.1 to compile its four client-only
Tailcat proxy binaries. End users do not need Go installed.

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
