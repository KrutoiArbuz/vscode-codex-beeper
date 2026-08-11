'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const OUTPUT = vscode.window.createOutputChannel('Codex Beeper');
const STATE_BY_FILE = new Map();
const RECENT_EVENTS = [];
const RECENT_EVENT_SET = new Set();
const METADATA_SCAN_BYTES = 1024 * 1024;
const SOUND_STORAGE_DIRECTORY = 'sounds';
const COMPLETION_SOUND_SETTING = 'completionSoundFile';
const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  '.aac',
  '.aif',
  '.aiff',
  '.caf',
  '.flac',
  '.m4a',
  '.mp3',
  '.oga',
  '.ogg',
  '.wav',
  '.wma',
]);

let watcher;
let pollTimer;
let statusBar;
let enabled = true;
let extensionContext;

function activate(context) {
  extensionContext = context;
  enabled = getConfig().get('enabled', true);

  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    90,
  );
  statusBar.command = 'codexBeeper.toggle';
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('codexBeeper.toggle', toggle),
    vscode.commands.registerCommand('codexBeeper.testBeep', () =>
      notify('test', 'Codex Beeper test'),
    ),
    vscode.commands.registerCommand('codexBeeper.showLog', () =>
      OUTPUT.show(true),
    ),
    vscode.commands.registerCommand(
      'codexBeeper.selectCompletionSound',
      selectCompletionSound,
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codexBeeper')) {
        restart();
      }
    }),
  );

  start();
}

function deactivate() {
  stop();
  extensionContext = undefined;
  OUTPUT.dispose();
}

function getConfig() {
  return vscode.workspace.getConfiguration('codexBeeper');
}

function codexHome() {
  const configured = getConfig().get('codexHome', '').trim();
  return configured || path.join(os.homedir(), '.codex');
}

function sessionsDir() {
  return path.join(codexHome(), 'sessions');
}

function start() {
  stop();
  STATE_BY_FILE.clear();
  updateStatus();

  if (!enabled) {
    log('Monitoring disabled.');
    return;
  }

  const dir = sessionsDir();
  log(`Monitoring ${dir}`);
  primeExistingFiles(dir);
  createWatcher(dir);

  const interval = Math.max(500, getConfig().get('scanIntervalMs', 1500));
  pollTimer = setInterval(() => scanExistingFiles(dir, false), interval);
  if (typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }
}

function restart() {
  enabled = getConfig().get('enabled', true);
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
  await getConfig().update('enabled', next, vscode.ConfigurationTarget.Global);
  enabled = next;
  start();
  vscode.window.showInformationMessage(
    `Codex Beeper ${next ? 'enabled' : 'disabled'}.`,
  );
}

function updateStatus() {
  if (!statusBar) {
    return;
  }

  statusBar.text = enabled ? '$(bell) Codex' : '$(bell-slash) Codex';
  statusBar.tooltip = enabled
    ? 'Codex Beeper is monitoring session logs'
    : 'Codex Beeper is disabled';
  statusBar.show();
}

function createWatcher(dir) {
  if (!fs.existsSync(dir)) {
    log(`Sessions directory does not exist yet: ${dir}`);
    return;
  }

  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(dir, '**/*.jsonl'),
  );
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
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
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
      const state = createFileState(stats.size);
      restoreFileState(file, state, stats.size);
      STATE_BY_FILE.set(file, state);
    }
  } catch (error) {
    log(`Failed to prime ${file}: ${error.message}`);
  }
}

function processFile(file, includeExisting) {
  let state = STATE_BY_FILE.get(file);
  if (!state) {
    state = createFileState(includeExisting ? 0 : 0);
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
    state.pending = '';
  }

  if (stats.size === state.offset) {
    return;
  }

  let chunk;
  try {
    const fd = fs.openSync(file, 'r');
    const length = stats.size - state.offset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, state.offset);
    fs.closeSync(fd);
    state.offset = stats.size;
    chunk = state.pending + buffer.toString('utf8');
  } catch (error) {
    log(`Failed to read ${file}: ${error.message}`);
    return;
  }

  const lines = chunk.split(/\r?\n/);
  state.pending = lines.pop() || '';

  for (const line of lines) {
    handleLine(file, state, line);
  }
}

