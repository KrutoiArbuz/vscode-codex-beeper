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
- `Codex Beeper: Select Completion Sound`

## Custom completion sound

Run `Codex Beeper: Select Completion Sound` from the Command Palette, or open the
`Codex Beeper: Completion Sound File` setting and select the file there. The extension
copies the selected audio file into VS Code-managed extension storage. Playback therefore
continues to work if the original file is moved or deleted.

`Codex Beeper: Test Beep` plays the selected completion sound. Clear the
`codexBeeper.completionSoundFile` setting to return to the platform default. The selected
file applies to completed requests; approval requests keep their existing sound behavior.

To play only part of the selected file, set:

- `codexBeeper.completionSoundStartSeconds` — where playback begins, in seconds
- `codexBeeper.completionSoundEndSeconds` — where playback stops, in seconds; use `0` to play through the end

For example, start `1.25` and end `2.75` plays a 1.5-second clip. The end must be
greater than the start. On Linux and macOS, a non-zero start position requires
`ffplay` from FFmpeg; Windows uses its built-in media player.

## Settings

- `codexBeeper.enabled`
- `codexBeeper.codexHome`
- `codexBeeper.beepOnTaskComplete`
- `codexBeeper.beepOnApprovalRequest`
- `codexBeeper.showNotifications`
- `codexBeeper.customSoundCommand`
- `codexBeeper.completionSoundFile`
- `codexBeeper.completionSoundStartSeconds`
- `codexBeeper.completionSoundEndSeconds`
- `codexBeeper.volumePercent`
- `codexBeeper.scanIntervalMs`
