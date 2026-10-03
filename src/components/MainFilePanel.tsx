import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import {
  Folder,
  FileCode,
  FileImage,
  FileText,
  File as FileIcon,
  ArrowUp,
  ArrowDown,
  BookmarkPlus,
  ChevronRight,
  FolderPlus,
  FilePlus,
  Link,
  Edit3,
  Trash2,
  RefreshCw,
  ExternalLink,
  Plus,
  Scissors,
  Copy,
  ClipboardPaste,
  FileArchive,
  PackageOpen,
  Terminal,
  Check,
} from 'lucide-react';
import { FileItem, ViewMode, SortOrder, ItemDetails } from '../types';
import {
  COLUMNS,
  ColumnId,
  ColumnPrefs,
  DateColumn,
  DateMode,
  SortLevel,
  cellText,
  detailKey,
  isDateColumn,
  visibleColumns,
} from '../columns';
import { useMenuPosition } from '../useMenuPosition';
import { PathVars, PathVarName, summarizeValue } from '../pathVars';
import { GlobalVarDef } from '../globalVars';

interface MainFilePanelProps {
  items: FileItem[];
  selectedPaths: Set<string>;
  onItemClick: (item: FileItem, mods: { ctrlKey: boolean; shiftKey: boolean }) => void;
  onItemContextSelect: (item: FileItem) => void;
  cutPaths: string[];
  selectionCount: number;
  canPaste: boolean;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDeleteSelection: () => void;
  onClearSelection: () => void;
  onBulkRename: () => void;
  renameTrigger: number;
  zipSelectionCount: number;
  isBusy: boolean;
  onCompress: () => void;
  onExtract: () => void;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (file: FileItem) => void;
  viewMode: ViewMode;
  colPrefs: ColumnPrefs;
  sortLevels: SortLevel[];
  details: Record<string, ItemDetails>;
  appByExt: Record<string, string>;
  onSortClick: (column: ColumnId, additive: boolean) => void;
  onSortSet: (column: ColumnId, order: SortOrder, mode: 'only' | 'then') => void;
  onSortRemove: (column: ColumnId) => void;
  onDateMode: (column: DateColumn, kind: 'dateSort' | 'dateShow', mode: DateMode) => void;
  onHideColumn: (column: ColumnId) => void;
  onOpenColumnSettings: () => void;
  onAddQuickAccess?: (item: { label: string; path: string; icon_type?: string }) => void;
  currentPath?: string;
  onRefresh?: () => void;
  globalVars: GlobalVarDef[];
  pathVars: PathVars;
  onAssignPathVar: (name: PathVarName, paths: string[]) => void;
}

const ImageThumbnail: React.FC<{
  path: string;
  name: string;
  fallbackIcon: React.ReactNode;
}> = ({ path, name, fallbackIcon }) => {
  const [imgSrc, setImgSrc] = useState<string>(() => {
    try {
      return convertFileSrc(path);
    } catch {
      return '';
    }
  });
  const [loadState, setLoadState] = useState<'initial' | 'fallback' | 'failed'>('initial');

  useEffect(() => {
    try {
      setImgSrc(convertFileSrc(path));
      setLoadState('initial');
    } catch {
      setImgSrc('');
      setLoadState('initial');
    }
  }, [path]);

  const handleError = () => {
    if (loadState === 'initial') {
      setLoadState('fallback');
      invoke<string>('read_image_base64', { path })
        .then((b64) => setImgSrc(b64))
        .catch(() => setLoadState('failed'));
    } else {
      setLoadState('failed');
    }
  };

  if (loadState === 'failed' || !imgSrc) {
    return <div className="grid-thumb-fallback">{fallbackIcon}</div>;
  }

  return (
    <img
      src={imgSrc}
      alt={name}
      className="grid-thumb-img"
      loading="lazy"
      onError={handleError}
    />
  );
};

