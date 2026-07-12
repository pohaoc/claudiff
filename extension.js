// ClauDiff — Cursor-style "Auto + Review" for Claude Code.
//
// A PreToolUse hook (hooks/pretooluse.sh) reports every Edit/Write here. In
// any mode where edits already apply unblocked ("acceptEdits" / "auto"), the
// extension snapshots the file's pre-edit content and answers "allow"
// immediately — it doesn't care which of those modes is active, since both
// mean the same thing for file edits; they only differ in what happens to
// other tools (Bash, WebFetch, ...), which is the user's call, not this
// extension's concern. When the turn finishes, a Stop hook (hooks/stop.sh)
// pings /stop and the extension diffs each touched file against its
// snapshot, presenting the changes inline: every contiguous hunk gets red
// (old) / green (new) lines and its own ✓ Keep / ✗ Revert CodeLens.
// Reverted hunks are patched back out of the file; kept hunks stay.
//
// Mode mapping (pick in Claude Code's own permission-mode menu):
//   - "acceptEdits" (edit automatically), "auto" → Auto + Review (this
//     extension) — both already apply edits unblocked
//   - "default" (ask before edits)               → untouched — Claude
//     Code's native per-edit blocking prompt
//   - "plan" / "bypassPermissions" / "dontAsk"    → untouched
//
// Files are reviewed one at a time; "Next File" defers the current one.
// Keep All / Revert All settle every remaining hunk in the current file.
//
// Typing in the preview while a review is open is safe: every positional
// buffer edit is guarded by an exact-text check (review.previewText), foreign
// edits are folded back in by rebuilding the preview from an advanced
// baseline, and saves strip the preview-only red rows before they can reach
// disk. Reverted changes are reported back to Claude as one-shot context at
// the user's next prompt (hooks/userpromptsubmit.sh → /decisions) so it
// doesn't re-apply them; nothing is sent when everything was kept.
//
// Plain CommonJS on purpose: no build step, no dependencies.

"use strict";

const http = require("http");
const path = require("path");
const vscode = require("vscode");
const { lineDiff } = require("./diff");

const SCHEME = "claudiff";
// If no Stop arrives (interrupted turn, killed session), present the review
// this long after the last recorded edit so snapshots never sit forever.
const IDLE_PRESENT_MS = 60_000;
// Foreign edits to the inline preview are folded back in after this pause,
// so the rebuild doesn't thrash while the user is typing.
const RECOMPUTE_DEBOUNCE_MS = 300;
// Caps for the reverted-changes report delivered at the next user prompt —
// enough for Claude to know what not to re-apply, small enough to stay cheap.
const REPORT_MAX_HUNKS = 12;
const REPORT_MAX_EXCERPT_LINES = 6;
const REJECTIONS_MAX_SESSIONS = 20;
const REJECTIONS_MAX_PER_SESSION = 100;

let nextId = 1;
/** @type {FileReview | undefined} */
let active;
/** @type {FileReview[]} */
const queue = [];
/**
 * Edits recorded during a turn, awaiting the Stop hook.
 * @type {Map<string, { files: Map<string, { baseline: string, existedBefore: boolean }>, timer: any }>}
 */
const sessions = new Map();
/** Content store for the diff-tab fallback. @type {Map<string, string>} */
const contents = new Map();
/**
 * Reverted changes not yet reported to Claude, per session. Rejections are
 * staged on their review while the revert is still buffer-only, committed
 * here once it reaches disk, and delivered (then cleared) through /decisions
 * when the user sends their next prompt.
 * @type {Map<string, { entries: Object[], overflow: number }>}
 */
const rejections = new Map();
/** @type {http.Server | undefined} */
let server;
/** @type {vscode.OutputChannel} */
let log;
/** @type {vscode.TextEditorDecorationType} */
let removedDeco;
/** @type {vscode.TextEditorDecorationType} */
let addedDeco;
/** @type {vscode.StatusBarItem} */
let statusItem;
/** @type {vscode.EventEmitter<void>} */
let lensEmitter;

/**
 * @typedef {Object} ReviewHunk
 * @property {number} oldStart
 * @property {string[]} oldLines
 * @property {number} newStart
 * @property {string[]} newLines
 * @property {number} previewOld   buffer line where the red block starts
 * @property {number} previewNew   buffer line where the green block starts
 * @property {"kept" | "reverted" | undefined} decided
 *
 * @typedef {Object} FileReview
 * @property {number} id
 * @property {string} filePath
 * @property {string} sessionId
 * @property {string} baseline        file content before the turn's edits
 * @property {boolean} existedBefore
 * @property {string | undefined} current  content being reviewed (disk/buffer at present time)
 * @property {string[] | undefined} currentLines
 * @property {ReviewHunk[]} hunks
 * @property {{ mode: "inline" | "diffTab", uri?: vscode.Uri, origUri?: vscode.Uri, propUri?: vscode.Uri } | undefined} presented
 * @property {boolean} busy
 * @property {string | undefined} previewText  exact text the extension last wrote to the preview buffer; positions are only trusted while the buffer still equals it
 * @property {boolean} applying     an extension-authored buffer edit is in flight (change events are ours, not foreign)
 * @property {boolean} pendingRepresent  a save stripped the preview; rebuild once it completes
 * @property {any} recomputeTimer   debounce timer for folding foreign edits back in
 * @property {Object[]} staged      rejected-change records awaiting disk persistence
 */

