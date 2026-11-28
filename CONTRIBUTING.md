# Contributing

Thank you for improving the BoxCompute CLI (`bxc`). Bug fixes, documentation
and new commands are all welcome.

## Before you start

- A bug fix or a small improvement can go straight to a pull request.
- For a new command, a new flag, or a change to output that scripts may parse
  (`--json`), open an issue first so we can agree on the shape before you build
  it.
- The CLI talks to the public BoxCompute API. The server (authentication, the
  Sandbox API, billing) is not in this repository and is not open source, so a
  change can only use what the API already serves. If you need something it
  does not offer, open an issue describing the use case.
- Report vulnerabilities privately, never in an issue: see
  [SECURITY.md](SECURITY.md).

## Set up

You need [Bun](https://bun.sh) 1.3.14 (the version in `package.json`),
Node.js 20 or newer, and Go 1.27.1 for the native helpers under `native/`.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:native
bun run lint
bun run build
npm pack --dry-run
```

These checks need no BoxCompute account. To try a change against the real
service, run `node dist/cli.js login` and use your own account. Running VMs
spend your account's credit, so stop them when you are done
(`node dist/cli.js sandbox stop SANDBOX_ID`).

The package runs on Node.js 20, 22 and 24, not only under Bun. CI checks all
three.

## Pull requests

- Keep one change per pull request. Pull requests are squash-merged, so the
  title becomes the commit message: use
  [Conventional Commits](https://www.conventionalcommits.org) such as
  `fix(cli): …`, `feat(cli): …` or `docs: …`.
- Add or update tests for the behaviour you change.
- A change to anything that ships in the npm package (`src/`, `skills/`,
  `README.md`, `tsconfig.build.json`, or published `package.json` fields) must
  bump the version in `package.json` and add a matching entry at the top of
  `CHANGELOG.md`, in the format of the entries already there. Use a patch
  version for fixes and a minor version for new commands or flags. CI fails
  without it. If another pull request takes your version number first, a
  maintainer can renumber yours, so leave **Allow edits by maintainers** on.
- Follow the rules under _Security boundary_ in [CLAUDE.md](CLAUDE.md): never
  print the saved credential or accept it as an argument, pass everything after
  `--` to the program in the sandbox untouched, and never overwrite a skill the
  user has edited.
- Never commit API keys, tokens, files from `~/boxcompute`, or recorded
  responses from a signed-in account.

CI runs without any repository secrets. GitHub holds a first-time
contributor's CI until a maintainer approves it. Merging does not publish:
maintainers release from `main` separately.

## License

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE) that covers this repository.
