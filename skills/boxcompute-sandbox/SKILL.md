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
- Sandboxes persist across commands; do not destroy one merely because the
  current task is finished.
- `bxc sandbox delete SANDBOX_ID --yes` destroys the remote runtime and is
  intentionally explicit. Use it only when the user asks to remove the runtime
  or clearly designated it as disposable. The BoxCompute workspace remains.
- The CLI does not retry mutating requests. If a connection drops during a
  start or delete, inspect state before deciding what to do next.

Summarize which workspace was used, the meaningful command results, and whether
the sandbox was left running.
