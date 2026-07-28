"use strict";

const assert = require("assert");
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
let onDidCreate;
let onDidChange;

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
  extension.activate({ subscriptions: disposables });

  appendEscalatedCall(autoFile, "02");

  assert.deepStrictEqual(
    notifications,
    [],
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

  assert.deepStrictEqual(
    notifications,
    [],
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

  console.log("smoke ok");
  console.log(JSON.stringify({ notifications }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
