import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { tabColor } from '../tabColors';
import { SplitCell, SplitDir, canSplitCell, cellRank, closeCell } from '../splitLayout';
import { TermTab } from '../types';

// ---- Command line tabs ----
// Each tab is its own shell. The active tab is the one the file panel follows, the one GUI navigation sends
// `cd` to, and the one commands/paths are typed into. Refs are updated together with the state so code that
// runs right after a change (select a new tab, then navigate) already sees it.
// `onFollow`: the file panel should show this tab's folder (it became the active one).
export function useTerminalTabs({
  currentPathRef,
  pendingCmdRef,
  onFollow,
}: {
  currentPathRef: React.MutableRefObject<string>;
  pendingCmdRef: React.MutableRefObject<string | null>;
  onFollow: (t: TermTab) => void;
}) {
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const tabsRef = useRef<TermTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const tabCounterRef = useRef(0);
  const tabColorRef = useRef(0); // next color of the rotation
  const userNameRef = useRef('User');
  const firstTabRef = useRef(false);
  const appLevelRef = useRef<'admin' | 'normal'>('normal'); // the login boonsh itself runs with
  // Per tab: true while its shell sits at the prompt, false while a command or program (claude, vim, npm run dev
  // ...) is running. Keys sent to a running program would be typed into it, so a cd is held back until the
  // prompt returns.
  const atPromptRef = useRef<Record<string, boolean>>({});
  // Per tab: the folder the GUI moved to while a program was running; the shell is told when its prompt is back.
  const heldCdRef = useRef<Record<string, string | null>>({});

  const updateTabs = (next: TermTab[]) => {
    tabsRef.current = next;
    setTabs(next);
  };
  const activate = (id: string | null) => {
    activeTabIdRef.current = id;
    setActiveTabId(id);
  };

  // Type into the active tab's shell
  const ptyWrite = (data: string): Promise<unknown> => {
    const id = activeTabIdRef.current;
    return id ? invoke('pty_write', { id, data }) : Promise.resolve();
  };

  const newTab = () => {
    const id = `tab${++tabCounterRef.current}`;
    atPromptRef.current[id] = true;
    updateTabs([
      ...tabsRef.current,
      {
        id,
        name: userNameRef.current,
        cwd: currentPathRef.current,
        level: appLevelRef.current,
        color: tabColor(tabColorRef.current++),
      },
    ]);
    pendingCmdRef.current = null;
    activate(id);
  };

  // Split Screen: a tab splits Left-Right or Top-Bottom, and each of its two screens can be split once more the
  // other way (at most four). A new screen starts like a new tab (same login as the app, the folder of the screen
  // it came from) and takes the tab's color. The screens of a tab stay together in `tabs`, the first one first.
  // `members` replaces the screens of the tab `headId` (at the place of its first screen).
  const replaceGroup = (list: TermTab[], headId: string, members: TermTab[]) => {
    const at = list.findIndex((t) => t.id === headId || t.splitOf === headId);
    const rest = list.filter((t) => t.id !== headId && t.splitOf !== headId);
    const sorted = [...members].sort((a, b) => cellRank(a.cell) - cellRank(b.cell));
    return [...rest.slice(0, at), ...sorted, ...rest.slice(at)];
  };
  const newPane = (from: TermTab, headId: string, color: string, cell: SplitCell): TermTab => {
    const id = `tab${++tabCounterRef.current}`;
    atPromptRef.current[id] = true;
    return {
      id,
      name: userNameRef.current,
      cwd: from.cwd || currentPathRef.current,
      level: appLevelRef.current,
      color,
      splitOf: headId,
      cell,
    };
  };
  const splitTab = (mainId: string, dir: SplitDir) => {
    const list = tabsRef.current;
    const main = list.find((t) => t.id === mainId);
    if (!main || main.splitOf || main.cell) return;
    const pane = newPane(main, mainId, main.color, 'b');
    updateTabs(replaceGroup(list, mainId, [{ ...main, splitDir: dir, cell: 'a' }, pane]));
    pendingCmdRef.current = null;
    activate(pane.id);
    onFollow(pane);
  };
  // Split one screen of a split tab (a half that is not split yet) across the first split
  const splitPane = (paneId: string) => {
    const list = tabsRef.current;
    const p = list.find((t) => t.id === paneId);
    if (!p || !canSplitCell(p.cell)) return;
    const headId = p.splitOf ?? p.id;
    const head = list.find((t) => t.id === headId);
    if (!head) return;
    const pane = newPane(p, headId, head.color, `${p.cell}2`);
    const members = list
      .filter((t) => t.id === headId || t.splitOf === headId)
      .map((t) => (t.id === p.id ? { ...t, cell: `${p.cell}1` as SplitCell } : t));
    updateTabs(replaceGroup(list, headId, [...members, pane]));
    pendingCmdRef.current = null;
    activate(pane.id);
    onFollow(pane);
  };

  const selectTab = (id: string) => {
    if (id === activeTabIdRef.current) return;
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t) return;
    pendingCmdRef.current = null;
    activate(id);
    onFollow(t);
  };

  const lastRespawnRef = useRef(0);
  const removeTab = (id: string, byExit = false) => {
    const list = tabsRef.current;
    const idx = list.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const gone = list[idx];
    delete atPromptRef.current[id];
    delete heldCdRef.current[id];
    // One screen of a split tab closes: the others take its room (closeCell). The first screen left owns the tab
    // header, with the tab's name and color; a lone screen left is a plain tab again.
    const headId = gone.splitOf ?? gone.id;
    const group = list.filter((t) => t.id === headId || t.splitOf === headId);
    if (group.length > 1) {
      const head = group.find((t) => t.id === headId) ?? gone;
      const rest = group.filter((t) => t.id !== id);
      const res = gone.cell ? closeCell(head.splitDir ?? 'lr', group.flatMap((t) => (t.cell ? [t.cell] : [])), gone.cell) : null;
      let members: TermTab[];
      if (!res || rest.length === 1) {
        members = [{ ...rest[0], splitOf: undefined, splitDir: undefined, cell: undefined, name: head.name, color: head.color }];
      } else {
        const moved = rest
          .map((t) => ({ ...t, cell: (t.cell && res.moves[t.cell]) || t.cell }))
          .sort((a, b) => cellRank(a.cell) - cellRank(b.cell));
        const first = moved[0];
        members = moved.map((t) =>
          t === first
            ? { ...t, splitOf: undefined, splitDir: res.dir, name: head.name, color: head.color }
            : { ...t, splitOf: first.id, splitDir: undefined }
        );
      }
      updateTabs(replaceGroup(list, headId, members));
      if (activeTabIdRef.current === id) {
        // the screen that took the closed one's room (its partner in the same half), else the first one
        const half = gone.cell?.[0];
        const next = members.find((t) => half && t.cell?.[0] === half) ?? members[0];
        pendingCmdRef.current = null;
        activate(next.id);
        onFollow(next);
      }
      return;
    }
    const next = list.filter((t) => t.id !== id);
    updateTabs(next);
    if (next.length === 0) {
      // There is always one command line: the last tab going away leaves a fresh one. A shell that dies at once
      // (a broken install) must not respawn in a loop, so a tab that ended on its own gets one only every 3 s.
      pendingCmdRef.current = null;
      activate(null);
      if (!byExit || Date.now() - lastRespawnRef.current > 3000) {
        lastRespawnRef.current = Date.now();
        newTab();
      }
      return;
    }
    if (activeTabIdRef.current === id) {
      const near = next[idx] ?? next[idx - 1] ?? null;
      // a split tab next to it: go to its first screen
      const neighbor = near?.splitOf ? next.find((t) => t.id === near.splitOf) ?? near : near;
      pendingCmdRef.current = null;
      activate(neighbor ? neighbor.id : null);
      if (neighbor) onFollow(neighbor);
    }
  };

  const RUNNING_MSG = 'A program is still running in this tab. Close it anyway?';
  // Close a whole tab (all its screens when it is split)
  const closeTab = (id: string) => {
    const others = tabsRef.current.filter((t) => t.splitOf === id).map((t) => t.id);
    if ([id, ...others].some((x) => atPromptRef.current[x] === false) && !window.confirm(RUNNING_MSG)) return;
    if (others.length) {
      if (others.includes(activeTabIdRef.current ?? '')) activate(id); // the file panel then follows the next tab only once
      for (const x of others) {
        delete atPromptRef.current[x];
        delete heldCdRef.current[x];
      }
      updateTabs(
        tabsRef.current
          .filter((t) => t.splitOf !== id)
          .map((t) => (t.id === id ? { ...t, splitDir: undefined, cell: undefined } : t))
      );
    }
    removeTab(id);
  };
  // Close one screen of a split tab
  const closePane = (id: string) => {
    if (atPromptRef.current[id] === false && !window.confirm('A program is still running in this screen. Close it anyway?')) return;
    removeTab(id);
  };
  const closeAllTabs = () => {
    if (tabsRef.current.some((t) => atPromptRef.current[t.id] === false) && !window.confirm(RUNNING_MSG)) return;
    updateTabs([]);
    activate(null);
    atPromptRef.current = {};
    heldCdRef.current = {};
    pendingCmdRef.current = null;
    newTab(); // there is always one command line
  };
  // Give a tab a new shell with the other login: same place in the bar, same name and folder, new id (so the old
  // shell is ended and a new one starts). Only this tab changes; the others keep running as they are.
  const replaceTab = (oldId: string, level: 'admin' | 'normal') => {
    const list = tabsRef.current;
    if (!list.some((t) => t.id === oldId)) return;
    const nid = `tab${++tabCounterRef.current}`;
    delete atPromptRef.current[oldId];
    delete heldCdRef.current[oldId];
    atPromptRef.current[nid] = true;
    updateTabs(
      list.map((t) =>
        t.id === oldId ? { ...t, id: nid, level } : t.splitOf === oldId ? { ...t, splitOf: nid } : t
      )
    );
    if (activeTabIdRef.current === oldId) {
      pendingCmdRef.current = null;
      activate(nid);
    }
  };
  const switchTabLevel = () => {
    const id = activeTabIdRef.current;
    const t = tabsRef.current.find((x) => x.id === id);
    if (!id || !t) return;
    if (
      atPromptRef.current[id] === false &&
      !window.confirm("Switching the login restarts this tab's command line and ends the program running in it. Continue?")
    ) {
      return;
    }
    replaceTab(id, t.level === 'admin' ? 'normal' : 'admin');
  };
  // A tab's shell could not start (the Windows permission prompt was refused ...): back to the app's own login
  const spawnFailed = (id: string, message: string) => {
    window.alert(message);
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t) return;
    if (t.level !== appLevelRef.current) replaceTab(id, appLevelRef.current);
    else removeTab(id);
  };
  const renameTab = (id: string, name: string) => {
    updateTabs(tabsRef.current.map((t) => (t.id === id ? { ...t, name } : t)));
  };
  const recolorTab = (id: string, color: string) => {
    updateTabs(tabsRef.current.map((t) => (t.id === id ? { ...t, color } : t)));
  };
  // Drag a tab to a new place in the bar (index among the tab headers); a split tab moves with all its screens
  const moveTab = (id: string, toIndex: number) => {
    const groups: TermTab[][] = [];
    for (const t of tabsRef.current) {
      if (t.splitOf && groups.length) groups[groups.length - 1].push(t);
      else groups.push([t]);
    }
    const from = groups.findIndex((g) => g[0].id === id);
    if (from < 0 || from === toIndex || toIndex < 0 || toIndex >= groups.length) return;
    const [g] = groups.splice(from, 1);
    groups.splice(toIndex, 0, g);
    updateTabs(groups.flat());
  };

  // The first tab: named after the user, opens in the default folder
  useEffect(() => {
    if (firstTabRef.current) return; // StrictMode runs effects twice in dev
    firstTabRef.current = true;
    Promise.all([
      invoke<string>('get_username')
        .then((n) => {
          userNameRef.current = n;
        })
        .catch(() => {}),
      invoke<boolean>('is_admin')
        .then((a) => {
          appLevelRef.current = a ? 'admin' : 'normal';
        })
        .catch(() => {}),
    ]).finally(newTab);
  }, []);

  return {
    tabs,
    activeTabId,
    tabsRef,
    activeTabIdRef,
    atPromptRef,
    heldCdRef,
    updateTabs,
    ptyWrite,
    newTab,
    splitTab,
    splitPane,
    selectTab,
    removeTab,
    closeTab,
    closePane,
    closeAllTabs,
    switchTabLevel,
    spawnFailed,
    renameTab,
    recolorTab,
    moveTab,
  };
}
