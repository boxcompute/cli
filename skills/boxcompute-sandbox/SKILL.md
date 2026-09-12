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

## VM beta and files (CLI 0.4.0+)

For approved-account offline VM tests, use `bxc --json sandbox start WORKSPACE_ID
--vm --idempotency-key KEY`. Generate and save one unique key per intended VM;
reuse the same key, workspace, and optional `--name` on retry. Save the returned
ID even when pending. Start does not wait; inspect status and require
`vmSandbox: true` and `state: running` before work. Stop waiting after five
minutes and clean up the test VM. Never change keys to recover a stuck create.

VMs have 0.5 CPU, 1 GiB RAM, a 256 MiB temporary workspace, no external network
or SSH, and a fixed 600-second lifetime including boot. Execution does not
extend that lifetime or replace an expired VM. Probe executables; dependencies
are not guaranteed and online installation is unavailable.

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
