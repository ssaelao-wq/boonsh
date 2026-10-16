import React, { useState } from 'react';
import { HardDrive, Monitor } from 'lucide-react';
import { DriveInfo, almostFull, driveName, fullUsage, usedPercent } from '../drives';
import { driveColor } from '../driveColors';

interface ThisPCViewProps {
  drives: DriveInfo[];
  onOpen: (path: string) => void;
}

/** "This PC" in the file panel: every drive with a meter of the space in use, like Explorer. */
export const ThisPCView: React.FC<ThisPCViewProps> = ({ drives, onOpen }) => {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="this-pc" onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
      <div className="this-pc-title">
        <Monitor size={15} />
        <span>This PC</span>
        <span className="this-pc-count">
          {drives.length} drive{drives.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="this-pc-grid" onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
        {drives.map((d) => {
          const pct = usedPercent(d);
          return (
            <div
              key={d.path}
              className={`this-pc-drive ${selected === d.path ? 'selected' : ''} ${d.ready ? '' : 'not-ready'}`}
              onClick={() => setSelected(d.path)}
              onDoubleClick={() => d.ready && onOpen(d.path)}
              onKeyDown={(e) => e.key === 'Enter' && d.ready && onOpen(d.path)}
              tabIndex={0}
              title={
                d.ready
                  ? `${driveName(d)}\n${pct.toFixed(1)}% used${d.file_system ? ` · ${d.file_system}` : ''}\nDouble-click to open`
                  : `${driveName(d)}: not ready`
              }
            >
              <HardDrive size={36} strokeWidth={1.25} style={{ color: driveColor(d.path), flexShrink: 0 }} />
              <div className="this-pc-info">
                <div className="this-pc-name">{driveName(d)}</div>
                <div className="this-pc-meter" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                  <div className={`this-pc-meter-fill ${almostFull(d) ? 'full' : ''}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="this-pc-usage">{fullUsage(d)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
