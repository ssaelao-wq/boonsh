import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  HardDrive,
  Monitor,
  BookmarkPlus,
  Plus,
  FolderPlus,
  FilePlus,
  Link,
  ExternalLink,
  RefreshCw,
  ShoppingBasket,
  Cloud,
  Smartphone,
} from 'lucide-react';
import { FileItem, FileListResult } from '../types';
import { useMenuPosition } from '../useMenuPosition';
import { driveColor } from '../driveColors';
import { DriveInfo, driveName, fullUsage, treeUsage } from '../drives';
import { basketName, isBasket } from '../basket';
import { fileAge as folderAge, FileAge as FolderAge, startOfToday } from '../fileAge';
import { isGDrivePath, getGDriveConfig, GDriveConfig, formatStorageBytes, gdriveHasChildren } from '../gdrive';

type Listing = { path: string; items: FileItem[] } | null;

const cleanOf = (p: string) => p.toLowerCase().replace(/\\+$/, '');


interface FolderTreeNodeProps {
  name: string;
  path: string;
  currentPath: string;
  listing: Listing;
  onNavigate: (path: string) => Promise<boolean> | void;
  onOpenBasket: (path: string) => void;
  openBasketPath: string | null;
  onContextMenu: (e: React.MouseEvent, path: string, name: string) => void;
  // this folder could not be opened (renamed or deleted elsewhere): the parent reloads its list
  onGone?: () => void;
  // whether this folder has anything for the tree (the parent asked; undefined = not known yet)
  hasKids?: boolean;
  modified?: number; // the folder's Date Modified (seconds), for its colour
  // the newest Date Modified found below this folder, not expanded here (the parent asked `tree_newest`)
  bestBelow?: number;
  // tells the parent the newest Date Modified anywhere in this folder's own subtree (itself included), so the
  // colour it is shown with can carry on up to the parent, and the parent's parent, and so on to the drive
  onBest?: (path: string, newest: number) => void;
  modifiedText?: string;
  usage?: string; // a drive: "Used 211GB/463GB" after its name
  tooltip?: string; // replaces the path as the row's tooltip
  depth?: number;
  isDrive?: boolean;
  icon?: React.ReactNode; // overrides the drive/folder icon (the Google Drive root row)
}

