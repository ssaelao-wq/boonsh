// What the Settings > About section shows. The full license texts of every library are in
// src-tauri/THIRD_PARTY_LICENSES.txt (written by scripts/gen-third-party.py and installed next to the app).

export const APP_NAME = 'boonsh';
export const COPYRIGHT = 'Copyright (c) 2026 Somboon L.';
export const REPO_URL = 'https://github.com/ssaelao-wq/boonsh';

/** The main open-source libraries inside boonsh, and the license each is used under. */
export const COMPONENTS: { name: string; license: string }[] = [
  { name: 'Tauri (app framework)', license: 'MIT or Apache-2.0' },
  { name: 'React', license: 'MIT' },
  { name: 'xterm.js (terminal)', license: 'MIT' },
  { name: 'Lucide icons', license: 'ISC' },
  { name: 'portable-pty (PowerShell terminal)', license: 'MIT' },
  { name: 'walkdir', license: 'MIT or Unlicense' },
  { name: 'trash (Recycle Bin)', license: 'MIT' },
  { name: 'zip', license: 'MIT' },
  { name: 'regex-lite', license: 'MIT or Apache-2.0' },
  { name: 'windows (Microsoft, Rust)', license: 'MIT or Apache-2.0' },
  { name: 'serde, dirs, base64', license: 'MIT or Apache-2.0' },
  { name: 'tokio', license: 'MIT' },
];
