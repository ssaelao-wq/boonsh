// Command blocks in the command line panel: every command and its output is one section, with a divider above
// its command line and a mark in the left margin (green = worked, red = failed). The PowerShell prompt (pty.rs)
// reports how the command before it ended with an invisible OSC 133 "D" sequence; the panel places the blocks
// on the command lines itself (TerminalPanel). Pure helpers here, so they can be tested.

/** How a command ended, from the prompt's `ESC ] 133 ; D [; <exit code> ; <ms>] BEL`. `ran: false` = no command
 *  ran since the last prompt (an empty Enter, or boonsh re-drew the prompt). `code: null` = failed with a
 *  PowerShell error, which has no exit code (the prompt sends `-`). null = not a "D" report. */
export type CommandEnd = { ran: false } | { ran: true; code: number | null; ms: number | null };

export function parseCommandEnd(data: string): CommandEnd | null {
  const parts = data.split(';');
  if (parts[0] !== 'D') return null;
  if (parts.length < 2 || parts[1] === '') return { ran: false };
  const code = Number(parts[1]);
  const ms = parts.length > 2 && parts[2] !== '' ? Number(parts[2]) : NaN;
  return { ran: true, code: Number.isFinite(code) ? code : null, ms: Number.isFinite(ms) && ms >= 0 ? ms : null };
}

/** "0.4 s", "12 s", "3 min 05 s", "1 h 02 min" */
export function formatDuration(ms: number): string {
  if (ms < 10000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export type BlockState = 'running' | 'ok' | 'failed' | 'done';

/** The margin mark's tooltip. `done` = finished, result unknown (cmd tabs report no exit code). */
export function blockTooltip(state: BlockState, started: Date, code?: number | null, ms?: number | null): string {
  const at = started.toLocaleTimeString();
  if (state === 'running') return `Running (started ${at})`;
  const took = ms != null ? ` · took ${formatDuration(ms)}` : '';
  if (state === 'done') return `Finished${took} · started ${at}`;
  if (state === 'ok') return `Worked${took} · started ${at}`;
  return `Failed (${code == null ? 'PowerShell error' : `exit code ${code}`})${took} · started ${at}`;
}

/** Ctrl+Up / Ctrl+Down: the buffer line to scroll to, from the command lines (ascending) and where the user is
 *  (`from`: the last command jumped to, else the top line shown, or the prompt's line when at the bottom).
 *  Up = the nearest command above it; Down = the nearest below it, or null (go to the bottom). */
export function jumpTarget(lines: number[], from: number, dir: 'up' | 'down'): number | null {
  if (dir === 'up') {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i] < from) return lines[i];
    return lines.length ? lines[0] : null;
  }
  for (const l of lines) if (l > from) return l;
  return null;
}

/** A prompt with nothing typed after it (`NAME > `, `admin > `): left by an empty Enter, not command output. */
export const isBarePrompt = (text: string) => /^[^>]+>$/.test(text.trim()); // user names may hold spaces, not >


/** The index of the block that holds buffer line `row` (the last one starting at or above it), or -1. */
export function blockAt(lines: number[], row: number): number {
  let found = -1;
  for (let i = 0; i < lines.length && lines[i] <= row; i++) found = i;
  return found;
}

// Lines boonsh itself sends to a shell with Enter (the `cd` after a folder change in the file panel), so the
// command line panel gives them a block too. The panel registers the listener; App / useTerminalTabs report.
let sentListener: ((id: string) => void) | null = null;
export const onLineSent = (listener: ((id: string) => void) | null) => {
  sentListener = listener;
};
export const lineSent = (id: string) => sentListener?.(id);