function activate(context) {
  log = vscode.window.createOutputChannel("ClauDiff");

  removedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("diffEditorOverview.removedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  addedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("diffEditorOverview.insertedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = "claudiff.next";

  lensEmitter = new vscode.EventEmitter();

  context.subscriptions.push(
    log,
    removedDeco,
    addedDeco,
    statusItem,
    lensEmitter,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: (uri) => contents.get(uri.toString()) ?? "",
    }),
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file" }, { scheme: SCHEME }],
      {
        onDidChangeCodeLenses: lensEmitter.event,
        provideCodeLenses: provideLenses,
      },
    ),
    vscode.commands.registerCommand("claudiff.accept", (id, idx) => decideCommand(id, idx, true)),
    vscode.commands.registerCommand("claudiff.reject", (id, idx) => decideCommand(id, idx, false)),
    vscode.commands.registerCommand("claudiff.next", () => nextFile()),
    vscode.commands.registerCommand("claudiff.acceptAll", () => decideAll(true)),
    vscode.commands.registerCommand("claudiff.rejectAll", () => decideAll(false)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const review = active;
      if (
        !review ||
        review.applying ||
        !review.presented ||
        review.presented.mode !== "inline" ||
        e.document.uri.toString() !== review.presented.uri.toString() ||
        e.contentChanges.length === 0
      ) {
        return;
      }
      // Foreign edit (typing, paste, another extension): hunk positions can
      // no longer be trusted — fold the edit back in instead.
      scheduleRecompute(review);
    }),
    vscode.workspace.onWillSaveTextDocument((e) => {
      const review = active;
      if (
        !review ||
        review.applying ||
        !review.presented ||
        review.presented.mode !== "inline" ||
        e.document.uri.toString() !== review.presented.uri.toString()
      ) {
        return;
      }
      // Never let preview-only (red) rows reach disk: swap in the real
      // content — foreign edits kept, undecided hunks keep Claude's side —
      // as part of this same save, and rebuild the preview afterwards. This
      // covers manual Cmd+S, autosave toggled mid-review, and other
      // extensions triggering saves.
      const proposed = reconstructProposed(review, e.document.getText());
      if (proposed === e.document.getText()) {
        return;
      }
      clearTimeout(review.recomputeTimer);
      review.pendingRepresent = true;
      e.waitUntil(
        Promise.resolve([vscode.TextEdit.replace(fullRange(e.document), proposed)]),
      );
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const review = active;
      if (
        !review ||
        !review.pendingRepresent ||
        !review.presented ||
        review.presented.mode !== "inline" ||
        doc.uri.toString() !== review.presented.uri.toString()
      ) {
        return;
      }
      review.pendingRepresent = false;
      // The save persisted every decision made so far.
      commitRejections(review);
      scheduleRecompute(review, 0);
    }),
  );

  updateUi();
  startServer(context);
}

function deactivate() {
  if (server) {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// HTTP server (hook endpoints)
// ---------------------------------------------------------------------------

function startServer(context) {
  const port = vscode.workspace
    .getConfiguration("claudiff")
    .get("port", 48291);

  server = http.createServer((req, res) => {
    if (
      req.method === "POST" &&
      (req.url === "/review" || req.url === "/stop" || req.url === "/decisions")
    ) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          if (req.url === "/review") {
            handleReview(body, res);
          } else if (req.url === "/decisions") {
            handleDecisions(body, res);
          } else {
            handleStop(body, res);
          }
        } catch (err) {
          log.appendLine(`${req.url} failed: ${err && err.message}`);
          respond(res, "none");
        }
      });
    } else if (req.url === "/health") {
      res.end("ok");
    } else {
      res.statusCode = 404;
      res.end();
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      // Another VS Code window already owns the port; that window handles reviews.
      log.appendLine(`Port ${port} in use — another window is handling reviews.`);
    } else {
      log.appendLine(`Server error: ${err.message}`);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    log.appendLine(`Review server listening on 127.0.0.1:${port}`);
  });
  context.subscriptions.push({ dispose: () => server && server.close() });
}

/** PreToolUse: snapshot the file, then allow the edit through immediately. */
function handleReview(body, res) {
  let hook;
  try {
    hook = JSON.parse(body);
  } catch {
    return respond(res, "none");
  }

  // Only intercept in modes where edits already apply unblocked
  // ("acceptEdits", "auto"); "ask before edits" and other modes stand down
  // and behave natively.
  const cfg = vscode.workspace.getConfiguration("claudiff");
  const modes = cfg.get("reviewModes", ["acceptEdits", "auto"]);
  if (!modes.includes(hook.permission_mode)) {
    return respond(res, "none");
  }

  const input = hook.tool_input || {};
  if (
    (hook.tool_name !== "Edit" && hook.tool_name !== "Write") ||
    typeof input.file_path !== "string" ||
    input.file_path.length === 0
  ) {
    return respond(res, "none");
  }
  const abs = path.isAbsolute(input.file_path)
    ? input.file_path
    : path.join(hook.cwd || "", input.file_path);
  const uri = vscode.Uri.file(abs);

  // Auto-applying is scoped to the workspace by default; anything outside
  // falls through to Claude Code's built-in prompt.
  if (
    !vscode.workspace.getWorkspaceFolder(uri) &&
    !cfg.get("autoApplyOutsideWorkspace", false)
  ) {
    return respond(res, "none");
  }

  const sessionId = hook.session_id || "";
  recordEdit(sessionId, abs)
    .then(() => {
      // Snapshot is safely taken — let the edit land on disk.
      respond(res, "allow", "Auto-applied; the user reviews all changes at the end of the turn");
      log.appendLine(`Recorded ${hook.tool_name} ${abs}`);
      armIdleTimer(sessionId);
      updateUi();
    })
    .catch((err) => {
      log.appendLine(`Snapshot failed for ${abs}: ${err && err.message}`);
      respond(res, "none");
    });
}

