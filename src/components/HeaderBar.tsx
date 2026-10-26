import React, { useState, useEffect, useRef } from 'react';
import {
  FolderUp,
  Search,
  LayoutList,
  LayoutGrid,
  Grid,
  Eye,
  RefreshCw,
  Sun,
  Moon,
  FolderTree,
  ChevronRight,
  Edit2,
  Monitor,
  Settings,
  Scissors,
  Copy,
  ClipboardPaste,
  Trash2,
  Terminal,
  Sparkles,
  ShoppingBasket,
  Columns2,
  Command,
  Cloud,
  Smartphone,
} from 'lucide-react';
import { ViewMode } from '../types';
import { isGDrivePath, getCachedGDriveFolderName, gdriveGetBreadcrumbs, GDriveBreadcrumb } from '../gdrive';
import { isLanPath } from '../lan';

// Cheat sheet for the search query language (parsed in src-tauri/src/search.rs)
export const SEARCH_EXAMPLES: [string, string][] = [
  ['report', 'Name contains "report" (wildcards: *.md, rep*t)'],
  ['"my file"', 'Quotes keep words with spaces together'],
  ['filename:^inv.*\\.pdf$', 'Name matches a regular expression'],
  ['filesize:0-1M', 'Size range (B, K, M, G, T; 1K = 1024)'],
  ['filesize:250K-1.2M', 'Decimals are fine'],
  ['filesize:1G+', 'At least 1 GB (also -10K, >1M, <100K, 0)'],
  ['type:folder size:>20G', 'Folders by total size of everything inside (scans the whole folder)'],
  ['filetype:exe', 'Extension; comma = OR: jpg,png'],
  ['filetype:image', 'Groups: image, video, audio, doc, archive, code, folder, file'],
  ['filedate:2026-07', 'Modified in a year, month or day: 2026, 2026-07-06'],
  ['filedate:-07-06', 'Any year: July 6 (-07- any July, --06 any 6th)'],
  ['filedate:2026-01..2026-03', 'Date range (either side can be left open)'],
  ['filedate:7d', 'Last 7 days (also today, yesterday)'],
  ['path:legal', 'Anywhere in the full path (folders too)'],
  ['path:client-xyz,client-abc', 'Comma = OR (spaces around it are fine)'],
  ['path:client-xyz +legal', 'Space + "+word" = AND (the + goes right in front of the word)'],
  ['path:a, b +c', 'AND before OR: a OR (b AND c). Parentheses group: path:client-xyz +(legal,contract)'],
  ["path:'legal'", "Quotes = exact text as whole folder/file names. Names with spaces need quotes: path:'my client'"],
  ["path:'my client'*", "A * outside the quotes is a wildcard (starts with). Also path:'client-xyz\\invoices'"],
  [String.raw`input:.\client, d:\work`, 'Where to search (default: the current folder). Comma = more folders or files'],
  [String.raw`input:.\abc +.\xyz name.txt`, 'AND by file name: only names found on both sides (lists all copies). Same order rules as path:'],
  ['input:{INPUT01}', 'Search in the files/folders of a Global Var (no value yet = ignored, current folder is used)'],
  ['!filetype:tmp', '! in front excludes matches'],
];

