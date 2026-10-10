import React, { useState } from 'react';
import { Home, HardDrive, Monitor, Download, FileText, Folder, Trash2 } from 'lucide-react';
import { QuickAccessItem } from '../types';
import { useMenuPosition } from '../useMenuPosition';
import { driveColor } from '../driveColors';

interface QuickAccessBarProps {
  items: QuickAccessItem[];
  currentPath: string;
  onNavigate: (path: string) => void;
  onRemoveQuickAccess?: (path: string) => void;
}

export const QuickAccessBar: React.FC<QuickAccessBarProps> = ({
  items,
  currentPath,
  onNavigate,
  onRemoveQuickAccess,
}) => {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
    label: string;
  } | null>(null);
  const menuPos = useMenuPosition(contextMenu);

  const getIcon = (type: string, path: string) => {
    switch (type) {
      case 'home':
        return <Home size={13} style={{ color: '#f97316' }} />;
      case 'desktop':
        return <Monitor size={13} style={{ color: '#3b82f6' }} />;
      case 'downloads':
        return <Download size={13} style={{ color: '#10b981' }} />;
      case 'documents':
        return <FileText size={13} style={{ color: '#8b5cf6' }} />;
      case 'drive':
        return <HardDrive size={13} style={{ color: driveColor(path) }} />;
      default:
        return <Folder size={13} style={{ color: '#f59e0b' }} />;
    }
  };

  const handleContextMenu = (e: React.MouseEvent, item: QuickAccessItem) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      path: item.path,
      label: item.label,
    });
  };

  const handleRemove = () => {
    if (contextMenu && onRemoveQuickAccess) {
      onRemoveQuickAccess(contextMenu.path);
    }
    setContextMenu(null);
  };

  return (
    <div className="quick-access-bar">
      <span className="quick-access-label">Quick Access:</span>
      <div className="quick-access-chips">
        {items.map((item) => {
          const isSelected = currentPath.toLowerCase() === item.path.toLowerCase();
          return (
            <button
              key={item.path}
              className={`quick-access-chip ${isSelected ? 'active' : ''}`}
              onClick={() => onNavigate(item.path)}
              onContextMenu={(e) => handleContextMenu(e, item)}
              title={item.path}
            >
              {getIcon(item.icon_type, item.path)}
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* Right Click Context Menu Popup */}
      {contextMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setContextMenu(null)} />
          <div className="context-menu" ref={menuPos.ref} style={menuPos.style}>
            <div className="context-menu-item" onClick={handleRemove}>
              <Trash2 size={13} style={{ color: 'var(--text-muted)' }} />
              <span>Remove from Quick Access</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
