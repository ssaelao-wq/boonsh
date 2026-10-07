import React from 'react';
import { isHotkey } from './hotkey';
import { Folder, Globe, Cpu, Wrench } from 'lucide-react';

export interface CommandItem {
  id: string;
  name: string;
  insertText: string; // text typed into the terminal when the command is picked
  description: string;
  usage: string;
  hotkey?: string; // e.g. "Ctrl+Alt+K": types the command at the prompt from anywhere in the app
}

export type CommandGroupIcon = 'folder' | 'globe' | 'cpu' | 'wrench';

export interface CommandGroup {
  category: string;
  icon: CommandGroupIcon;
  items: CommandItem[];
  custom?: boolean; // a group the user made (can be renamed and deleted); the four built-in groups cannot
}

export const MAX_GROUP_NAME = 30;

// Returns an error message for a bad group name, or '' when it is fine. `ignore` is the group being renamed.
export function validateGroupName(name: string, groups: CommandGroup[], ignore?: string): string {
  const n = name.trim();
  if (!n) return 'Group name is required.';
  if (n.length > MAX_GROUP_NAME) return `Group name can be at most ${MAX_GROUP_NAME} characters.`;
  if (groups.some((g) => g.category !== ignore && g.category.toLowerCase() === n.toLowerCase())) {
    return `A group named "${n}" already exists.`;
  }
  return '';
}

const STORAGE_KEY = 'boonsh_commands';

export const DEFAULT_COMMAND_GROUPS: CommandGroup[] = [
  {
    category: 'Basic Commands',
    icon: 'folder',
    items: [
      { id: 'basic-ren', name: 'ren (rename)', insertText: 'ren ', description: 'Rename a file or folder', usage: 'ren "oldname.txt" "newname.txt"' },
      { id: 'basic-del', name: 'del (delete)', insertText: 'del ', description: 'Delete a file or folder', usage: 'del "filename.txt"' },
      { id: 'basic-copy', name: 'copy', insertText: 'copy {SELEC} {DEST}', description: 'Copy file or folder to location', usage: 'copy "source.txt" "destination.txt"' },
      { id: 'basic-move', name: 'move', insertText: 'move {SELEC} {DEST}', description: 'Move file or directory', usage: 'move "source.txt" "destination.txt"' },
      { id: 'basic-mkdir', name: 'mkdir', insertText: 'mkdir ', description: 'Create a new directory', usage: 'mkdir "NewFolder"' },
      { id: 'basic-dir', name: 'dir / ls', insertText: 'dir', description: 'List current folder contents', usage: 'dir' },
      { id: 'basic-cls', name: 'cls', insertText: 'cls', description: 'Clear terminal screen', usage: 'cls' },
    ],
  },
  {
    category: 'Network Commands',
    icon: 'globe',
    items: [
      { id: 'net-ping', name: 'ping', insertText: 'ping ', description: 'Test network connectivity to host', usage: 'ping google.com' },
      { id: 'net-ipconfig', name: 'ipconfig', insertText: 'ipconfig ', description: 'Display IP address configuration', usage: 'ipconfig /all' },
      { id: 'net-netstat', name: 'netstat', insertText: 'netstat ', description: 'Display active network ports & connections', usage: 'netstat -ano' },
      { id: 'net-tracert', name: 'tracert', insertText: 'tracert ', description: 'Trace network path to destination', usage: 'tracert google.com' },
      { id: 'net-nslookup', name: 'nslookup', insertText: 'nslookup ', description: 'Query DNS name server records', usage: 'nslookup google.com' },
      { id: 'net-tnc', name: 'Test-NetConnection', insertText: 'Test-NetConnection ', description: 'Test TCP port connection to host', usage: 'Test-NetConnection -ComputerName google.com -Port 80' },
    ],
  },
  {
    category: 'System Commands',
    icon: 'cpu',
    items: [
      { id: 'sys-tasklist', name: 'tasklist', insertText: 'tasklist', description: 'List all running system processes', usage: 'tasklist' },
      { id: 'sys-taskkill', name: 'taskkill', insertText: 'taskkill ', description: 'Force stop process by PID', usage: 'taskkill /PID 1234 /F' },
      { id: 'sys-systeminfo', name: 'systeminfo', insertText: 'systeminfo', description: 'Display Windows system details', usage: 'systeminfo' },
      { id: 'sys-whoami', name: 'whoami', insertText: 'whoami', description: 'Display logged-in username', usage: 'whoami' },
    ],
  },
  {
    category: 'Customize',
    icon: 'wrench',
    items: [],
  },
];

