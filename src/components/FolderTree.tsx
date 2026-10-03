import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  HardDrive,
  Monitor,
  BookmarkPlus,
  Plus,
  FolderPlus,
  FilePlus,
  Link,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';
import { FileItem, FileListResult, QuickAccessItem } from '../types';
import { useMenuPosition } from '../useMenuPosition';

interface FolderTreeNodeProps {
  name: string;
  path: string;
  currentPath: string;
  onNavigate: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, name: string) => void;
  depth?: number;
  isDrive?: boolean;
}

const FolderTreeNode: React.FC<FolderTreeNodeProps> = ({
  name,
  path,
  currentPath,
  onNavigate,
  onContextMenu,
  depth = 0,
  isDrive = false,
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(false);
  const [children, setChildren] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const cleanPath = path.toLowerCase().replace(/\\+$/, '');
  const cleanCurrent = currentPath.toLowerCase().replace(/\\+$/, '');
  const isSelected = cleanCurrent === cleanPath;

  // Auto-expand if currentPath is inside this folder; collapse if user clicked higher or outside folder
  useEffect(() => {
    if (cleanCurrent === cleanPath || cleanCurrent.startsWith(cleanPath + '\\')) {
      if (!isExpanded && children.length === 0) {
        fetchSubfolders();
      }
      setIsExpanded(true);
    } else if (isExpanded && !isDrive) {
      setIsExpanded(false);
    }
  }, [currentPath]);

  const fetchSubfolders = () => {
    setLoading(true);
    invoke<FileListResult>('list_directory', { targetPath: path })
      .then((res) => {
        const subdirs = res.items.filter((item) => item.is_dir);
        setChildren(subdirs);
      })
      .catch((err) => console.error('Tree load error:', err))
      .finally(() => setLoading(false));
  };

  const handleToggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isExpanded && children.length === 0) {
      fetchSubfolders();
    }
    setIsExpanded(!isExpanded);
  };

  const handleFolderClick = () => {
    onNavigate(path);
    if (!isExpanded) {
      if (children.length === 0) fetchSubfolders();
      setIsExpanded(true);
    }
  };

  return (
    <div className="tree-node-wrapper">
      <div
        className={`tree-node-item ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        onClick={handleFolderClick}
        onContextMenu={(e) => onContextMenu(e, path, name)}
        title={path}
      >
        <span
          className="tree-caret"
          onClick={handleToggleExpand}
          style={{ cursor: 'pointer', padding: '0 2px' }}
        >
          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>

        {isDrive ? (
          <HardDrive size={13} style={{ color: 'var(--text-main)' }} />
        ) : isExpanded ? (
          <FolderOpen size={13} style={{ color: 'var(--text-main)' }} />
        ) : (
          <Folder size={13} style={{ color: 'var(--text-muted)' }} />
        )}

        <span className="tree-node-label">{name}</span>
      </div>

      {isExpanded && (
        <div className="tree-children">
          {loading ? (
            <div
              style={{
                paddingLeft: `${(depth + 1) * 12 + 6}px`,
                fontSize: 11,
                color: 'var(--text-dim)',
              }}
            >
              Loading...
            </div>
          ) : (
            children.map((child) => (
              <FolderTreeNode
                key={child.path}
                name={child.name}
                path={child.path}
                currentPath={currentPath}
                onNavigate={onNavigate}
                onContextMenu={onContextMenu}
                depth={depth + 1}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
};

interface FolderTreeProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  onAddQuickAccess?: (item: { label: string; path: string; icon_type?: string }) => void;
  onRefresh?: () => void;
}

export const FolderTree: React.FC<FolderTreeProps> = ({
  currentPath,
  onNavigate,
  onAddQuickAccess,
  onRefresh,
}) => {
  const [drives, setDrives] = useState<QuickAccessItem[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
    name: string;
  } | null>(null);
  const menuPos = useMenuPosition(contextMenu);
  const [showNewSubmenu, setShowNewSubmenu] = useState<boolean>(false);
  const [showShortcutModal, setShowShortcutModal] = useState<{
    name: string;
    targetPath: string;
    parentDir: string;
  } | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<QuickAccessItem[]>('get_quick_access')
      .then((items) => {
        const driveItems = items.filter((item) => item.icon_type === 'drive');
        setDrives(driveItems);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const scrollToThirdLine = () => {
      if (!contentRef.current) return;
      const selectedNode = contentRef.current.querySelector<HTMLElement>(
        '.tree-node-item.selected'
      );
      if (selectedNode) {
        const targetTop = Math.max(0, selectedNode.offsetTop - 48);
        contentRef.current.scrollTo({
          top: targetTop,
          behavior: 'smooth',
        });
      }
    };

    scrollToThirdLine();
    const t1 = setTimeout(scrollToThirdLine, 80);
    const t2 = setTimeout(scrollToThirdLine, 250);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [currentPath]);

  const handleContextMenu = (e: React.MouseEvent, path: string, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    onNavigate(path);
    setShowNewSubmenu(false);
    const posX = e.clientX; // kept on-screen by useMenuPosition
    const posY = e.clientY;
    setContextMenu({
      x: posX,
      y: posY,
      path,
      name,
    });
  };

  const handleAddQA = () => {
    if (contextMenu && onAddQuickAccess) {
      onAddQuickAccess({
        label: contextMenu.name,
        path: contextMenu.path,
        icon_type: 'folder',
      });
    }
    setContextMenu(null);
  };

  const handleCreateFolder = () => {
    if (!contextMenu) return;
    const targetDir = contextMenu.path;
    setContextMenu(null);
    setShowNewSubmenu(false);
    invoke<string>('create_new_folder', { parentDir: targetDir, name: 'New folder' })
      .then(() => onRefresh?.())
      .catch((err) => alert(err));
  };

  const handleCreateTextFile = () => {
    if (!contextMenu) return;
    const targetDir = contextMenu.path;
    setContextMenu(null);
    setShowNewSubmenu(false);
    invoke<string>('create_new_file', { parentDir: targetDir, name: 'New Text Document.txt' })
      .then(() => onRefresh?.())
      .catch((err) => alert(err));
  };

  const handleOpenShortcutModal = () => {
    if (!contextMenu) return;
    const targetDir = contextMenu.path;
    const defaultName = `${contextMenu.name} - Shortcut.lnk`;
    setContextMenu(null);
    setShowNewSubmenu(false);
    setShowShortcutModal({
      name: defaultName,
      targetPath: targetDir,
      parentDir: targetDir,
    });
  };

  const handleCreateShortcutSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!showShortcutModal) return;
    invoke<string>('create_shortcut', {
      parentDir: showShortcutModal.parentDir,
      name: showShortcutModal.name,
      targetPath: showShortcutModal.targetPath,
    })
      .then(() => {
        setShowShortcutModal(null);
        onRefresh?.();
      })
      .catch((err) => alert(err));
  };

  return (
    <div className="folder-tree-container">
      <div className="folder-tree-header">Folder Tree</div>
      <div className="folder-tree-content" ref={contentRef}>
        <div className="tree-node-item" style={{ fontWeight: 400, paddingLeft: 4 }}>
          <Monitor size={14} style={{ color: 'var(--text-main)' }} />
          <span>This PC</span>
        </div>

        {drives.map((drive) => (
          <FolderTreeNode
            key={drive.path}
            name={drive.label}
            path={drive.path}
            currentPath={currentPath}
            onNavigate={onNavigate}
            onContextMenu={handleContextMenu}
            depth={1}
            isDrive={true}
          />
        ))}
      </div>

      {/* Right Click Context Menu Popup */}
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
            <div className="context-menu-item" onClick={() => { setContextMenu(null); onNavigate(contextMenu.path); }}>
              <ExternalLink size={13} style={{ color: 'var(--text-muted)' }} />
              <span>Open</span>
            </div>

            {/* New Submenu Trigger */}
            <div
              className="context-menu-item"
              onMouseEnter={() => setShowNewSubmenu(true)}
              onClick={() => setShowNewSubmenu(!showNewSubmenu)}
              style={{ justifyContent: 'space-between' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Plus size={13} style={{ color: 'var(--text-muted)' }} />
                <span>New</span>
              </div>
              <ChevronRight size={13} style={{ color: 'var(--text-dim)' }} />

              {/* Submenu Popup */}
              {showNewSubmenu && (
                <div className={menuPos.submenuClass} onClick={(e) => e.stopPropagation()}>
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
              <span>Add to Quick Access</span>
            </div>

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
