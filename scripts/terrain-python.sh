#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -x .terrain-venv/bin/python ]; then
  exec .terrain-venv/bin/python "$@"
fi
exec python3 "$@"
