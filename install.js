#!/usr/bin/env node
// One-shot installer for ClauDiff: symlinks this repo into whichever VS Code
// extensions directories exist on this machine, and registers its hooks in
// Claude Code's settings.json — global (~/.claude/settings.json) by default,
// or a single project's .claude/settings.json with --project.
//
// Every step is idempotent and keyed off THIS repo's absolute path (ROOT
// below), so re-running after moving the repo cleans up stale entries
// instead of leaving duplicates. Run again any time; nothing here needs a
// build step.
//
// Usage:
//   node install.js                     install globally
//   node install.js --project [dir]      register hooks for one project only
//                                        (dir defaults to the current directory)
//   node install.js --uninstall          remove the extension link + hooks
//                                        (add --project to match a scoped install)
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = __dirname;
const pkg = require(path.join(ROOT, "package.json"));
const EXT_ID = `${pkg.publisher}.${pkg.name}-${pkg.version}`;

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const projectIdx = args.indexOf("--project");
const projectDir =
  projectIdx !== -1 ? path.resolve(args[projectIdx + 1] || process.cwd()) : null;

const HOOK_SCRIPTS = {
  PreToolUse: {
    file: "pretooluse.sh",
    matcher: "Edit|Write",
    timeout: 120,
    statusMessage: "Recording edit for review…",
  },
  Stop: { file: "stop.sh", timeout: 15 },
  UserPromptSubmit: { file: "userpromptsubmit.sh", timeout: 10 },
};

// ---------------------------------------------------------------------------
// 1. Extension symlink
// ---------------------------------------------------------------------------

function candidateExtensionDirs() {
  const home = os.homedir();
  return [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-server", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
    path.join(home, ".vscode-server-insiders", "extensions"),
  ].filter((d) => fs.existsSync(d));
}

function linkExtension() {
  let dirs = candidateExtensionDirs();
  if (dirs.length === 0) {
    // Neither local nor remote VS Code has run here yet — default to local
    // and create it, so a fresh machine still ends up installed.
    const fallback = path.join(os.homedir(), ".vscode", "extensions");
    fs.mkdirSync(fallback, { recursive: true });
    dirs = [fallback];
  }
  for (const dir of dirs) {
    const target = path.join(dir, EXT_ID);
    let existingKind = "none";
    try {
      const st = fs.lstatSync(target);
      existingKind = st.isSymbolicLink() ? "symlink" : "real";
    } catch {
      existingKind = "none";
    }
    if (existingKind === "real") {
      console.log(`Skipping ${target} — a real (non-symlink) folder is already there.`);
      continue;
    }
    if (existingKind === "symlink") {
      const existing = fs.readlinkSync(target);
      if (path.resolve(dir, existing) === ROOT) {
        console.log(`Already linked: ${target}`);
        continue;
      }
      fs.unlinkSync(target); // stale link (repo moved, or an older clone)
    }
    fs.symlinkSync(ROOT, target, "junction");
    console.log(`Linked ${target} -> ${ROOT}`);
  }
}

function unlinkExtension() {
  for (const dir of candidateExtensionDirs()) {
    const target = path.join(dir, EXT_ID);
    try {
      const st = fs.lstatSync(target);
      if (st.isSymbolicLink() && path.resolve(dir, fs.readlinkSync(target)) === ROOT) {
        fs.unlinkSync(target);
        console.log(`Removed ${target}`);
      }
    } catch {
      // nothing there — fine
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Claude Code hook registration
// ---------------------------------------------------------------------------

function settingsPath() {
  return projectDir
    ? path.join(projectDir, ".claude", "settings.json")
    : path.join(os.homedir(), ".claude", "settings.json");
}

function loadSettings(file) {
  if (!fs.existsSync(file)) {
    return {};
  }
  const text = fs.readFileSync(file, "utf8").trim();
  return text ? JSON.parse(text) : {};
}

/**
 * True if `command` is an earlier ClauDiff registration of this exact hook
 * script — from this repo or a previous location it lived at. Matched on the
 * "sh .../hooks/<file>" shape our own entries always take, so re-running
 * after moving the repo replaces the stale entry instead of stacking a
 * second one, without touching unrelated hooks some other tool registered.
 */
function isOurCommand(command, scriptFile) {
  if (typeof command !== "string") {
    return false;
  }
  const suffix = path.join("hooks", scriptFile).replace(/\\/g, "[\\\\/]").replace(/\//g, "[\\\\/]");
  return new RegExp(`^sh .*${suffix}$`).test(command.trim());
}

function registerHooks() {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const settings = loadSettings(file);
  settings.hooks = settings.hooks || {};

  for (const [event, spec] of Object.entries(HOOK_SCRIPTS)) {
    const command = `sh ${path.join(ROOT, "hooks", spec.file)}`;
    const groups = settings.hooks[event] || [];
    for (const group of groups) {
      group.hooks = (group.hooks || []).filter((h) => !isOurCommand(h.command, spec.file));
    }
    const kept = groups.filter((g) => (g.hooks || []).length > 0);
    const entry = { type: "command", command, timeout: spec.timeout };
    if (spec.statusMessage) {
      entry.statusMessage = spec.statusMessage;
    }
    kept.push(spec.matcher ? { matcher: spec.matcher, hooks: [entry] } : { hooks: [entry] });
    settings.hooks[event] = kept;
  }

  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return file;
}

function unregisterHooks() {
  const file = settingsPath();
  if (!fs.existsSync(file)) {
    return;
  }
  const settings = loadSettings(file);
  if (!settings.hooks) {
    return;
  }
  for (const [event, spec] of Object.entries(HOOK_SCRIPTS)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) {
      continue;
    }
    for (const group of groups) {
      group.hooks = (group.hooks || []).filter((h) => !isOurCommand(h.command, spec.file));
    }
    const kept = groups.filter((g) => (g.hooks || []).length > 0);
    if (kept.length > 0) {
      settings.hooks[event] = kept;
    } else {
      delete settings.hooks[event];
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log(`Unregistered hooks in ${file}`);
}

// ---------------------------------------------------------------------------

if (uninstall) {
  unlinkExtension();
  unregisterHooks();
  console.log("\nClauDiff uninstalled. Reload VS Code and start a new Claude Code session to fully clear it.");
} else {
  linkExtension();
  const file = registerHooks();
  console.log(`Registered hooks in ${file}`);
  console.log("\nClauDiff installed. Next steps:");
  console.log('  1. Reload VS Code ("Developer: Reload Window") so it picks up the extension.');
  console.log("  2. Start a new Claude Code session so it picks up the hooks.");
  console.log('  3. Set Claude Code\'s permission mode to "acceptEdits" or "auto" and edit away.');
}
