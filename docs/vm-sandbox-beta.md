# Test tools in a VM sandbox

Create a VM, upload test data, run a command, download the results, and delete
the VM using the BoxCompute API. This guide is for developers building short,
bounded integration tests for command-line tools and agent tool execution.

**Access:** any authenticated BoxCompute account can create VM sandboxes; no
separate approval is required. This profile is not intended for production
workloads or always-on services, and active VMs bill until you delete them.

**CLI support:** CLI 0.4.0 or newer creates VMs by default — `bxc sandbox start`
omits the runtime selector and waits up to 180 seconds for `running` — plus
`upload` and `download`. Use `--vm --idempotency-key KEY` for an explicit VM
create with your own retry key, `--no-wait` for the receipt only, and
`--gvisor` for a container sandbox instead. The [CLI walkthrough](#cli-walkthrough-040-or-newer)
uses browser login and the CLI's saved credential. The direct API walkthrough
uses a separately loaded account API key; do not extract the CLI's credential.
Experimental Tailcat SSH does not apply to VM sandboxes.

The walkthrough uses a small text fixture and requires no additional software
inside the VM. The [Hermes section](#evaluating-hermes-agent) explains what you
can investigate for an agent integration and what is not supported yet.

Last updated: September 17, 2026. VM contract updated September 17, 2026.

## Check whether your experiment fits

| Capability | Current VM profile |
| --- | --- |
| Availability | Any authenticated account. No separate VM approval. |
| Selection | Omitted `vmSandbox` selects the VM runtime (the default); `vmSandbox: false` explicitly selects a gVisor container sandbox. Rejected VM requests do not fall back to that path. |
| Resources | Fixed 500m CPU (0.5 CPU), 1,024 MiB RAM, 10 GiB workspace. No public sizing controls. |
| Lifetime | No automatic expiry. The VM exists, and bills for active use, until you delete it. |
| Image | Immutable, server-selected approved minimal Ubuntu image. No arbitrary image override, library profile, or attached volumes. |
| User/runtime | Unprivileged user; `HOME=/workspace`. No sudo/root installation or SSH login. Check that your required executables are available; Node.js, uv and your tool's dependencies are not guaranteed. |
| Networking | Outbound Internet access by default; request `blockNetwork: true` at create for a VM with no NIC. No inbound exposure either way. |
| Serving | No supported public inbound port, SSH endpoint, application tunnel, or webhook URL. Binding a guest port does not publish it. |
| Storage | `/workspace` is storage for this VM. Download needed data before deleting it. An account workspace groups sandboxes; it does not preserve their files. |
| Lifecycle | Create, status, execute, files, delete. Do not depend on sleep/resume, snapshots, checkpoints, forks, or restore for this VM profile. |

Start with a small payload and one command at a time. A full toolchain, browser,
model or concurrent agent workload may exceed the available resources.

## CLI walkthrough (0.4.0 or newer)

Use Bash and `jq` on your development machine. Install the CLI and authenticate
through the browser; the CLI keeps its saved credential outside your project:

```bash
npm install --global @boxcompute/cli@0.4.0
bxc login
bxc doctor
bxc --json workspaces
```

Select an owned workspace deliberately and set its ID below. If you need a new workspace, create
one in BoxCompute or use the optional workspace API request later in this guide.
Run these steps in the same shell in a new local test directory.

### Create and check readiness

Generate and save a key **once** for this intended VM. The key is not a credential.
Keep the workspace ID and optional name unchanged when retrying:

```bash
WORKSPACE_ID='REPLACE_WITH_OWNED_WORKSPACE_ID'
# Default runtime (VM). Start waits up to 180 seconds for running and
# reports the sandbox and its state either way.
bxc --json sandbox start "$WORKSPACE_ID" > vm-create-response.json
```

For an explicit VM create with your own retry key, add
`--vm --idempotency-key "$CREATE_KEY"` (generate and save the key once) and
`--no-wait` to get the creation receipt immediately; the receipt can be
`pending`, and a successful exit does not prove readiness. Either way, save the
returned sandbox ID separately:

```bash
SANDBOX_ID=$(jq -er '.sandbox.id | strings | select(length > 0)' vm-create-response.json)
printf '%s\n' "$SANDBOX_ID" > vm-sandbox-id.txt
bxc --json sandbox status "$SANDBOX_ID" > vm-status.json &&
jq -e '.sandbox.vmSandbox == true and .sandbox.state == "running"' vm-status.json
```

Continue only when the status check succeeds. For pending status, wait about
10 seconds before checking again; stop after five minutes and keep the saved
ID for later. If creation times out, retry only the `bxc sandbox start`
command with the unchanged key and options; do not rerun key generation. The
same request recovers the same ID. Completed receipts are retained for 24
hours and are not current status. Keep the saved ID even if a later replay
fails. Neither start nor status retries failed requests or allocates a
replacement VM.

### Upload, execute, and download

```bash
printf '0123456789abcdefghijklmnopqrstuvwxyz\n' > fixture.txt
bxc sandbox upload "$SANDBOX_ID" fixture.txt /workspace/fixture.txt
bxc --json sandbox exec "$SANDBOX_ID" --cwd /workspace \
  --timeout 10 --max-output-bytes 4096 -- \
  /bin/sh -c 'cat /workspace/fixture.txt > /workspace/result.txt' \
  > vm-execute-response.json &&
jq -e '.exitCode == 0 and .timedOut == false and .stdoutTruncated == false and .stderrTruncated == false' vm-execute-response.json
```

Continue only after upload and execution succeed. The shell text is fixed;
do not interpolate untrusted inputs. CLI execution JSON exposes the result
fields at the top level, while the direct API wraps them in `result`.
Execution is not idempotent; retrying after a lost response can run it again.

```bash
bxc sandbox download "$SANDBOX_ID" /workspace/result.txt downloaded.txt &&
cmp fixture.txt downloaded.txt
```

Uploads send raw bytes (up to 8 MiB) with a 30-second request timeout. Remote
paths must be absolute under `/workspace`; create parent directories with exec.
Downloads follow offsets and opaque cursors until EOF, with a five-minute total
deadline. They validate range metadata and byte counts and write a private
local file only on completion. The destination's parent directory must exist;
an existing destination is never overwritten. On stale cursors, expiry, or
other errors, partial local data is discarded. Stop writers and restart the
download explicitly after investigating the error. No transfer retries occur.
For manual partial reads, use the direct API examples below.

### Clean up

Download results early, then delete this disposable VM, including after a
failed test or expiry:

```bash
bxc sandbox delete "$SANDBOX_ID" --yes
```

Deletion leaves the parent workspace and sibling sandboxes intact. An expired
VM cannot be renewed by execution or file activity. Keep real model orchestration
on your own host and dispatch only bounded work to the VM.

## Before the direct API walkthrough

You need an approved account, an active API key, and Bash, curl, jq and Python 3
on your development machine. The examples also use `cmp` to compare files.
Run them in the same shell, in a new directory for your test files. Python is
used only to generate unique request keys; it is not required inside the VM.

Use **`https://api.boxcompute.ai/api/v2`** as the API base URL. See the
[OpenAPI reference](https://api.boxcompute.ai/api/v2/openapi.json) for request
and response schemas.

Use an active BoxCompute account API key as `Authorization: Bearer <API_KEY>`.
Keep the key on your development machine or integration controller, not in
the VM, test fixture, source repository, or logs. Disable shell tracing with
`set +x` before securely loading the key into `BOXCOMPUTE_API_KEY`.
No model-provider credential is needed for these offline experiments.

Required scopes: `sandbox:read` for workspace listing, sandbox status and file
reads; `sandbox:create` for creation; `sandbox:execute` for execution and file
uploads; `sandbox:delete` for cleanup. Workspace bootstrap additionally needs
`workspace:create`. Billing/credit checks still apply.

## Run your first integration test

### 1. Select an owned workspace

```bash
BASE='https://api.boxcompute.ai/api/v2'
: "${BOXCOMPUTE_API_KEY:?Load an approved account API key securely first}"
curl --fail-with-body -sS "$BASE/workspaces" \
  -H "Authorization: Bearer $BOXCOMPUTE_API_KEY"
```

HTTP 200 returns `{"workspaces":[...]}`. Deliberately select an owned workspace;
do not silently use the first result. Set `WORKSPACE_ID` to its returned `id`.
The workspace must belong to your account. You do not need a separate tenant
ID or tenant header.

If you need a new workspace, run the following optional request. HTTP 201
returns `{"workspace":{...}}`; use its `id` in the next step. Skip this request
when using an existing workspace. You can create up to 10 workspaces per account.

```bash
WORKSPACE_KEY="workspace-$(python3 -c 'import uuid; print(uuid.uuid4())')"
curl --fail-with-body -sS -i "$BASE/workspaces" \
  -H "Authorization: Bearer $BOXCOMPUTE_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $WORKSPACE_KEY" \
  --data '{"name":"Integration tests"}'
```

If the response is lost, retry with the same workspace key and body rather
than rerunning the key-generation line.

### 2. Create once; recover with the same key and body

Running this step allocates a VM for an approved account. Keep the request body,
key and returned sandbox ID for recovery; do not generate a new key on retry.

```bash
WORKSPACE_ID='REPLACE_WITH_RETURNED_WORKSPACE_ID'
CREATE_KEY="vm-$(python3 -c 'import uuid; print(uuid.uuid4())')" # Generate ONCE
jq -n --arg workspaceId "$WORKSPACE_ID" \
  '{workspaceId:$workspaceId,vmSandbox:true}' > vm-create.json
printf '%s\n' "$CREATE_KEY" > vm-create-key.txt

create_vm() {
  curl --fail-with-body -sS --connect-timeout 10 --max-time 30 \
    -o vm-create-response.json -w '%{http_code}\n' "$BASE/sandboxes" \
    -H "Authorization: Bearer $BOXCOMPUTE_API_KEY" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $CREATE_KEY" \
    --data-binary @vm-create.json
}
create_vm && jq . vm-create-response.json
```

The initial response is **202**, with a `sandbox` object normally in `pending`.
After a successful response, record `sandbox.id` separately before a retry can
overwrite the response file:

```bash
SANDBOX_ID=$(jq -er '.sandbox.id | strings | select(length > 0)' vm-create-response.json)
printf '%s\n' "$SANDBOX_ID" > vm-sandbox-id.txt
```

On a transport timeout, the outcome is unknown: retry `create_vm` with the
unchanged key/body. While work is pending, replays return 202. Once provisioning
converges, the same request returns **201 with the same public sandbox ID**.
Repeat at a modest interval (for example 10 seconds), with a bounded overall
wait; do not loop forever or allocate a replacement on every error. A 202 is
durable acceptance, **not** proof of eligibility or readiness. Provisioning
failures can leave it pending. If it is still pending after five minutes, stop
waiting, save the ID and error response for support, and use step 5 to delete
it. Five minutes is a suggested client wait limit, not a provisioning-time
guarantee. Do not change the key to try to resolve a stuck request.

If your shell closes, restore `CREATE_KEY` from `vm-create-key.txt`, keep
`vm-create.json` unchanged, reload the API key securely, and define the same
`BASE` and `create_vm` function. Do not rerun the initialization block, which
generates a new key. Restore any saved sandbox ID from `vm-sandbox-id.txt`.

Only `workspaceId`, optional `name` (1–80 trimmed characters), `vmSandbox`,
and `blockNetwork` (VM only; omitted means outbound Internet) configure public
creation. Unknown fields are currently discarded, not sizing controls. Do
not send `image`, `backend`, `cpu` (container sandboxes only), `memoryMiB`,
`workspaceMiB`, `timeoutSeconds`, `libraries`, or `volumes`.

An explicit `vmSandbox:true` requires `Idempotency-Key`: 1–255 visible ASCII
characters, no spaces. An omitted `vmSandbox` may be sent without one; the
server then generates the key. Keys are account-wide across mutations. Changed normalized input or
reuse for a different mutation gives `409 IDEMPOTENCY_CONFLICT`. Completed
receipts are retained for 24 hours after completion. A replay is a saved
creation receipt, not current status; even a deleted VM's receipt can replay.

### 3. Inspect status, then execute bounded work

```bash
: "${SANDBOX_ID:?Set the returned sandbox ID first}"
curl --fail-with-body -sS "$BASE/sandboxes/$SANDBOX_ID" \
  -H "Authorization: Bearer $BOXCOMPUTE_API_KEY" \
  -o vm-status.json && jq . vm-status.json
```

HTTP 200 returns `{"sandbox":{...}}` with `id`, `workspaceId`, `name`, `state`,
`vmSandbox`, `createdAt` and nullable `lastUsedAt`. Timestamps are Unix
milliseconds. States are `cold`, `pending`, `running`, `expired`; require
`vmSandbox:true` and `running` before your test. Status can lag changes in VM
availability, so handle errors from execute and file requests even after a
`running` response. The response does not include an expiry timestamp.

```bash
jq -e '.sandbox.vmSandbox == true and .sandbox.state == "running"' vm-status.json &&
curl --fail-with-body -sS "$BASE/sandboxes/$SANDBOX_ID/execute" \
  -H "Authorization: Bearer $BOXCOMPUTE_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"argv":["/bin/echo","beta integration"],"cwd":"/workspace","timeoutSeconds":10,"maxOutputBytes":4096}'
```

HTTP 200 wraps `result` containing `stdout`, `stderr`, `exitCode`, `timedOut`,
`stdoutTruncated` and `stderrTruncated`. For this echo, expect
`stdout:"beta integration\n"`, empty stderr, exit code 0, and all flags false.
Check the result, not only HTTP success: nonzero exit codes also return 200.
Use structured `argv`, not a `command` field. Shell syntax requires an explicit
shell, and interpolating untrusted inputs into shell text is unsafe.

`cwd` defaults to `/workspace` and must stay there or below it. Optional `env`
is a string map (up to 64 valid environment variable names). `argv` has 1–64
nonempty entries, each at most 8,192 characters. Execution timeout accepts
1–900 seconds (default 120).
Output is bounded to 1–1,048,576 bytes (default 262,144). Start with short
timeouts, small output and one task at a time. Execute is not idempotent:
retrying after a lost response can run the work again.

### 4. Stage fixtures and retrieve exact bytes

Uploads are raw bytes, not JSON, base64 or multipart. The per-upload limit is
8 MiB. File paths must be absolute under `/workspace`, at most 4,096 characters,
without `.`/`..` components or NUL. Create parent directories with execute if
needed. This tiny fixture stays in the existing workspace directory.

```bash
printf '0123456789abcdefghijklmnopqrstuvwxyz\n' > fixture.txt
curl --fail-with-body -sS -i -X PUT \
  "$BASE/sandboxes/$SANDBOX_ID/files/content?path=%2Fworkspace%2Ffixture.txt" \
  -H "Authorization: Bearer $BOXCOMPUTE_API_KEY" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @fixture.txt
# Expect 204 with no body.
```

Run a command against the uploaded fixture to produce a result file. The
shell text below is fixed and contains no interpolated user input:

```bash
curl --fail-with-body -sS "$BASE/sandboxes/$SANDBOX_ID/execute" \
  -H "Authorization: Bearer $BOXCOMPUTE_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"argv":["/bin/sh","-c","cat /workspace/fixture.txt > /workspace/result.txt"],"cwd":"/workspace","timeoutSeconds":10,"maxOutputBytes":4096}' \
  -o vm-execute-response.json &&
jq -e '.result | .exitCode == 0 and .timedOut == false and .stdoutTruncated == false and .stderrTruncated == false' vm-execute-response.json
```

Continue only after that check succeeds. Download the generated result and
compare its bytes with the local fixture:

```bash
curl --fail-with-body -sS -D full.headers -G \
  "$BASE/sandboxes/$SANDBOX_ID/files/content" \
  -H "Authorization: Bearer $BOXCOMPUTE_API_KEY" \
  --data-urlencode 'path=/workspace/result.txt' -o full.txt &&
cmp fixture.txt full.txt

curl --fail-with-body -sS -D range.headers -G \
  "$BASE/sandboxes/$SANDBOX_ID/files/content" \
  -H "Authorization: Bearer $BOXCOMPUTE_API_KEY" \
  --data-urlencode 'path=/workspace/result.txt' \
  --data-urlencode 'offset=7' --data-urlencode 'maxBytes=11' -o range.txt &&
printf '789abcdefgh' > expected-range.txt &&
cmp expected-range.txt range.txt
```

Both reads return **200**, including partial reads, not 206. Use query
`offset` (default 0) and `maxBytes` (1–8,388,608; default 8,388,608), **not** an
HTTP `Range` header. Inspect `X-BoxCompute-Offset`, `X-BoxCompute-Next-Offset`,
`X-BoxCompute-File-Size`, and `X-BoxCompute-EOF` in the saved header files. A
default read is only a full download if EOF is true. For larger files, repeat
using the returned next offset and `X-BoxCompute-Next-Cursor` as the `cursor`
query parameter, appending chunks until EOF. A file changed between pages can
return `409 CURSOR_STALE`; restart the download rather than mixing versions.
Stop the writer before exporting a database; byte-range transport alone does
not make a live database backup consistent.

### 5. Export early; delete explicitly

Download your results before deleting the VM. VMs have no automatic expiry,
so an idle VM keeps billing until you delete it. When an
execute or file request detects that the VM has expired, it returns
`503 SANDBOX_UNAVAILABLE` and the sandbox is marked `expired`.
Using that sandbox ID again does not automatically create a replacement VM.
A 503 alone is not proof of expiry: transport failures also use that code.

```bash
curl --fail-with-body -sS -i -X DELETE "$BASE/sandboxes/$SANDBOX_ID" \
  -H "Authorization: Bearer $BOXCOMPUTE_API_KEY"
# Expect 204 with no body; a subsequent status GET returns 404.
```

Delete even after expiry, to cancel a pending creation, or if a test step fails.
Deletion removes this sandbox and its associated storage, not the parent
workspace or sibling sandboxes. A repeated DELETE after removal returns 404.
Treat workspace contents as disposable: files are not automatically exported
on expiry.

## Troubleshooting

Errors have shape `{"code":"...","error":"..."}`. Useful distinctions:
401 invalid/missing key; 403 `INSUFFICIENT_SCOPE` or frozen billing account;
402 `INSUFFICIENT_CREDIT`; 404 `NOT_FOUND` for missing/foreign resources or
`FILE_NOT_FOUND` for missing files; 408 `EXECUTION_TIMEOUT`; 413
`PAYLOAD_TOO_LARGE`; 415 `UNSUPPORTED_MEDIA_TYPE`; 502 `SERVICE_UNAVAILABLE`;
503 `SANDBOX_UNAVAILABLE`.

- For 401/403, check your key's status and scopes.
- For 402, check your account credit before retrying.
- For 409 `IDEMPOTENCY_CONFLICT`, check whether you changed the request body or
  reused a key for another operation. Recover the original request first.
- For 409 `CURSOR_STALE`, restart the file download from offset zero without
  the old cursor after stopping the writer.
- For 503, inspect sandbox status. If it is expired, delete it; do not retry
  execution expecting a fresh VM.
- For repeated 5xx errors or a stuck creation, contact BoxCompute with the
  sandbox ID, time of the request, HTTP status and error code. Never include
  your API key or sensitive file contents in a support report.

## Evaluating Hermes Agent

The authoritative [Hermes installation guide](https://hermes-agent.nousresearch.com/docs/getting-started/installation),
[configuration reference](https://hermes-agent.nousresearch.com/docs/user-guide/configuration),
and [messaging gateway guide](https://hermes-agent.nousresearch.com/docs/user-guide/messaging)
describe its installation and runtime requirements. Pin the Hermes version you
investigate; those requirements can change. **Hermes is not preinstalled, and
running Hermes end to end in this VM profile has not been verified.** Start with
bounded tool execution rather than trying to host the full agent.

| Hermes requirement | What developers can do here / blocker |
| --- | --- |
| Linux installer | Upstream requires Git, curl, xz-utils; it downloads code and dependencies including uv/Python 3.11, Node.js v26 (or accepted installed versions), ripgrep and ffmpeg. Outbound Internet is available by default, but the fixed 0.5 CPU / 1 GiB profile makes a full install unlikely to fit; measure a minimal payload before attempting it. |
| Runtime and optional tools | Minimal Ubuntu is not a Hermes runtime image. Browser tooling additionally needs Chromium and OS libraries, some requiring administrator installation. No root install, custom image or library-profile request is available. Measure a small payload before attempting it; a full installation is not known to fit. |
| Model/provider access | Nous Portal uses OAuth; other providers use their credentials/endpoints, including OpenAI-compatible services. Main and auxiliary model calls need outbound connectivity, which is available by default. Keep real provider credentials off the VM and out of fixtures; use synthetic or placeholder credentials for experiments. No local model service or GPU is supplied. |
| Command backend | Hermes documents local, Docker, SSH and several cloud/container backends, not a built-in BoxCompute backend. If runtime prerequisites are independently satisfied, local execution would run inside this VM as its unprivileged user. Docker/SSH/cloud hosting assumptions do not transfer; any public-API adapter is developer work, not provided here. |
| State | Hermes uses `~/.hermes` or `HERMES_HOME` for config, credentials, memory, skills, sessions, logs and SQLite `state.db`. A proposed `/workspace/hermes-home` is scratch only. Export synthetic test state before deleting the VM; account workspace identity does not preserve it across VMs. |
| SQLite storage | The VM workspace uses virtiofs, a shared filesystem. Hermes defaults to SQLite WAL and warns that some virtiofs setups need `database.journal_mode: delete`. SQLite behavior here has not been verified for Hermes. Test a fresh disposable database; do not copy a live WAL database or assume that changing config converts an existing one. |
| Gateway, cron, dashboard | The gateway is a background service with persistent sessions and external platform connections; serving also needs a reachable endpoint. A VM with no inbound publication cannot host long-running Hermes or its messaging/dashboard service, and an always-on VM bills until deleted. |

Do not upload real Hermes `.env`, `auth.json`, private keys or personal session
backups to start testing. Use synthetic state and placeholder credentials.
Network access, larger/longer-lived instances, persistent volumes, browser
dependencies and inbound serving require future platform capabilities, not
undocumented create fields or a workaround inside the guest.

## Useful experiments to build now

1. **API adapter contract tests:** implement your own client around the flow
   above. Record one create key/ID, pending-to-ready handling, stdout/stderr,
   file checksums and cleanup. Keep any real model orchestration on your own
   development host; dispatch only bounded tool work to the
   VM. This is an integration design to implement, not an existing Hermes plugin.
2. **Offline tool fixtures:** upload a small script plus synthetic inputs; run
   it with an available interpreter or a compatible, developer-built standalone
   binary. First probe `id`, `uname -m`, `command -v` for required executables,
   and `df` for `/workspace`. `command -v` is shell syntax: invoke it through
   an explicit shell, for example `argv:["/bin/sh","-c","command -v python3"]`.
   Record missing dependencies as blockers rather than installing from the
   Internet or assuming packages are preinstalled.
3. **Hermes component investigation:** outside the VM, identify a pinned
   component and its transitive dependencies. Only if a small payload
   fits, test configuration/state serialization or deterministic tool behavior
   without model access. For a loopback mock experiment, you supply both mock
   and client inside the VM and stop them within the test budget; this would
   test protocol handling, not real inference or inbound serving.
4. **Failure-aware client behavior:** in your test sandbox,
   exercise same-key recovery and small file ranges, export results, and handle
   expiry/unavailability without automatic replacement. Keep experiment and
   cleanup budgets explicit. Save the failed stage and sandbox ID so you can
   diagnose failures without repeatedly allocating new VMs.
