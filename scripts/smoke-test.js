"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-beeper-"));
const sessionsDir = path.join(tempRoot, "sessions", "2026", "07", "18");
fs.mkdirSync(sessionsDir, { recursive: true });

const notifications = [];
const logs = [];
const disposables = [];

const fakeConfig = {
  enabled: true,
  codexHome: tempRoot,
  beepOnTaskComplete: true,
  beepOnApprovalRequest: true,
  showNotifications: true,
  customSoundCommand: "true",
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
    }
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => Object.prototype.hasOwnProperty.call(fakeConfig, key) ? fakeConfig[key] : fallback,
      update: async (key, value) => {
        fakeConfig[key] = value;
      }
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    createFileSystemWatcher: () => ({
      onDidCreate: () => undefined,
      onDidChange: () => undefined,
      dispose: () => undefined
    })
  },
  commands: {
    registerCommand: () => ({ dispose: () => undefined })
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
  extension.activate({ subscriptions: disposables });

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

  if (!sawComplete || !sawApproval) {
    console.error(JSON.stringify({ notifications, logs }, null, 2));
    process.exit(1);
  }

  console.log("smoke ok");
  console.log(JSON.stringify({ notifications }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
