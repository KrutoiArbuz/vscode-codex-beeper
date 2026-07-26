"use strict";

const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const OUTPUT = vscode.window.createOutputChannel("Codex Beeper");
const STATE_BY_FILE = new Map();
const RECENT_EVENTS = [];
const RECENT_EVENT_SET = new Set();

let watcher;
let pollTimer;
let statusBar;
let enabled = true;

function activate(context) {
  enabled = getConfig().get("enabled", true);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = "codexBeeper.toggle";
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("codexBeeper.toggle", toggle),
    vscode.commands.registerCommand("codexBeeper.testBeep", () => notify("test", "Codex Beeper test")),
    vscode.commands.registerCommand("codexBeeper.showLog", () => OUTPUT.show(true)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexBeeper")) {
        restart();
      }
    })
  );

  start();
}

function deactivate() {
  stop();
  OUTPUT.dispose();
}

function getConfig() {
  return vscode.workspace.getConfiguration("codexBeeper");
}

function codexHome() {
  const configured = getConfig().get("codexHome", "").trim();
  return configured || path.join(os.homedir(), ".codex");
}

function sessionsDir() {
  return path.join(codexHome(), "sessions");
}

function start() {
  stop();
  STATE_BY_FILE.clear();
  updateStatus();

  if (!enabled) {
    log("Monitoring disabled.");
    return;
  }

  const dir = sessionsDir();
  log(`Monitoring ${dir}`);
  primeExistingFiles(dir);
  createWatcher(dir);

  const interval = Math.max(500, getConfig().get("scanIntervalMs", 1500));
  pollTimer = setInterval(() => scanExistingFiles(dir, false), interval);
  if (typeof pollTimer.unref === "function") {
    pollTimer.unref();
  }
}

function restart() {
  enabled = getConfig().get("enabled", true);
  start();
}

function stop() {
  if (watcher) {
    watcher.dispose();
    watcher = undefined;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function toggle() {
  const next = !enabled;
  await getConfig().update("enabled", next, vscode.ConfigurationTarget.Global);
  enabled = next;
  start();
  vscode.window.showInformationMessage(`Codex Beeper ${next ? "enabled" : "disabled"}.`);
}

function updateStatus() {
  if (!statusBar) {
    return;
  }

  statusBar.text = enabled ? "$(bell) Codex" : "$(bell-slash) Codex";
  statusBar.tooltip = enabled ? "Codex Beeper is monitoring session logs" : "Codex Beeper is disabled";
  statusBar.show();
}

function createWatcher(dir) {
  if (!fs.existsSync(dir)) {
    log(`Sessions directory does not exist yet: ${dir}`);
    return;
  }

  watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, "**/*.jsonl"));
  watcher.onDidCreate((uri) => processFile(uri.fsPath, false));
  watcher.onDidChange((uri) => processFile(uri.fsPath, false));
}

function primeExistingFiles(dir) {
  scanExistingFiles(dir, true);
}

function scanExistingFiles(dir, primeOnly) {
  for (const file of listJsonlFiles(dir)) {
    if (primeOnly) {
      primeFile(file);
    } else {
      processFile(file, false);
    }
  }
}

function listJsonlFiles(root) {
  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function primeFile(file) {
  try {
    const stats = fs.statSync(file);
    if (!STATE_BY_FILE.has(file)) {
      STATE_BY_FILE.set(file, {
        offset: stats.size,
        pending: "",
        ignore: false,
        sawMeta: false
      });
    }
  } catch (error) {
    log(`Failed to prime ${file}: ${error.message}`);
  }
}

function processFile(file, includeExisting) {
  let state = STATE_BY_FILE.get(file);
  if (!state) {
    state = {
      offset: includeExisting ? 0 : 0,
      pending: "",
      ignore: false,
      sawMeta: false
    };
    STATE_BY_FILE.set(file, state);
  }

  let stats;
  try {
    stats = fs.statSync(file);
  } catch {
    STATE_BY_FILE.delete(file);
    return;
  }

  if (stats.size < state.offset) {
    state.offset = 0;
    state.pending = "";
  }

  if (stats.size === state.offset) {
    return;
  }

  let chunk;
  try {
    const fd = fs.openSync(file, "r");
    const length = stats.size - state.offset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, state.offset);
    fs.closeSync(fd);
    state.offset = stats.size;
    chunk = state.pending + buffer.toString("utf8");
  } catch (error) {
    log(`Failed to read ${file}: ${error.message}`);
    return;
  }

  const lines = chunk.split(/\r?\n/);
  state.pending = lines.pop() || "";

  for (const line of lines) {
    handleLine(file, state, line);
  }
}

