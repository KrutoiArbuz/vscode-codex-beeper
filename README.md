# Codex Beeper

Tiny local VS Code extension that monitors Codex JSONL session logs and plays a desktop sound when:

- The main Codex agent completes a task (`task_complete`)
- Codex requires manual approval or explicitly requests user input

The extension does not use Codex hooks. It watches `~/.codex/sessions/**/*.jsonl` from the VS Code extension host.

When Codex uses automatic approval review, the extension stays silent for approved actions and notifies only when the reviewer denies an action or times out, leaving the task in need of user attention. Direct approval requests in manual-review mode still notify immediately. Regular subagent completions are ignored.

## Commands

- `Codex Beeper: Toggle`
- `Codex Beeper: Test Beep`
- `Codex Beeper: Show Log`

## Settings

- `codexBeeper.enabled`
- `codexBeeper.codexHome`
- `codexBeeper.beepOnTaskComplete`
- `codexBeeper.beepOnApprovalRequest`
- `codexBeeper.showNotifications`
- `codexBeeper.customSoundCommand`
- `codexBeeper.volumePercent`
- `codexBeeper.scanIntervalMs`
