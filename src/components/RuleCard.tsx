import React from 'react';
import { ArrowUp, ArrowDown, X, HelpCircle } from 'lucide-react';
import { ApplyTo, RULE_TITLES, RuleForm } from '../bulkRename';

interface RuleCardProps {
  rule: RuleForm;
  index: number;
  count: number;
  onChange: (patch: Record<string, unknown>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  helpOpen: boolean;
  onToggleHelp: () => void;
}

export const ApplyToSelect: React.FC<{ value: ApplyTo; onChange: (v: ApplyTo) => void }> = ({ value, onChange }) => (
  <select
    className="modal-input br-select"
    value={value}
    onChange={(e) => onChange(e.target.value as ApplyTo)}
    title="Name = the part before the extension. Folders have no extension."
  >
    <option value="name">Name only</option>
    <option value="ext">Extension only</option>
    <option value="both">Whole file name</option>
  </select>
);

// Tokens for the name template; clicking one adds it to the template
const TEMPLATE_TOKENS: { token: string; hint: string }[] = [
  { token: '{name}', hint: 'The current name without its extension' },
  { token: '{ext}', hint: 'The extension, without the dot' },
  { token: '{parent}', hint: 'The name of the folder the item is in' },
  { token: '{n:3}', hint: 'A counter with 3 digits: 001, 002... ({n} has no zero padding)' },
  { token: '{date}', hint: "The item's modified date: 2026-07-06. Try {date:yyyyMMdd}" },
  { token: '{today}', hint: "Today's date: 2026-07-06. Try {today:yyyy}" },
];

export const RuleCard: React.FC<RuleCardProps> = ({ rule, index, count, onChange, onMove, onRemove, helpOpen, onToggleHelp }) => {
  const field = (label: string, children: React.ReactNode, cls = '') => (
    <div className={`br-field ${cls}`}>
      <span className="modal-label">{label}</span>
      {children}
    </div>
  );
  const numberField = (label: string, value: string, key: string, title?: string) =>
    field(
      label,
      <input className="modal-input" inputMode="numeric" value={value} title={title} onChange={(e) => onChange({ [key]: e.target.value })} />,
      'small'
    );

  let body: React.ReactNode = null;
  switch (rule.kind) {
    case 'find':
      body = (
        <>
          <div className="br-fields">
            {field(
              'Find',
              <input
                className="modal-input br-mono"
                value={rule.find}
                onChange={(e) => onChange({ find: e.target.value })}
                placeholder={rule.regex ? 'regular expression, e.g. \\s*\\(\\d+\\)$' : 'text to find, e.g. (1)'}
              />,
              'grow'
            )}
            {field(
              'Replace with',
              <input
                className="modal-input br-mono"
                value={rule.replace}
                onChange={(e) => onChange({ replace: e.target.value })}
                placeholder={rule.regex ? 'empty = remove; $1, ${1}, $2 ...' : 'empty = remove the found text'}
              />,
              'grow'
            )}
            {field('Apply to', <ApplyToSelect value={rule.applyTo} onChange={(v) => onChange({ applyTo: v })} />)}
          </div>
          <div className="br-options">
            <label className="br-check">
              <input type="checkbox" checked={rule.regex} onChange={(e) => onChange({ regex: e.target.checked })} />
              Regular expression
            </label>
            <label className="br-check">
              <input type="checkbox" checked={rule.matchCase} onChange={(e) => onChange({ matchCase: e.target.checked })} />
              Match case
            </label>
            <label className="br-check">
              <input type="checkbox" checked={rule.allMatches} onChange={(e) => onChange({ allMatches: e.target.checked })} />
              Replace all matches
            </label>
            <button type="button" className={helpOpen ? 'active' : ''} onClick={onToggleHelp} title="Regex help and recipes">
              <HelpCircle size={13} />
              <span>Regex help</span>
            </button>
          </div>
        </>
      );
      break;

    case 'case':
      body = (
        <div className="br-fields">
          {field(
            'Case',
            <select className="modal-input br-select" value={rule.mode} onChange={(e) => onChange({ mode: e.target.value })}>
              <option value="lower">lower case</option>
              <option value="upper">UPPER CASE</option>
              <option value="title">Title Case</option>
              <option value="sentence">Sentence case</option>
            </select>,
            'grow'
          )}
          {field('Apply to', <ApplyToSelect value={rule.applyTo} onChange={(v) => onChange({ applyTo: v })} />, 'grow')}
        </div>
      );
      break;

    case 'insert_remove':
      body = (
        <>
          <div className="br-fields">
            {field(
              'Action',
              <select className="modal-input br-select" value={rule.mode} onChange={(e) => onChange({ mode: e.target.value })}>
                <option value="insert">Insert text</option>
                <option value="remove">Remove characters</option>
              </select>,
              'grow'
            )}
            {field('Apply to', <ApplyToSelect value={rule.applyTo} onChange={(v) => onChange({ applyTo: v })} />, 'grow')}
          </div>
          {rule.mode === 'insert' ? (
            <div className="br-fields">
              {field(
                'Text to insert',
                <input className="modal-input br-mono" value={rule.text} onChange={(e) => onChange({ text: e.target.value })} placeholder="e.g. 2026_" />,
                'grow'
              )}
              {field(
                'Where',
                <select className="modal-input br-select" value={rule.insertWhere} onChange={(e) => onChange({ insertWhere: e.target.value })}>
                  <option value="start">at the start</option>
                  <option value="end">at the end (before the extension)</option>
                  <option value="position">before character number...</option>
                </select>,
                'grow'
              )}
              {rule.insertWhere === 'position' && numberField('Number', rule.position, 'position', 'Counted from the start: 1 is the first character')}
            </div>
          ) : (
            <div className="br-fields">
              {numberField('How many', rule.count, 'count', 'Number of characters to remove')}
              {field(
                'From',
                <select className="modal-input br-select" value={rule.removeWhere} onChange={(e) => onChange({ removeWhere: e.target.value })}>
                  <option value="first">the start</option>
                  <option value="last">the end</option>
                  <option value="position">character number...</option>
                </select>,
                'grow'
              )}
              {rule.removeWhere === 'position' && numberField('Number', rule.position, 'position', 'Counted from the start: 1 is the first character')}
            </div>
          )}
        </>
      );
      break;

    case 'numbering':
      body = (
        <>
          <div className="br-fields">
            {numberField('Start', rule.start, 'start')}
            {numberField('Step', rule.step, 'step', 'How much the number grows for each item. 0: every item gets the same number')}
            {numberField('Digits', rule.pad, 'pad', 'Zero padding: 3 gives 001, 002 ...')}
            {field(
              'Put the number',
              <select className="modal-input br-select" value={rule.position} onChange={(e) => onChange({ position: e.target.value })}>
                <option value="suffix">after the name</option>
                <option value="prefix">before the name</option>
                <option value="replace">instead of the name</option>
              </select>,
              'grow'
            )}
            {field(
              'Separator',
              <input className="modal-input br-mono" value={rule.separator} disabled={rule.position === 'replace'} onChange={(e) => onChange({ separator: e.target.value })} />,
              'small'
            )}
          </div>
          <div className="br-options">
            <label className="br-check">
              <input type="checkbox" checked={rule.restart} onChange={(e) => onChange({ restart: e.target.checked })} />
              Start again in each folder
            </label>
            <span className="br-note">Numbers follow the order of the file panel.</span>
          </div>
        </>
      );
      break;

    case 'extension':
      body = (
        <>
          <div className="br-fields">
            {field(
              'Action',
              <select className="modal-input br-select" value={rule.mode} onChange={(e) => onChange({ mode: e.target.value })}>
                <option value="set">Set the extension to...</option>
                <option value="lower">lower case</option>
                <option value="upper">UPPER CASE</option>
                <option value="remove">Remove the extension</option>
              </select>,
              'grow'
            )}
            {rule.mode === 'set' &&
              field(
                'New extension',
                <input className="modal-input br-mono" value={rule.text} onChange={(e) => onChange({ text: e.target.value })} placeholder="e.g. jpg" />,
                'grow'
              )}
          </div>
          <div className="br-fields">
            {field(
              'Only files that now end in (optional)',
              <input
                className="modal-input br-mono"
                value={rule.only}
                onChange={(e) => onChange({ only: e.target.value })}
                placeholder="all files, or e.g. jpeg, jpe"
                title="Comma separated. Folders are never changed."
              />,
              'grow'
            )}
          </div>
        </>
      );
      break;

    case 'template':
      body = (
        <>
          <div className="br-fields">
            {field(
              'Template',
              <input
                className="modal-input br-mono"
                value={rule.template}
                onChange={(e) => onChange({ template: e.target.value })}
                placeholder="e.g. {date}_{name}"
              />,
              'grow'
            )}
            {field(
              'Builds',
              <select className="modal-input br-select" value={rule.applyTo} onChange={(e) => onChange({ applyTo: e.target.value })} title="Name only keeps the extension. Whole file name: write the extension yourself, e.g. {name}.{ext}">
                <option value="name">the name (keeps the extension)</option>
                <option value="both">the whole file name</option>
              </select>
            )}
          </div>
          <div className="br-options">
            <span className="br-note">Click to add:</span>
            {TEMPLATE_TOKENS.map((t) => (
              <button key={t.token} type="button" className="br-chip" title={t.hint} onClick={() => onChange({ template: rule.template + t.token })}>
                {t.token}
              </button>
            ))}
          </div>
          {rule.template.includes('{n') && (
            <div className="br-fields">
              {numberField('Start', rule.start, 'start', 'The first {n}')}
              {numberField('Step', rule.step, 'step', 'How much {n} grows for each item. 0: every item gets the same {n}')}
              <label className="br-check" style={{ paddingBottom: 6 }}>
                <input type="checkbox" checked={rule.restart} onChange={(e) => onChange({ restart: e.target.checked })} />
                Start again in each folder
              </label>
            </div>
          )}
          <span className="br-note">
            Dates: yyyy yy MM dd HH mm ss, e.g. {'{date:yyyyMMdd}'}. Type {'{{'} for a literal {'{'}. Items follow the order of the file panel.
          </span>
        </>
      );
      break;
  }

  return (
    <div className={`br-card ${rule.on ? '' : 'off'}`}>
      <div className="br-card-head">
        <label className="br-card-title">
          <input type="checkbox" checked={rule.on} onChange={(e) => onChange({ on: e.target.checked })} />
          <span>
            {index + 1}&nbsp; {RULE_TITLES[rule.kind]}
          </span>
        </label>
        <div className="br-card-tools">
          <button type="button" onClick={() => onMove(-1)} disabled={index === 0} title="Run this rule earlier (move up)">
            <ArrowUp size={13} />
          </button>
          <button type="button" onClick={() => onMove(1)} disabled={index === count - 1} title="Run this rule later (move down)">
            <ArrowDown size={13} />
          </button>
          <button type="button" onClick={onRemove} title="Remove this rule">
            <X size={13} />
          </button>
        </div>
      </div>
      {body}
    </div>
  );
};