const FolderTreeNode: React.FC<FolderTreeNodeProps> = ({
  name,
  path,
  currentPath,
  listing,
  onNavigate,
  onOpenBasket,
  openBasketPath,
  onContextMenu,
  onGone,
  hasKids,
  modified,
  bestBelow,
  onBest,
  modifiedText,
  usage,
  tooltip,
  depth = 0,
  isDrive = false,
  icon,
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(false);
  const [children, setChildren] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [loaded, setLoaded] = useState<boolean>(false); // `children` holds this folder's real list
  // which of the child folders have sub-folders of their own (they show the expand arrow only then)
  const [kidsOf, setKidsOf] = useState<Record<string, boolean>>({});
  const [checkGen, setCheckGen] = useState(0);
  // the newest Date Modified found below each child folder, not expanded here (asked with `tree_newest`)
  const [newestOf, setNewestOf] = useState<Record<string, number>>({});
  // the newest Date Modified reported live by a child that IS expanded (its own subtree, itself included).
  // Kept when the child is folded away again (a timestamp already found cannot become wrong, only stale by a
  // later change the folded child no longer reports), dropped only when the child leaves the list entirely.
  const [hotKids, setHotKids] = useState<Record<string, number>>({});
  const reportBest = (p: string, newest: number) => {
    setHotKids((prev) => (prev[p] === newest ? prev : { ...prev, [p]: newest }));
  };

  const cleanPath = cleanOf(path);
  const cleanCurrent = cleanOf(currentPath);
  const isSelected = cleanCurrent === cleanPath;

  // Auto-expand when the open folder is below this one, so the tree shows the way to it; collapse when it is
  // outside (drives too: opening D: folds C: away, like folders). Opening this folder itself does not expand it:
  // only its arrow does.
  useEffect(() => {
    if (cleanCurrent.startsWith(cleanPath + '\\')) {
      // this list (loaded earlier) does not have the way down: a folder made since then (path bar, terminal cd,
      // another program). Load the list again.
      const missing = !children.some((c) => cleanCurrent === cleanOf(c.path) || cleanCurrent.startsWith(cleanOf(c.path) + '\\'));
      if ((!isExpanded && children.length === 0) || missing) {
        fetchSubfolders();
      }
      setIsExpanded(true);
    } else if (isExpanded && cleanCurrent !== cleanPath) {
      setIsExpanded(false);
    }
  }, [currentPath]);

  // Ask which child folders have sub-folders, whenever the list changes or this folder is listed again (F5,
  // a change on disk), so the arrows stay true.
  useEffect(() => {
    // `tree_has_children`/`tree_newest` walk the local filesystem, so a gdrive:// "path" just fails to open;
    // Drive folders go through `gdrive_has_children` instead (one lightweight request per folder, not a
    // combined query sharing one pageSize: a single busy folder could otherwise fill the page and make the
    // other, genuinely non-empty ones look empty too). "Newest below" has no Drive equivalent yet, so a Drive
    // subfolder's own tree colour still only ever comes from its own date, never from something inside it not
    // yet opened — a smaller, accepted gap than the arrow always showing used to be.
    const allFolders = children.filter((c) => c.is_dir);
    if (allFolders.length === 0) return;
    const localFolders = allFolders.filter((c) => !isGDrivePath(c.path));
    const driveFolders = allFolders.filter((c) => isGDrivePath(c.path));
    let stale = false;
    if (localFolders.length > 0) {
      invoke<boolean[]>('tree_has_children', { paths: localFolders.map((c) => c.path) })
        .then((res) => {
          if (!stale) setKidsOf((prev) => ({ ...prev, ...Object.fromEntries(localFolders.map((c, i) => [c.path, res[i]])) }));
        })
        .catch(() => {});
      invoke<number[]>('tree_newest', { paths: localFolders.map((c) => c.path), since: startOfToday() })
        .then((res) => {
          if (!stale) setNewestOf((prev) => ({ ...prev, ...Object.fromEntries(localFolders.map((c, i) => [c.path, res[i]])) }));
        })
        .catch(() => {});
    }
    if (driveFolders.length > 0) {
      gdriveHasChildren(driveFolders.map((c) => c.path))
        .then((res) => {
          if (!stale) setKidsOf((prev) => ({ ...prev, ...Object.fromEntries(driveFolders.map((c, i) => [c.path, res[i]])) }));
        })
        .catch(() => {});
    }
    return () => {
      stale = true;
    };
  }, [children, checkGen]);

  const fetchSubfolders = () => {
    setLoading(true);
    invoke<FileListResult>('list_directory', { targetPath: path })
      .then((res) => {
        setChildren(res.items.filter((item) => item.is_dir || isBasket(item)));
        setLoaded(true);
      })
      .catch((err) => console.error('Tree load error:', err))
      .finally(() => setLoading(false));
  };

  // The file panel listed this folder (opened, refreshed, or changed on disk): take its sub-folders from that
  // listing, so a renamed, new or deleted folder shows here without collapsing and reopening the tree.
  useEffect(() => {
    if (!listing || cleanOf(listing.path) !== cleanPath) return;
    const subdirs = listing.items.filter((item) => item.is_dir || isBasket(item));
    setChildren((prev) =>
      prev.length === subdirs.length &&
      prev.every((c, i) => c.path === subdirs[i].path && c.modified_timestamp === subdirs[i].modified_timestamp)
        ? prev
        : subdirs
    );
    setLoaded(true);
    setCheckGen((g) => g + 1);
  }, [listing]);

  const handleToggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isExpanded && children.length === 0) {
      fetchSubfolders();
    }
    setIsExpanded(!isExpanded);
  };

  // a click on the name only opens the folder in the file panel; the arrow expands it here
  const handleFolderClick = () => {
    Promise.resolve(onNavigate(path)).then((ok) => {
      if (ok === false) onGone?.();
    });
  };

  // the newest Date Modified anywhere in this folder's own subtree: its own date, the backend's answer for a
  // child not expanded here (`newestOf`), or a shown child's own answer (`hotKids`, more complete once it has
  // expanded further down). This is what carries a change's colour up through every parent to the drive.
  const bestOfChildren = children.reduce(
    (best, c) => (c.is_dir ? Math.max(best, c.modified_timestamp ?? 0, newestOf[c.path] ?? 0, hotKids[c.path] ?? 0) : best),
    0
  );
  const newest = Math.max(modified ?? 0, bestBelow ?? 0, bestOfChildren);
  const age: FolderAge = folderAge(newest || undefined);
  // true once the shown colour comes from something below, not from this folder's own date
  const fromBelow = newest > (modified ?? 0);
  useEffect(() => {
    onBest?.(path, newest);
  }, [newest]);

  // the arrow only when there is something to expand (drives always have one)
  const showCaret = isDrive || (loaded ? children.length > 0 : hasKids !== false);

  return (
    <div className="tree-node-wrapper">
      <div
        className={`tree-node-item ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        onClick={handleFolderClick}
        onContextMenu={(e) => onContextMenu(e, path, name)}
        title={
          tooltip ??
          (modifiedText ? `${path}\nModified: ${modifiedText}` : path) +
            (fromBelow ? '\nA folder inside was modified more recently than this one' : '')
        }
      >
        {showCaret ? (
          <span
            className="tree-caret"
            onClick={handleToggleExpand}
            style={{ cursor: 'pointer', padding: '0 2px' }}
          >
            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        ) : (
          <span className="tree-caret tree-caret-none" />
        )}

        {icon ? (
          icon
        ) : isDrive ? (
          <HardDrive size={13} style={{ color: driveColor(path) }} />
        ) : (
          // the file panel's folder (MainFilePanel getFileIcon): 16 px, a one-screen-pixel line; coloured by when it
          // was last modified (today: orange, 30+ days: dim yellow, a year+: grey)
          <Folder
            size={16}
            strokeWidth={1 / Math.max(1, window.devicePixelRatio || 1)}
            absoluteStrokeWidth
            style={{ color: `var(--tree-folder-${age}-stroke)`, fill: `var(--tree-folder-${age}-fill)` }}
          />
        )}

        <span className="tree-node-label">
          {name}
          {usage && <span className="tree-drive-usage">{usage}</span>}
        </span>
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
            children.map((child) =>
              isBasket(child) ? (
                // a basket: no children of its own; a click shows its links in the file panel
                <div
                  key={child.path}
                  className={`tree-node-item ${openBasketPath && cleanOf(openBasketPath) === cleanOf(child.path) ? 'selected' : ''}`}
                  style={{ paddingLeft: `${(depth + 1) * 12 + 6}px` }}
                  onClick={() => onOpenBasket(child.path)}
                  title={`Basket: ${child.path}`}
                >
                  <span className="tree-caret tree-caret-none" />
                  <ShoppingBasket size={13} style={{ color: 'var(--basket-color)' }} />
                  <span className="tree-node-label">{basketName(child.name)}</span>
                </div>
              ) : (
                <FolderTreeNode
                  key={child.path}
                  name={child.name}
                  path={child.path}
                  currentPath={currentPath}
                  listing={listing}
                  onNavigate={onNavigate}
                  onOpenBasket={onOpenBasket}
                  openBasketPath={openBasketPath}
                  onContextMenu={onContextMenu}
                  onGone={fetchSubfolders}
                  hasKids={kidsOf[child.path]}
                  modified={child.modified_timestamp}
                  // the backend's answer for this child, or (at least as good) what it last reported itself
                  // before being folded away, so re-expanding it shows the right colour before it re-asks
                  bestBelow={Math.max(newestOf[child.path] ?? 0, hotKids[child.path] ?? 0) || undefined}
                  onBest={reportBest}
                  modifiedText={child.modified}
                  depth={depth + 1}
                />
              )
            )
          )}
        </div>
      )}
    </div>
  );
};

interface FolderTreeProps {
  currentPath: string;
  listing: Listing;
  onNavigate: (path: string) => Promise<boolean> | void;
  onOpenBasket: (path: string) => void;
  openBasketPath: string | null;
  onAddQuickAccess?: (item: { label: string; path: string; icon_type?: string }) => void;
  onRefresh?: () => void;
  onCreateBasket?: (folder: string) => void; // New -> Basket in the right-clicked folder
  drives: DriveInfo[]; // App loads them (also for the This PC view)
  onOpenThisPC: () => void;
  thisPCOpen: boolean;
}

export const FolderTree: React.FC<FolderTreeProps> = ({
  currentPath,
  listing,
  onNavigate,
  onOpenBasket,
  openBasketPath,
  onAddQuickAccess,
  onRefresh,
  onCreateBasket,
  drives,
  onOpenThisPC,
  thisPCOpen,
}) => {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
    name: string;
  } | null>(null);
  const menuPos = useMenuPosition(contextMenu);
  // Shown as a drive-like entry below the local drives, same as This PC's own card; re-checked on window focus
  // since connecting/disconnecting happens in Settings while this tree stays mounted the whole time.
  const [gdriveConfig, setGdriveConfig] = useState<GDriveConfig | null>(null);
  useEffect(() => {
    const load = () => {
      getGDriveConfig().then(setGdriveConfig).catch(() => {});
    };
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);
  const [showNewSubmenu, setShowNewSubmenu] = useState<boolean>(false);
  const [showShortcutModal, setShowShortcutModal] = useState<{
    name: string;
    targetPath: string;
    parentDir: string;
  } | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);


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
        icon_type: isGDrivePath(contextMenu.path) ? 'gdrive' : 'folder',
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

  const handleCreateBasket = () => {
    if (!contextMenu) return;
    const targetDir = contextMenu.path;
    setContextMenu(null);
    setShowNewSubmenu(false);
    onCreateBasket?.(targetDir);
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
        {/* a click shows the drives with their space in the file panel */}
        <div
          className={`tree-node-item ${thisPCOpen ? 'selected' : ''}`}
          style={{ fontWeight: 400, paddingLeft: 4 }}
          onClick={onOpenThisPC}
          title="This PC: the drives and their free space"
        >
          <Monitor size={14} style={{ color: 'var(--text-main)' }} />
          <span className="tree-node-label">This PC</span>
        </div>

        {drives.map((drive) => (
          <FolderTreeNode
            key={drive.path}
            name={driveName(drive)}
            usage={treeUsage(drive)}
            tooltip={`${drive.path}\n${fullUsage(drive)}${drive.file_system ? ` · ${drive.file_system}` : ''}`}
            path={drive.path}
            currentPath={currentPath}
            listing={listing}
            onNavigate={onNavigate}
            onOpenBasket={onOpenBasket}
            openBasketPath={openBasketPath}
            onContextMenu={handleContextMenu}
            depth={1}
            isDrive={true}
          />
        ))}

        {gdriveConfig?.connected && (
          <FolderTreeNode
            key="gdrive-root"
            name="Google Drive"
            path="gdrive://root"
            usage={
              gdriveConfig.quota_limit
                ? `Used ${formatStorageBytes(gdriveConfig.quota_usage)}/${formatStorageBytes(gdriveConfig.quota_limit)}`
                : undefined
            }
            tooltip={`Google Drive (${gdriveConfig.account_name || gdriveConfig.account_email || 'Connected'})`}
            currentPath={currentPath}
            listing={listing}
            onNavigate={onNavigate}
            onOpenBasket={onOpenBasket}
            openBasketPath={openBasketPath}
            onContextMenu={handleContextMenu}
            depth={1}
            isDrive={true}
            icon={<Cloud size={13} style={{ color: '#38bdf8' }} />}
          />
        )}

        <FolderTreeNode
          key="lan-mobile"
          name="Mobile Drop"
          path="lan://mobile"
          tooltip="Mobile Drop: Transfer files & export Google Docs to PDF over Wi-Fi"
          currentPath={currentPath}
          listing={listing}
          onNavigate={onNavigate}
          onOpenBasket={onOpenBasket}
          openBasketPath={openBasketPath}
          onContextMenu={handleContextMenu}
          depth={1}
          isDrive={true}
          icon={<Smartphone size={13} style={{ color: '#10b981' }} />}
        />
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
              // a submenu closes when the pointer leaves its row (it overlaps the row, so moving into it keeps it open)
              onMouseLeave={() => setShowNewSubmenu(false)}
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
                  {/* A text file, a shortcut and a basket are all local-filesystem things; Google Drive only
                      gets a remote folder (handleCreateFolder already routes to gdrive_create_folder) */}
                  {!isGDrivePath(contextMenu.path) && (
                    <>
                      <div className="context-menu-item" onClick={handleCreateTextFile}>
                        <FilePlus size={13} style={{ color: 'var(--text-muted)' }} />
                        <span>Text Document</span>
                      </div>
                      <div className="context-menu-item" onClick={handleOpenShortcutModal}>
                        <Link size={13} style={{ color: 'var(--text-muted)' }} />
                        <span>Shortcut</span>
                      </div>
                      {onCreateBasket && (
                        <div
                          className="context-menu-item"
                          onClick={handleCreateBasket}
                          title="A basket holds links to files and folders from anywhere"
                        >
                          <ShoppingBasket size={13} style={{ color: 'var(--basket-color)' }} />
                          <span>Basket</span>
                        </div>
                      )}
                    </>
                  )}
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
