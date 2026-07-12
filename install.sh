#!/bin/sh
# Single-command install/uninstall for ClauDiff. See install.js for what it
# actually does (symlink the extension, register hooks); this is just a thin,
# node-independent entry point so you don't have to type "node install.js".
set -e
dir=$(cd "$(dirname "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "ClauDiff install needs Node.js on PATH — see README.md for the manual steps instead." >&2
  exit 1
fi
exec node "$dir/install.js" "$@"
