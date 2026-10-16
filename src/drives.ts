// The PC's drives (drives.rs `get_drives`), for the Folder Tree's drive rows and the This PC view.

export interface DriveInfo {
  path: string; // "C:\"
  letter: string; // "C"
  label: string; // volume name ("OS"), "" when none
  kind: 'fixed' | 'removable' | 'network' | 'cd' | 'ram' | 'other';
  ready: boolean; // false: no disc, a network drive that is not connected ...
  total: number;
  free: number;
  used: number;
  file_system: string;
}

const DEFAULT_NAME: Record<string, string> = {
  removable: 'USB Drive',
  network: 'Network Drive',
  cd: 'DVD Drive',
};

/** "OS (C:)", or Explorer's name for a drive without a volume name: "Local Disk (D:)". */
export const driveName = (d: DriveInfo) => `${d.label || DEFAULT_NAME[d.kind] || 'Local Disk'} (${d.letter}:)`;

const GB = 1024 ** 3;

/** Short sizes as in "Used 211GB/463GB": whole GB (one decimal under 10 GB), MB under 1 GB, TB from 1 TB. */
export function shortSize(n: number): string {
  if (n >= 1024 * GB) return `${(n / (1024 * GB)).toFixed(1)}TB`;
  if (n >= 10 * GB) return `${Math.round(n / GB)}GB`;
  if (n >= GB) return `${(n / GB).toFixed(1)}GB`;
  return `${Math.round(n / 1024 ** 2)}MB`;
}

/** Share of the drive in use, 0..100. */
export const usedPercent = (d: DriveInfo) => (d.total > 0 ? Math.min(100, (d.used / d.total) * 100) : 0);

/** The tree's text after the drive's name. */
export const treeUsage = (d: DriveInfo) => (d.ready ? `Used ${shortSize(d.used)}/${shortSize(d.total)}` : 'not ready');

/** The This PC view's line under the meter. */
export const fullUsage = (d: DriveInfo) =>
  d.ready ? `Used ${shortSize(d.used)} / Free ${shortSize(d.free)} / Total ${shortSize(d.total)}` : 'Not ready';

/** Explorer turns the meter red when a drive is almost full (about 90%). */
export const almostFull = (d: DriveInfo) => d.ready && usedPercent(d) >= 90;