function createFileState(offset) {
  return {
    offset,
    pending: '',
    sessionKind: 'unknown',
    approvalsReviewer: 'unknown',
  };
}

function restoreFileState(file, state, size) {
  if (size === 0) {
    return;
  }

  let fd;
  try {
    fd = fs.openSync(file, 'r');

    const headLength = Math.min(size, METADATA_SCAN_BYTES);
    scanStateRecords(readFileSlice(fd, 0, headLength), state, false);

    if (size > headLength) {
      const tailStart = Math.max(0, size - METADATA_SCAN_BYTES);
      scanStateRecords(
        readFileSlice(fd, tailStart, size - tailStart),
        state,
        tailStart > 0,
      );
    }
  } catch (error) {
    log(`Failed to restore session state from ${file}: ${error.message}`);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore stale descriptor
      }
    }
  }
}

function readFileSlice(fd, offset, length) {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead).toString('utf8');
}

function scanStateRecords(text, state, skipFirstPartialLine) {
  const lines = text.split(/\r?\n/);
  if (skipFirstPartialLine) {
    lines.shift();
  }

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    try {
      updateStateFromRecord(state, JSON.parse(line));
    } catch {
      // ignore partial or malformed records
    }
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

  updateStateFromRecord(state, record);

  if (record.type === 'session_meta') {
    return;
  }

  const kind = classify(record, state);
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

function sessionKind(payload) {
  const subagent = payload.source && payload.source.subagent;
  const isSubagent =
    payload.thread_source === 'subagent' || Boolean(subagent);

  if (!isSubagent) {
    return 'main';
  }

  if (isGuardianSource(subagent)) {
    return 'guardian';
  }

  return 'subagent';
}

function isGuardianSource(source) {
  if (source === 'guardian') {
    return true;
  }

  if (!source || typeof source !== 'object') {
    return false;
  }

  return (
    source.other === 'guardian' ||
    source.type === 'guardian' ||
    source.name === 'guardian'
  );
}

function updateStateFromRecord(state, record) {
  const payload = record.payload || {};

  if (record.type === 'session_meta') {
    state.sessionKind = sessionKind(payload);
  } else if (record.type === 'turn_context') {
    updateTurnState(state, payload);
  } else if (
    record.type === 'event_msg' &&
    payload.type === 'thread_settings_applied'
  ) {
    updateTurnState(state, payload.thread_settings || {});
  }
}

function updateTurnState(state, payload) {
  if (typeof payload.approvals_reviewer === 'string') {
    state.approvalsReviewer = payload.approvals_reviewer;
  }

  if (state.sessionKind === 'subagent' && payload.model === 'codex-auto-review') {
    state.sessionKind = 'guardian';
  }
}

function classify(record, state) {
  const payload = record.payload || {};

  if (state.sessionKind === 'guardian') {
    return classifyGuardianReview(record);
  }

  if (state.sessionKind === 'subagent') {
    return undefined;
  }

  if (record.type === 'event_msg' && payload.type === 'task_complete') {
    return getConfig().get('beepOnTaskComplete', true) ? 'complete' : undefined;
  }

  if (record.type === 'response_item' && payload.type === 'function_call') {
    if (payload.name === 'request_user_input') {
      return getConfig().get('beepOnApprovalRequest', true)
        ? 'input'
        : undefined;
    }

    const args = parseArguments(payload.arguments);
    if (
      args &&
      args.sandbox_permissions === 'require_escalated' &&
      isManualReviewer(state.approvalsReviewer)
    ) {
      return getConfig().get('beepOnApprovalRequest', true)
        ? 'approval'
        : undefined;
    }
  }

  return undefined;
}

function classifyGuardianReview(record) {
  const payload = record.payload || {};
  if (record.type !== 'event_msg' || payload.type !== 'task_complete') {
    return undefined;
  }

  const assessment = parseArguments(payload.last_agent_message);
  if (!assessment) {
    return undefined;
  }

  const needsAttention =
    assessment.outcome === 'deny' ||
    assessment.status === 'denied' ||
    assessment.status === 'timedOut';

  return needsAttention && getConfig().get('beepOnApprovalRequest', true)
    ? 'approval'
    : undefined;
}

function isManualReviewer(reviewer) {
  // A new session file can be observed before its turn_context is appended.
  // Only explicit manual-review metadata is safe to notify on immediately.
  return reviewer === 'user';
}

function parseArguments(value) {
  if (!value) {
    return undefined;
  }

  if (typeof value === 'object') {
    return value;
  }

  if (typeof value !== 'string') {
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
    record.timestamp || '',
    payload.id || payload.turn_id || payload.call_id || '',
    payload.type || '',
  ].join(':');
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
  if (kind === 'approval') {
    return 'Codex is asking for approval';
  }
  if (kind === 'input') {
    return 'Codex needs your input';
  }
  if (kind === 'test') {
    return 'Codex Beeper test';
  }
  return 'Codex finished';
}

async function selectCompletionSound() {
  if (!extensionContext) {
    return;
  }

  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: 'Select a Codex completion sound',
    openLabel: 'Use Completion Sound',
    filters: {
      'Audio files': Array.from(SUPPORTED_AUDIO_EXTENSIONS, (extension) =>
        extension.slice(1),
      ),
    },
  });

  if (!selected || selected.length === 0) {
    return;
  }

  const source = selected[0];
  const sourcePath = source.fsPath || source.path;
  const fileName = path.basename(sourcePath);
  const extension = path.extname(fileName).toLowerCase();

  if (!SUPPORTED_AUDIO_EXTENSIONS.has(extension)) {
    vscode.window.showErrorMessage(
      `Unsupported audio format: ${extension || 'no file extension'}.`,
    );
    return;
  }

  const storageDirectory = vscode.Uri.joinPath(
    extensionContext.globalStorageUri,
    SOUND_STORAGE_DIRECTORY,
  );
  const destination = vscode.Uri.joinPath(storageDirectory, fileName);
  const previousName = configuredCompletionSoundName();

  try {
    await vscode.workspace.fs.createDirectory(storageDirectory);

    if (source.toString() !== destination.toString()) {
      await vscode.workspace.fs.copy(source, destination, { overwrite: true });
    }

    await getConfig().update(
      COMPLETION_SOUND_SETTING,
      fileName,
      vscode.ConfigurationTarget.Global,
    );

    if (previousName && !sameStoredSound(previousName, fileName)) {
      await deleteStoredSound(previousName);
    }

    log(
      `Stored completion sound in VS Code extension storage: ${destination.fsPath}`,
    );
    vscode.window.showInformationMessage(
      `Codex completion sound set to ${fileName}.`,
    );
  } catch (error) {
    log(`Failed to store completion sound: ${error.message}`);
    vscode.window.showErrorMessage(
      `Could not save the completion sound: ${error.message}`,
    );
  }
}

