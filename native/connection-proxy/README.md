# BoxCompute connection proxy

This is the client-only Tailcat transport used by `bxc sandbox ssh`. Its wire
contract and dependency versions are synchronized with
`boxcompute/sandbox@f397f001c879516fd9095791dbf842a899bc7df7`.

The binary can only generate an ephemeral node key or proxy standard input and
output to TCP port 22 using a private, owner-only, lease-limited configuration.
It does not contain the server endpoint, signer, enrollment, or admission code.
