export interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  size_formatted: string;
  modified: string;
  modified_timestamp: number;
  created: string;
  created_timestamp: number;
  ext: string;
  is_hidden: boolean;
  links?: number; // a .basket file: how many links it holds
  state?: 'gone' | 'new'; // inside a basket: nothing at the linked path / not linked yet (see basket.rs)
}

export interface QuickAccessItem {
  label: string;
  path: string;
  icon_type: string;
}

export interface FileListResult {
  current_path: string;
  parent_path: string | null;
  items: FileItem[];
  total_files: number;
  total_folders: number;
  total_size: number;
}

export type ViewMode = 'details' | 'tiles' | 'thumbnails';
export type SortOrder = 'asc' | 'desc';

// Properties read from the file by the backend (file_props.rs); empty / 0 = the file has none
export interface ItemDetails {
  path: string;
  dimensions: string;
  pixels: number;
  length: string;
  length_secs: number;
  album: string;
  artist: string;
  actor: string;
  genre: string;
  rating: number; // stars, 0 = not rated
}

// One command line tab. `cwd` is the folder its shell was last in (what the file panel shows when the tab is active).
export interface TermTab {
  id: string;
  name: string;
  cwd: string;
  level: 'admin' | 'normal'; // the login this tab's shell runs with
  color: string; // the tab header color (one of TAB_COLORS)
}