function sameStoredSound(firstName, secondName) {
  const first = storedCompletionSoundUri(firstName);
  const second = storedCompletionSoundUri(secondName);
  if (!first || !second) {
    return false;
  }

  if (first.scheme !== 'file' || second.scheme !== 'file') {
    return first.toString() === second.toString();
  }

  const firstPath = path.resolve(first.fsPath);
  const secondPath = path.resolve(second.fsPath);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return firstPath.toLowerCase() === secondPath.toLowerCase();
  }

  return firstPath === secondPath;
}

async function deleteStoredSound(fileName) {
  const uri = storedCompletionSoundUri(fileName);
  if (!uri) {
    return;
  }

  try {
    await vscode.workspace.fs.delete(uri);
  } catch {
    // The previous managed copy may already have been removed.
  }
}

function notify(kind, message) {
  log(message);
  playSound(kind);

  if (getConfig().get('showNotifications', true)) {
    vscode.window.showInformationMessage(message);
  }
}

function playSound(kind) {
  if (kind === 'complete' || kind === 'test') {
    const storedSound = storedCompletionSoundPath();
    if (storedSound) {
      const command = soundFileCommand(storedSound);
      if (command) {
        spawnDetached(
          command.command,
          command.args,
          kind,
          command.environment,
          command.stopAfterMs,
        );
        return;
      }

      log(`No audio player is available for: ${storedSound}`);
    }
  }

  const custom = getConfig().get('customSoundCommand', '').trim();
  if (custom) {
    runShellCommand(custom, kind);
    return;
  }

  const command = defaultSoundCommand();
  if (!command) {
    log('No default sound command for this platform.');
    return;
  }

  spawnDetached(command.command, command.args, kind);
}