/**
 * Snapshots the file's pre-edit content for this session's turn. If the file
 * is currently under (or queued for) review, that review is folded back into
 * the accumulating turn: decided hunks are finalized to disk, undecided ones
 * re-appear in the next review together with the new changes.
 */
async function recordEdit(sessionId, abs) {
  let sess = sessions.get(sessionId);
  if (!sess) {
    sess = { files: new Map(), timer: undefined };
    sessions.set(sessionId, sess);
  }

  const existing =
    active && active.filePath === abs
      ? active
      : queue.find((r) => r.filePath === abs);
  if (existing) {
    const wasActive = existing === active;
    if (wasActive) {
      active = undefined;
      // Revert the preview buffer BEFORE allowing: Claude Code writes to
      // disk the moment the hook returns, and the buffer must be clean.
      await cleanupPreview(existing);
    } else {
      queue.splice(queue.indexOf(existing), 1);
    }
    await stashPartialDecisions(existing);
    if (!sess.files.has(abs)) {
      sess.files.set(abs, {
        baseline: existing.baseline,
        existedBefore: existing.existedBefore,
      });
    }
    updateUi();
    if (wasActive) {
      presentNext();
    }
  } else if (!sess.files.has(abs)) {
    let baseline = "";
    let existedBefore = true;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
      baseline = Buffer.from(bytes).toString("utf8");
    } catch {
      existedBefore = false;
    }
    sess.files.set(abs, { baseline, existedBefore });
  }
}

function armIdleTimer(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) {
    return;
  }
  clearTimeout(sess.timer);
  sess.timer = setTimeout(() => {
    log.appendLine(`No Stop received — presenting session after ${IDLE_PRESENT_MS / 1000}s idle`);
    presentSession(sessionId);
  }, IDLE_PRESENT_MS);
}

/** Stop hook: the turn is over — start reviewing everything it touched. */
function handleStop(body, res) {
  // Never block Claude Code from stopping.
  res.end();
  let hook;
  try {
    hook = JSON.parse(body);
  } catch {
    return;
  }
  presentSession(hook.session_id || "");
}

function presentSession(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) {
    return;
  }
  sessions.delete(sessionId);
  clearTimeout(sess.timer);
  for (const [abs, snap] of sess.files) {
    // Already under or queued for review (an older baseline) — keep that one.
    if (active && active.filePath === abs) {
      continue;
    }
    if (queue.some((r) => r.filePath === abs)) {
      continue;
    }
    queue.push({
      id: nextId++,
      filePath: abs,
      sessionId,
      baseline: snap.baseline,
      existedBefore: snap.existedBefore,
      current: undefined,
      currentLines: undefined,
      hunks: [],
      presented: undefined,
      busy: false,
      previewText: undefined,
      applying: false,
      pendingRepresent: false,
      recomputeTimer: undefined,
      staged: [],
    });
  }
  updateUi();
  if (!active) {
    presentNext();
  }
}

/**
 * Answers the waiting PreToolUse hook script. For allow/deny the body is the
 * exact hook output Claude Code expects (the script just echoes it); "none"
 * sends an empty body so Claude Code's normal permission flow takes over.
 */
