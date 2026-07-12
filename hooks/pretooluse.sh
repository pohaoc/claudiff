#!/bin/sh
# PreToolUse hook for Claude Code: forwards the Edit/Write call (stdin) to
# the extension, which snapshots the file and replies
# "allow" immediately (Auto + Review — the user reviews at end of turn).
#
# The extension replies with either the exact PreToolUse hook-output JSON
# or an empty body (no decision). If the extension isn't running, curl fails
# and we exit 0 with no output — Claude Code's normal permission prompt
# takes over. This hook must never break a session.
exec 2>/dev/null
curl -sS --fail --max-time 115 -X POST \
  -H 'content-type: application/json' \
  --data-binary @- \
  "http://127.0.0.1:${CLAUDIFF_PORT:-48291}/review" || exit 0