function configuredCompletionSoundName() {
  const configured = getConfig().get(COMPLETION_SOUND_SETTING, '').trim();
  if (!configured) {
    return undefined;
  }

  if (
    path.basename(configured) !== configured ||
    !SUPPORTED_AUDIO_EXTENSIONS.has(path.extname(configured).toLowerCase())
  ) {
    log(`Ignoring invalid ${COMPLETION_SOUND_SETTING} setting: ${configured}`);
    return undefined;
  }

  return configured;
}

function storedCompletionSoundUri(fileName = configuredCompletionSoundName()) {
  if (!extensionContext || !fileName) {
    return undefined;
  }

  return vscode.Uri.joinPath(
    extensionContext.globalStorageUri,
    SOUND_STORAGE_DIRECTORY,
    fileName,
  );
}

function storedCompletionSoundPath() {
  const uri = storedCompletionSoundUri();
  if (!uri) {
    return undefined;
  }

  if (!fs.existsSync(uri.fsPath)) {
    log(`Stored completion sound is missing: ${uri.fsPath}`);
    return undefined;
  }

  return uri.fsPath;
}

function completionSoundTiming() {
  const start = nonNegativeNumberSetting('completionSoundStartSeconds', 0);
  const configuredEnd = nonNegativeNumberSetting(
    'completionSoundEndSeconds',
    0,
  );

  if (configuredEnd > 0 && configuredEnd <= start) {
    log(
      'Ignoring completionSoundEndSeconds because it must be greater than completionSoundStartSeconds.',
    );
    return { start, end: undefined };
  }

  return {
    start,
    end: configuredEnd > 0 ? configuredEnd : undefined,
  };
}

function nonNegativeNumberSetting(name, fallback) {
  const configured = Number(getConfig().get(name, fallback));
  if (!Number.isFinite(configured)) {
    return fallback;
  }

  return Math.max(0, configured);
}

function soundFileCommand(soundFile) {
  const volume = volumePercent();
  const timing = completionSoundTiming();
  const hasTiming = timing.start > 0 || timing.end !== undefined;

  if (process.platform === 'win32') {
    return windowsSoundFileCommand(soundFile, volume, timing);
  }

  if (hasTiming) {
    const ffplayCommand = ffplaySoundFileCommand(soundFile, volume, timing);
    if (ffplayCommand) {
      return ffplayCommand;
    }

    if (timing.start > 0) {
      log(
        'A non-zero completion sound start time requires ffplay (from FFmpeg) on this platform; playing from the beginning.',
      );
    }
  }

  if (process.platform === 'darwin') {
    const args = ['-v', String(volume / 100)];
    if (timing.end !== undefined) {
      args.push('-t', String(timing.end));
    }
    args.push(soundFile);
    return { command: 'afplay', args };
  }

  const paplay = findExecutable('paplay');
  if (paplay) {
    return {
      command: paplay,
      args: [`--volume=${pulseVolume(volume)}`, soundFile],
      stopAfterMs: timing.end === undefined ? undefined : timing.end * 1000,
    };
  }

  const ffplayCommand = ffplaySoundFileCommand(soundFile, volume, timing);
  if (ffplayCommand) {
    return ffplayCommand;
  }

  const canberra = findExecutable('canberra-gtk-play');
  if (canberra) {
    return {
      command: canberra,
      args: ['-f', soundFile],
      stopAfterMs: timing.end === undefined ? undefined : timing.end * 1000,
    };
  }

  const aplay = findExecutable('aplay');
  if (aplay && path.extname(soundFile).toLowerCase() === '.wav') {
    return {
      command: aplay,
      args: ['-q', soundFile],
      stopAfterMs: timing.end === undefined ? undefined : timing.end * 1000,
    };
  }

  return undefined;
}

