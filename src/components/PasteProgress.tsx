import { useEffect, useState } from 'react';
import { ChevronsRight, Pause, Play, X } from 'lucide-react';
import { PasteProgress as Progress, SpeedSample, progressFraction, progressText, speedOf } from '../paste';

export interface PasteJob {
  id: number;
  label: string; // "Copying 12 items to Downloads"
  progress: Progress | null;
  samples: SpeedSample[]; // bytes done over the last seconds (speed and time left)
  paused: boolean;
  cancelling: boolean;
  startingNow: boolean;
}

// Running and waiting pastes, bottom right above the status bar. A job shows only after a moment, so small pastes
// do not flash a card. Copies run one at a time: a waiting card offers Start now (run beside the others); a running
// one Pause / Resume. Cancel stops it (paste_cancel): items already pasted stay, the one in progress is removed.
export function PasteProgress({
  jobs,
  onCancel,
  onPause,
  onStartNow,
}: {
  jobs: PasteJob[];
  onCancel: (id: number) => void;
  onPause: (id: number, paused: boolean) => void;
  onStartNow: (id: number) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (jobs.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [jobs.length]);
  const shown = jobs.filter((j) => now - j.id >= SHOW_AFTER_MS);
  if (shown.length === 0) return null;
  return (
    <div className="paste-progress-stack">
      {shown.map((j) => {
        const waiting = j.progress?.phase === 'queued';
        const frac = progressFraction(j.progress);
        const current = j.progress?.current.split('\\').pop() ?? '';
        return (
          <div key={j.id} className={`paste-progress ${waiting ? 'waiting' : ''}`} role="status">
            <div className="paste-progress-head">
              <span className="paste-progress-label" title={j.label}>{j.label}</span>
              {waiting ? (
                <button
                  className="paste-progress-btn"
                  onClick={() => onStartNow(j.id)}
                  disabled={j.startingNow || j.cancelling}
                  title="Copy this one now, beside the paste that is running"
                >
                  <ChevronsRight size={12} /> Start now
                </button>
              ) : (
                <button
                  className="paste-progress-btn"
                  onClick={() => onPause(j.id, !j.paused)}
                  disabled={j.cancelling || j.progress?.phase === 'done'}
                  title={j.paused ? 'Go on copying' : 'Hold the copy (also in the middle of a big file)'}
                >
                  {j.paused ? <><Play size={12} /> Resume</> : <><Pause size={12} /> Pause</>}
                </button>
              )}
              <button
                className="paste-progress-btn"
                onClick={() => onCancel(j.id)}
                disabled={j.cancelling}
                title="Stop: what is already pasted stays"
              >
                {j.cancelling ? 'Cancelling…' : <><X size={12} /> Cancel</>}
              </button>
            </div>
            <div className={`paste-progress-bar ${frac === null && !waiting && !j.paused ? 'busy' : ''} ${j.paused ? 'paused' : ''}`}>
              <div style={{ width: frac === null ? (waiting ? '0%' : undefined) : `${(frac * 100).toFixed(1)}%` }} />
            </div>
            <div className="paste-progress-text">
              <span>{progressText(j.progress, speedOf(j.samples), j.paused)}</span>
              {frac !== null && <span>{Math.floor(frac * 100)}%</span>}
            </div>
            {current && <div className="paste-progress-current" title={j.progress?.current}>{current}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** A paste that is done within this time never shows a card */
export const SHOW_AFTER_MS = 400;