function respond(res, decision, reason) {
  if (res.writableEnded) {
    return;
  }
  if (decision === "none") {
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason || "Approved in the review UI",
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Rejection reporting (tell Claude what the user reverted)
// ---------------------------------------------------------------------------

/**
 * UserPromptSubmit hook: replies with a report of changes the user reverted
 * since the last prompt (delivered once, then cleared). Claude Code injects
 * the hook's stdout as context, so an empty body costs zero tokens in the
 * common everything-kept case.
 */
function handleDecisions(body, res) {
  let hook;
  try {
    hook = JSON.parse(body);
  } catch {
    res.end();
    return;
  }
  const report = takeRejectionReport(hook.session_id || "");
  if (report) {
    log.appendLine(`Delivered reverted-changes report for session ${hook.session_id}`);
  }
  res.setHeader("content-type", "text/plain");
  res.end(report);
}

/** Stages a reverted hunk on its review until the revert reaches disk. */
function stageHunkRejection(review, hunk) {
  review.staged.push({
    kind: "hunk",
    line: hunk.oldStart + 1,
    newLines: hunk.newLines.slice(0, REPORT_MAX_EXCERPT_LINES),
    newTotal: hunk.newLines.length,
    oldLines: hunk.oldLines.slice(0, REPORT_MAX_EXCERPT_LINES),
    oldTotal: hunk.oldLines.length,
  });
}

/** A whole-file revert supersedes any staged per-hunk records. */
function stageFileRejection(review, deleted) {
  review.staged = [{ kind: deleted ? "deleted" : "file" }];
}

/**
 * Moves a review's staged rejections into its session's bucket. Call only
 * once the reverts are actually on disk, so the report never describes a
 * disk state that doesn't exist yet.
 */
function commitRejections(review) {
  if (review.staged.length === 0) {
    return;
  }
  let bucket = rejections.get(review.sessionId);
  if (!bucket) {
    bucket = { entries: [], overflow: 0 };
    rejections.set(review.sessionId, bucket);
    while (rejections.size > REJECTIONS_MAX_SESSIONS) {
      rejections.delete(rejections.keys().next().value);
    }
  }
  for (const e of review.staged) {
    if (bucket.entries.length >= REJECTIONS_MAX_PER_SESSION) {
      bucket.overflow++;
    } else {
      bucket.entries.push({ ...e, file: review.filePath });
    }
  }
  review.staged = [];
}

/** Builds (and clears) the pending report for a session; "" when empty. */
function takeRejectionReport(sessionId) {
  const bucket = rejections.get(sessionId);
  rejections.delete(sessionId);
  if (!bucket || (bucket.entries.length === 0 && bucket.overflow === 0)) {
    return "";
  }
  const lines = [
    "[ClauDiff] The user reviewed your edits in the IDE and REVERTED the changes below. " +
      "The files on disk already reflect this. Do not re-apply these changes unless the user " +
      "explicitly asks, and re-read these files before editing them again.",
  ];
  const excerpt = (label, shownLines, total) => {
    if (total === 0) {
      return;
    }
    lines.push(`    ${label}:`);
    for (const l of shownLines) {
      lines.push(`      ${l}`);
    }
    if (total > shownLines.length) {
      const more = total - shownLines.length;
      lines.push(`      … (+${more} more line${more === 1 ? "" : "s"})`);
    }
  };
  let shown = 0;
  let skipped = bucket.overflow;
  for (const e of bucket.entries) {
    if (shown >= REPORT_MAX_HUNKS) {
      skipped++;
      continue;
    }
    shown++;
    const rel = vscode.workspace.asRelativePath(e.file);
    if (e.kind === "deleted") {
      lines.push(`- ${rel}: deleted (you created it; the user rejected it)`);
    } else if (e.kind === "file") {
      lines.push(`- ${rel}: entire file reverted to its pre-edit content`);
    } else {
      lines.push(`- ${rel} (around line ${e.line}):`);
      excerpt("your version (removed)", e.newLines, e.newTotal);
      excerpt("restored original", e.oldLines, e.oldTotal);
    }
  }
  if (skipped > 0) {
    lines.push(`- …and ${skipped} more reverted change${skipped === 1 ? "" : "s"}.`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

async function presentNext() {
  active = queue.shift();
  updateUi();
  if (!active) {
    return;
  }
  const review = active;
  try {
    await present(review);
  } catch (err) {
    log.appendLine(`Present #${review.id} failed: ${err && err.message}`);
    drop(review, "present failed");
  }
}

function drop(review, note) {
  log.appendLine(`Review #${review.id} (${path.basename(review.filePath)}) skipped: ${note}`);
  clearTimeout(review.recomputeTimer);
  review.recomputeTimer = undefined;
  if (active === review) {
    active = undefined;
    updateUi();
    presentNext();
  }
}

async function present(review) {
  const uri = vscode.Uri.file(review.filePath);
  let current;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    current = Buffer.from(bytes).toString("utf8");
  } catch {
    return drop(review, "file no longer exists");
  }
  if (current === review.baseline) {
    return drop(review, "no net change");
  }

  const style = vscode.workspace
    .getConfiguration("claudiff")
    .get("style", "inline");
  const autoSave = vscode.workspace
    .getConfiguration("files")
    .get("autoSave", "off");

  // The inline preview is an unsaved buffer edit, so it is only safe with a
  // clean buffer and autosave off (autosave would write the preview to disk).
  let doc;
  let inlineOk = style === "inline" && autoSave === "off";
  if (inlineOk) {
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      inlineOk = false;
    }
    if (doc && doc.isDirty) {
      inlineOk = false;
    }
    if (doc && !doc.isDirty && doc.getText() !== current) {
      current = doc.getText();
      if (current === review.baseline) {
        return drop(review, "no net change");
      }
    }
  }
  review.current = current;
  review.currentLines = current.split("\n");

  if (inlineOk && doc) {
    await presentInline(review, doc);
  } else {
    presentDiffTab(review);
  }
  lensEmitter.fire();
  updateUi();

  const name = path.basename(review.filePath);
  const count = review.hunks.length;
  const msg =
    review.presented.mode === "inline"
      ? `Claude edited ${name} — ${count} change${count === 1 ? "" : "s"} to review`
      : `Claude edited ${name} — review the diff`;
  vscode.window
    .showInformationMessage(msg, "Keep All", "Revert All")
    .then((choice) => {
      if (active !== review) {
        return; // already settled or deferred
      }
      if (choice === "Keep All") {
        decideAll(true);
      } else if (choice === "Revert All") {
        decideAll(false);
      }
      // Dismissed: leave pending — lenses/keybindings still work.
    });
}

/**
 * If the file is already open in some tab, returns that tab's view column so
 * showTextDocument focuses the existing tab instead of opening a duplicate
 * in the active group.
 */
function existingTabColumn(uri) {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.toString() === uri.toString()
      ) {
        return group.viewColumn;
      }
    }
  }
  return undefined;
}

function fullRange(doc) {
  return new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
}

/**
 * Cursor-style: for every hunk, splice the removed lines back in above the
 * added ones and highlight both, as an unsaved preview. Disk keeps the new
 * content throughout; deciding hunks edits the buffer, and the final save
 * happens once every hunk is decided.
 */
async function presentInline(review, doc) {
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
    viewColumn: existingTabColumn(doc.uri),
  });
  await buildInlinePreview(review, doc);
  const h0 = review.hunks[0];
  editor.selection = new vscode.Selection(h0.previewOld, 0, h0.previewOld, 0);
  editor.revealRange(
    new vscode.Range(h0.previewOld, 0, h0.previewNew + h0.newLines.length, 0),
    vscode.TextEditorRevealType.InCenter,
  );
}

/**
 * (Re)builds the inline preview from review.baseline vs review.current:
 * splices each hunk's removed lines in above its added ones, records the
 * exact buffer text in review.previewText, and decorates. Hunk positions are
 * only ever trusted while the buffer still equals previewText.
 */