function ffplaySoundFileCommand(soundFile, volume, timing) {
  const ffplay = findExecutable('ffplay');
  if (!ffplay) {
    return undefined;
  }

  const args = [
    '-nodisp',
    '-autoexit',
    '-loglevel',
    'quiet',
    '-volume',
    String(volume),
  ];
  if (timing.start > 0) {
    args.push('-ss', String(timing.start));
  }
  if (timing.end !== undefined) {
    args.push('-t', String(timing.end - timing.start));
  }
  args.push(soundFile);

  return { command: ffplay, args };
}

function windowsSoundFileCommand(soundFile, volume, timing) {
  const script = [
    'Add-Type -AssemblyName PresentationCore',
    '$player = New-Object System.Windows.Media.MediaPlayer',
    '$player.Open([Uri]$env:CODEX_BEEPER_SOUND_FILE)',
    '$deadline = (Get-Date).AddMilliseconds(2000)',
    'while (-not $player.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }',
    '$player.Volume = [double]$env:CODEX_BEEPER_SOUND_VOLUME',
    '$start = [double]$env:CODEX_BEEPER_SOUND_START',
    'if ($start -gt 0) { $player.Position = [TimeSpan]::FromSeconds($start) }',
    '$player.Play()',
    '$end = [double]$env:CODEX_BEEPER_SOUND_END',
    'if ($end -gt $start) { $playMs = ($end - $start) * 1000 } elseif ($player.NaturalDuration.HasTimeSpan) { $playMs = [Math]::Max(0, $player.NaturalDuration.TimeSpan.TotalMilliseconds - ($start * 1000)) } else { $playMs = 500 }',
    'Start-Sleep -Milliseconds $playMs',
    '$player.Close()',
  ].join('; ');

  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script],
    environment: {
      ...process.env,
      CODEX_BEEPER_SOUND_FILE: soundFile,
      CODEX_BEEPER_SOUND_VOLUME: String(volume / 100),
      CODEX_BEEPER_SOUND_START: String(timing.start),
      CODEX_BEEPER_SOUND_END: String(timing.end || 0),
    },
  };
}

function defaultSoundCommand() {
  const volume = volumePercent();

  if (process.platform === 'darwin') {
    return {
      command: 'afplay',
      args: ['-v', String(volume / 100), '/System/Library/Sounds/Glass.aiff'],
    };
  }

  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command', '[console]::beep(880,250)'],
    };
  }

  const sounds = [
    '/usr/share/sounds/freedesktop/stereo/complete.oga',
    '/usr/share/sounds/freedesktop/stereo/message.oga',
    '/usr/share/sounds/freedesktop/stereo/bell.oga',
  ];
  const sound = sounds.find((candidate) => fs.existsSync(candidate));

  if (findExecutable('paplay') && sound) {
    return {
      command: 'paplay',
      args: [`--volume=${pulseVolume(volume)}`, sound],
    };
  }

  if (findExecutable('canberra-gtk-play')) {
    return {
      command: 'canberra-gtk-play',
      args: ['-i', 'complete'],
    };
  }

  return undefined;
}

function volumePercent() {
  const configured = Number(getConfig().get('volumePercent', 35));
  if (!Number.isFinite(configured)) {
    return 35;
  }

  return Math.max(1, Math.min(100, Math.round(configured)));
}

function pulseVolume(percent) {
  return Math.max(1, Math.min(65536, Math.round((65536 * percent) / 100)));
}

function findExecutable(name) {
  const pathValue = process.env.PATH || '';
  const extensions =
    process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];

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

function spawnDetached(command, args, kind, environment, stopAfterMs) {
  try {
    const child = cp.spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      ...(environment ? { env: environment } : {}),
    });
    child.once('error', (error) => {
      log(`Sound process failed for ${kind}: ${error.message}`);
    });
    child.unref();

    if (Number.isFinite(stopAfterMs) && stopAfterMs > 0) {
      const stopTimer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore a sound process that already exited
        }
      }, stopAfterMs);
      if (typeof stopTimer.unref === 'function') {
        stopTimer.unref();
      }
    }

    log(`Spawned sound for ${kind}: ${command} ${args.join(' ')}`);
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
  deactivate,
};