interface HeaderBarProps {
  currentPath: string;
  parentPath: string | null;
  searchQuery: string;
  searchOpen: boolean; // the search bar at the bottom of the file panel is shown
  onToggleSearch: () => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  showPreview: boolean;
  onTogglePreview: () => void;
  showFilePanel: boolean;
  onToggleFilePanel: () => void;
  showTerminal: boolean;
  onToggleTerminal: () => void;
  dualPane: boolean;
  onToggleDualPane: () => void;
  onOpenPalette: () => void;
  showAssistant: boolean;
  onToggleAssistant: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onNavigate: (path: string) => void;
  // an open basket: its name and the linked folders opened inside it, after the folder path (click = go there)
  basketTrail?: { label: string; title: string; onClick: () => void }[] | null;
  onUp?: () => void; // replaces "up to the parent folder" (in a basket: one level back, then out of it)
  thisPC?: boolean; // the This PC view is shown: the path bar says so
  onRefresh: () => void;
  showSettings: boolean;
  onOpenSettings: () => void;
  selectionCount: number;
  clipboard: { mode: 'copy' | 'cut'; paths: string[] } | null;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDelete: () => void;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({
  currentPath,
  parentPath,
  searchQuery,
  searchOpen,
  onToggleSearch,
  viewMode,
  onViewModeChange,
  showPreview,
  onTogglePreview,
  showFilePanel,
  onToggleFilePanel,
  showTerminal,
  onToggleTerminal,
  dualPane,
  onToggleDualPane,
  onOpenPalette,
  showAssistant,
  onToggleAssistant,
  theme,
  onToggleTheme,
  onNavigate,
  basketTrail,
  onUp,
  thisPC,
  onRefresh,
  showSettings,
  onOpenSettings,
  selectionCount,
  clipboard,
  onCut,
  onCopy,
  onPaste,
  onDelete,
}) => {
  const [isEditingPath, setIsEditingPath] = useState<boolean>(false);
  const [pathInput, setPathInput] = useState<string>(currentPath);
  const pathInputRef = useRef<HTMLInputElement>(null);
  // A long path scrolls: keep its end (the open folder, or the open basket) in view, as Explorer does
  const crumbsRef = useRef<HTMLDivElement>(null);
  const trailKey = (basketTrail ?? []).map((c) => c.title).join('|');
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [currentPath, trailKey]);

  useEffect(() => {
    setPathInput(currentPath);
  }, [currentPath]);

  // The full chain of ancestor folders down to currentPath, for "Google Drive > Development > ... > Phase2"
  // (Drive ids are not nested strings like a local path, so the chain has to be asked for, not just split).
  const [gdriveBreadcrumbs, setGdriveBreadcrumbs] = useState<GDriveBreadcrumb[]>([]);

  useEffect(() => {
    if (!isGDrivePath(currentPath) || currentPath === 'gdrive://root' || currentPath === 'gdrive:') {
      setGdriveBreadcrumbs([]);
      return;
    }
    // show something at once (just this folder's own name) while the full chain loads, instead of flashing
    // empty or a stale chain from the folder navigated away from
    const cached = getCachedGDriveFolderName(currentPath);
    setGdriveBreadcrumbs([{ path: currentPath, name: cached || 'Folder' }]);
    let cancelled = false;
    gdriveGetBreadcrumbs(currentPath)
      .then((chain) => {
        if (!cancelled && chain.length > 0) setGdriveBreadcrumbs(chain);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  const handleStartEditingPath = () => {
    setPathInput(currentPath);
    setIsEditingPath(true);
    setTimeout(() => pathInputRef.current?.select(), 50);
  };

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) {
      onNavigate(pathInput.trim());
    }
    setIsEditingPath(false);
  };

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setPathInput(currentPath);
      setIsEditingPath(false);
    }
  };

  // Build breadcrumb segments from currentPath (e.g. C:\somboon-data\Dev\boonsh)
  const segments = currentPath
    ? currentPath.split(/[/\\]/).filter(Boolean)
    : [];

  const getSegmentPath = (index: number) => {
    if (index === 0) return segments[0] + '\\';
    return segments.slice(0, index + 1).join('\\');
  };

