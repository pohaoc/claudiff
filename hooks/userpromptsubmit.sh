#!/bin/sh
# UserPromptSubmit hook: asks the extension for a report of changes the user
# reverted in review since the last prompt. Whatever this prints to stdout is
# injected as context for Claude — an empty body (nothing reverted, or the
# extension isn't running) injects nothing and costs zero tokens.
exec 2>/dev/null
curl -sS --fail --max-time 5 -X POST \
  -H 'content-type: application/json' \
  --data-binary @- \
  "http://127.0.0.1:${CLAUDIFF_PORT:-48291}/decisions" || exit 0
