import React from 'react';
import { FileItem } from '../types';

interface StatusBarProps {
  totalFiles: number;
  totalFolders: number;
  totalSizeFormatted: string;
  selectedItem: FileItem | null;
  selectionCount: number;
  selectionSizeFormatted: string;
  busyMessage: string;
  shellEngine: string;
  basketCounts?: { links: number; gone: number; new: number } | null; // shown instead of the folder totals in a basket
}

export const StatusBar: React.FC<StatusBarProps> = ({
  totalFiles,
  totalFolders,
  totalSizeFormatted,
  selectedItem,
  selectionCount,
  selectionSizeFormatted,
  busyMessage,
  shellEngine,
  basketCounts,
}) => {
  return (
    <div className="status-bar">
      <div className="status-bar-left">
        {basketCounts ? (
          <span className="status-count">
            Basket: {basketCounts.links} link{basketCounts.links === 1 ? '' : 's'}
            {basketCounts.gone > 0 && ` · ${basketCounts.gone} gone`}
            {basketCounts.new > 0 && ` · ${basketCounts.new} new`}
          </span>
        ) : (
          <>
            <span className="status-count">{totalFolders} folders, {totalFiles} files</span>
            <span className="status-divider">|</span>
            <span className="status-count">Total Size: {totalSizeFormatted}</span>
          </>
        )}
        {busyMessage && (
          <>
            <span className="status-divider">|</span>
            <span className="status-busy">{busyMessage}</span>
          </>
        )}
      </div>

      <div className="status-bar-right">
        {selectionCount > 1 ? (
          <>
            <span className="status-selected-item">
              Selected: {selectionCount} items ({selectionSizeFormatted})
            </span>
            <span className="status-divider">|</span>
          </>
        ) : selectedItem && selectionCount === 1 && (
          <>
            <span className="status-selected-item" title={`${selectedItem.name} (${selectedItem.size_formatted})`}>
              Selected: {selectedItem.name} ({selectedItem.size_formatted})
            </span>
            <span className="status-divider">|</span>
          </>
        )}
        <span className="status-shell">
          Shell: {shellEngine || 'PowerShell'} (Active)
        </span>
      </div>
    </div>
  );
};