async function buildInlinePreview(review, doc) {
  const hunks = lineDiff(review.baseline, review.current);
  const lines = review.current.split("\n");
  let offset = 0;
  for (const h of hunks) {
    const at = h.newStart + offset;
    lines.splice(at, 0, ...h.oldLines);
    h.previewOld = at;
    h.previewNew = at + h.oldLines.length;
    h.decided = undefined;
    offset += h.oldLines.length;
  }
  review.hunks = hunks;
  review.previewText = lines.join("\n");
  await applyOwnEdit(review, doc, review.previewText);
  review.presented = { mode: "inline", uri: doc.uri };
  refreshDecorations(review);
}

/** Replaces the whole buffer as an extension-authored (non-foreign) edit. */
async function applyOwnEdit(review, doc, text) {
  if (doc.getText() === text) {
    return;
  }
  review.applying = true;
  try {
    const we = new vscode.WorkspaceEdit();
    we.replace(doc.uri, fullRange(doc), text);
    await vscode.workspace.applyEdit(we);
  } finally {
    review.applying = false;
  }
}

function presentDiffTab(review) {
  const fileUri = vscode.Uri.file(review.filePath);
  const origUri = fileUri.with({ scheme: SCHEME, query: `orig-${review.id}` });
  const propUri = fileUri.with({ scheme: SCHEME, query: `prop-${review.id}` });
  contents.set(origUri.toString(), review.baseline);
  contents.set(propUri.toString(), review.current);
  review.presented = { mode: "diffTab", origUri, propUri };

  vscode.commands.executeCommand(
    "vscode.diff",
    origUri,
    propUri,
    `Claude edit: ${path.basename(review.filePath)}`,
    { preview: false },
  );
}

function refreshDecorations(review) {
  const p = review.presented;
  if (!p || p.mode !== "inline") {
    return;
  }
  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === p.uri.toString(),
  );
  if (!editor) {
    return;
  }
  const red = [];
  const green = [];
  for (const h of review.hunks) {
    if (h.decided) {
      continue;
    }
    if (h.oldLines.length > 0) {
      red.push(new vscode.Range(h.previewOld, 0, h.previewOld + h.oldLines.length - 1, 0));
    }
    if (h.newLines.length > 0) {
      green.push(new vscode.Range(h.previewNew, 0, h.previewNew + h.newLines.length - 1, 0));
    }
  }
  editor.setDecorations(removedDeco, red);
  editor.setDecorations(addedDeco, green);
}

function clearInlineDecorations(uri) {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === uri.toString()) {
      editor.setDecorations(removedDeco, []);
      editor.setDecorations(addedDeco, []);
    }
  }
}

// ---------------------------------------------------------------------------
// Foreign edits to the preview (the user typed while reviewing)
// ---------------------------------------------------------------------------

/**
 * Rebuilds the file's real ("proposed") content from the preview buffer: the
 * buffer minus the spliced-in red rows of undecided hunks, with any foreign
 * edits preserved. Foreign edits are located by diffing the buffer against
 * review.previewText — the coordinate system in which hunk positions are
 * still valid. A foreign edit overlapping a red block keeps the editor's
 * replacement lines: they become real content, and the follow-up re-diff
 * against the baseline keeps them revertible, so no buffer state is
 * unrecoverable.
 */
function reconstructProposed(review, bufferText) {
  const prev = review.previewText.split("\n");
  const red = new Uint8Array(prev.length);
  for (const h of review.hunks) {
    if (h.decided) {
      continue;
    }
    for (let k = h.previewOld; k < h.previewOld + h.oldLines.length; k++) {
      red[k] = 1;
    }
  }
  const out = [];
  let i = 0;
  const copyUnchanged = (until) => {
    for (; i < until; i++) {
      if (!red[i]) {
        out.push(prev[i]);
      }
    }
  };
  if (bufferText !== review.previewText) {
    for (const d of lineDiff(review.previewText, bufferText)) {
      copyUnchanged(d.oldStart);
      out.push(...d.newLines);
      i += d.oldLines.length;
    }
  }
  copyUnchanged(prev.length);
  return out.join("\n");
}

function scheduleRecompute(review, delay = RECOMPUTE_DEBOUNCE_MS) {
  clearTimeout(review.recomputeTimer);
  review.recomputeTimer = setTimeout(() => {
    review.recomputeTimer = undefined;
    if (active !== review || !review.presented || review.presented.mode !== "inline") {
      return;
    }
    recompute(review).catch((err) => {
      log.appendLine(`Recompute #${review.id} failed: ${err && err.message}`);
    });
  }, delay);
}

/**
 * Folds a foreign edit back into the review: decided hunks finalize into an
 * advanced baseline (exactly like stashPartialDecisions), the proposed
 * content is reconstructed from the buffer, and the preview is rebuilt from
 * the fresh diff — the foreign edit simply shows up as ordinary reviewable
 * hunks. Reverting always restores stored baseline lines, never buffer text.
 */
