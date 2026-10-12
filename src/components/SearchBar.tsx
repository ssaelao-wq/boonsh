import React, { useState, useRef } from 'react';
import { Search, HelpCircle, FolderTree } from 'lucide-react';
import { SEARCH_EXAMPLES } from './HeaderBar';

interface SearchBarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchError: string;
  searchNotice: string;
  searching: boolean;
  includeSubfolders: boolean;
  onToggleIncludeSubfolders: () => void;
  onClose: () => void; // Esc: the same as the header's Toggle Search Bar button (clears the search)
}

// The search bar at the bottom of the file panel (shown by the header's Toggle Search Bar button): a one-line
// box, the ? cheat sheet and the Subfolders switch. Messages and the cheat sheet open upwards, over the files.
export const SearchBar: React.FC<SearchBarProps> = ({
  searchQuery,
  onSearchChange,
  searchError,
  searchNotice,
  searching,
  includeSubfolders,
  onToggleIncludeSubfolders,
  onClose,
}) => {
  const [showHelp, setShowHelp] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Clicking a cheat-sheet example appends it to the query
  const insertExample = (example: string) => {
    const q = searchQuery.trim();
    onSearchChange(q ? `${q} ${example}` : example);
    setShowHelp(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div className="search-bar">
      <div className="search-bar-field">
        <Search size={14} className="search-bar-icon" />
        <input
          ref={inputRef}
          type="text"
          spellCheck={false}
          className={`search-bar-input${searchError ? ' search-input-error' : ''}`}
          placeholder="Search name, filetype:exe, path:legal, input:.\folder ..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
          title={searchError || 'Type a name or filters. Click ? for all options. Esc closes the search.'}
          autoFocus
        />
        {searchError ? (
          <div className="search-error-bubble">{searchError}</div>
        ) : searchNotice ? (
          <div className="search-notice-bubble">{searchNotice}</div>
        ) : (
          searching && <div className="search-status-bubble">Searching...</div>
        )}
      </div>

      <button className={showHelp ? 'active' : ''} onClick={() => setShowHelp((v) => !v)} title="Search options & examples">
        <HelpCircle size={14} />
      </button>
      {showHelp && (
        <>
          <div className="context-menu-overlay" onClick={() => setShowHelp(false)} />
          <div className="search-help">
            <div className="search-help-title">Search options (click one to add it)</div>
            {SEARCH_EXAMPLES.map(([example, desc]) => (
              <div key={example} className="search-help-row" onClick={() => insertExample(example)}>
                <code>{example}</code>
                <span>{desc}</span>
              </div>
            ))}
            <div className="search-help-footer">
              Separate terms with spaces; all of them must match. Dates are the modified date in local
              time. Short forms: name:, size:, type:, ext:, date: (path: has none). Lists like jpg,png may have spaces around the comma. Without input: the search runs in the current folder. The Subfolders button searches up to 8
              levels deep, showing at most 300 results.
            </div>
          </div>
        </>
      )}

      <button
        className={includeSubfolders ? 'active' : ''}
        onClick={onToggleIncludeSubfolders}
        title={includeSubfolders ? 'Subfolders: ON (Click to search current folder only)' : 'Subfolders: OFF (Click to search subfolders)'}
      >
        <FolderTree size={14} />
      </button>
    </div>
  );
};
