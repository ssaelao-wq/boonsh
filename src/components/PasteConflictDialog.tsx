import { useEffect, useState } from 'react';
import { File, Folder } from 'lucide-react';
import { Clash, PasteChoice, fillChoices, formatWhen, keepBothName } from '../paste';
import { formatSize } from '../folderSizes';

// The pop-up for a paste whose names are already taken: one clash at a time (Replace / Keep Both / Skip), with
// "Do this for the remaining clashes", like Explorer. Resolves with a choice per source path, or null = Cancel.
export function PasteConflictDialog({
  clashes,
  destName,
  onDone,
}: {
  clashes: Clash[];
  destName: string;
  onDone: (choices: Record<string, PasteChoice> | null) => void;
}) {
  const [answered, setAnswered] = useState<PasteChoice[]>([]);
  const [forAll, setForAll] = useState(false);
  const index = answered.length;
  const c = clashes[index];
  const left = clashes.length - index - 1;

  const choose = (choice: PasteChoice) => {
    const next = [...answered, choice];
    if (forAll || next.length >= clashes.length) onDone(fillChoices(clashes, next, forAll ? choice : null));
    else setAnswered(next);
  };

  // R / K / S answer, Esc cancels the paste
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      const pick: PasteChoice | null = k === 'r' ? 'replace' : k === 'k' ? 'keep' : k === 's' ? 'skip' : null;
      if (pick) {
        e.preventDefault();
        e.stopPropagation();
        choose(pick);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDone(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!c) return null;
  const mixed = c.source_is_dir !== c.target_is_dir;
  const replaceNote = c.in_paste
    ? 'The item pasted after it takes its place.'
    : mixed
    ? `The ${c.target_is_dir ? 'folder' : 'file'} in the folder goes to the Recycle Bin.`
    : c.source_is_dir
    ? 'The folders are merged: files with the same name are replaced, the others are kept.'
    : 'The file in the folder is overwritten.';
  const newer = c.source_modified && c.target_modified && c.source_modified !== c.target_modified
    ? c.source_modified > c.target_modified ? 'source' : 'target'
    : null;

  const side = (title: string, isDir: boolean, size: number, when: number, path: string, isNewer: boolean) => (
    <div className="paste-clash-side" title={path}>
      <div className="paste-clash-side-title">{title}</div>
      <div className="paste-clash-side-row">
        {isDir ? <Folder size={16} className="paste-clash-icon" /> : <File size={16} className="paste-clash-icon" />}
        <span>{isDir ? 'Folder' : formatSize(size)}</span>
      </div>
      {when > 0 && (
        <div className="paste-clash-side-when">
          {formatWhen(when)}
          {isNewer && <span className="paste-clash-newer"> (newer)</span>}
        </div>
      )}
    </div>
  );

  return (
    <div className="modal-overlay" onClick={(e) => e.stopPropagation()}>
      <div className="modal-dialog paste-clash-dialog" role="dialog" aria-label="Name already in use">
        <div className="modal-header">
          Name already in use{clashes.length > 1 ? ` (${index + 1} of ${clashes.length})` : ''}
        </div>
        <div className="modal-body">
          <div className="paste-clash-name" title={c.name}>{c.name}</div>
          <div className="modal-label">
            {c.in_paste
              ? 'Another item in this paste has the same name.'
              : `${destName} already has an item with this name.`}
          </div>
          <div className="paste-clash-sides">
            {side('Being pasted', c.source_is_dir, c.source_size, c.source_modified, c.source, newer === 'source')}
            {side(c.in_paste ? 'Pasted before it' : 'Already there', c.target_is_dir, c.target_size, c.target_modified, c.target, newer === 'target')}
          </div>
          <div className="paste-clash-choices">
            <button className="paste-clash-choice" onClick={() => choose('replace')} autoFocus>
              <b><u>R</u>eplace</b>
              <span>{replaceNote}</span>
            </button>
            <button className="paste-clash-choice" onClick={() => choose('keep')}>
              <b><u>K</u>eep Both</b>
              <span>The pasted one gets a number: {keepBothName(c.name, c.source_is_dir)} (or the next free number).</span>
            </button>
            <button className="paste-clash-choice" onClick={() => choose('skip')}>
              <b><u>S</u>kip</b>
              <span>This item is not pasted.</span>
            </button>
          </div>
          {left > 0 && (
            <label className="paste-clash-forall">
              <input type="checkbox" checked={forAll} onChange={(e) => setForAll(e.target.checked)} />
              Do this for the remaining {left} clash{left === 1 ? '' : 'es'}
            </label>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={() => onDone(null)} title="Paste nothing (Esc)">Cancel paste</button>
        </div>
      </div>
    </div>
  );
}