async function recompute(review) {
  if (review.busy) {
    scheduleRecompute(review);
    return;
  }
  review.busy = true;
  try {
    const doc = await vscode.workspace.openTextDocument(review.presented.uri);
    const text = doc.getText();
    if (text === review.previewText) {
      return; // consistent again (e.g. the edit was undone)
    }
    const proposed = reconstructProposed(review, text);
    review.baseline = resolvedContent(review, "old");
    review.current = proposed;
    review.currentLines = proposed.split("\n");
    if (proposed === review.baseline) {
      // The foreign edits settled every remaining difference by hand.
      review.presented = undefined;
      await applyOwnEdit(review, doc, proposed);
      clearInlineDecorations(doc.uri);
      review.applying = true;
      try {
        const ok = await doc.save();
        if (!ok) {
          vscode.window.showWarningMessage(
            `ClauDiff: could not save ${path.basename(review.filePath)} — please save it manually.`,
          );
        }
      } finally {
        review.applying = false;
      }
      commitRejections(review);
      log.appendLine(`Review #${review.id}: user edits settled all remaining hunks`);
      if (active === review) {
        active = undefined;
        updateUi();
        presentNext();
      }
      return;
    }
    const autoSave = vscode.workspace
      .getConfiguration("files")
      .get("autoSave", "off");
    if (autoSave !== "off") {
      // Autosave was turned on mid-review: rebuilding the inline preview
      // would just get stripped again on the next autosave, forever. Persist
      // the flattened content and continue in the diff-tab presentation.
      review.presented = undefined;
      await applyOwnEdit(review, doc, proposed);
      clearInlineDecorations(doc.uri);
      review.applying = true;
      try {
        await doc.save();
      } finally {
        review.applying = false;
      }
      commitRejections(review);
      review.hunks = [];
      log.appendLine(`Review #${review.id}: autosave is on — switching to the diff tab`);
      presentDiffTab(review);
    } else {
      log.appendLine(`Review #${review.id}: foreign edit folded into the preview`);
      await buildInlinePreview(review, doc);
    }
  } finally {
    review.busy = false;
  }
  lensEmitter.fire();
  updateUi();
}

/** Undoes whatever present() put on screen, leaving the file untouched. */
async function cleanupPreview(review) {
  const p = review.presented;
  review.presented = undefined;
  clearTimeout(review.recomputeTimer);
  review.recomputeTimer = undefined;
  review.pendingRepresent = false;
  if (!p) {
    return;
  }
  if (p.mode === "inline") {
    try {
      const doc = await vscode.workspace.openTextDocument(p.uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: existingTabColumn(p.uri),
      });
      editor.setDecorations(removedDeco, []);
      editor.setDecorations(addedDeco, []);
      if (review.currentLines && doc.getText() !== review.previewText) {
        // The user edited the preview. Flatten instead of reverting (which
        // would discard their typing): strip the red rows, keep their edits
        // and Claude's undecided side, persist that, and advance the
        // baseline so decided hunks stay settled while everything else
        // (including the user's edits) comes back for review later.
        const proposed = reconstructProposed(review, doc.getText());
        await applyOwnEdit(review, doc, proposed);
        review.applying = true;
        try {
          await doc.save();
        } finally {
          review.applying = false;
        }
        commitRejections(review);
        review.baseline = resolvedContent(review, "old");
        review.hunks = [];
        review.current = undefined;
        review.currentLines = undefined;
      } else if (doc.isDirty) {
        // Preview was never saved; revert restores the on-disk state.
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
    } catch (err) {
      log.appendLine(`Cleanup #${review.id} failed: ${err && err.message}`);
    }
  } else {
    contents.delete(p.origUri.toString());
    contents.delete(p.propUri.toString());
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.modified.toString() === p.propUri.toString()
        ) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * Rebuilds the file content from the review's hunk decisions. Undecided
 * hunks take `undecidedSide` ("new" keeps Claude's change, "old" restores
 * the baseline lines).
 */
function resolvedContent(review, undecidedSide) {
  const cur = review.currentLines;
  const out = [];
  let idx = 0;
  for (const h of review.hunks) {
    out.push(...cur.slice(idx, h.newStart));
    const side = h.decided
      ? h.decided === "kept"
        ? "new"
        : "old"
      : undecidedSide;
    out.push(...(side === "new" ? h.newLines : h.oldLines));
    idx = h.newStart + h.newLines.length;
  }
  out.push(...cur.slice(idx));
  return out.join("\n");
}

/**
 * Finalizes any decided hunks of a review that is being deferred or folded
 * back into an accumulating turn: reverted hunks are patched out on disk,
 * and the baseline advances so decided hunks don't re-appear while undecided
 * ones do. Call after cleanupPreview.
 */
async function stashPartialDecisions(review) {
  if (!review.currentLines || !review.hunks.some((h) => h.decided)) {
    review.hunks = [];
    review.current = undefined;
    review.currentLines = undefined;
    return;
  }
  const disk = resolvedContent(review, "new");
  const baseline = resolvedContent(review, "old");
  if (disk !== review.current) {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(review.filePath),
      Buffer.from(disk, "utf8"),
    );
  }
  commitRejections(review);
  review.baseline = baseline;
  review.hunks = [];
  review.current = undefined;
  review.currentLines = undefined;
}

/** Command entry point for Keep/Revert (CodeLens passes ids, keybindings don't). */
function decideCommand(id, idx, keep) {
  if (!active) {
    return;
  }
  if (typeof id === "number" && id !== active.id) {
    return;
  }
  if (!active.presented) {
    return;
  }
  if (active.presented.mode === "diffTab") {
    // No per-hunk granularity in the diff-tab fallback.
    decideAll(keep);
    return;
  }
  let hunk;
  if (typeof idx === "number") {
    hunk = active.hunks[idx];
  } else {
    hunk = hunkAtCursor() || active.hunks.find((h) => !h.decided);
  }
  if (!hunk || hunk.decided) {
    return;
  }
  decideHunk(active, hunk, keep);
}

function hunkAtCursor() {
  if (!active || !active.presented || active.presented.mode !== "inline") {
    return undefined;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== active.presented.uri.toString()) {
    return undefined;
  }
  const line = editor.selection.active.line;
  return active.hunks.find(
    (h) =>
      !h.decided &&
      line >= h.previewOld &&
      line < h.previewNew + h.newLines.length,
  );
}

