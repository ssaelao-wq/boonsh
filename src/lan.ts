import { invoke } from '@tauri-apps/api/core';
import { isGDrivePath } from './gdrive';

export interface PairedDevice {
  id: string;
  name: string;
  token: string;
  created_at: number;
  permanent: boolean;
}

export interface LanStatus {
  running: boolean;
  port: number;
  lan_ip: string;
  hostname: string;
  qr_url: string;
  mdns_url: string;
  active_token: string;
  paired_devices: PairedDevice[];
  outgoing_count: number;
  incoming_count: number;
  incoming_dir: string;
  incoming_label: string;
  is_second_pane: boolean;
  gdrive_upload_dest?: string | null;
  gdrive_upload_dest_label?: string | null;
  is_client_connected: boolean;
  connected_client_name?: string;
}

export function isLanPath(path?: string | null): boolean {
  if (!path) return false;
  return path.startsWith('lan://') || path === 'lan:';
}

export async function getLanStatus(): Promise<LanStatus> {
  return await invoke<LanStatus>('lan_get_status');
}

export async function startLanServer(): Promise<LanStatus> {
  return await invoke<LanStatus>('lan_start_server');
}

export async function stopLanServer(): Promise<void> {
  await invoke('lan_stop_server');
}

export async function revokeLanDevice(deviceId: string): Promise<void> {
  await invoke('lan_revoke_device', { deviceId });
}

export async function clearLanStaging(): Promise<void> {
  await invoke('lan_clear_staging');
}

export async function shareFilesToLan(paths: string[]): Promise<[string, string][]> {
  // Sharing never removes the original (unlike a Cut pasted into Mobile Drop, which paste.rs drives directly).
  return await invoke<[string, string][]>('lan_share_files', { paths, isMove: false });
}

export async function openLanIncomingFolder(): Promise<void> {
  await invoke('lan_open_incoming_folder');
}

export async function setLanIncomingDir(path: string | null): Promise<LanStatus> {
  return await invoke<LanStatus>('lan_set_incoming_dir', { path });
}

/** Sets (or clears) the Google Drive folder phone uploads are forwarded into; always clears any local
 *  `setLanIncomingDir` destination too, since the two are alternatives, never both at once (lan_share.rs). */
export async function setLanGDriveUploadDest(dest: string | null): Promise<LanStatus> {
  return await invoke<LanStatus>('lan_set_gdrive_upload_dest', { dest });
}

export function resolveLanIncomingDestination(
  dual: boolean,
  currentPath?: string | null,
  otherPath?: string | null
): string | null {
  if (!dual) return null;
  // If one pane is Mobile Drop, the other pane is the destination
  if (isLanPath(currentPath)) {
    if (otherPath && !isLanPath(otherPath) && !isGDrivePath(otherPath)) return otherPath;
  } else if (isLanPath(otherPath)) {
    if (currentPath && !isLanPath(currentPath) && !isGDrivePath(currentPath)) return currentPath;
  } else if (otherPath && !isLanPath(otherPath) && !isGDrivePath(otherPath)) {
    // If dual panes are both regular folders, the second file panel (other pane) is the destination
    return otherPath;
  }
  return null;
}

/** The Google Drive counterpart of `resolveLanIncomingDestination`: when Mobile Drop is paired in dual-pane
 *  with a Drive folder on the other side, phone uploads forward straight into it instead of landing locally. */
export function resolveLanGDriveDestination(
  dual: boolean,
  currentPath?: string | null,
  otherPath?: string | null
): string | null {
  if (!dual) return null;
  if (isLanPath(currentPath) && otherPath && isGDrivePath(otherPath)) return otherPath;
  if (isLanPath(otherPath) && currentPath && isGDrivePath(currentPath)) return currentPath;
  return null;
}
