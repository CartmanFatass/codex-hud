/**
 * Compact HUD input is never meant to be a keyboard sink. If tmux still
 * delivers a keystroke to the 1-line bar, replay it into the Codex pane and
 * put focus back there so Codex shortcuts keep working.
 */
export function tmuxForwardKeyArgs(mainPane: string, data: Buffer): string[] | null {
  if (!mainPane || data.length === 0) {
    return null;
  }
  if (isMouseReport(data)) {
    return null;
  }
  const hex = Array.from(data, (byte) => byte.toString(16).padStart(2, '0'));
  return ['send-keys', '-t', mainPane, '-H', ...hex];
}

export function tmuxFocusPaneArgs(mainPane: string): string[] | null {
  if (!mainPane) {
    return null;
  }
  return ['select-pane', '-t', mainPane];
}

function isMouseReport(data: Buffer): boolean {
  if (data.length < 3 || data[0] !== 0x1b || data[1] !== 0x5b) {
    return false;
  }
  return data[2] === 0x3c || data[2] === 0x4d;
}
