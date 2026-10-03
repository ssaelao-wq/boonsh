import React from 'react';
import { Home, HardDrive, Monitor, Download, FileText, Folder } from 'lucide-react';
import { QuickAccessItem } from '../types';

interface QuickAccessSidebarProps {
  items: QuickAccessItem[];
  currentPath: string;
  onNavigate: (path: string) => void;
}

export const QuickAccessSidebar: React.FC<QuickAccessSidebarProps> = ({
  items,
  currentPath,
  onNavigate,
}) => {
  const getIcon = (type: string) => {
    switch (type) {
      case 'home':
        return <Home size={15} />;
      case 'desktop':
        return <Monitor size={15} />;
      case 'downloads':
        return <Download size={15} />;
      case 'documents':
        return <FileText size={15} />;
      case 'drive':
        return <HardDrive size={15} />;
      default:
        return <Folder size={15} />;
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-title">Quick Access</div>
      {items.map((item) => {
        const isSelected = currentPath.toLowerCase() === item.path.toLowerCase();
        return (
          <div
            key={item.path}
            className={`sidebar-item ${isSelected ? 'selected' : ''}`}
            onClick={() => onNavigate(item.path)}
            title={item.path}
          >
            {getIcon(item.icon_type)}
            <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.label}
            </span>
          </div>
        );
      })}
    </div>
  );
};
