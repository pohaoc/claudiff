#!/bin/sh
# Stop hook: tells the extension the turn is over so the review can begin.
# Fire-and-forget — never blocks Claude Code from stopping.
exec 2>/dev/null
curl -sS --fail --max-time 10 -X POST \
  -H 'content-type: application/json' \
  --data-binary @- \
  "http://127.0.0.1:${CLAUDIFF_PORT:-48291}/stop" >/dev/null || exit 0