async function decideHunk(review, hunk, keep) {
  if (review.busy || !review.presented || review.presented.mode !== "inline") {
    return;
  }
  review.busy = true;
  try {
    const doc = await vscode.workspace.openTextDocument(review.presented.uri);
    if (doc.getText() !== review.previewText) {
      // A foreign edit landed since the last rebuild — positions can't be
      // trusted. Fold it in; the refreshed hunks take the next click.
      scheduleRecompute(review, 0);
      return;
    }
    hunk.decided = keep ? "kept" : "reverted";
    if (!keep) {
      stageHunkRejection(review, hunk);
    }
    const delStart = keep ? hunk.previewOld : hunk.previewNew;
    const delCount = keep ? hunk.oldLines.length : hunk.newLines.length;
    if (delCount > 0) {
      review.applying = true;
      try {
        const we = new vscode.WorkspaceEdit();
        we.replace(doc.uri, lineDeleteRange(doc, delStart, delCount), "");
        await vscode.workspace.applyEdit(we);
      } finally {
        review.applying = false;
      }
      const pl = review.previewText.split("\n");
      pl.splice(delStart, delCount);
      review.previewText = pl.join("\n");
      for (const other of review.hunks) {
        if (other === hunk || other.decided) {
          continue;
        }
        if (other.previewOld > hunk.previewOld) {
          other.previewOld -= delCount;
          other.previewNew -= delCount;
        }
      }
      if (doc.getText() !== review.previewText) {
        // Someone typed while the edit was in flight — self-heal instead of
        // trusting positions any further.
        scheduleRecompute(review, 0);
        return;
      }
    }
    log.appendLine(
      `Hunk ${review.hunks.indexOf(hunk) + 1}/${review.hunks.length} of ${path.basename(review.filePath)}: ${hunk.decided}`,
    );
    refreshDecorations(review);
    lensEmitter.fire();
    updateUi();
    if (review.hunks.every((h) => h.decided)) {
      await finishInline(review);
    } else {
      const next = review.hunks.find((h) => !h.decided);
      const editor = vscode.window.visibleTextEditors.find(
        (e) => review.presented && e.document.uri.toString() === review.presented.uri.toString(),
      );
      if (next && editor) {
        editor.selection = new vscode.Selection(next.previewOld, 0, next.previewOld, 0);
        editor.revealRange(
          new vscode.Range(next.previewOld, 0, next.previewNew + next.newLines.length, 0),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      }
    }
  } finally {
    review.busy = false;
  }
}

/** Deletes `count` whole lines starting at line `start`, handling EOF. */
function lineDeleteRange(doc, start, count) {
  if (start + count < doc.lineCount) {
    return new vscode.Range(start, 0, start + count, 0);
  }
  const endPos = doc.lineAt(doc.lineCount - 1).range.end;
  const startPos = start > 0 ? doc.lineAt(start - 1).range.end : new vscode.Position(0, 0);
  return new vscode.Range(startPos, endPos);
}

/** All hunks decided: the buffer now holds the final content — save it. */
async function finishInline(review) {
  const uri = review.presented.uri;
  review.presented = undefined;
  clearTimeout(review.recomputeTimer);
  review.recomputeTimer = undefined;
  review.pendingRepresent = false;
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      viewColumn: existingTabColumn(uri),
    });
    editor.setDecorations(removedDeco, []);
    editor.setDecorations(addedDeco, []);

    const allReverted = review.hunks.every((h) => h.decided === "reverted");
    if (!review.existedBefore && allReverted) {
      // A brand-new file whose every hunk was reverted: remove it entirely.
      if (doc.isDirty) {
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
      await closeTabsFor(uri);
      try {
        await vscode.workspace.fs.delete(uri);
        stageFileRejection(review, true);
        commitRejections(review);
        log.appendLine(`Deleted ${review.filePath} (new file, fully reverted)`);
      } catch (err) {
        log.appendLine(`Could not delete ${review.filePath}: ${err && err.message}`);
      }
    } else if (doc.isDirty) {
      const ok = await doc.save();
      if (!ok) {
        vscode.window.showWarningMessage(
          `ClauDiff: could not save ${path.basename(review.filePath)} — please save it manually.`,
        );
      } else {
        commitRejections(review);
      }
    } else {
      // Buffer already matches disk (e.g. a mid-review save persisted the
      // final state) — the decisions are on disk.
      commitRejections(review);
    }
  } catch (err) {
    log.appendLine(`Finish #${review.id} failed: ${err && err.message}`);
  }
  const kept = review.hunks.filter((h) => h.decided === "kept").length;
  log.appendLine(
    `Review #${review.id} (${path.basename(review.filePath)}): ${kept}/${review.hunks.length} hunks kept`,
  );
  if (active === review) {
    active = undefined;
    updateUi();
    presentNext();
  }
}

async function closeTabsFor(uri) {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.toString() === uri.toString()
      ) {
        await vscode.window.tabGroups.close(tab);
      }
    }
  }
}