export const GroupIcon: React.FC<{ icon: CommandGroupIcon }> = ({ icon }) => {
  const style = { color: 'var(--text-muted)' };
  if (icon === 'globe') return <Globe size={13} style={style} />;
  if (icon === 'cpu') return <Cpu size={13} style={style} />;
  if (icon === 'wrench') return <Wrench size={13} style={style} />;
  return <Folder size={13} style={style} />;
};

export const newCommandId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const cloneDefaults = (): CommandGroup[] =>
  DEFAULT_COMMAND_GROUPS.map((g) => ({ ...g, items: g.items.map((i) => ({ ...i })) }));

// Saved groups are user-edited. The four built-in groups are always present, in order; groups the user added
// follow them in the order they were made.
// Built-in commands whose typed text changed in a later version. A saved command that still types just the old plain
// word (the user never edited the typed text) gets the new text; an edited one is left alone. Only the typed text
// changes, the usage hint stays as the user has it. Matched by id or, for lists saved before ids existed, by name.
const OLD_PLAIN: Record<string, string> = { move: 'move', copy: 'copy' };

function upgradeBuiltin(item: CommandItem): CommandItem {
  const key = item.id.startsWith('basic-') ? item.id.slice(6) : item.name.trim().toLowerCase();
  const word = OLD_PLAIN[key];
  if (word === undefined || item.insertText.trim().toLowerCase() !== word) return item;
  const now = DEFAULT_COMMAND_GROUPS.flatMap((g) => g.items).find((i) => i.name === word);
  return now ? { ...item, insertText: now.insertText } : item;
}

export function loadCommandGroups(): CommandGroup[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaults();
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return cloneDefaults();
    const builtin = DEFAULT_COMMAND_GROUPS.map((def) => {
      const match = saved.find((g: any) => g && g.category === def.category && Array.isArray(g.items));
      if (!match) return { ...def, items: def.items.map((i) => ({ ...i })) };
      const items: CommandItem[] = match.items
        .filter((i: any) => i && typeof i.name === 'string')
        .map((i: any) => ({
          id: typeof i.id === 'string' ? i.id : newCommandId(),
          name: i.name,
          insertText: typeof i.insertText === 'string' ? i.insertText : i.name,
          description: typeof i.description === 'string' ? i.description : '',
          usage: typeof i.usage === 'string' ? i.usage : '',
          hotkey: typeof i.hotkey === 'string' && isHotkey(i.hotkey) ? i.hotkey : undefined,
        }))
        .map(upgradeBuiltin);
      return { ...def, items };
    });
    const names = new Set(builtin.map((g) => g.category.toLowerCase()));
    const custom: CommandGroup[] = [];
    for (const g of saved) {
      if (!g || typeof g.category !== 'string' || !g.category.trim() || !Array.isArray(g.items)) continue;
      const key = g.category.trim().toLowerCase();
      if (names.has(key)) continue;
      names.add(key);
      custom.push({
        category: g.category.trim(),
        icon: 'folder',
        custom: true,
        items: g.items
          .filter((i: any) => i && typeof i.name === 'string')
          .map((i: any) => ({
            id: typeof i.id === 'string' ? i.id : newCommandId(),
            name: i.name,
            insertText: typeof i.insertText === 'string' ? i.insertText : i.name,
            description: typeof i.description === 'string' ? i.description : '',
            usage: typeof i.usage === 'string' ? i.usage : '',
            hotkey: typeof i.hotkey === 'string' && isHotkey(i.hotkey) ? i.hotkey : undefined,
          })),
      });
    }
    return [...builtin, ...custom];
  } catch {
    return cloneDefaults();
  }
}

export function saveCommandGroups(groups: CommandGroup[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // Storage unavailable: changes last for this session only
  }
}

export function resetCommandGroups(): CommandGroup[] {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  return cloneDefaults();
}
