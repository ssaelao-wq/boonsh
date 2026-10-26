import React, { useState, useEffect } from 'react';
import { HardDrive, Monitor, Cloud, Smartphone } from 'lucide-react';
import { DriveInfo, almostFull, driveName, fullUsage, usedPercent } from '../drives';
import { driveColor } from '../driveColors';
import { getGDriveConfig, GDriveConfig, formatStorageBytes } from '../gdrive';
import { getLanStatus, LanStatus } from '../lan';

interface ThisPCViewProps {
  drives: DriveInfo[];
  onOpen: (path: string) => void;
}

/** "This PC" in the file panel: every drive with a meter of the space in use, like Explorer. */
export const ThisPCView: React.FC<ThisPCViewProps> = ({ drives, onOpen }) => {
  const [selected, setSelected] = useState<string | null>(null);
  const [gdrive, setGdrive] = useState<GDriveConfig | null>(null);
  const [lanStatus, setLanStatus] = useState<LanStatus | null>(null);

  useEffect(() => {
    getGDriveConfig().then(setGdrive).catch(() => {});
    getLanStatus().then(setLanStatus).catch(() => {});
  }, []);
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
        {gdrive?.connected && (
          <div
            className={`this-pc-drive ${selected === 'gdrive://root' ? 'selected' : ''}`}
            onClick={() => setSelected('gdrive://root')}
            onDoubleClick={() => onOpen('gdrive://root')}
            onKeyDown={(e) => e.key === 'Enter' && onOpen('gdrive://root')}
            tabIndex={0}
            title={`Google Drive (${gdrive.account_name || gdrive.account_email || 'Connected'})\nDouble-click to open`}
          >
            <Cloud size={36} strokeWidth={1.25} style={{ color: '#38bdf8', flexShrink: 0 }} />
            <div className="this-pc-info">
              <div className="this-pc-name">Google Drive</div>
              {gdrive.quota_limit ? (
                <>
                  <div className="this-pc-meter" role="meter" aria-valuenow={Math.round(((gdrive.quota_usage || 0) / gdrive.quota_limit) * 100)} aria-valuemin={0} aria-valuemax={100}>
                    <div
                      className="this-pc-meter-fill"
                      style={{ width: `${Math.min(100, Math.round(((gdrive.quota_usage || 0) / gdrive.quota_limit) * 100))}%`, background: '#38bdf8' }}
                    />
                  </div>
                  <div className="this-pc-usage">
                    {formatStorageBytes(gdrive.quota_usage)} used of {formatStorageBytes(gdrive.quota_limit)}
                  </div>
                </>
              ) : (
                <div className="this-pc-usage" style={{ color: '#22c55e' }}>Connected · {gdrive.account_email}</div>
              )}
            </div>
          </div>
        )}
        <div
          className={`this-pc-drive ${selected === 'lan://mobile' ? 'selected' : ''}`}
          onClick={() => setSelected('lan://mobile')}
          onDoubleClick={() => onOpen('lan://mobile')}
          onKeyDown={(e) => e.key === 'Enter' && onOpen('lan://mobile')}
          tabIndex={0}
          title="Mobile Drop: Transfer files & export Google Docs to PDF over Wi-Fi"
        >
          <Smartphone size={36} strokeWidth={1.25} style={{ color: '#10b981', flexShrink: 0 }} />
          <div className="this-pc-info">
            <div className="this-pc-name">Mobile Drop</div>
            <div className="this-pc-usage" style={{ color: '#10b981' }}>
              {lanStatus?.paired_devices && lanStatus.paired_devices.length > 0
                ? `Paired: ${lanStatus.paired_devices.map(d => d.name).join(', ')}`
                : 'Local Wi-Fi · Click to connect'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