function handleLine(file, state, line) {
  if (!line.trim()) {
    return;
  }

  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }

  if (record.type === "session_meta") {
    state.sawMeta = true;
    const payload = record.payload || {};
    state.ignore = payload.thread_source === "subagent" || Boolean(payload.source && payload.source.subagent);
    return;
  }

  if (state.ignore) {
    return;
  }

  const kind = classify(record);
  if (!kind) {
    return;
  }

  const key = eventKey(file, record, kind);
  if (hasRecentEvent(key)) {
    return;
  }

  rememberEvent(key);
  notify(kind, messageFor(kind));
}

function classify(record) {
  const payload = record.payload || {};

  if (record.type === "event_msg" && payload.type === "task_complete") {
    return getConfig().get("beepOnTaskComplete", true) ? "complete" : undefined;
  }

  if (record.type === "response_item" && payload.type === "function_call") {
    const args = parseArguments(payload.arguments);
    if (args && args.sandbox_permissions === "require_escalated") {
      return getConfig().get("beepOnApprovalRequest", true) ? "approval" : undefined;
    }
  }

  return undefined;
}

function parseArguments(value) {
  if (!value) {
    return undefined;
  }

  if (typeof value === "object") {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function eventKey(file, record, kind) {
  const payload = record.payload || {};
  return [
    file,
    kind,
    record.timestamp || "",
    payload.id || payload.turn_id || payload.call_id || "",
    payload.type || ""
  ].join(":");
}

function hasRecentEvent(key) {
  return RECENT_EVENT_SET.has(key);
}

function rememberEvent(key) {
  RECENT_EVENT_SET.add(key);
  RECENT_EVENTS.push(key);

  while (RECENT_EVENTS.length > 1000) {
    const oldKey = RECENT_EVENTS.shift();
    RECENT_EVENT_SET.delete(oldKey);
  }
}

function messageFor(kind) {
  if (kind === "approval") {
    return "Codex is asking for approval";
  }
  if (kind === "test") {
    return "Codex Beeper test";
  }
  return "Codex finished";
}

function notify(kind, message) {
  log(message);
  playSound(kind);

  if (getConfig().get("showNotifications", true)) {
    vscode.window.showInformationMessage(message);
  }
}

function playSound(kind) {
  const custom = getConfig().get("customSoundCommand", "").trim();
  if (custom) {
    runShellCommand(custom, kind);
    return;
  }

  const command = defaultSoundCommand();
  if (!command) {
    log("No default sound command for this platform.");
    return;
  }

  spawnDetached(command.command, command.args, kind);
}

function defaultSoundCommand() {
  const volume = volumePercent();

  if (process.platform === "darwin") {
    return {
      command: "afplay",
      args: ["-v", String(volume / 100), "/System/Library/Sounds/Glass.aiff"]
    };
  }

  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-Command", "[console]::beep(880,250)"]
    };
  }

  const sounds = [
    "/usr/share/sounds/freedesktop/stereo/complete.oga",
    "/usr/share/sounds/freedesktop/stereo/message.oga",
    "/usr/share/sounds/freedesktop/stereo/bell.oga"
  ];
  const sound = sounds.find((candidate) => fs.existsSync(candidate));

  if (findExecutable("paplay") && sound) {
    return {
      command: "paplay",
      args: [`--volume=${pulseVolume(volume)}`, sound]
    };
  }

  if (findExecutable("canberra-gtk-play")) {
    return {
      command: "canberra-gtk-play",
      args: ["-i", "complete"]
    };
  }

  return undefined;
}

function volumePercent() {
  const configured = Number(getConfig().get("volumePercent", 35));
  if (!Number.isFinite(configured)) {
    return 35;
  }

  return Math.max(1, Math.min(100, Math.round(configured)));
}

function pulseVolume(percent) {
  return Math.max(1, Math.min(65536, Math.round((65536 * percent) / 100)));
}

function findExecutable(name) {
  const pathValue = process.env.PATH || "";
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

  for (const dir of pathValue.split(path.delimiter)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }

  return undefined;
}

function spawnDetached(command, args, kind) {
  try {
    const child = cp.spawn(command, args, {
      detached: true,
      stdio: "ignore"
    });
    child.unref();

    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore stale process
      }
    }, 2500);

    if (typeof killTimer.unref === "function") {
      killTimer.unref();
    }

    log(`Spawned sound for ${kind}: ${command} ${args.join(" ")}`);
  } catch (error) {
    log(`Failed to spawn sound for ${kind}: ${error.message}`);
  }
}

function runShellCommand(command, kind) {
  try {
    cp.exec(command, { timeout: 2500 }, (error) => {
      if (error) {
        log(`Custom sound command failed for ${kind}: ${error.message}`);
      }
    });
    log(`Started custom sound command for ${kind}: ${command}`);
  } catch (error) {
    log(`Failed to start custom sound command for ${kind}: ${error.message}`);
  }
}

function log(message) {
  const timestamp = new Date().toISOString();
  OUTPUT.appendLine(`${timestamp} ${message}`);
}

module.exports = {
  activate,
  deactivate
};
