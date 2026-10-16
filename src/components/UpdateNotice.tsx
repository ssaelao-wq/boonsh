import { useState } from 'react';
import { Download } from 'lucide-react';
import type { Update } from '@tauri-apps/plugin-updater';

// A newer boonsh was found: bottom left, with the release notes on request, Install and restart, and Later
// (that version is then not shown again by itself; Settings > About can still find it).
export function UpdateNotice({
  update,
  installing,
  onInstall,
  onLater,
}: {
  update: Update;
  installing: string | null;
  onInstall: () => void;
  onLater: () => void;
}) {
  const [notes, setNotes] = useState(false);
  return (
    <div className="update-notice" role="status">
      <div className="update-notice-head">
        <Download size={14} className="update-notice-icon" />
        <span>
          <b>boonsh {update.version}</b> is available (you have {update.currentVersion}).
        </span>
      </div>
      {notes && <pre className="update-notice-notes">{update.body?.trim() || 'No release notes.'}</pre>}
      <div className="update-notice-buttons">
        <button onClick={() => setNotes(!notes)}>{notes ? 'Hide notes' : "What's new"}</button>
        <span style={{ flex: 1 }} />
        {installing ? (
          <span className="update-notice-progress">{installing}</span>
        ) : (
          <>
            <button onClick={onLater} title="Not now: this version is not offered again by itself">Later</button>
            <button className="active" onClick={onInstall} title="Download, install and start the new version">
              Install and restart
            </button>
          </>
        )}
      </div>
    </div>
  );
}
