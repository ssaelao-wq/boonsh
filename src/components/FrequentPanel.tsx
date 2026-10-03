import React, { useState } from 'react';
import { Folder, Trash2 } from 'lucide-react';
import { FrequentEntry, folderLabel, keyOf } from '../frequent';
import { useMenuPosition } from '../useMenuPosition';

interface FrequentPanelProps {
  items: FrequentEntry[]; // already limited to the number chosen in Settings
  currentPath: string;
  onNavigate: (path: string) => void;
  onRemove: (path: string) => void; // forget the folder: its count starts again from 0
}

export const FrequentPanel: React.FC<FrequentPanelProps> = ({ items, currentPath, onNavigate, onRemove }) => {
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FrequentEntry } | null>(null);
  const menuPos = useMenuPosition(menu);
  const here = keyOf(currentPath);

  return (
    <div className="frequent-panel">
      <div className="folder-tree-header">Frequently Accessed</div>
      <div className="frequent-list">
        {items.length === 0 && (
          <div className="frequent-empty">Folders you open often will show up here.</div>
        )}
        {items.map((e) => (
          <div
            key={e.path}
            className={`tree-node-item ${keyOf(e.path) === here ? 'selected' : ''}`}
            style={{ paddingLeft: 8 }}
            title={`${e.path}\nOpened ${e.count} time${e.count === 1 ? '' : 's'}`}
            onClick={() => onNavigate(e.path)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
            }}
          >
            <Folder size={14} style={{ color: 'var(--text-main)', flexShrink: 0 }} />
            <span className="frequent-name">{folderLabel(e.path)}</span>
          </div>
        ))}
      </div>

      {menu && (
        <>
          <div
            className="context-menu-overlay"
            onClick={() => setMenu(null)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              setMenu(null);
            }}
          />
          <div className="context-menu" ref={menuPos.ref} style={menuPos.style}>
            <div
              className="context-menu-item"
              title="Its count goes back to 0 and builds up again from the next visit"
              onClick={() => {
                onRemove(menu.entry.path);
                setMenu(null);
              }}
            >
              <Trash2 size={13} style={{ color: 'var(--text-muted)' }} />
              <span>Remove from Frequently Accessed</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
