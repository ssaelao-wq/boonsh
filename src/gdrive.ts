import { invoke } from '@tauri-apps/api/core';

export interface GDriveConfig {
  client_id: string;
  has_client_secret: boolean;
  connected: boolean;
  account_email?: string;
  account_name?: string;
  quota_limit?: number;
  quota_usage?: number;
}

export async function getGDriveConfig(): Promise<GDriveConfig> {
  return await invoke<GDriveConfig>('gdrive_get_config');
}

export async function saveGDriveCredentials(clientId: string, clientSecret: string): Promise<void> {
  await invoke('gdrive_save_credentials', {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
  });
}

export async function disconnectGDrive(): Promise<void> {
  await invoke('gdrive_disconnect');
}

export async function startGDriveLogin(): Promise<GDriveConfig> {
  return await invoke<GDriveConfig>('gdrive_start_login');
}

export function formatStorageBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function isGDrivePath(path?: string | null): boolean {
  if (!path) return false;
  return path.startsWith('gdrive://') || path === 'gdrive:';
}

export function parseGDriveId(path: string): string {
  const stripped = path.startsWith('gdrive://')
    ? path.slice('gdrive://'.length)
    : path.startsWith('gdrive:')
    ? path.slice('gdrive:'.length)
    : path;
  const id = stripped.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
  return !id || id.toLowerCase() === 'root' ? 'root' : id;
}

export async function gdriveCreateFolder(parentDir: string, name: string): Promise<string> {
  return await invoke<string>('gdrive_create_folder', { parentDir, name });
}

export async function gdriveRename(path: string, newName: string): Promise<void> {
  await invoke('gdrive_rename', { path, newName });
}

export async function gdriveDelete(paths: string[]): Promise<void> {
  await invoke('gdrive_delete', { paths });
}

/** `tree_has_children` for Drive folders: one per path, so the tree's expand arrow means something. */
export async function gdriveHasChildren(paths: string[]): Promise<boolean[]> {
  return await invoke<boolean[]>('gdrive_has_children', { paths });
}

export async function gdriveOpenInBrowser(path: string): Promise<void> {
  await invoke('gdrive_open_in_browser', { path });
}

const folderNameCache = new Map<string, string>();

export function setCachedGDriveFolderName(path: string, name: string): void {
  const norm = path.replace(/\/+$/, '');
  folderNameCache.set(norm, name);
}

export function getCachedGDriveFolderName(path: string): string | undefined {
  const norm = path.replace(/\/+$/, '');
  return folderNameCache.get(norm);
}

export function cacheGDriveFolderNames(items: { path: string; name: string; is_dir?: boolean }[]): void {
  for (const item of items) {
    if (item.is_dir && isGDrivePath(item.path)) {
      setCachedGDriveFolderName(item.path, item.name);
    }
  }
}

export interface GDriveBreadcrumb {
  path: string;
  name: string;
}

/** The full chain of folder names from My Drive down to `path` ("Development > Unicon_Container > Phase2"). */
export async function gdriveGetBreadcrumbs(path: string): Promise<GDriveBreadcrumb[]> {
  const chain = await invoke<GDriveBreadcrumb[]>('gdrive_get_breadcrumbs', { path });
  for (const crumb of chain) setCachedGDriveFolderName(crumb.path, crumb.name);
  return chain;
}

export async function gdriveGetFolderName(path: string): Promise<string | null> {
  const norm = path.replace(/\/+$/, '');
  const id = parseGDriveId(norm);
  if (id === 'root') {
    return 'My Drive';
  }
  const cached = folderNameCache.get(norm);
  if (cached) return cached;

  try {
    const name = await invoke<string | null>('gdrive_get_folder_name', { path: norm });
    if (name) {
      folderNameCache.set(norm, name);
    }
    return name;
  } catch {
    return null;
  }
}

