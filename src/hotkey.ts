// Hot keys for terminal commands. A hot key is always Ctrl+Alt plus a letter, a digit or F1-F12, written like
// "Ctrl+Alt+K". Ctrl+Alt is used because none of boonsh's own shortcuts (Ctrl+A/C/X/V/Z/P, Ctrl+Shift+F, F2, F5,
// Del ...) and none of the shell's editing keys (Ctrl+A/E/K/L/R/U/W ...) use it. A hot key works only while the
// command line has the keyboard focus (see TerminalPanel), so it cannot clash with anything in the file panel. The key
// is read from `KeyboardEvent.code`, so the hot key is the same key on every keyboard layout.

import type { CommandGroup } from './commands';

export const HOTKEY_PREFIX = 'Ctrl+Alt+';

// Every key a hot key can use, in the order the Settings drop-down lists them
export const HOTKEY_KEYS: string[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
];

const KEY_CODE = /^(?:Key([A-Z])|Digit([0-9])|F([1-9]|1[0-2]))$/;

export const isHotkey = (s: string): boolean => s.startsWith(HOTKEY_PREFIX) && HOTKEY_KEYS.includes(s.slice(HOTKEY_PREFIX.length));

// The hot key a key press makes, or null when it is not Ctrl+Alt plus an allowed key
export function hotkeyFromEvent(e: KeyboardEvent): string | null {
  if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return null;
  const m = KEY_CODE.exec(e.code);
  if (!m) return null;
  return HOTKEY_PREFIX + (m[1] ?? m[2] ?? `F${m[3]}`);
}

// The keys of the drop-down: every key no other command uses (`ignoreId` is the command being edited)
export function availableKeys(groups: CommandGroup[], ignoreId?: string): string[] {
  const used = new Set(
    groups.flatMap((g) => g.items).filter((i) => i.id !== ignoreId && i.hotkey).map((i) => i.hotkey as string)
  );
  return HOTKEY_KEYS.filter((k) => !used.has(HOTKEY_PREFIX + k));
}

// Returns an error message when `hotkey` cannot be used for the command `ignoreId`, or '' when it is fine (or empty).
export function validateHotkey(hotkey: string, groups: CommandGroup[], ignoreId?: string): string {
  if (!hotkey) return '';
  const other = groups.flatMap((g) => g.items).find((i) => i.id !== ignoreId && i.hotkey === hotkey);
  return other ? `${hotkey} is already used by "${other.name}".` : '';
}
