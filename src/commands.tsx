import React from 'react';
import { Folder, Globe, Cpu, Wrench } from 'lucide-react';

export interface CommandItem {
  id: string;
  name: string;
  insertText: string; // text typed into the terminal when the command is picked
  description: string;
  usage: string;
}

export type CommandGroupIcon = 'folder' | 'globe' | 'cpu' | 'wrench';

export interface CommandGroup {
  category: string;
  icon: CommandGroupIcon;
  items: CommandItem[];
}

const STORAGE_KEY = 'boonsh_commands';

export const DEFAULT_COMMAND_GROUPS: CommandGroup[] = [
  {
    category: 'Basic Commands',
    icon: 'folder',
    items: [
      { id: 'basic-ren', name: 'ren (rename)', insertText: 'ren ', description: 'Rename a file or folder', usage: 'ren "oldname.txt" "newname.txt"' },
      { id: 'basic-del', name: 'del (delete)', insertText: 'del ', description: 'Delete a file or folder', usage: 'del "filename.txt"' },
      { id: 'basic-copy', name: 'copy', insertText: 'copy ', description: 'Copy file or folder to location', usage: 'copy "source.txt" "destination.txt"' },
      { id: 'basic-move', name: 'move', insertText: 'move ', description: 'Move file or directory', usage: 'move "source.txt" "destination.txt"' },
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

// Saved groups are user-edited; the group set itself is fixed (always the default groups, in order).
export function loadCommandGroups(): CommandGroup[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaults();
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return cloneDefaults();
    return DEFAULT_COMMAND_GROUPS.map((def) => {
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
        }));
      return { ...def, items };
    });
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
