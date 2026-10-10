// One color per drive letter, shared by the Quick Access row and the folder tree so a drive looks the same in both.
// The shades are CSS variables (`--drive-0` .. `--drive-7` in index.css): bright on the dark theme, deep on the light one.
const DRIVE_COLORS = 8;

// C: is the first color, D: the next and so on; A: / B: wrap around, a path without a letter is grey.
export const driveColor = (path: string): string => {
  const letter = /^([a-z]):/i.exec(path)?.[1].toUpperCase();
  if (!letter) return 'var(--text-muted)';
  const i = letter.charCodeAt(0) - 'C'.charCodeAt(0);
  return `var(--drive-${((i % DRIVE_COLORS) + DRIVE_COLORS) % DRIVE_COLORS})`;
};
