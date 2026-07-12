# ClauDiff — Inline diff review in Claude Code for VSCode

In any mode where Claude's edits already apply unblocked, ClauDiff adds the review you're
missing: when the turn finishes, every changed file opens with each contiguous
change shown inline as red (old) / green (new) lines. You keep or revert each
hunk individually.

No API key, no SDK, no separate login, no build step — it plugs into your
existing Claude Code session via hooks, and the extension is plain
logic in JavaScript without dependency.

## Mode mapping

| Claude Code mode | Behavior |
| --- | --- |
| **acceptEdits** ("edit automatically") | **Inline review** — edits/filesystem-safe commands auto-apply, everything else still prompts; inline hunk review at end of turn |
| **auto** ("auto") | **Inline review** — every tool call auto-approves (with Claude Code's own safety classifier), inline hunk review at end of turn |
| **default** ("manual") | Untouched — Claude Code's native per-edit blocking prompt |
| **plan** | Untouched |

## Setup

### 1. Install

```sh
./install.sh
```

- **Symlinks the extension** into whichever VS Code extensions directories
  exist on this machine (local `~/.vscode/extensions`, remote/SSH/WSL
  `~/.vscode-server/extensions`), named `publisher.name-version` the way VS Code expects. Being a symlink, it always
  reflects the repo's current state — no reinstall after `git pull`.
- **Registers the three hooks** (below) in `~/.claude/settings.json`, merging
  into whatever's already there rather than overwriting it.


To register the hooks for one project instead of globally:

```sh
./install.sh --project /path/to/project   # defaults to the current directory
```

To remove everything ClauDiff added (add `--project ...` to match a
project-scoped install):

```sh
./install.sh --uninstall
```

`install.sh` just needs `node` on `PATH` (no other dependencies) and shells
out to `install.js`, which does the actual work — read that file if you want
to see exactly what it touches before running it.

Then reload VS Code (**Developer: Reload Window**) and start a new Claude
Code session so it picks up the hooks.

<details>
<summary>Manual install, if you'd rather not run a script</summary>

Copy (or symlink) this folder into your VS Code extensions directory as
`pohaoc.claudiff-1.0.0` (match `publisher.name-version` from `package.json`):

- Remote / SSH / WSL: `~/.vscode-server/extensions/pohaoc.claudiff-1.0.0/`
- Local: `~/.vscode/extensions/pohaoc.claudiff-1.0.0/`

Then add to `~/.claude/settings.json` (or a project's `.claude/settings.json`),
replacing `/path/to/claudiff` with this repo's absolute path:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "sh /path/to/claudiff/hooks/pretooluse.sh",
            "timeout": 120,
            "statusMessage": "Recording edit for review…"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh /path/to/claudiff/hooks/stop.sh",
            "timeout": 15
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh /path/to/claudiff/hooks/userpromptsubmit.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

</details>

### 2. How to use?

Chat with Claude Code as usual in "edit automatically" (`acceptEdits`) or
"auto" (`auto`) mode — whichever suits how much autonomy you want Claude to
have.

Each hunk gets its own CodeLens: `✓ Keep | ✗ Revert`. The first hunk also
carries file-level actions: `✓✓ Keep All | ✗✗ Revert All`, and `→ Next File`
when more files are waiting. In summary:

- **Keep hunk**: `Cmd/Ctrl+Enter` 
- **Revert hunk**: `Cmd/Ctrl+Backspace`
- **Keep All / Revert All**: settle every remaining hunk in the current file
- **Next File**: `Ctrl/Cmd+Alt+.`: defers the current file and show the next.

#### Other details
Once every hunk in a file is decided, the buffer is saved — that's the moment
the file on disk changes (if you reverted anything). A brand-new file whose
every hunk is reverted is deleted.

If the file under review is already open in some tab (any editor group), the
review jumps to that tab instead of opening a duplicate.

Inline mode falls back to a diff tab (whole-file Keep All / Revert All only)
for dirty buffers or when `files.autoSave` is on. Set `claudiff.style` to
`"diffTab"` to always use the diff editor.

The "ClauDiff" output channel logs every snapshot and decision
(`curl http://127.0.0.1:48291/health` should print `ok`).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudiff.port` | `48291` | Localhost port for the review server. Override the hook side with `CLAUDIFF_PORT`. |
| `claudiff.reviewModes` | `["acceptEdits", "auto"]` | Permission modes that get inline review. Remove from here to disable. |
| `claudiff.style` | `"inline"` | `"inline"` (in-buffer hunk review) or `"diffTab"` (whole-file diff editor). |
| `claudiff.autoApplyOutsideWorkspace` | `false` | Auto-apply edits outside the open workspace folders. When off, those hit the built-in prompt. |


## How it works

```
Claude Code session (official extension chatbox or CLI)
  ├─ PreToolUse hook (Edit|Write) ── pretooluse.sh ──▶ extension (localhost:48291)
  │      ◀── snapshot pre-edit content, reply "allow" immediately ──┘
  │      (repeat for every edit in the turn — nothing blocks)
  ├─ Stop hook (turn finished) ──── stop.sh ─────────▶ extension
  │      └─ diff each touched file against its snapshot
  │         → inline red/green hunks, ✓ Keep / ✗ Revert per hunk
  │         → reverted hunks are patched back out of the file
  └─ UserPromptSubmit hook ──── userpromptsubmit.sh ─▶ extension
         └─ replies with a one-shot report of anything you reverted
            → injected as context so Claude doesn't re-apply it
            → empty (zero tokens) when you kept everything
```

Fail-safe by design:

- **Extension not running** → curl fails, the hook prints nothing, and Claude
  Code's normal permission prompt appears. Nothing breaks.
- **Files outside the workspace** → fall through to the built-in prompt
  (unless `claudiff.autoApplyOutsideWorkspace` is on).
- **Interrupted turn (no Stop event)** → if claude hook didn't fire, the review still opens ~60s after the last edit.
- **Other modes** → in `default` / `plan` the extension
  returns no decision and the mode behaves exactly as usual.
## Safeguard

- **Typing in the file while a review is showing is safe.** Every Keep/Revert
  first verifies the buffer still matches the exact preview the extension
  built; if you edited it, the preview is rebuilt (~300 ms after you stop
  typing) and your edit simply shows up as its own reviewable hunk — reverting
  it restores the pre-turn lines. Saving mid-review is also safe: the
  preview-only red lines are stripped as part of the save itself, so they can
  never reach disk, and your edits are kept. This also protects your
  typing when Claude re-edits a file you're mid-review on, or when you defer
  it with Next File.
- **Claude is told about reverts — at your next prompt.** Within the turn the
  PreToolUse hook already answered "allow", so Claude believes the edit
  succeeded. Once your reverts are persisted, the UserPromptSubmit hook
  injects a short one-shot report (file, location, the removed/restored
  lines, capped in size) with your next message, so Claude doesn't mistake
  the revert for an accident and re-apply it. When you kept everything,
  nothing is injected and the token cost is zero. Reverts you decide *after*
  sending a prompt ride along with the following one.
- **Your own edits during review are *not* proactively reported — known
  risk.** Only reverts (undoing Claude's changes) are reported. If you rewrite
  a chunk yourself instead of reverting it, that report doesn't mention it.
  Your edit is still preserved — it's folded in as its own reviewable hunk and
  saved to disk — and Claude does pick it up eventually, because Claude Code's
  built-in file-freshness tracking forces a re-read the next time it touches
  the file. However, if Claude re-edits that
  region from memory *before* that re-read, it can clobber your rewrite. If an edit matters to the conversation, mention it in chat.
