# Working in this repo

This repository owns the public `@boxcompute/cli` npm package and its bundled
`boxcompute-sandbox` agent skill. The BoxCompute application and API live in
`boxcompute/web-agent`; the Sandbox control plane lives in `boxcompute/sandbox`.

## Toolchain

Use the repository-pinned Bun version, not npm, for development:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run lint
bun run build
npm pack --dry-run
```

The distributed entry point runs on Node.js 20 and newer. A change is not ready
only because it passes under Bun; keep the Node 20, 22, and 24 package smoke
checks green as well.

## Security boundary

The CLI stores its bearer credential outside project directories with mode
`0600`. Never print it, put it in the bundled skill, accept it on a command
line, or persist it in a repository. Browser authentication must keep the
device code short-lived and must validate that the verification URL has the
same origin as the configured BoxCompute service.

Arguments after the `bxc sandbox exec SANDBOX_ID --` separator belong to the
program running in the sandbox. Do not interpret them as CLI options.

Managed skills may be updated only when their recorded digest still matches.
Never overwrite or remove a locally modified skill without an explicit force
or confirmation flag.

## Releases

Every distributable change must bump `package.json` to a new semantic version
and add the matching `CHANGELOG.md` entry in the same pull request. Confirm the
version does not already exist:

```bash
npm view @boxcompute/cli@VERSION version
```

Publishing is a protected manual dispatch of `.github/workflows/release.yml`
from `main`. The workflow uses npm trusted publishing, stages a reviewed GitHub
release, publishes, verifies npm visibility, and then publishes the immutable
GitHub release. Never publish from a local terminal or add an `NPM_TOKEN`.

Release tags are `vMAJOR.MINOR.PATCH`. Notes follow the Sandbox convention: a
short outcome, explicit user action, security impact, and the exact source
commit. GitHub Releases and `CHANGELOG.md` are the public release record.

The source is publicly visible but proprietary. Do not replace `UNLICENSED` or
add an open-source license without owner approval.
