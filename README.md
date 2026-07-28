# Codex Beeper

Tiny local VS Code extension that monitors Codex JSONL session logs and plays a desktop sound when:

- Codex records a completed turn (`task_complete`)
- Codex records a command request with `sandbox_permissions: "require_escalated"`

The extension does not use Codex hooks. It watches `~/.codex/sessions/**/*.jsonl` from the VS Code extension host.

## Commands

- `Codex Beeper: Toggle`
- `Codex Beeper: Test Beep`
- `Codex Beeper: Show Log`
- `Codex Beeper: Select Completion Sound`

## Custom completion sound

Run `Codex Beeper: Select Completion Sound` from the Command Palette, or open the
`Codex Beeper: Completion Sound File` setting and select the file there. The extension
copies the selected audio file into VS Code-managed extension storage. Playback therefore
continues to work if the original file is moved or deleted.

`Codex Beeper: Test Beep` plays the selected completion sound. Clear the
`codexBeeper.completionSoundFile` setting to return to the platform default. The selected
file applies to completed requests; approval requests keep their existing sound behavior.

## Settings

- `codexBeeper.enabled`
- `codexBeeper.codexHome`
- `codexBeeper.beepOnTaskComplete`
- `codexBeeper.beepOnApprovalRequest`
- `codexBeeper.showNotifications`
- `codexBeeper.customSoundCommand`
- `codexBeeper.completionSoundFile`
- `codexBeeper.volumePercent`
- `codexBeeper.scanIntervalMs`
