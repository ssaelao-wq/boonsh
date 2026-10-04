import React, { useState, useEffect, useRef } from 'react';
import {
  FolderUp,
  Search,
  LayoutList,
  LayoutGrid,
  Grid,
  Eye,
  RefreshCw,
  X,
  Sun,
  Moon,
  FolderTree,
  ChevronRight,
  Edit2,
  Settings,
  Scissors,
  Copy,
  ClipboardPaste,
  Trash2,
  HelpCircle,
} from 'lucide-react';
import { ViewMode } from '../types';

// Cheat sheet for the search query language (parsed in src-tauri/src/search.rs)
const SEARCH_EXAMPLES: [string, string][] = [
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
  onSearchChange: (query: string) => void;
  searchError: string;
  searchNotice: string;
  searching: boolean;
  includeSubfolders: boolean;
  onToggleIncludeSubfolders: () => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  showPreview: boolean;
  onTogglePreview: () => void;
  showFilePanel: boolean;
  onToggleFilePanel: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onNavigate: (path: string) => void;
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
  onSearchChange,
  searchError,
  searchNotice,
  searching,
  includeSubfolders,
  onToggleIncludeSubfolders,
  viewMode,
  onViewModeChange,
  showPreview,
  onTogglePreview,
  showFilePanel,
  onToggleFilePanel,
  theme,
  onToggleTheme,
  onNavigate,
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
  const [showSearchInput, setShowSearchInput] = useState<boolean>(false);
  const [showSearchHelp, setShowSearchHelp] = useState<boolean>(false);
  const searchInputRef = useRef<HTMLTextAreaElement>(null);

  // Clicking a cheat-sheet example appends it to the query
  const insertSearchExample = (example: string) => {
    const q = searchQuery.trim();
    onSearchChange(q ? `${q} ${example}` : example);
    setShowSearchHelp(false);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };
  const [isEditingPath, setIsEditingPath] = useState<boolean>(false);
  const [pathInput, setPathInput] = useState<string>(currentPath);
  const pathInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPathInput(currentPath);
  }, [currentPath]);

  const handleToggleSearch = () => {
    if (showSearchInput && searchQuery) {
      onSearchChange('');
    }
    setShowSearchInput(!showSearchInput);
  };

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
          onClick={() => parentPath && onNavigate(parentPath)}
          disabled={!parentPath}
          title="Go Up Directory"
          style={{ opacity: parentPath ? 1 : 0.4 }}
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
          <div className="path-breadcrumbs" onClick={handleStartEditingPath} title="Click to edit path">
            {segments.length === 0 ? (
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
            <span title="Edit path" onClick={handleStartEditingPath} style={{ display: 'inline-flex', cursor: 'pointer' }}>
              <Edit2 size={12} className="path-edit-icon" />
            </span>
          </div>
        )}
      </div>

      {/* Toggleable Search Bar */}
      {showSearchInput ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, position: 'relative' }}>
          <div className="search-box">
            <textarea
              ref={searchInputRef}
              rows={2}
              spellCheck={false}
              className={`search-floating${searchError ? ' search-input-error' : ''}`}
              placeholder="Search name, filetype:exe, path:legal, input:.\folder ..."
              value={searchQuery}
              // one logical line: it only wraps on screen, so Enter adds nothing and pasted line breaks become spaces
              onChange={(e) => onSearchChange(e.target.value.replace(/[\r\n]+/g, ' '))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
              title={searchError || 'Type a name or filters. Click ? for all options.'}
              autoFocus
            />
            <Search size={14} style={{ position: 'absolute', left: 8, top: 7, zIndex: 1003, color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <button
              onClick={handleToggleSearch}
              style={{ position: 'absolute', right: 4, top: 3, zIndex: 1003, padding: 2, border: 'none' }}
              title="Close Search"
            >
              <X size={12} />
            </button>
            {searchError ? (
              <div className="search-error-bubble">{searchError}</div>
            ) : searchNotice ? (
              <div className="search-notice-bubble">{searchNotice}</div>
            ) : (
              searching && <div className="search-status-bubble">Searching...</div>
            )}
          </div>

          <button
            className={showSearchHelp ? 'active' : ''}
            onClick={() => setShowSearchHelp((v) => !v)}
            title="Search options & examples"
          >
            <HelpCircle size={14} />
          </button>
          {showSearchHelp && (
            <>
              <div className="context-menu-overlay" onClick={() => setShowSearchHelp(false)} />
              <div className="search-help">
                <div className="search-help-title">Search options (click one to add it)</div>
                {SEARCH_EXAMPLES.map(([example, desc]) => (
                  <div key={example} className="search-help-row" onClick={() => insertSearchExample(example)}>
                    <code>{example}</code>
                    <span>{desc}</span>
                  </div>
                ))}
                <div className="search-help-footer">
                  Separate terms with spaces; all of them must match. Dates are the modified date in local
                  time. Short forms: name:, size:, type:, ext:, date: (path: has none). Lists like jpg,png may have spaces around the comma. Without input: the search runs in the current folder. The Subfolders button searches up to 8
                  levels deep, showing at most 300 results.
                </div>
              </div>
            </>
          )}

          <button
            className={includeSubfolders ? 'active' : ''}
            onClick={onToggleIncludeSubfolders}
            title={includeSubfolders ? "Subfolders: ON (Click to search current folder only)" : "Subfolders: OFF (Click to search subfolders)"}
            style={{ padding: '3px 6px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}
          >
            <FolderTree size={12} />
            <span style={{ fontSize: 10 }}>Subfolders</span>
          </button>
        </div>
      ) : (
        <button
          className={searchQuery ? 'active' : ''}
          onClick={handleToggleSearch}
          title="Toggle Search Bar"
        >
          <Search size={14} style={{ color: '#06b6d4' }} />
        </button>
      )}

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

        {/* Toggle Bottom Preview Drawer */}
        <button
          className={showPreview ? 'active' : ''}
          onClick={onTogglePreview}
          title="Toggle Preview Drawer (Ctrl+P)"
        >
          <Eye size={14} style={{ color: '#6366f1' }} />
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
      </div>
    </div>
  );
};
