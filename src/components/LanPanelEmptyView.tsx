import React, { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import QRCode from 'qrcode';
import { Smartphone, Copy, Check, RefreshCw, Trash2, ShieldCheck, Wifi, FolderOpen, QrCode } from 'lucide-react';
import { LanStatus, getLanStatus, startLanServer, revokeLanDevice, clearLanStaging, openLanIncomingFolder } from '../lan';

interface LanPanelEmptyViewProps {
  onRefresh?: () => void;
  onShowFiles?: () => void;
}

interface LanUploadProgress {
  name: string;
  received: number;
  total: number;
  done: boolean;
}

export const LanPanelEmptyView: React.FC<LanPanelEmptyViewProps> = ({ onRefresh, onShowFiles }) => {
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [showQrExpanded, setShowQrExpanded] = useState<boolean>(false);
  // The upload itself is streamed straight to disk now (lan_share.rs), so without this the desktop side showed
  // nothing at all until a phone's file had fully landed, however large it was.
  const [uploadProgress, setUploadProgress] = useState<LanUploadProgress | null>(null);

  const loadStatus = async () => {
    try {
      const st = await startLanServer();
      setStatus(st);
      if (st.qr_url) {
        const url = await QRCode.toDataURL(st.qr_url, {
          margin: 1,
          width: 220,
          color: {
            dark: '#f1f5f9',
            light: '#0f1117',
          },
        });
        setQrDataUrl(url);
      }
    } catch (e) {
      console.error('Failed to load LAN status', e);
    }
  };

  useEffect(() => {
    loadStatus();
    const interval = setInterval(() => {
      getLanStatus().then(setStatus).catch(() => {});
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<LanUploadProgress>('lan-upload-progress', (e) => {
      if (e.payload.done) {
        setUploadProgress(null);
        getLanStatus().then(setStatus).catch(() => {}); // the new file is ready; show it without waiting 2.5 s
      } else {
        setUploadProgress(e.payload);
      }
    }).then((f) => {
      unlisten = f;
    });
    return () => unlisten?.();
  }, []);

  const handleCopyUrl = () => {
    if (status?.qr_url) {
      navigator.clipboard.writeText(status.qr_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeLanDevice(id);
      loadStatus();
    } catch (e) {
      alert('Failed to revoke device: ' + e);
    }
  };

  const handleClear = async () => {
    try {
      await clearLanStaging();
      loadStatus();
      onRefresh?.();
    } catch (e) {
      alert('Failed to clear staging: ' + e);
    }
  };

  const isConnected = !!status?.is_client_connected;
  const hasPaired = (status?.paired_devices && status.paired_devices.length > 0) || isConnected;
  const clientName = status?.connected_client_name || status?.paired_devices[0]?.name || 'Mobile Phone';

  return (
    <div className="lan-empty-container" style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '28px 24px',
      color: 'var(--text-main)',
      height: '100%',
      overflowY: 'auto',
      gap: 16,
    }}>
      {/* Top Header */}
      <div style={{ textAlign: 'center', maxWidth: 460 }}>
        <div style={{
          display: 'inline-flex',
          padding: 12,
          borderRadius: '50%',
          background: isConnected ? 'rgba(16, 185, 129, 0.15)' : 'rgba(56, 189, 248, 0.1)',
          color: isConnected ? '#10b981' : '#38bdf8',
          marginBottom: 10,
        }}>
          <Smartphone size={30} />
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 6px 0' }}>
          Mobile Drop
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
          {isConnected
            ? 'Transfer files directly between your notebook and mobile phone over local Wi-Fi.'
            : 'Scan this QR code with your mobile phone camera or the LINE QR code scanner to connect.'}
        </p>

        {/* Toolbar action buttons */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 12 }}>
          {onShowFiles && hasPaired && (
            <button
              className="lan-panel-btn"
              onClick={onShowFiles}
              title="Return to the Mobile Drop file panel"
            >
              <span>Show File List</span>
            </button>
          )}
          <button
            className="lan-panel-btn"
            onClick={loadStatus}
          >
            <RefreshCw size={12} />
            <span>Refresh</span>
          </button>
          <button
            className="lan-panel-btn"
            onClick={handleClear}
          >
            <Trash2 size={12} />
            <span>Clear Staging</span>
          </button>
          <button
            className="lan-panel-btn"
            onClick={() => openLanIncomingFolder()}
            title="Open the folder on your notebook where received files are stored"
          >
            <FolderOpen size={12} />
            <span>Incoming Folder</span>
          </button>
        </div>
      </div>

      {/* Receiving from phone: the upload itself streams straight to disk with no other feedback otherwise */}
      {uploadProgress && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '10px 14px',
          background: 'rgba(56, 189, 248, 0.08)',
          border: '1px solid rgba(56, 189, 248, 0.25)',
          borderRadius: 8,
          width: '100%',
          maxWidth: 460,
          fontSize: 12,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
            <span>Receiving <b style={{ color: 'var(--text-main)' }}>{uploadProgress.name}</b>&hellip;</span>
            <span>
              {uploadProgress.total > 0 ? Math.round((uploadProgress.received / uploadProgress.total) * 100) : 0}%
            </span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              background: '#38bdf8',
              width: `${uploadProgress.total > 0 ? Math.min(100, (uploadProgress.received / uploadProgress.total) * 100) : 0}%`,
              transition: 'width 0.2s linear',
            }} />
          </div>
        </div>
      )}

      {/* Connected Hero Banner */}
      {isConnected && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 18px',
          background: 'rgba(16, 185, 129, 0.1)',
          border: '1px solid rgba(16, 185, 129, 0.3)',
          borderRadius: 10,
          width: '100%',
          maxWidth: 460,
        }}>
          <div style={{
            position: 'relative',
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: 'rgba(16, 185, 129, 0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#10b981',
            flexShrink: 0,
          }}>
            <Smartphone size={18} />
            <span style={{
              position: 'absolute',
              bottom: 1,
              right: 1,
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: '#10b981',
              boxShadow: '0 0 6px #10b981',
            }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#10b981' }}>
              {clientName} Connected
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Wi-Fi transfer bridge is active. Ready to transfer files.
            </div>
          </div>
          <button
            className="lan-panel-btn"
            onClick={() => setShowQrExpanded(!showQrExpanded)}
            title="Toggle QR Code display"
          >
            <QrCode size={12} />
            <span>{showQrExpanded ? 'Hide QR' : 'Show QR'}</span>
          </button>
        </div>
      )}

      {/* QR Code Container (shown if not connected, or if user toggled Show QR) */}
      {qrDataUrl && (!isConnected || showQrExpanded) && (
        <div style={{
          background: '#0f1117',
          padding: 16,
          borderRadius: 12,
          border: '1px solid var(--border-color, #282c39)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
        }}>
          <img
            src={qrDataUrl}
            alt="Scan to Connect Phone"
            style={{ width: 180, height: 180, display: 'block', borderRadius: 6 }}
          />
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: 'var(--text-muted)',
            background: 'rgba(255, 255, 255, 0.05)',
            padding: '6px 12px',
            borderRadius: 6,
            maxWidth: 280,
            overflow: 'hidden',
          }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {status?.qr_url}
            </span>
            <button
              onClick={handleCopyUrl}
              style={{
                background: 'none',
                border: 'none',
                color: copied ? '#10b981' : 'var(--text-muted)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                padding: 2,
              }}
              title="Copy URL"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        </div>
      )}

      {/* Two-Way Dual-Screen Transfer Guide */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 10,
        maxWidth: 460,
        width: '100%',
      }}>
        <div style={{
          background: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid var(--border-color, #282c39)',
          borderRadius: 8,
          padding: 12,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#38bdf8', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>📤 Send to Mobile</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            Press <b>F5 (Copy)</b> or drag files from your other pane here.
            <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
              Staged files appear here and on your phone with a 1-tap save button.
            </div>
          </div>
        </div>

        <div style={{
          background: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid var(--border-color, #282c39)',
          borderRadius: 8,
          padding: 12,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#10b981', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>📥 Receive on PC</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            On your phone, tap <b>"Choose Photo or File"</b>.
            <div style={{ color: '#10b981', marginTop: 4, fontWeight: 500 }}>
              Saves to: {status?.incoming_label || 'Downloads'} {status?.is_second_pane ? '(Second Pane)' : ''}
            </div>
          </div>
        </div>
      </div>

      {/* Workflow tips */}
      <div style={{
        background: 'rgba(255, 255, 255, 0.02)',
        border: '1px solid var(--border-color, #282c39)',
        borderRadius: 8,
        padding: '10px 14px',
        fontSize: 11,
        color: 'var(--text-dim)',
        maxWidth: 460,
        width: '100%',
        lineHeight: 1.5,
      }}>
        <div style={{ fontWeight: 600, color: 'var(--text-main)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Wifi size={13} style={{ color: '#10b981' }} />
          <span>How Mobile Drop Dual Screen Works</span>
        </div>
        <div>• <b>Why is this panel empty?</b> Mobile browsers cannot browse your phone's internal storage directly for privacy/security. This panel acts as your <b>Transfer Bridge</b>.</div>
        <div>• Google Docs in Google Drive are <b>automatically converted to PDF</b> when transferred.</div>
        {status?.incoming_dir && (
          <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid rgba(255, 255, 255, 0.05)', wordBreak: 'break-all' }}>
            • Incoming folder: <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>{status.incoming_dir}</span>
          </div>
        )}
      </div>

      {/* Paired devices list */}
      {status && status.paired_devices && status.paired_devices.length > 0 && (
        <div style={{
          maxWidth: 460,
          width: '100%',
          background: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid var(--border-color, #282c39)',
          borderRadius: 8,
          padding: 12,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <ShieldCheck size={14} style={{ color: '#10b981' }} />
            <span>Paired Devices (Permanent Connection)</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {status.paired_devices.map((dev) => (
              <div key={dev.id} style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                background: 'rgba(255, 255, 255, 0.03)',
                borderRadius: 6,
                fontSize: 12,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Smartphone size={14} style={{ color: '#10b981' }} />
                  <span style={{ fontWeight: 500 }}>{dev.name}</span>
                  <span style={{ fontSize: 10, color: '#10b981', background: 'rgba(16, 185, 129, 0.1)', padding: '2px 6px', borderRadius: 4 }}>
                    Auto-reconnects
                  </span>
                </div>
                <button
                  onClick={() => handleRevoke(dev.id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#ef4444',
                    cursor: 'pointer',
                    fontSize: 11,
                    padding: '2px 6px',
                  }}
                  title="Forget this phone"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