/** Keep All / Revert All for every remaining hunk in the current file. */
async function decideAll(keep) {
  if (!active || !active.presented || active.busy) {
    return;
  }
  const review = active;
  if (review.presented.mode === "inline") {
    review.busy = true;
    try {
      const doc = await vscode.workspace.openTextDocument(review.presented.uri);
      if (doc.getText() !== review.previewText) {
        // A foreign edit landed since the last rebuild — fold it in; the
        // refreshed hunks take the next click.
        scheduleRecompute(review, 0);
        return;
      }
      for (const h of review.hunks) {
        if (!h.decided) {
          h.decided = keep ? "kept" : "reverted";
          if (!keep) {
            stageHunkRejection(review, h);
          }
        }
      }
      const finalText = resolvedContent(review, "new");
      await applyOwnEdit(review, doc, finalText);
      review.previewText = finalText;
    } finally {
      review.busy = false;
    }
    await finishInline(review);
  } else {
    await cleanupPreview(review);
    const uri = vscode.Uri.file(review.filePath);
    if (!keep) {
      if (!review.existedBefore) {
        await closeTabsFor(uri);
        try {
          await vscode.workspace.fs.delete(uri);
          stageFileRejection(review, true);
          commitRejections(review);
          log.appendLine(`Deleted ${review.filePath} (new file, reverted)`);
        } catch (err) {
          log.appendLine(`Could not delete ${review.filePath}: ${err && err.message}`);
        }
      } else {
        let diskNow;
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          diskNow = Buffer.from(bytes).toString("utf8");
        } catch {
          diskNow = undefined;
        }
        if (diskNow !== undefined && diskNow !== review.current && diskNow !== review.baseline) {
          // The file changed while the diff tab was open — refresh the
          // review with the real content instead of clobbering that edit.
          review.current = diskNow;
          review.currentLines = diskNow.split("\n");
          log.appendLine(`Review #${review.id}: file changed under the diff tab — refreshed`);
          presentDiffTab(review);
          lensEmitter.fire();
          updateUi();
          return;
        }
        if (diskNow !== review.baseline) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(review.baseline, "utf8"));
        }
        stageFileRejection(review, false);
        commitRejections(review);
        log.appendLine(`Reverted ${review.filePath} to its pre-turn content`);
      }
    }
    log.appendLine(`Review #${review.id} (${path.basename(review.filePath)}): ${keep ? "kept" : "reverted"} (diff tab)`);
    if (active === review) {
      active = undefined;
      updateUi();
      presentNext();
    }
  }
}

/** Defers the current file (undecided hunks return later) and shows the next. */
async function nextFile() {
  if (!active || queue.length === 0) {
    return;
  }
  const current = active;
  active = undefined;
  await cleanupPreview(current);
  await stashPartialDecisions(current);
  queue.push(current);
  log.appendLine(`Review #${current.id} (${path.basename(current.filePath)}) deferred`);
  presentNext();
}

// ---------------------------------------------------------------------------
// CodeLens actions (rendered directly above each hunk)
// ---------------------------------------------------------------------------

function provideLenses(document) {
  if (!active || !active.presented) {
    return [];
  }
  const p = active.presented;
  const target = p.mode === "inline" ? p.uri : p.propUri;
  if (!target || document.uri.toString() !== target.toString()) {
    return [];
  }

  const lenses = [];
  const lensAt = (line, title, command, args, tooltip) => {
    const l = Math.max(0, Math.min(line, document.lineCount - 1));
    lenses.push(
      new vscode.CodeLens(new vscode.Range(l, 0, l, 0), {
        title,
        command,
        arguments: args,
        tooltip,
      }),
    );
  };

  if (p.mode === "inline") {
    const undecided = active.hunks.filter((h) => !h.decided);
    let first = true;
    for (const h of active.hunks) {
      if (h.decided) {
        continue;
      }
      const idx = active.hunks.indexOf(h);
      lensAt(h.previewOld, "✓ Keep", "claudiff.accept", [active.id, idx],
        "Keep this change (Cmd/Ctrl+Enter on the hunk)");
      lensAt(h.previewOld, "✗ Revert", "claudiff.reject", [active.id, idx],
        "Revert this change (Cmd/Ctrl+Backspace on the hunk)");
      if (first) {
        if (queue.length > 0) {
          lensAt(h.previewOld, `→ Next File (${queue.length} more)`, "claudiff.next", [],
            "Defer this file and review the next one");
        }
        if (undecided.length > 1) {
          lensAt(h.previewOld, `✓✓ Keep All (${undecided.length})`, "claudiff.acceptAll", [],
            "Keep every remaining change in this file");
          lensAt(h.previewOld, `✗✗ Revert All (${undecided.length})`, "claudiff.rejectAll", [],
            "Revert every remaining change in this file");
        }
        first = false;
      }
    }
  } else {
    lensAt(0, "✓✓ Keep All", "claudiff.acceptAll", [],
      "Keep Claude's changes to this file");
    lensAt(0, "✗✗ Revert All", "claudiff.rejectAll", [],
      "Revert this file to its pre-turn content");
    if (queue.length > 0) {
      lensAt(0, `→ Next File (${queue.length} more)`, "claudiff.next", [],
        "Defer this file and review the next one");
    }
  }
  return lenses;
}

// ---------------------------------------------------------------------------
// Status bar / context keys
// ---------------------------------------------------------------------------

function updateUi() {
  vscode.commands.executeCommand("setContext", "claudiff.active", !!active);
  vscode.commands.executeCommand("setContext", "claudiff.hasQueue", queue.length > 0);
  lensEmitter && lensEmitter.fire();

  let accumulating = 0;
  for (const sess of sessions.values()) {
    accumulating += sess.files.size;
  }

  if (active) {
    const name = path.basename(active.filePath);
    const total = active.hunks.length;
    const done = active.hunks.filter((h) => h.decided).length;
    const hunkPart = total > 0 ? ` — ${done}/${total} decided` : "";
    const queuePart = queue.length > 0 ? ` (+${queue.length} file${queue.length === 1 ? "" : "s"})` : "";
    statusItem.text = `$(eye) Review ${name}${hunkPart}${queuePart}`;
    statusItem.tooltip =
      "Keep hunk: Cmd/Ctrl+Enter · Revert hunk: Cmd/Ctrl+Backspace" +
      (queue.length > 0 ? " · Click: next file" : "");
    statusItem.show();
  } else if (accumulating > 0) {
    statusItem.text = `$(pencil) Claude editing — ${accumulating} file${accumulating === 1 ? "" : "s"} to review`;
    statusItem.tooltip = "Edits auto-apply; the review starts when the turn ends";
    statusItem.show();
  } else {
    statusItem.hide();
  }
}

module.exports = { activate, deactivate };
