import React, { useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { marked } from 'marked';
import manualText from '../../FEATURES_SPEC.md?raw';

/** GitHub-style heading id: "## 10. Settings: customize" -> "10-settings-customize". */
const slugOf = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');

/** The user manual: FEATURES_SPEC.md shown as a page. The file is bundled with the app, so it is always the
 *  manual of this version. */
export const ManualView: React.FC = () => {
  const html = useMemo(() => marked.parse(manualText, { gfm: true, async: false }) as string, []);
  const ref = useRef<HTMLDivElement>(null);

  // give every heading an id, so the contents list and other `#...` links can jump to it
  useEffect(() => {
    const seen = new Map<string, number>();
    ref.current?.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
      const base = slugOf(h.textContent || '');
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      h.id = n === 0 ? base : `${base}-${n}`;
    });
  }, [html]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    e.preventDefault();
    if (href.startsWith('#')) {
      ref.current?.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView({ block: 'start' });
    } else if (/^https?:\/\//i.test(href)) {
      void invoke('open_in_default_app', { path: href });
    }
  };

  return (
    <div className="manual-scroll">
      <div className="manual-view" ref={ref} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
};
