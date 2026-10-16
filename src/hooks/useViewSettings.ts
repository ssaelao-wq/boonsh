import { useState } from 'react';
import { GroupSpec, Bucket, loadGroups, saveGroups } from '../grouping';
import {
  ColumnId,
  ColumnPrefs,
  DateColumn,
  DateMode,
  SortLevel,
  DEFAULT_SORT,
  loadPrefs,
  savePrefs,
  loadSort,
  saveSort,
} from '../columns';
import { ViewMode } from '../types';

// How the file panel looks: theme, view mode, the sort levels, the columns and the group view. All saved.
export function useViewSettings() {
  const [theme, setThemeState] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('boonsh_theme');
    return saved === 'light' ? 'light' : 'dark';
  });
  const setTheme = (t: 'dark' | 'light') => {
    setThemeState(t);
    localStorage.setItem('boonsh_theme', t);
  };
  const [viewMode, setViewModeState] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('boonsh_view_mode');
    return (saved === 'tiles' || saved === 'thumbnails' || saved === 'details') ? saved : 'details';
  });
  const setViewMode = (mode: ViewMode) => {
    setViewModeState(mode);
    localStorage.setItem('boonsh_view_mode', mode);
  };

  // Smart sort: a list of levels (column + direction), and which columns the file panel shows. Both are saved.
  const [sortLevels, setSortLevels] = useState<SortLevel[]>(loadSort);
  const [colPrefs, setColPrefs] = useState<ColumnPrefs>(loadPrefs);
  const updateSort = (next: SortLevel[]) => {
    setSortLevels(next);
    saveSort(next);
  };
  // Group view: header rows over the files. Separate from the sort, saved, and kept for every folder and search
  // result until the user cancels it. The layers follow the sort numbers of the grouped columns.
  const [groups, setGroups] = useState<GroupSpec[]>(loadGroups);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()); // ids of folded groups (this session)
  const updateGroups = (next: GroupSpec[]) => {
    setGroups(next);
    saveGroups(next);
    setCollapsed(new Set());
  };
  const groupColumn = (col: ColumnId, buckets: Bucket[]) => {
    const rest = groups.filter((g) => g.column !== col);
    if (buckets.length === 0) {
      updateGroups(rest); // nothing ticked any more: stop grouping this column
      return;
    }
    updateGroups([...rest, { column: col, buckets }]);
    // the sort numbers decide the layer order, so a grouped column gets a number (the next one) if it has none
    if (!sortLevels.some((l) => l.column === col)) updateSort([...sortLevels, { column: col, order: 'asc' }]);
  };
  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const updatePrefs = (next: ColumnPrefs) => {
    setColPrefs(next);
    savePrefs(next);
    // a hidden column should not keep sorting or grouping invisibly
    const kept = sortLevels.filter((l) => next.visible.includes(l.column));
    if (kept.length !== sortLevels.length) updateSort(kept.length ? kept : DEFAULT_SORT);
    const keptGroups = groups.filter((g) => next.visible.includes(g.column));
    if (keptGroups.length !== groups.length) updateGroups(keptGroups);
  };
  const setDateMode = (col: DateColumn, kind: 'dateSort' | 'dateShow', mode: DateMode) =>
    updatePrefs({ ...colPrefs, [kind]: { ...colPrefs[kind], [col]: mode } });
  const hideColumn = (col: ColumnId) => {
    if (col === 'name') return;
    updatePrefs({ ...colPrefs, visible: colPrefs.visible.filter((c) => c !== col) });
  };

  return {
    theme,
    setTheme,
    viewMode,
    setViewMode,
    sortLevels,
    updateSort,
    colPrefs,
    updatePrefs,
    groups,
    updateGroups,
    groupColumn,
    collapsed,
    setCollapsed,
    toggleGroup,
    setDateMode,
    hideColumn,
  };
}
