# BoxCompute service client

This private helper binds selected TCP ports to `127.0.0.1` and forwards each
accepted connection through one lease-limited Tailcat client. It accepts exactly
two bounded JSON messages on stdin: local/remote mappings, then the sealed grant
configuration already authenticated and decrypted by the TypeScript parent.

The helper never receives the BoxCompute API credential or recipient private
key. Parent exit, a third input message, signal delivery, or the fixed deadline
closes every listener and active flow. Release packaging cross-compiles the
helper for Linux and macOS on x64 and arm64 and records dependency licenses.
