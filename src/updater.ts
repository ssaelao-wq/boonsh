// Updates (tauri-plugin-updater): boonsh asks GitHub for `latest.json` of the newest release (the endpoint is in
// tauri.conf.json, plugins.updater), checks the installer's signature against the public key there, downloads it
// and runs it (passive: a small progress window, no questions). The state and the notice are in
// hooks/useUpdater.ts and components/UpdateNotice.tsx; these are the saved settings and pure rules.

export const AUTO_KEY = 'boonsh_update_auto'; // '0' = no automatic check (default: on)
export const LAST_KEY = 'boonsh_update_checked'; // time of the last automatic check (ms)
export const SKIP_KEY = 'boonsh_update_skip'; // a version the user answered "Later" for: not shown again by itself
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const FIRST_CHECK_DELAY_MS = 8000; // after start, so the check never slows the window down

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private storage off: the setting just isn't remembered
  }
}

export const autoCheckOn = () => read(AUTO_KEY) !== '0';
export const setAutoCheck = (on: boolean) => write(AUTO_KEY, on ? '1' : '0');
export const lastCheck = () => Number(read(LAST_KEY)) || 0;
export const markChecked = (now = Date.now()) => write(LAST_KEY, String(now));
export const skippedVersion = () => read(SKIP_KEY) ?? '';
export const skipVersion = (version: string) => write(SKIP_KEY, version);

/** An automatic check is due: on, and the last one is a day old (or in the future: the clock was changed) */
export function shouldAutoCheck(now: number, last: number, on: boolean): boolean {
  if (!on) return false;
  return last <= 0 || last > now || now - last >= CHECK_EVERY_MS;
}

/** The automatic notice shows a found update unless the user said "Later" to that same version */
export function shouldNotify(version: string, skipped: string): boolean {
  return !!version && version !== skipped;
}

/** "45%" of a download, '' while the size is unknown */
export function downloadPercent(done: number, total: number | undefined): string {
  if (!total || total <= 0) return '';
  return `${Math.min(100, Math.floor((done / total) * 100))}%`;
}