export const MainFilePanel: React.FC<MainFilePanelProps> = ({
  items,
  selectedPaths,
  onItemClick,
  onItemContextSelect,
  cutPaths,
  selectionCount,
  canPaste,
  onCut,
  onCopy,
  onPaste,
  onDeleteSelection,
  onClearSelection,
  onBulkRename,
  renameTrigger,
  zipSelectionCount,
  isBusy,
  onCompress,
  onExtract,
  onOpenDirectory,
  onOpenFile,
  viewMode,
  colPrefs,
  sortLevels,
  details,
  appByExt,
  onSortClick,
  onSortSet,
  onSortRemove,
  onDateMode,
  onHideColumn,
  onOpenColumnSettings,
  onAddQuickAccess,
  currentPath = '',
  onRefresh,
  globalVars,
  pathVars,
  onAssignPathVar,
}) => {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: FileItem | null;
  } | null>(null);

  const menuPos = useMenuPosition(contextMenu);

  const [showNewSubmenu, setShowNewSubmenu] = useState<boolean>(false);
  const [showVarSubmenu, setShowVarSubmenu] = useState<boolean>(false);
  useEffect(() => setShowVarSubmenu(false), [contextMenu]);
  // The submenu opens level with its row; near the bottom of the window, slide it up so it stays visible
  const varSubmenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = varSubmenuRef.current;
    if (!showVarSubmenu || !el) return;
    el.style.top = '-4px';
    const over = el.getBoundingClientRect().bottom - (window.innerHeight - 4);
    if (over > 0) el.style.top = `${-4 - over}px`;
  }, [showVarSubmenu, globalVars.length]);
  const [showRenameModal, setShowRenameModal] = useState<{ item: FileItem; newName: string } | null>(null);
  const [showShortcutModal, setShowShortcutModal] = useState<{ name: string; targetPath: string } | null>(null);

  // Column width state for resizable table columns
  const [colWidths, setColWidths] = useState<Record<ColumnId, number>>(
    () => Object.fromEntries(COLUMNS.map((c) => [c.id, c.width])) as Record<ColumnId, number>
  );

  const [resizing, setResizing] = useState<{
    col: ColumnId;
    startX: number;
    startWidth: number;
  } | null>(null);

  const handleResizeStart = (e: React.MouseEvent, col: ColumnId) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing({
      col,
      startX: e.clientX,
      startWidth: colWidths[col],
    });
  };

  React.useEffect(() => {
    if (!resizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - resizing.startX;
      const newWidth = Math.max(60, resizing.startWidth + deltaX);
      setColWidths((prev) => ({
        ...prev,
        [resizing.col]: newWidth,
      }));
    };

    const handleMouseUp = () => {
      setResizing(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizing]);

  const getFileIcon = (item: FileItem, size = 16) => {
    if (item.is_dir) return <Folder size={size} style={{ color: 'var(--text-main)' }} />;
    const ext = item.ext.toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico'].includes(ext)) {
      return <FileImage size={size} style={{ color: 'var(--text-muted)' }} />;
    }
    if (['rs', 'js', 'ts', 'tsx', 'py', 'ps1', 'json', 'toml', 'yaml', 'html', 'css'].includes(ext)) {
      return <FileCode size={size} style={{ color: 'var(--text-muted)' }} />;
    }
    if (['md', 'txt', 'log', 'doc', 'pdf'].includes(ext)) {
      return <FileText size={size} style={{ color: 'var(--text-muted)' }} />;
    }
    return <FileIcon size={size} style={{ color: 'var(--text-dim)' }} />;
  };

  const cutSet = new Set(cutPaths);

  // Shift+Click would otherwise highlight page text between the two clicks
  const preventShiftTextSelect = (e: React.MouseEvent) => {
    if (e.shiftKey) e.preventDefault();
  };

  // Clicking empty space (not an item) clears the selection, like Explorer
  const handleBackgroundClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClearSelection();
  };

  // Dragging a selected item drags every selected item (paths are space-separated for the terminal)
  const handleDragStart = (e: React.DragEvent, item: FileItem) => {
    const paths = selectedPaths.has(item.path)
      ? items.filter((i) => selectedPaths.has(i.path)).map((i) => i.path)
      : [item.path];
    e.dataTransfer.setData('text/plain', paths.map((p) => `"${p}"`).join(' '));
  };

  // Helper for generating unique filenames
  const getUniqueName = (baseName: string, ext: string = '') => {
    let name = ext ? `${baseName}.${ext}` : baseName;
    let count = 1;
    const existingNames = items.map((i) => i.name.toLowerCase());
    while (existingNames.includes(name.toLowerCase())) {
      count++;
      name = ext ? `${baseName} (${count}).${ext}` : `${baseName} (${count})`;
    }
    return name;
  };

  // Unified Context Menu Trigger for Files and Folders (Selected or Unselected)
  const handleItemContextMenu = (e: React.MouseEvent, item: FileItem) => {
    e.preventDefault();
    e.stopPropagation();
    onItemContextSelect(item); // Selects the item unless it's already part of the selection
    setShowNewSubmenu(false);
    const posX = e.clientX; // kept on-screen by useMenuPosition
    const posY = e.clientY;
    setContextMenu({
      x: posX,
      y: posY,
      item,
    });
  };

  // Context Menu Trigger for Background Empty Space
  const handleBackgroundContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowNewSubmenu(false);
    const posX = e.clientX; // kept on-screen by useMenuPosition
    const posY = e.clientY;
    setContextMenu({
      x: posX,
      y: posY,
      item: null,
    });
  };

  // Actions
  const handleOpenItem = (item: FileItem) => {
    setContextMenu(null);
    if (item.is_dir) {
      onOpenDirectory(item.path);
    } else {
      onOpenFile(item);
    }
  };

  const handleCreateFolder = () => {
    setContextMenu(null);
    setShowNewSubmenu(false);
    if (!currentPath) return;
    const folderName = getUniqueName('New folder');
    invoke<string>('create_new_folder', { parentDir: currentPath, name: folderName })
      .then(() => {
        onRefresh?.();
      })
      .catch((err) => alert(err));
  };

  const handleCreateTextFile = () => {
    setContextMenu(null);
    setShowNewSubmenu(false);
    if (!currentPath) return;
    const fileName = getUniqueName('New Text Document', 'txt');
    invoke<string>('create_new_file', { parentDir: currentPath, name: fileName })
      .then(() => {
        onRefresh?.();
      })
      .catch((err) => alert(err));
  };

  const handleOpenShortcutModal = () => {
    const defaultTarget = contextMenu?.item ? contextMenu.item.path : currentPath;
    const defaultName = contextMenu?.item
      ? `${contextMenu.item.name} - Shortcut.lnk`
      : 'New Shortcut.lnk';
    setContextMenu(null);
    setShowNewSubmenu(false);
    setShowShortcutModal({
      name: defaultName,
      targetPath: defaultTarget,
    });
  };

  const handleCreateShortcutSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!showShortcutModal || !currentPath) return;
    invoke<string>('create_shortcut', {
      parentDir: currentPath,
      name: showShortcutModal.name,
      targetPath: showShortcutModal.targetPath,
    })
      .then(() => {
        setShowShortcutModal(null);
        onRefresh?.();
      })
      .catch((err) => alert(err));
  };

  const handleAddQA = () => {
    if (onAddQuickAccess) {
      if (contextMenu?.item && contextMenu.item.is_dir) {
        onAddQuickAccess({
          label: contextMenu.item.name,
          path: contextMenu.item.path,
          icon_type: 'folder',
        });
      } else if (currentPath) {
        const parts = currentPath.split(/[\\/]/).filter(Boolean);
        const label = parts.length > 0 ? parts[parts.length - 1] : currentPath;
        onAddQuickAccess({
          label,
          path: currentPath,
          icon_type: 'folder',
        });
      }
    }
    setContextMenu(null);
  };

  const handleOpenRenameModal = (item: FileItem) => {
    setContextMenu(null);
    setShowRenameModal({
      item,
      // The real file name: in search results `item.name` is a display path like "./sub/file.txt"
      newName: item.path.split(/[\\/]/).filter(Boolean).pop() ?? item.name,
    });
  };

  // F2 with exactly one item selected (App bumps renameTrigger) opens the same box as right-click, Rename
  useEffect(() => {
    if (renameTrigger === 0) return;
    const selected = items.filter((i) => selectedPaths.has(i.path));
    if (selected.length === 1) handleOpenRenameModal(selected[0]);
  }, [renameTrigger]);

  const handleRenameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!showRenameModal) return;
    invoke<string>('rename_item', {
      oldPath: showRenameModal.item.path,
      newName: showRenameModal.newName,
    })
      .then(() => {
        setShowRenameModal(null);
        onRefresh?.();
      })
      .catch((err) => alert(err));
  };

  // Context-menu actions close the menu, then run the App-level selection action
  const runMenuAction = (action: () => void) => () => {
    setContextMenu(null);
    setShowNewSubmenu(false);
    action();
  };

  // Arrow for the direction; with more than one sort level, the level number (1 = main sort) beside it
  const renderSortIndicator = (col: ColumnId) => {
    const i = sortLevels.findIndex((l) => l.column === col);
    if (i < 0) return null;
    const Arrow = sortLevels[i].order === 'asc' ? ArrowUp : ArrowDown;
    return (
      <span className="sort-ind">
        <Arrow size={12} />
        {sortLevels.length > 1 && <span className="sort-rank">{i + 1}</span>}
      </span>
    );
  };

  // Right-click on a column header: sort choices, date comparison, hide / choose columns
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number; col: ColumnId } | null>(null);
  const headerPos = useMenuPosition(headerMenu);
  const columns = visibleColumns(colPrefs);
  const SORT_TIP =
    'Click: sort by this column (click again to reverse)\nShift+Click: add as the next sort level (1, 2, 3 ...)\nRight-click: more sort options';
  const runHeader = (action: () => void) => () => {
    setHeaderMenu(null);
    action();
  };

  return (
    <div
      className="main-file-panel"
      onContextMenu={handleBackgroundContextMenu}
    >
      {viewMode === 'thumbnails' ? (
        <div className="file-grid" onClick={handleBackgroundClick}>
          {items.map((item) => {
            const isSelected = selectedPaths.has(item.path);
            const isImage =
              !item.is_dir &&
              ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico'].includes(
                item.ext.toLowerCase()
              );
            return (
              <div
                key={item.path}
                className={`grid-card ${isSelected ? 'selected' : ''} ${cutSet.has(item.path) ? 'cut' : ''}`}
                onClick={(e) => onItemClick(item, e)}
                onMouseDown={preventShiftTextSelect}
                onDoubleClick={() =>
                  item.is_dir ? onOpenDirectory(item.path) : onOpenFile(item)
                }
                onContextMenu={(e) => handleItemContextMenu(e, item)}
                draggable
                onDragStart={(e) => handleDragStart(e, item)}
                title={item.name}
              >
                <div className="grid-card-thumb">
                  {isImage ? (
                    <ImageThumbnail
                      path={item.path}
                      name={item.name}
                      fallbackIcon={getFileIcon(item, 36)}
                    />
                  ) : (
                    getFileIcon(item, 36)
                  )}
                </div>
                <div className="grid-card-name">{item.name}</div>
              </div>
            );
          })}
        </div>
      ) : viewMode === 'tiles' ? (
        <div className="file-tiles-grid" onClick={handleBackgroundClick}>
          {items.map((item) => {
            const isSelected = selectedPaths.has(item.path);
            const fileTypeStr = item.is_dir
              ? 'File Folder'
              : item.ext
              ? `${item.ext.toUpperCase()} File`
              : 'File';
            return (
              <div
                key={item.path}
                className={`tile-card ${isSelected ? 'selected' : ''} ${cutSet.has(item.path) ? 'cut' : ''}`}
                onClick={(e) => onItemClick(item, e)}
                onMouseDown={preventShiftTextSelect}
                onDoubleClick={() =>
                  item.is_dir ? onOpenDirectory(item.path) : onOpenFile(item)
                }
                onContextMenu={(e) => handleItemContextMenu(e, item)}
                draggable
                onDragStart={(e) => handleDragStart(e, item)}
              >
                <div className="tile-icon">{getFileIcon(item, 28)}</div>
                <div className="tile-info">
                  <div className="tile-name" title={item.name}>
                    {item.name}
                  </div>
                  <div className="tile-detail">
                    <span className="tile-type">{fileTypeStr}</span>
                    <span className="tile-sep">•</span>
                    <span className="tile-size">
                      {item.is_dir ? '—' : item.size_formatted}
                    </span>
                  </div>
                  <div className="tile-date">{item.modified}</div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="file-table-wrapper" onClick={handleBackgroundClick}>
          <table className="file-table">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th
                    key={col.id}
                    style={{ width: colWidths[col.id], textAlign: col.right ? 'right' : 'left', position: 'relative' }}
                    onClick={(e) => onSortClick(col.id, e.shiftKey || e.ctrlKey)}
                    onMouseDown={(e) => {
                      if (e.shiftKey) e.preventDefault(); // no text selection while adding a sort level
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setContextMenu(null);
                      setHeaderMenu({ x: e.clientX, y: e.clientY, col: col.id });
                    }}
                    title={SORT_TIP}
                  >
                    {col.label} {renderSortIndicator(col.id)}
                    <div
                      className="column-resizer"
                      onMouseDown={(e) => handleResizeStart(e, col.id)}
                      onClick={(e) => e.stopPropagation()}
                      title={`Drag to resize ${col.label} column`}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const isSelected = selectedPaths.has(item.path);
                return (
                  <tr
                    key={item.path}
                    className={`file-row ${isSelected ? 'selected' : ''} ${cutSet.has(item.path) ? 'cut' : ''}`}
                    onClick={(e) => onItemClick(item, e)}
                onMouseDown={preventShiftTextSelect}
                    onDoubleClick={() =>
                      item.is_dir ? onOpenDirectory(item.path) : onOpenFile(item)
                    }
                    onContextMenu={(e) => handleItemContextMenu(e, item)}
                    draggable
                    onDragStart={(e) => handleDragStart(e, item)}
                  >
                    {columns.map((col) =>
                      col.id === 'name' ? (
                        <td key="name">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {getFileIcon(item)}
                            <span style={{ fontWeight: 400, color: 'var(--text-main)' }}>{item.name}</span>
                          </div>
                        </td>
                      ) : (
                        <td
                          key={col.id}
                          style={{ textAlign: col.right ? 'right' : 'left', color: 'var(--text-muted)', fontSize: 11 }}
                          title={col.id === 'location' ? cellText(col.id, item, colPrefs) : undefined}
                        >
                          {cellText(col.id, item, colPrefs, details[detailKey(item)], appByExt)}
                        </td>
                      )
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Column header right-click menu */}
      {headerMenu && (() => {
        const col = headerMenu.col;
        const lvl = sortLevels.findIndex((l) => l.column === col);
        const cur = lvl >= 0 ? sortLevels[lvl] : null;
        const only = sortLevels.length === 1 && cur !== null;
        const mark = (on: boolean) => (
          <span style={{ width: 13, display: 'inline-flex' }}>{on ? <Check size={13} /> : null}</span>
        );
        const dateCol = isDateColumn(col) ? col : null;
        const cmp = dateCol ? colPrefs.dateSort[dateCol] : 'datetime';
        const label = COLUMNS.find((c) => c.id === col)?.label ?? '';
        return (
          <>
            <div
              className="context-menu-overlay"
              onClick={() => setHeaderMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setHeaderMenu(null);
              }}
            />
            <div className="context-menu" ref={headerPos.ref} style={headerPos.style}>
              <div className="context-menu-item" onClick={runHeader(() => onSortSet(col, 'asc', 'only'))}>
                {mark(only && cur!.order === 'asc')}
                <span>Sort {label} ascending</span>
              </div>
              <div className="context-menu-item" onClick={runHeader(() => onSortSet(col, 'desc', 'only'))}>
                {mark(only && cur!.order === 'desc')}
                <span>Sort {label} descending</span>
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={runHeader(() => onSortSet(col, 'asc', 'then'))}>
                {mark(!!cur && sortLevels.length > 1 && cur.order === 'asc')}
                <span>{cur ? `Level ${lvl + 1}: ascending` : `Then sort by ${label}: ascending (level ${sortLevels.length + 1})`}</span>
              </div>
              <div className="context-menu-item" onClick={runHeader(() => onSortSet(col, 'desc', 'then'))}>
                {mark(!!cur && sortLevels.length > 1 && cur.order === 'desc')}
                <span>{cur ? `Level ${lvl + 1}: descending` : `Then sort by ${label}: descending (level ${sortLevels.length + 1})`}</span>
              </div>
              {cur && sortLevels.length > 1 && (
                <div className="context-menu-item" onClick={runHeader(() => onSortRemove(col))}>
                  {mark(false)}
                  <span>Remove {label} from the sort</span>
                </div>
              )}
              {dateCol && (
                <>
                  <div className="context-menu-divider" />
                  <div className="context-menu-item" onClick={runHeader(() => onDateMode(dateCol, 'dateSort', 'datetime'))}>
                    {mark(cmp === 'datetime')}
                    <span>Sort by date and time</span>
                  </div>
                  <div
                    className="context-menu-item"
                    onClick={runHeader(() => onDateMode(dateCol, 'dateSort', 'date'))}
                    title="Files from the same day count as equal, so the next sort level decides their order"
                  >
                    {mark(cmp === 'date')}
                    <span>Sort by date only (ignore the time)</span>
                  </div>
                </>
              )}
              <div className="context-menu-divider" />
              {col !== 'name' && (
                <div className="context-menu-item" onClick={runHeader(() => onHideColumn(col))}>
                  {mark(false)}
                  <span>Hide this column</span>
                </div>
              )}
              <div className="context-menu-item" onClick={runHeader(onOpenColumnSettings)}>
                {mark(false)}
                <span>Choose columns...</span>
              </div>
            </div>
          </>
        );
      })()}

      {/* Unified Custom Right-Click Context Menu Popup */}
      {contextMenu && (
        <>
          <div
            className="context-menu-overlay"
            onClick={() => {
              setContextMenu(null);
              setShowNewSubmenu(false);
            }}
          />
          <div className="context-menu" ref={menuPos.ref} style={menuPos.style}>
            {contextMenu.item && (
              <div
                className="context-menu-item"
                onClick={() => handleOpenItem(contextMenu.item!)}
              >
                <ExternalLink size={13} style={{ color: 'var(--text-muted)' }} />
                <span>Open</span>
              </div>
            )}

            {/* New Submenu Trigger */}
            <div
              className="context-menu-item"
              onMouseEnter={() => {
                setShowNewSubmenu(true);
                setShowVarSubmenu(false);
              }}
              onClick={() => setShowNewSubmenu(!showNewSubmenu)}
              style={{ justifyContent: 'space-between' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Plus size={13} style={{ color: 'var(--text-muted)' }} />
                <span>New</span>
              </div>
              <ChevronRight size={13} style={{ color: 'var(--text-dim)' }} />

              {/* New Submenu Popup */}
              {showNewSubmenu && (
                <div
                  className={menuPos.submenuClass}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="context-menu-item" onClick={handleCreateFolder}>
                    <FolderPlus size={13} style={{ color: 'var(--text-muted)' }} />
                    <span>Folder</span>
                  </div>
                  <div className="context-menu-item" onClick={handleCreateTextFile}>
                    <FilePlus size={13} style={{ color: 'var(--text-muted)' }} />
                    <span>Text Document</span>
                  </div>
                  <div className="context-menu-item" onClick={handleOpenShortcutModal}>
                    <Link size={13} style={{ color: 'var(--text-muted)' }} />
                    <span>Shortcut</span>
                  </div>
                </div>
              )}
            </div>

            <div className="context-menu-divider" />

            <div className="context-menu-item" onClick={handleAddQA}>
              <BookmarkPlus size={13} style={{ color: 'var(--text-muted)' }} />
              <span>
                {contextMenu.item && contextMenu.item.is_dir
                  ? 'Add to Quick Access'
                  : 'Add Current Folder to Quick Access'}
              </span>
            </div>

            <div className="context-menu-divider" />

            {contextMenu.item && (
              <>
                <div className="context-menu-item" onClick={runMenuAction(onCut)}>
                  <Scissors size={13} style={{ color: 'var(--text-muted)' }} />
                  <span>Cut{selectionCount > 1 ? ` (${selectionCount} items)` : ''}</span>
                  <span className="context-menu-shortcut">Ctrl+X</span>
                </div>
                <div className="context-menu-item" onClick={runMenuAction(onCopy)}>
                  <Copy size={13} style={{ color: 'var(--text-muted)' }} />
                  <span>Copy{selectionCount > 1 ? ` (${selectionCount} items)` : ''}</span>
                  <span className="context-menu-shortcut">Ctrl+C</span>
                </div>
              </>
            )}
            <div
              className={`context-menu-item ${canPaste ? '' : 'disabled'}`}
              onClick={canPaste ? runMenuAction(onPaste) : undefined}
            >
              <ClipboardPaste size={13} style={{ color: 'var(--text-muted)' }} />
              <span>Paste</span>
              <span className="context-menu-shortcut">Ctrl+V</span>
            </div>

            {globalVars.length > 0 && (
              <>
                <div className="context-menu-divider" />
                <div
                  className="context-menu-item"
                  onMouseEnter={() => {
                    setShowVarSubmenu(true);
                    setShowNewSubmenu(false);
                  }}
                  onClick={() => setShowVarSubmenu(!showVarSubmenu)}
                  style={{ justifyContent: 'space-between' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Terminal size={13} style={{ color: 'var(--text-muted)' }} />
                    <span>Assign to Global Var</span>
                  </div>
                  <ChevronRight size={13} style={{ color: 'var(--text-dim)' }} />

                  {showVarSubmenu && (
                    <div ref={varSubmenuRef} className={menuPos.submenuClass} onClick={(e) => e.stopPropagation()}>
                      {globalVars.map((v) => {
                        const value = summarizeValue(pathVars[v.name] ?? [], currentPath);
                        // On an item: a "selection" variable takes everything selected, an "item" variable only
                        // the clicked one. On empty space both take the current folder.
                        const target = contextMenu.item
                          ? v.takes === 'selection'
                            ? items.filter((i) => selectedPaths.has(i.path)).map((i) => i.path)
                            : [contextMenu.item.path]
                          : currentPath
                            ? [currentPath]
                            : [];
                        return (
                          <div
                            key={v.id}
                            className={`context-menu-item ${target.length ? '' : 'disabled'}`}
                            title={(pathVars[v.name] ?? []).join('\n') || v.description}
                            onClick={target.length ? runMenuAction(() => onAssignPathVar(v.name, target)) : undefined}
                          >
                            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {`{${v.name}}`}
                              {value ? `=${value}` : ''}
                              {!contextMenu.item ? ' (this folder)' : ''}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}

            {contextMenu.item && (
              <>
                <div className="context-menu-divider" />
                <div
                  className={`context-menu-item ${isBusy ? 'disabled' : ''}`}
                  onClick={isBusy ? undefined : runMenuAction(onCompress)}
                >
                  <FileArchive size={13} style={{ color: 'var(--text-muted)' }} />
                  <span>Compress to ZIP{selectionCount > 1 ? ` (${selectionCount} items)` : ''}</span>
                </div>
                {zipSelectionCount > 0 && (
                  <div
                    className={`context-menu-item ${isBusy ? 'disabled' : ''}`}
                    onClick={isBusy ? undefined : runMenuAction(onExtract)}
                  >
                    <PackageOpen size={13} style={{ color: 'var(--text-muted)' }} />
                    <span>Extract ZIP{zipSelectionCount > 1 ? ` (${zipSelectionCount} files)` : ''}</span>
                  </div>
                )}
              </>
            )}

            {contextMenu.item && (
              <>
                <div className="context-menu-divider" />
                {selectionCount <= 1 ? (
                  <>
                    <div
                      className="context-menu-item"
                      onClick={() => handleOpenRenameModal(contextMenu.item!)}
                    >
                      <Edit3 size={13} style={{ color: 'var(--text-muted)' }} />
                      <span>Rename</span>
                      <span className="context-menu-shortcut">F2</span>
                    </div>
                    {contextMenu.item.is_dir && (
                      <div className="context-menu-item" onClick={runMenuAction(onBulkRename)} title="Rename the files and folders inside this folder">
                        <Edit3 size={13} style={{ color: 'var(--text-muted)' }} />
                        <span>Bulk Rename inside this folder...</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="context-menu-item" onClick={runMenuAction(onBulkRename)}>
                    <Edit3 size={13} style={{ color: 'var(--text-muted)' }} />
                    <span>Bulk Rename... ({selectionCount} items)</span>
                    <span className="context-menu-shortcut">F2</span>
                  </div>
                )}
                <div className="context-menu-item" onClick={runMenuAction(onDeleteSelection)}>
                  <Trash2 size={13} style={{ color: 'var(--text-muted)' }} />
                  <span>Delete{selectionCount > 1 ? ` (${selectionCount} items)` : ''}</span>
                  <span className="context-menu-shortcut">Del</span>
                </div>
              </>
            )}

            <div className="context-menu-divider" />

            <div
              className="context-menu-item"
              onClick={() => {
                setContextMenu(null);
                onRefresh?.();
              }}
            >
              <RefreshCw size={13} style={{ color: 'var(--text-muted)' }} />
              <span>Refresh</span>
            </div>
          </div>
        </>
      )}

      {/* Rename Modal */}
      {showRenameModal && (
        <div className="modal-overlay" onClick={() => setShowRenameModal(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">Rename Item</div>
            <form onSubmit={handleRenameSubmit} className="modal-body">
              <span className="modal-label">New name:</span>
              <input
                type="text"
                className="modal-input"
                value={showRenameModal.newName}
                onChange={(e) =>
                  setShowRenameModal({ ...showRenameModal, newName: e.target.value })
                }
                onFocus={(e) => {
                  // Like Explorer: select the name, not the extension, so typing replaces just the name
                  const v = e.target.value;
                  const dot = v.lastIndexOf('.');
                  e.target.setSelectionRange(0, !showRenameModal.item.is_dir && dot > 0 ? dot : v.length);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setShowRenameModal(null);
                }}
                autoFocus
              />
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowRenameModal(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Rename
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New Shortcut Modal */}
      {showShortcutModal && (
        <div className="modal-overlay" onClick={() => setShowShortcutModal(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">Create New Shortcut</div>
            <form onSubmit={handleCreateShortcutSubmit} className="modal-body">
              <span className="modal-label">Shortcut Name (.lnk):</span>
              <input
                type="text"
                className="modal-input"
                value={showShortcutModal.name}
                onChange={(e) =>
                  setShowShortcutModal({ ...showShortcutModal, name: e.target.value })
                }
                placeholder="e.g. MyShortcut.lnk"
                autoFocus
              />
              <span className="modal-label" style={{ marginTop: 4 }}>
                Target Path (File or Folder):
              </span>
              <input
                type="text"
                className="modal-input"
                value={showShortcutModal.targetPath}
                onChange={(e) =>
                  setShowShortcutModal({
                    ...showShortcutModal,
                    targetPath: e.target.value,
                  })
                }
                placeholder="e.g. C:\Users\Username\Documents"
              />
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowShortcutModal(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Create Shortcut
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
