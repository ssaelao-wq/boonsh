// Two file panes (hooks/useDualPane.ts): saved settings and the pure checks for F5 / F6 / drops between them.

export type Side = 'left' | 'right';

/** `boonsh_dual_pane`: on/off, the other pane's folder, the left pane's share of the width */
export interface DualSettings {
  on: boolean;
  path: string;
  ratio: number;
}

export const DUAL_KEY = 'boonsh_dual_pane';
const DEFAULTS: DualSettings = { on: false, path: '', ratio: 0.5 };

export const clampRatio = (r: number) => Math.min(0.8, Math.max(0.2, r));

export function parseDual(raw: string | null): DualSettings {
  if (!raw) return { ...DEFAULTS };
  try {
    const v = JSON.parse(raw);
    return {
      on: v.on === true,
      path: typeof v.path === 'string' ? v.path : '',
      ratio: typeof v.ratio === 'number' && isFinite(v.ratio) ? clampRatio(v.ratio) : DEFAULTS.ratio,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function loadDual(): DualSettings {
  try {
    return parseDual(localStorage.getItem(DUAL_KEY));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveDual(s: DualSettings) {
  try {
    localStorage.setItem(DUAL_KEY, JSON.stringify(s));
  } catch {
    // storage blocked: the setting lasts until boonsh closes
  }
}

export const otherSide = (s: Side): Side => (s === 'left' ? 'right' : 'left');

const norm = (p: string) => p.toLowerCase().replace(/[\\/]+$/, '');

export const sameFolder = (a: string, b: string) => norm(a) === norm(b);

/** Why `paths` (in `from`) cannot be copied / moved into `dest`, or null when they can */
export function transferProblem(paths: string[], from: string, dest: string, move: boolean): string | null {
  const verb = move ? 'move' : 'copy';
  if (paths.length === 0) return `Select the items to ${verb} first.`;
  if (!dest) return 'The other pane shows no folder.';
  if (sameFolder(from, dest)) return `Both panes show the same folder: open another folder in the other pane to ${verb} there.`;
  const d = norm(dest) + '\\';
  const inside = paths.find((p) => d.startsWith(norm(p) + '\\'));
  if (inside) return `Cannot ${verb} the folder "${inside.split('\\').pop()}" into itself.`;
  return null;
}

/** The confirmation for F5 / F6: "Copy 3 items to D:\Backup?" */
export function transferQuestion(paths: string[], dest: string, move: boolean): string {
  const what = paths.length === 1 ? `"${paths[0].split('\\').pop()}"` : `${paths.length} items`;
  return `${move ? 'Move' : 'Copy'} ${what} to\n${dest}?`;
}
