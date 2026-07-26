# Codex Beeper

Tiny local VS Code extension that monitors Codex JSONL session logs and plays a desktop sound when:

- Codex records a completed turn (`task_complete`)
- Codex records a command request with `sandbox_permissions: "require_escalated"`

The extension does not use Codex hooks. It watches `~/.codex/sessions/**/*.jsonl` from the VS Code extension host.

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
