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
const fakeFfplay = path.join(fakeBinDir, "ffplay");
fs.writeFileSync(fakeFfplay, "", "utf8");
fs.chmodSync(fakeFfplay, 0o755);
process.env.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH || ""}`;

const notifications = [];
const errors = [];
const logs = [];
const disposables = [];
let onDidCreate;
let onDidChange;
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
  completionSoundStartSeconds: 1.25,
  completionSoundEndSeconds: 2.75,
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
      onDidCreate: (listener) => {
        onDidCreate = listener;
      },
      onDidChange: (listener) => {
        onDidChange = listener;
      },
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
  const exists = fs.existsSync(file);
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");

  const listener = exists ? onDidChange : onDidCreate;
  if (listener) {
    listener({ fsPath: file });
  }
}

function appendMainMeta(file) {
  append(file, {
    timestamp: "2026-07-18T00:00:00.000Z",
    type: "session_meta",
    payload: {
      thread_source: "user",
      source: "vscode"
    }
  });
}

function appendGuardianMeta(file) {
  append(file, {
    timestamp: "2026-07-18T00:00:00.000Z",
    type: "session_meta",
    payload: {
      thread_source: "subagent",
      source: {
        subagent: {
          other: "guardian"
        }
      }
    }
  });
}

function appendEscalatedCall(file, id) {
  append(file, {
    timestamp: `2026-07-18T00:00:${id}.000Z`,
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      id: `call-${id}`,
      arguments: JSON.stringify({
        cmd: "git status",
        sandbox_permissions: "require_escalated",
        justification: "test"
      })
    }
  });
}

async function main() {
  const autoFile = path.join(sessionsDir, "rollout-auto.jsonl");
  appendMainMeta(autoFile);
  append(autoFile, {
    timestamp: "2026-07-18T00:00:01.000Z",
    type: "turn_context",
    payload: {
      approvals_reviewer: "auto_review"
    }
  });

  const guardianFile = path.join(sessionsDir, "rollout-guardian.jsonl");
  appendGuardianMeta(guardianFile);

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
  const clipSpawn = soundSpawns.find(({ args }) => args.includes(storedSound));
  assert.strictEqual(clipSpawn.command, fakeFfplay);
  assert.deepStrictEqual(
    clipSpawn.args.slice(clipSpawn.args.indexOf("-ss"), clipSpawn.args.indexOf("-ss") + 4),
    ["-ss", "1.25", "-t", "1.5"],
    "Test Beep should apply the configured start and end positions"
  );

  appendEscalatedCall(autoFile, "02");

  assert.strictEqual(
    notifications.filter((message) => message === "Codex is asking for approval").length,
    0,
    "auto-reviewed escalation must stay silent after restoring an existing session"
  );

  append(guardianFile, {
    timestamp: "2026-07-18T00:00:03.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "review-safe",
      last_agent_message: JSON.stringify({
        risk_level: "low",
        outcome: "allow"
      })
    }
  });

  assert.strictEqual(
    notifications.filter((message) => message === "Codex is asking for approval").length,
    0,
    "automatically approved escalation must stay silent after restoring a reviewer session"
  );

  append(guardianFile, {
    timestamp: "2026-07-18T00:00:04.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "review-risky",
      last_agent_message: JSON.stringify({
        risk_level: "high",
        outcome: "deny"
      })
    }
  });

  assert.strictEqual(
    notifications.filter((message) => message === "Codex is asking for approval").length,
    1,
    "denied automatic review must notify"
  );

  const subagentFile = path.join(sessionsDir, "rollout-subagent.jsonl");
  append(subagentFile, {
    timestamp: "2026-07-18T00:00:05.000Z",
    type: "session_meta",
    payload: {
      thread_source: "subagent",
      source: {
        subagent: {
          other: "worker"
        }
      }
    }
  });
  append(subagentFile, {
    timestamp: "2026-07-18T00:00:06.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "subagent-complete"
    }
  });

  assert.strictEqual(
    notifications.filter((message) => message === "Codex finished").length,
    0,
    "subagent completion must stay silent"
  );

  append(autoFile, {
    timestamp: "2026-07-18T00:00:07.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "main-complete"
    }
  });

  assert.strictEqual(
    notifications.filter((message) => message === "Codex finished").length,
    1,
    "main task completion must notify"
  );

  const unknownReviewerFile = path.join(sessionsDir, "rollout-unknown-reviewer.jsonl");
  appendMainMeta(unknownReviewerFile);
  appendEscalatedCall(unknownReviewerFile, "08");

  assert.strictEqual(
    notifications.filter((message) => message === "Codex is asking for approval").length,
    1,
    "escalation without explicit reviewer metadata must stay silent"
  );

  const manualFile = path.join(sessionsDir, "rollout-manual.jsonl");
  appendMainMeta(manualFile);
  append(manualFile, {
    timestamp: "2026-07-18T00:00:08.000Z",
    type: "turn_context",
    payload: {
      approvals_reviewer: "user"
    }
  });
  appendEscalatedCall(manualFile, "09");

  assert.strictEqual(
    notifications.filter((message) => message === "Codex is asking for approval").length,
    2,
    "manual approval request must notify immediately"
  );

  append(autoFile, {
    timestamp: "2026-07-18T00:00:10.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "request_user_input",
      id: "request-input",
      arguments: "{}"
    }
  });

  assert.strictEqual(
    notifications.filter((message) => message === "Codex needs your input").length,
    1,
    "explicit user input request must notify"
  );

  extension.deactivate();

  if (errors.length > 0) {
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
