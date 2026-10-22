#!/bin/sh
# Test double for `bxc runner --dispatch`: runs exec argv directly on the host
# and records each call so tests can see what the runner asked for. A leaked
# runner token would show up in the log instead of "no-token".
printf '%s %s %s %s %s\n' "$BOXCOMPUTE_OPERATION" "$BOXCOMPUTE_SANDBOX_ID" "$BOXCOMPUTE_RUNNER_ID" \
  "${BOXCOMPUTE_IMAGE:-no-image}" "${BOXCOMPUTE_RUNNER_TOKEN:-no-token}" >> "${FAKE_DISPATCH_LOG:?}"
case "$BOXCOMPUTE_OPERATION" in
  ensure|delete)
    if [ "$BOXCOMPUTE_SANDBOX_ID" = bxs-ffffffffffffffff ]; then
      echo "preparing sandbox" >&2
      echo "disk full on test host" >&2
      echo "" >&2
      exit 1
    fi
    ;;
  exec)
    exec "$@"
    ;;
  *)
    echo "unknown operation" >&2
    exit 2
    ;;
esac
