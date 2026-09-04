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

## Use sandboxes

```sh
bxc doctor
bxc sandboxes
bxc sandbox start WORKSPACE_ID
bxc sandbox exec WORKSPACE_ID -- python -m pytest
```

Run `bxc` or `bxc --help` for the complete command reference. The previous
`bcompute` executable remains available as a compatibility alias.
