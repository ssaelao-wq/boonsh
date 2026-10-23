import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  Braces,
  FolderOpen,
  HardDrive,
  History,
  Lock,
  Search,
  SquareTerminal,
  TerminalSquare,
  Zap,
} from 'lucide-react';
import { KIND_LABEL, PREFIXES, PaletteItem, PaletteKind, highlightRuns, rankItems } from '../palette';

const ICON: Record<PaletteKind, (size: number) => React.ReactElement> = {
  action: (s) => <Zap size={s} style={{ color: '#f59e0b' }} />,
  command: (s) => <TerminalSquare size={s} style={{ color: '#22c55e' }} />,
  var: (s) => <Braces size={s} style={{ color: '#a855f7' }} />,
  const: (s) => <Lock size={s} style={{ color: '#a855f7' }} />,
  quick: (s) => <Bookmark size={s} style={{ color: '#f97316' }} />,
  recent: (s) => <History size={s} style={{ color: '#0ea5e9' }} />,
  drive: (s) => <HardDrive size={s} style={{ color: '#64748b' }} />,
  tab: (s) => <SquareTerminal size={s} style={{ color: '#22c55e' }} />,
  path: (s) => <FolderOpen size={s} style={{ color: 'var(--folder-stroke)' }} />,
  search: (s) => <Search size={s} style={{ color: '#06b6d4' }} />,
};

// Ctrl+Shift+P: a box at the top with one fuzzy-filtered list (src/palette.ts). Up / Down / PageUp / PageDown move,
// Enter runs, Esc (or a click outside) closes. `items` are built by App when the palette opens; `extra(query)` adds
// the items made from the typed text (open a typed folder, search for it).
export function CommandPalette({
  items,
  extra,
  recent,
  onRun,
  onClose,
}: {
  items: PaletteItem[];
  extra: (query: string) => PaletteItem[];
  recent: string[];
  onRun: (item: PaletteItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const ranked = useMemo(() => {
    const typed = extra(query);
    const found = rankItems(items, query, recent);
    // a typed folder goes first (it is what the user typed); a search for the text goes last
    return [
      ...typed.filter((i) => i.kind === 'path').map((item) => ({ item, hits: [] })),
      ...found,
      ...typed.filter((i) => i.kind !== 'path').map((item) => ({ item, hits: [] })),
    ];
  }, [items, query, recent, extra]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    listRef.current?.querySelector('.palette-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [active, ranked]);

  const run = (k: number) => {
    const r = ranked[k];
    if (r) onRun(r.item);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = ranked.length;
    const move = (to: number) => {
      e.preventDefault();
      if (n > 0) setActive(((to % n) + n) % n);
    };
    if (e.key === 'ArrowDown') move(active + 1);
    else if (e.key === 'ArrowUp') move(active - 1);
    else if (e.key === 'PageDown') move(Math.min(n - 1, active + 8));
    else if (e.key === 'PageUp') move(Math.max(0, active - 8));
    else if (e.key === 'Enter') {
      e.preventDefault();
      run(active);
    } else if (e.key === 'Escape' || (e.key.toLowerCase() === 'p' && e.ctrlKey && e.shiftKey)) {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') e.preventDefault(); // keep the focus in the box
    e.stopPropagation(); // the app's own keys (F5, Delete ...) must not act while the palette is open
  };

  return (
    <div className="palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="palette-input-row">
          <Search size={15} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type an action, a command, a folder or a variable…"
            spellCheck={false}
            aria-controls="palette-list"
          />
        </div>
        <div className="palette-list" id="palette-list" ref={listRef} role="listbox">
          {ranked.length === 0 && <div className="palette-empty">Nothing matches.</div>}
          {ranked.map(({ item, hits }, k) => (
            <div
              key={item.id}
              className={`palette-row ${k === active ? 'active' : ''}`}
              role="option"
              aria-selected={k === active}
              onMouseMove={() => k !== active && setActive(k)}
              onClick={() => run(k)}
            >
              <span className="palette-icon">{ICON[item.kind](15)}</span>
              <span className="palette-text">
                <span className="palette-title">
                  {highlightRuns(item.title, hits).map((r, i) =>
                    r.hit ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>
                  )}
                </span>
                {item.detail && <span className="palette-detail">{item.detail}</span>}
              </span>
              {item.shortcut && <kbd className="palette-key">{item.shortcut}</kbd>}
              <span className="palette-kind">{KIND_LABEL[item.kind]}</span>
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span>↑↓ move · Enter run · Esc close</span>
          <span>
            {PREFIXES.map((p) => (
              <span key={p.char} className="palette-prefix" title={`Start with ${p.char} to show only ${p.hint}`}>
                <b>{p.char}</b> {p.hint}
              </span>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
