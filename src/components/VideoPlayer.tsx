import React, { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import {
  Camera,
  Captions,
  Circle,
  FastForward,
  FolderOpen,
  Pause,
  Play,
  Rewind,
  Square,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { FileItem } from '../types';
import {
  AbState,
  SPEEDS,
  SUBTITLE_EXTENSIONS,
  abClick,
  abLoopTarget,
  clampTime,
  formatTime,
  srtToVtt,
  timeForFileName,
} from '../video';

interface VideoPlayerProps {
  item: FileItem;
  siblings: FileItem[]; // the other files of the folder (to find a subtitle with the same name)
  onToggleFullScreen: () => void;
}

interface SubtitleEntry {
  name: string;
  path: string;
}

const VOLUME_KEY = 'boonsh_video_volume';
const VIDEO_DIALOG_FILTER = 'Video files|*.mp4;*.m4v;*.mov;*.webm;*.ogv;*.mkv;*.avi;*.wmv;*.mpg;*.mpeg;*.3gp;*.ts|All files|*.*';
const SUBTITLE_DIALOG_FILTER = 'Subtitles|*.srt;*.vtt|All files|*.*';

const stemOf = (name: string) => name.replace(/\.[^.]+$/, '');

function loadVolume(): { volume: number; muted: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(VOLUME_KEY) || 'null');
    if (v && typeof v.volume === 'number') return { volume: Math.min(Math.max(v.volume, 0), 1), muted: !!v.muted };
  } catch {
    /* storage can be unavailable */
  }
  return { volume: 1, muted: false };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ item, siblings, onToggleFullScreen }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [filePath, setFilePath] = useState<string>(item.path); // "Open medium" can replace it
  const [fileName, setFileName] = useState<string>(item.name);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [{ volume, muted }, setVol] = useState(loadVolume);
  const [rate, setRate] = useState(1);
  const [ab, setAb] = useState<AbState>({ a: null, b: null });
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [message, setMessage] = useState<{ text: string; folder?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // subtitles
  const [subs, setSubs] = useState<SubtitleEntry[]>([]);
  const [subIndex, setSubIndex] = useState(-1); // -1 = off
  const [subUrl, setSubUrl] = useState<string | null>(null);
  const [subMenu, setSubMenu] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recStartRef = useRef(0);
  const recAbEndRef = useRef<number | null>(null);
  const abRef = useRef(ab);
  abRef.current = ab;
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const messageTimer = useRef<number | null>(null);

  const src = convertFileSrc(filePath);

  const say = useCallback((text: string, folder?: string) => {
    setMessage({ text, folder });
    if (messageTimer.current) window.clearTimeout(messageTimer.current);
    messageTimer.current = window.setTimeout(() => setMessage(null), 6000);
  }, []);

  // ---- volume (remembered between sessions) ----
  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.volume = volume;
      v.muted = muted;
    }
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume, muted }));
    } catch {
      /* ignore */
    }
  }, [volume, muted]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate]);

  // ---- subtitles: a .srt / .vtt next to the video with the same name is picked up by itself ----
  useEffect(() => {
    const stem = stemOf(item.name).toLowerCase();
    const found = siblings
      .filter((f) => !f.is_dir && SUBTITLE_EXTENSIONS.includes(f.ext.toLowerCase()))
      .filter((f) => {
        const s = stemOf(f.name).toLowerCase();
        return s === stem || s.startsWith(stem + '.');
      })
      .map((f) => ({ name: f.name, path: f.path }));
    setSubs(found);
    setSubIndex(found.length > 0 ? 0 : -1);
    // only when the video itself changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.path]);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    if (subIndex < 0 || !subs[subIndex]) {
      setSubUrl(null);
      return;
    }
    invoke<string>('read_subtitle', { path: subs[subIndex].path })
      .then((text) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([srtToVtt(text)], { type: 'text/vtt' }));
        setSubUrl(url);
      })
      .catch((e) => {
        if (!cancelled) {
          setSubUrl(null);
          say(`Could not read the subtitle: ${e}`);
        }
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [subIndex, subs, say]);

  // ---- transport ----
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const seekBy = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = clampTime(v.currentTime + delta, v.duration);
  }, []);

  const stop = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
  }, []);

  // ---- picture ----
  const capture = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) {
      say('Nothing to capture yet.');
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      canvas.getContext('2d')!.drawImage(v, 0, 0, canvas.width, canvas.height);
      const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) throw new Error('could not make the picture');
      const saved = await invoke<string>('save_capture', {
        videoPath: filePathRef.current,
        name: `${stemOf(fileName)}_${timeForFileName(v.currentTime)}.png`,
        data: await blobToBase64(blob),
      });
      say(`Picture saved: ${saved}`, saved.replace(/\\[^\\]+$/, ''));
    } catch (e) {
      say(`Capture failed: ${e}`);
    }
  }, [fileName, say]);

  // ---- recording (what is playing, as a WebM clip) ----
  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  const startRecording = useCallback(async () => {
    const v = videoRef.current as (HTMLVideoElement & { captureStream?: () => MediaStream }) | null;
    if (!v || !v.captureStream) {
      say('Recording is not supported here.');
      return;
    }
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) =>
      MediaRecorder.isTypeSupported(m)
    );
    if (!mime) {
      say('Recording is not supported here.');
      return;
    }
    try {
      const { a, b } = abRef.current;
      if (a !== null && b !== null) {
        v.currentTime = a;
        recAbEndRef.current = b;
      } else {
        recAbEndRef.current = null;
      }
      const stream = v.captureStream();
      const rec = new MediaRecorder(stream, { mimeType: mime });
      recChunksRef.current = [];
      recStartRef.current = v.currentTime;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) recChunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        setRecording(false);
        recorderRef.current = null;
        const from = recStartRef.current;
        const to = videoRef.current?.currentTime ?? from;
        const blob = new Blob(recChunksRef.current, { type: 'video/webm' });
        if (blob.size === 0) {
          say('Nothing was recorded.');
          return;
        }
        try {
          const saved = await invoke<string>('save_capture', {
            videoPath: filePathRef.current,
            name: `${stemOf(fileName)}_${timeForFileName(from)}_to_${timeForFileName(to)}.webm`,
            data: await blobToBase64(blob),
          });
          say(`Clip saved: ${saved}`, saved.replace(/\\[^\\]+$/, ''));
        } catch (e) {
          say(`Saving the clip failed: ${e}`);
        }
      };
      rec.start(1000);
      recorderRef.current = rec;
      setRecording(true);
      setRecSeconds(0);
      if (v.paused) await v.play().catch(() => {});
    } catch (e) {
      say(`Recording failed: ${e}`);
    }
  }, [fileName, say]);

  const toggleRecording = () => (recording ? stopRecording() : void startRecording());

  // the recording timer, and the A-B end of a recording or loop (checked often: timeupdate is too coarse)
  useEffect(() => {
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (!v) return;
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        setRecSeconds((s) => s + 0.1);
        const end = recAbEndRef.current;
        if (end !== null && v.currentTime >= end) {
          v.pause();
          stopRecording();
          return;
        }
      } else if (!v.paused) {
        const back = abLoopTarget(abRef.current, v.currentTime);
        if (back !== null) v.currentTime = back;
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [stopRecording]);

  // leaving the player (another file selected, preview closed) ends a recording and frees the subtitle
  useEffect(
    () => () => {
      const rec = recorderRef.current;
      if (rec && rec.state !== 'inactive') rec.stop();
      if (messageTimer.current) window.clearTimeout(messageTimer.current);
    },
    []
  );

  // ---- A-B, subtitles, open ----
  const onAb = () => {
    const v = videoRef.current;
    if (v) setAb((s) => abClick(s, v.currentTime));
  };

  const loadSubtitleFile = async () => {
    setSubMenu(false);
    const picked = await invoke<string | null>('pick_file', { title: 'Choose a subtitle file', filter: SUBTITLE_DIALOG_FILTER });
    if (!picked) return;
    const name = picked.split('\\').pop() || picked;
    const existing = subs.findIndex((s) => s.path.toLowerCase() === picked.toLowerCase());
    if (existing >= 0) {
      setSubIndex(existing);
    } else {
      setSubs((list) => [...list, { name, path: picked }]);
      setSubIndex(subs.length);
    }
  };

  const openMedium = async () => {
    const picked = await invoke<string | null>('pick_file', { title: 'Open a video', filter: VIDEO_DIALOG_FILTER });
    if (!picked) return;
    if (recorderRef.current) stopRecording();
    setError(null);
    setAb({ a: null, b: null });
    setFilePath(picked);
    setFileName(picked.split('\\').pop() || picked);
    setSubs([]);
    setSubIndex(-1);
    setCurrent(0);
    setDuration(0);
  };

  // ---- keyboard: Space, J / L (10 s), M, C, F ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (k === 'j') seekBy(-10);
      else if (k === 'l') seekBy(10);
      else if (k === 'm') setVol((s) => ({ ...s, muted: !s.muted }));
      else if (k === 'c') void capture();
      else if (k === 'f') onToggleFullScreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, capture, onToggleFullScreen]);

  const pct = (t: number | null) => (t !== null && duration > 0 ? `${(t / duration) * 100}%` : '0%');
  const abLabel = ab.a === null ? 'A-B' : ab.b === null ? `A ${formatTime(ab.a)}` : `${formatTime(ab.a)}-${formatTime(ab.b)}`;

  return (
    <div className="video-player" onClick={() => setSubMenu(false)}>
      <div className="video-stage" onDoubleClick={onToggleFullScreen}>
        {error ? (
          <div className="video-error">
            <div>{error}</div>
            <button onClick={() => void invoke('open_in_default_app', { path: filePath })}>Open in the default player</button>
          </div>
        ) : (
          <video
            ref={videoRef}
            key={filePath}
            src={src}
            crossOrigin="anonymous"
            preload="metadata"
            onClick={togglePlay}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration);
              e.currentTarget.volume = volume;
              e.currentTarget.muted = muted;
              e.currentTarget.playbackRate = rate;
            }}
            onTimeUpdate={(e) => !seeking && setCurrent(e.currentTarget.currentTime)}
            onError={() =>
              setError(
                'The built-in player cannot play this file (its format or codec is not supported). MP4 / M4V / MOV (H.264) and WebM play here.'
              )
            }
          >
            {subUrl && subIndex >= 0 && <track key={subUrl} kind="subtitles" src={subUrl} default />}
          </video>
        )}
        {recording && <div className="video-rec-badge">REC {formatTime(recSeconds)}</div>}
        {message && (
          <div
            className="video-toast"
            title={message.folder ? 'Click to open the folder' : undefined}
            onClick={() => message.folder && void invoke('open_in_default_app', { path: message.folder })}
            style={{ cursor: message.folder ? 'pointer' : 'default' }}
          >
            {message.text}
          </div>
        )}
      </div>

      {/* timing bar */}
      <div className="video-timing">
        <span className="video-time">{formatTime(current)}</span>
        <div className="video-seek">
          {ab.a !== null && (
            <div
              className="video-ab-range"
              style={{ left: pct(ab.a), width: ab.b !== null ? `calc(${pct(ab.b)} - ${pct(ab.a)})` : '2px' }}
            />
          )}
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(current, duration || 0)}
            disabled={!duration}
            onChange={(e) => {
              const t = Number(e.target.value);
              setCurrent(t);
              if (videoRef.current) videoRef.current.currentTime = t;
            }}
            onMouseDown={() => setSeeking(true)}
            onMouseUp={() => setSeeking(false)}
            onKeyDown={(e) => e.stopPropagation()}
            title="Seek"
          />
        </div>
        <span className="video-time">{formatTime(duration)}</span>
      </div>

      {/* buttons */}
      <div className="video-controls">
        <div className="video-controls-left">
          <button onClick={togglePlay} title={playing ? 'Pause (Space)' : 'Play (Space)'} disabled={!!error}>
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button onClick={() => seekBy(-10)} title="Back 10 seconds (J)" disabled={!!error}>
            <Rewind size={14} />
            <span className="video-btn-num">10</span>
          </button>
          <button onClick={stop} title="Stop" disabled={!!error}>
            <Square size={13} />
          </button>
          <button onClick={() => seekBy(10)} title="Forward 10 seconds (L)" disabled={!!error}>
            <span className="video-btn-num">10</span>
            <FastForward size={14} />
          </button>
          <span className="video-sep" />
          <button onClick={() => void capture()} title="Capture the picture (C)" disabled={!!error}>
            <Camera size={14} />
          </button>
          <button
            onClick={toggleRecording}
            className={recording ? 'active recording' : ''}
            title={
              recording
                ? 'Stop recording and save the clip'
                : ab.a !== null && ab.b !== null
                  ? 'Record the A-B part as a WebM clip'
                  : 'Record what is playing as a WebM clip'
            }
            disabled={!!error}
          >
            <Circle size={13} fill={recording ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={onAb}
            className={ab.a !== null ? 'active' : ''}
            title={
              ab.a === null
                ? 'A-B loop: click to set the start (A)'
                : ab.b === null
                  ? 'Click to set the end (B); the part then repeats'
                  : 'Click to clear the A-B loop'
            }
            disabled={!!error}
          >
            <span className="video-ab-text">{abLabel}</span>
          </button>
          <div className="video-sub-wrap">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setSubMenu((v) => !v);
              }}
              className={subIndex >= 0 ? 'active' : ''}
              title="Subtitles"
            >
              <Captions size={15} />
            </button>
            {subMenu && (
              <div className="video-menu" onClick={(e) => e.stopPropagation()}>
                <div
                  className={`video-menu-item ${subIndex < 0 ? 'on' : ''}`}
                  onClick={() => {
                    setSubIndex(-1);
                    setSubMenu(false);
                  }}
                >
                  Off
                </div>
                {subs.map((s, i) => (
                  <div
                    key={s.path}
                    className={`video-menu-item ${subIndex === i ? 'on' : ''}`}
                    title={s.path}
                    onClick={() => {
                      setSubIndex(i);
                      setSubMenu(false);
                    }}
                  >
                    {s.name}
                  </div>
                ))}
                <div className="video-menu-item" onClick={() => void loadSubtitleFile()}>
                  Load a subtitle file...
                </div>
              </div>
            )}
          </div>
          <button
            onClick={() => setRate(SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length])}
            title="Playback speed (click to change)"
            disabled={!!error}
          >
            <span className="video-btn-num">{rate}x</span>
          </button>
        </div>

        <div className="video-controls-right">
          <button onClick={() => setVol((s) => ({ ...s, muted: !s.muted }))} title={muted ? 'Unmute (M)' : 'Mute (M)'}>
            {muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
          <input
            type="range"
            className="video-volume"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => setVol({ volume: Number(e.target.value), muted: false })}
            onKeyDown={(e) => e.stopPropagation()}
            title={`Volume ${Math.round((muted ? 0 : volume) * 100)}%`}
          />
          <button onClick={() => void openMedium()} title="Open another video file...">
            <FolderOpen size={15} />
          </button>
        </div>
      </div>
    </div>
  );
};