  return (
    <div className="header-bar">
      <div className="header-actions">
        {/* Up directory button */}
        <button
          onClick={() => (onUp ? onUp() : parentPath ? onNavigate(parentPath) : currentPath.startsWith('gdrive://') ? onNavigate('') : undefined)}
          disabled={thisPC || (!onUp && !parentPath && !currentPath.startsWith('gdrive://'))}
          title={
            onUp && basketTrail
              ? 'Up: one level back in the basket, then out of it'
              : onUp
                ? 'Up: This PC (all drives)'
                : currentPath.startsWith('gdrive://') && !parentPath
                  ? 'Up: This PC'
                  : 'Go Up Directory'
          }
          style={{ opacity: !thisPC && (onUp || parentPath || currentPath.startsWith('gdrive://')) ? 1 : 0.4 }}
        >
          <FolderUp size={16} style={{ color: '#f59e0b' }} />
        </button>

        <button onClick={onRefresh} title="Refresh Directory (F5)">
          <RefreshCw size={14} style={{ color: '#10b981' }} />
        </button>

        <div className="header-divider" />

        {/* Clipboard actions on the file selection */}
        <button
          onClick={onCut}
          disabled={selectionCount === 0}
          title="Cut selected items (Ctrl+X)"
          style={{ opacity: selectionCount > 0 ? 1 : 0.4 }}
        >
          <Scissors size={14} style={{ color: '#ef4444' }} />
        </button>
        <button
          onClick={onCopy}
          disabled={selectionCount === 0}
          title="Copy selected items (Ctrl+C)"
          style={{ opacity: selectionCount > 0 ? 1 : 0.4 }}
        >
          <Copy size={14} style={{ color: '#3b82f6' }} />
        </button>
        <button
          onClick={onPaste}
          disabled={!clipboard}
          title={
            clipboard
              ? `Paste ${clipboard.paths.length} ${clipboard.mode === 'cut' ? 'cut' : 'copied'} item(s) here (Ctrl+V)`
              : 'Paste (Ctrl+V) - nothing to paste yet'
          }
          style={{ opacity: clipboard ? 1 : 0.4 }}
        >
          <ClipboardPaste size={14} style={{ color: '#8b5cf6' }} />
        </button>
        <button
          onClick={onDelete}
          disabled={selectionCount === 0}
          title="Delete selected items to Recycle Bin (Del)"
          style={{ opacity: selectionCount > 0 ? 1 : 0.4 }}
        >
          <Trash2 size={14} style={{ color: '#f43f5e' }} />
        </button>
      </div>

      {/* Editable / Clickable Breadcrumb Path Bar (Windows File Explorer Style) */}
      <div className="path-display-container">
        {isEditingPath ? (
          <form onSubmit={handlePathSubmit} style={{ width: '100%', display: 'flex' }}>
            <input
              ref={pathInputRef}
              type="text"
              className="path-edit-input"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onBlur={() => setIsEditingPath(false)}
              onKeyDown={handlePathKeyDown}
              autoFocus
            />
          </form>
        ) : (
          <div ref={crumbsRef} className="path-breadcrumbs" onClick={handleStartEditingPath} title="Click to edit path">
            {thisPC ? (
              <span className="breadcrumb-segment" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Monitor size={13} />
                This PC
              </span>
            ) : isLanPath(currentPath) ? (
              <span
                className="breadcrumb-segment"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                onClick={(e) => {
                  e.stopPropagation();
                  onNavigate('lan://mobile');
                }}
                title="Mobile Drop (lan://mobile)"
              >
                <Smartphone size={13} style={{ color: '#10b981' }} />
                Mobile Drop
              </span>
            ) : isGDrivePath(currentPath) ? (
              <>
                <span
                  className="breadcrumb-segment"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNavigate('gdrive://root');
                  }}
                  title="Google Drive (My Drive)"
                >
                  <Cloud size={13} style={{ color: '#38bdf8' }} />
                  Google Drive
                </span>
                {gdriveBreadcrumbs.map((crumb) => (
                  <React.Fragment key={crumb.path}>
                    <ChevronRight size={12} className="breadcrumb-separator" />
                    <span
                      className="breadcrumb-segment"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNavigate(crumb.path);
                      }}
                      title={crumb.path}
                    >
                      {crumb.name}
                    </span>
                  </React.Fragment>
                ))}
              </>
            ) : segments.length === 0 ? (
              <span className="breadcrumb-segment">C:\</span>
            ) : (
              segments.map((seg, idx) => (
                <React.Fragment key={idx}>
                  {idx > 0 && <ChevronRight size={12} className="breadcrumb-separator" />}
                  <span
                    className="breadcrumb-segment"
                    onClick={(e) => {
                      e.stopPropagation();
                      onNavigate(getSegmentPath(idx));
                    }}
                    title={getSegmentPath(idx)}
                  >
                    {idx === 0 ? seg + '\\' : seg}
                  </span>
                </React.Fragment>
              ))
            )}
            {basketTrail?.map((crumb, idx) => (
              <React.Fragment key={`b${idx}`}>
                <ChevronRight size={12} className="breadcrumb-separator" />
                {idx === 0 && <ShoppingBasket size={13} className="basket-icon" style={{ marginRight: 3, flexShrink: 0 }} />}
                <span
                  className="breadcrumb-segment"
                  onClick={(e) => {
                    e.stopPropagation();
                    crumb.onClick();
                  }}
                  title={idx === 0 ? `Basket: ${crumb.title}` : crumb.title}
                >
                  {crumb.label}
                </span>
              </React.Fragment>
            ))}
            <span title="Edit path" onClick={handleStartEditingPath} style={{ display: 'inline-flex', cursor: 'pointer' }}>
              <Edit2 size={12} className="path-edit-icon" />
            </span>
          </div>
        )}
      </div>

      {/* Toggle Search Bar: the bar itself is at the bottom of the file panel (SearchBar.tsx) */}
      <button
        className={searchOpen || searchQuery ? 'active' : ''}
        onClick={onToggleSearch}
        title="Toggle Search Bar"
      >
        <Search size={14} style={{ color: '#06b6d4' }} />
      </button>

      {/* Minimalist Action Icons */}
      <div className="header-actions">
        {/* View Mode Buttons */}
        <button
          className={viewMode === 'details' ? 'active' : ''}
          onClick={() => onViewModeChange('details')}
          title="Details View"
        >
          <LayoutList size={14} style={{ color: '#0ea5e9' }} />
        </button>
        <button
          className={viewMode === 'tiles' ? 'active' : ''}
          onClick={() => onViewModeChange('tiles')}
          title="Tiles View"
        >
          <LayoutGrid size={14} style={{ color: '#14b8a6' }} />
        </button>
        <button
          className={viewMode === 'thumbnails' ? 'active' : ''}
          onClick={() => onViewModeChange('thumbnails')}
          title="Thumbnail Grid View"
        >
          <Grid size={14} style={{ color: '#ec4899' }} />
        </button>

        <div className="header-divider" />

        {/* Toggle Middle File Panel */}
        <button
          className={showFilePanel ? 'active' : ''}
          onClick={onToggleFilePanel}
          title="Toggle Middle File Panel (Ctrl+Shift+F)"
        >
          <FolderTree size={14} style={{ color: '#84cc16' }} />
        </button>

        {/* Two panes: a second file list beside the first (F5 copies, F6 moves to the other one) */}
        <button
          className={dualPane ? 'active' : ''}
          onClick={onToggleDualPane}
          title={dualPane ? 'Back to one file pane' : 'Two file panes (F5 copies, F6 moves to the other pane, Tab switches)'}
        >
          <Columns2 size={14} style={{ color: '#f59e0b' }} />
        </button>

        {/* Mobile Drop: quick access to phone transfer & PDF export */}
        <button
          className={currentPath === 'lan://mobile' ? 'active' : ''}
          onClick={() => onNavigate('lan://mobile')}
          title="Mobile Drop: Transfer files & export Google Docs to PDF (lan://mobile)"
        >
          <Smartphone size={14} style={{ color: '#10b981' }} />
        </button>

        {/* Toggle Bottom Preview Drawer */}
        <button
          className={showPreview ? 'active' : ''}
          onClick={onTogglePreview}
          title="Toggle Preview Drawer (Ctrl+P)"
        >
          <Eye size={14} style={{ color: '#6366f1' }} />
        </button>

        {/* Show / hide the command line panel */}
        <button
          className={showTerminal ? 'active' : ''}
          onClick={onToggleTerminal}
          title={showTerminal ? 'Hide the command line panel' : 'Show the command line panel'}
        >
          <Terminal size={14} style={{ color: '#22c55e' }} />
        </button>

        {/* Command palette: every action, command, variable and folder in one list */}
        <button onClick={onOpenPalette} title="Command palette (Ctrl+Shift+P)">
          <Command size={14} style={{ color: '#f43f5e' }} />
        </button>

        {/* Settings (Command Manager) */}
        <button
          className={showSettings ? 'active' : ''}
          onClick={onOpenSettings}
          title="Settings: Manage Terminal Commands"
        >
          <Settings size={14} style={{ color: '#64748b' }} />
        </button>

        <div className="header-divider" />

        {/* Black / White Theme Toggle Button */}
        <button
          onClick={onToggleTheme}
          title={`Switch Theme (Current: ${theme === 'dark' ? 'Black Theme' : 'White Theme'})`}
        >
          {theme === 'dark' ? <Sun size={14} style={{ color: '#f59e0b' }} /> : <Moon size={14} style={{ color: '#818cf8' }} />}
        </button>

        {/* Show / hide the AI Assistant panel (under the command line) */}
        <button
          className={showAssistant ? 'active' : ''}
          onClick={onToggleAssistant}
          title={showAssistant ? 'Hide the AI Assistant' : 'Show the AI Assistant'}
        >
          <Sparkles size={14} style={{ color: '#a855f7' }} />
        </button>
      </div>
    </div>
  );
};
