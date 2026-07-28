"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-beeper-"));
const sessionsDir = path.join(tempRoot, "sessions", "2026", "07", "18");
const globalStorageDir = path.join(tempRoot, "vscode-global-storage");
const fakeBinDir = path.join(tempRoot, "bin");
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(fakeBinDir, { recursive: true });

const fakePaplay = path.join(fakeBinDir, "paplay");
fs.writeFileSync(fakePaplay, "", "utf8");
fs.chmodSync(fakePaplay, 0o755);
process.env.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH || ""}`;

const notifications = [];
const errors = [];
const logs = [];
const disposables = [];
const registeredCommands = new Map();
const soundSpawns = [];
let selectedSound;

const originalSpawn = childProcess.spawn;
childProcess.spawn = (command, args) => {
  soundSpawns.push({ command, args });
  const child = {
    kill: () => undefined,
    once: () => child,
    unref: () => undefined
  };
  return child;
};

function fileUri(file) {
  return {
    fsPath: file,
    path: file,
    scheme: "file",
    toString: () => `file://${file}`
  };
}

const fakeConfig = {
  enabled: true,
  codexHome: tempRoot,
  beepOnTaskComplete: true,
  beepOnApprovalRequest: true,
  showNotifications: true,
  customSoundCommand: "true",
  completionSoundFile: "",
  volumePercent: 35,
  scanIntervalMs: 500
};

const fakeVscode = {
  StatusBarAlignment: { Right: 2 },
  ConfigurationTarget: { Global: 1 },
  window: {
    createOutputChannel: () => ({
      appendLine: (line) => logs.push(line),
      show: () => undefined,
      dispose: () => undefined
    }),
    createStatusBarItem: () => ({
      show: () => undefined,
      dispose: () => undefined
    }),
    showInformationMessage: async (message) => {
      notifications.push(message);
      return undefined;
    },
    showErrorMessage: async (message) => {
      errors.push(message);
      return undefined;
    },
    showOpenDialog: async () => selectedSound ? [selectedSound] : undefined
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => Object.prototype.hasOwnProperty.call(fakeConfig, key) ? fakeConfig[key] : fallback,
      update: async (key, value) => {
        fakeConfig[key] = value;
      }
    }),
    fs: {
      copy: async (source, destination) => {
        fs.copyFileSync(source.fsPath, destination.fsPath);
      },
      createDirectory: async (uri) => {
        fs.mkdirSync(uri.fsPath, { recursive: true });
      },
      delete: async (uri) => {
        fs.rmSync(uri.fsPath);
      }
    },
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    createFileSystemWatcher: () => ({
      onDidCreate: () => undefined,
      onDidChange: () => undefined,
      dispose: () => undefined
    })
  },
  commands: {
    registerCommand: (command, callback) => {
      registeredCommands.set(command, callback);
      return { dispose: () => registeredCommands.delete(command) };
    }
  },
  Uri: {
    file: fileUri,
    joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts))
  },
  RelativePattern: class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "vscode") {
    return fakeVscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

function append(file, record) {
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const extension = require(path.join(repoRoot, "extension.js"));
  extension.activate({
    subscriptions: disposables,
    globalStorageUri: fakeVscode.Uri.file(globalStorageDir)
  });

  const sourceSound = path.join(tempRoot, "selected-sound.wav");
  fs.writeFileSync(sourceSound, "fake wave data", "utf8");
  selectedSound = fakeVscode.Uri.file(sourceSound);

  const selectSound = registeredCommands.get("codexBeeper.selectCompletionSound");
  assert(selectSound, "Select Completion Sound command was not registered");
  await selectSound();

  const storedSound = path.join(globalStorageDir, "sounds", "selected-sound.wav");
  assert.strictEqual(fakeConfig.completionSoundFile, "selected-sound.wav");
  assert.strictEqual(fs.readFileSync(storedSound, "utf8"), "fake wave data");

  fs.rmSync(sourceSound);
  assert(fs.existsSync(storedSound), "Managed sound copy should survive removal of the source file");

  const testBeep = registeredCommands.get("codexBeeper.testBeep");
  assert(testBeep, "Test Beep command was not registered");
  await testBeep();
  assert(
    soundSpawns.some(({ args }) => args.includes(storedSound)),
    "Test Beep should play the VS Code-managed sound copy"
  );

  const file = path.join(sessionsDir, "rollout-test.jsonl");
  append(file, {
    timestamp: "2026-07-18T00:00:00.000Z",
    type: "session_meta",
    payload: {
      thread_source: "main"
    }
  });

  append(file, {
    timestamp: "2026-07-18T00:00:01.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "turn-test"
    }
  });

  append(file, {
    timestamp: "2026-07-18T00:00:02.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      id: "call-test",
      arguments: JSON.stringify({
        cmd: "xdg-open .",
        sandbox_permissions: "require_escalated",
        justification: "test"
      })
    }
  });

  await delay(1200);
  extension.deactivate();

  const sawComplete = notifications.includes("Codex finished");
  const sawApproval = notifications.includes("Codex is asking for approval");

  if (!sawComplete || !sawApproval || errors.length > 0) {
    console.error(JSON.stringify({ notifications, errors, logs }, null, 2));
    process.exit(1);
  }

  console.log("smoke ok");
  console.log(JSON.stringify({ notifications, storedSound }, null, 2));

  childProcess.spawn = originalSpawn;
  fs.rmSync(tempRoot, { recursive: true });
}

main().catch((error) => {
  childProcess.spawn = originalSpawn;
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
