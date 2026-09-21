---
name: boxcompute-sandbox
description: Use the authenticated bxc CLI to run code, data work, builds, tests, or service experiments in an isolated BoxCompute workspace. Use when work needs remote compute or should not run directly on the user's machine; do not use for ordinary local file edits that need no execution.
---

# BoxCompute Sandbox

Use `bxc` as the only interface. Authentication belongs to the human: if
`bxc doctor` says the client is not authenticated, ask the user to run
`bxc auth`; never request, read, print, or transmit their saved credential.

## Choose or create a sandbox

Run `bxc --json workspaces` to choose the parent workspace, including when it
does not have a sandbox yet. Run `bxc --json sandboxes` to inspect existing
instances and do not assume the first result is correct. To allocate another
isolated instance under a workspace, start one with:

```sh
bxc --json sandbox start WORKSPACE_ID
```

The returned sandbox `id` is the stable instance ID used by later commands.

## VM sandboxes and files (CLI 0.4.0+)

VM is the default runtime: `bxc --json sandbox start WORKSPACE_ID` creates a VM
and waits up to 180 seconds for `state: running`, reporting the sandbox either
way. For an explicit VM create with your own retry key, add `--vm
--idempotency-key KEY`; reuse the same key, workspace, and optional `--name` on
retry, and save the returned ID even when pending. `--no-wait` returns the
creation receipt immediately. Use `--gvisor` for a container sandbox instead.
Never change keys to recover a stuck create.

VMs are sized at create with `--size small|large` (default `small`): small is
0.5 CPU / 1024 MiB RAM and large is 1.5 CPU / 3072 MiB RAM, both with a 10 GiB
workspace. Sizing is VM only: gVisor ignores `small` and rejects `large`, and
VM sizing is mutually exclusive with `--cpu`. Use `--size large` only when the
task needs more than the default profile; it bills more. VMs have outbound
Internet access by default, no SSH, and no automatic lifetime expiry — delete
the VM when finished because active VMs keep billing. Execution does not
replace an expired VM. Probe executables; dependencies are not guaranteed.

```sh
bxc sandbox upload SANDBOX_ID fixture.txt /workspace/fixture.txt
bxc sandbox download SANDBOX_ID /workspace/result.txt result.txt
```

Uploads send raw bytes and are limited to 8 MiB. Downloads follow cursors to
EOF, discard partial output on errors, and require a new local destination.
Remote paths stay under `/workspace`; create parent directories with exec.
Stop writers before downloading state. For disposable VM tests, export early
and delete with `bxc sandbox delete SANDBOX_ID --yes`, including on test failure
or expiry. Ordinary Sandbox persistence guidance below does not apply to VMs.

## Execute work

Prefer argument-vector execution, which avoids a local shell:

```sh
bxc sandbox exec SANDBOX_ID -- python -m pytest
bxc sandbox exec SANDBOX_ID --cwd /workspace/project -- npm test
```

Use `bash -lc` only when the remote operation genuinely needs shell syntax such
as pipes or redirection. Paths must stay at `/workspace` or below it. Separate
executions do not share shell variables or a changed working directory, so pass
`--cwd` and `--env KEY=VALUE` explicitly when needed.

Use `--json` when inspecting results programmatically. A non-zero command exit
is task evidence, not a reason to repeat blindly: read stdout/stderr, correct
the cause, and then run the revised command. Never send local secrets into the
sandbox unless the user explicitly places those secrets in scope.

## Experimental SSH transport

Use `bxc sandbox exec` for normal agent work. Only use the experimental SSH
transport when the user explicitly asks for SSH or for testing the Tailcat
connection path, and only with an already running operator-enabled sandbox:

```sh
BOXCOMPUTE_ENABLE_SSH=1 bxc sandbox ssh SANDBOX_ID
```

The non-PTY lease lasts at most 30 seconds and cleanup is best-effort. Do not
present it as a persistent shell, arbitrary tunnel, or proof of immediate
server-side revocation. If the CLI reports an uncertain revoke, preserve its
endpoint ID and use the printed `--revoke` command only after inspecting owner
state. Never retry activation automatically.

## Lifecycle and safety

- Inspect uncertain state with `bxc --json sandbox status SANDBOX_ID`.
- Read runtime output with `bxc sandbox logs SANDBOX_ID`. Add `--json` for
  structured entries or narrow results with `--since`, `--until`, `--stream`,
  `--source`, and `--limit`. Log reads do not start stopped compute, and remain
  available for the provider's nominal 30-day retention period after deletion;
  storage pressure may shorten that period, so logs are not an archive.
- Sandboxes persist across commands; do not destroy one merely because the
  current task is finished.
- `bxc sandbox delete SANDBOX_ID --yes` destroys the remote runtime and is
  intentionally explicit. Use it only when the user asks to remove the runtime
  or clearly designated it as disposable. The BoxCompute workspace remains.
- The CLI does not retry mutating requests. If a connection drops during a
  start or delete, inspect state before deciding what to do next.

Summarize which workspace was used, the meaningful command results, and whether
the sandbox was left running.
