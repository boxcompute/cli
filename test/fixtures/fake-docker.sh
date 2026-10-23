#!/bin/sh
# Test double for the docker CLI used by `bxc runner`: records every call and
# keeps one container's state in a file instead of talking to a daemon.
printf '%s%s\n' "${BOXCOMPUTE_RUNNER_TOKEN:+TOKEN-LEAKED }" "$*" >> "${FAKE_DOCKER_LOG:?}"
state_file=${FAKE_DOCKER_STATE:?}
state=$(cat "$state_file" 2>/dev/null || echo missing)
case "$1" in
  version)
    if [ -n "${FAKE_DOCKER_DOWN:-}" ]; then
      echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2
      exit 1
    fi
    echo 27.0.0
    ;;
  inspect)
    case "$state" in
      missing) echo "Error: No such container: $6" >&2; exit 1 ;;
      running) echo true ;;
      *) echo false ;;
    esac
    ;;
  run)
    if [ -n "${FAKE_DOCKER_PULL_DENIED:-}" ]; then
      echo "docker: Error response from daemon: pull access denied for private/image, repository does not exist or may require 'docker login'." >&2
      echo "See 'docker run --help'." >&2
      exit 125
    fi
    echo running > "$state_file"
    echo 4f0c0ffee
    ;;
  start) echo running > "$state_file"; echo "$2" ;;
  stop) echo stopped > "$state_file"; echo "$4" ;;
  rm)
    if [ "$state" = missing ]; then echo "Error response from daemon: No such container: $3" >&2; exit 1; fi
    echo missing > "$state_file"
    echo "$3"
    ;;
  volume) echo "$4" ;;
  exec)
    shift
    if [ "$1" = -i ]; then
      shift
      if [ "$1" = --env ]; then shift 2; fi
      shift
      exec "$@"
    fi
    case "$4" in
      *python3*) exit "${FAKE_DOCKER_TOOLS_EXIT:-0}" ;;
    esac
    ;;
  *)
    echo "unexpected docker call: $*" >&2
    exit 64
    ;;
esac
