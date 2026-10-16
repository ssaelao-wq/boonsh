import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { PathVars, PathVarName, EMPTY_PATH_VARS, hasPlaceholder } from '../pathVars';
import { GlobalVarDef, loadGlobalVars, saveGlobalVars, renameInText } from '../globalVars';
import { ConstVar, loadConstVars, saveConstVars, constMap } from '../constVars';
import { CommandGroup, loadCommandGroups, saveCommandGroups, resetCommandGroups } from '../commands';

// The terminal's command list (Settings), the Global Vars ({SELEC} / {DEST} ...) and CONSTs, and typing command
// templates at the prompt. The placeholder rules are in src-tauri/src/cmdvars.rs.
export function useCommandLine({
  ptyWrite,
  currentPathRef,
  pendingCmdRef,
}: {
  ptyWrite: (data: string) => Promise<unknown>;
  currentPathRef: React.MutableRefObject<string>;
  // Command template (with {SELEC}/{DEST}) sitting untouched at the prompt. While it is set, the typed line can be
  // rewritten when a variable or the folder changes. The terminal clears it as soon as the user types.
  pendingCmdRef: React.MutableRefObject<string | null>;
}) {
  // Terminal helper commands (editable in Settings, persisted in localStorage)
  const [commandGroups, setCommandGroups] = useState<CommandGroup[]>(loadCommandGroups);
  const handleCommandGroupsChange = (groups: CommandGroup[]) => {
    setCommandGroups(groups);
    saveCommandGroups(groups);
  };
  const resetCommands = () => setCommandGroups(resetCommandGroups());

  // {SELEC} / {DEST}: path variables for terminal commands. Memory only, so they vanish when the app closes.
  const [globalVars, setGlobalVars] = useState<GlobalVarDef[]>(loadGlobalVars); // definitions (saved)
  const globalVarsRef = useRef(globalVars);
  globalVarsRef.current = globalVars;
  const [pathVars, setPathVars] = useState<PathVars>(EMPTY_PATH_VARS); // values (memory only)
  const pathVarsRef = useRef(pathVars);
  pathVarsRef.current = pathVars;
  const varNames = () => globalVarsRef.current.map((v) => v.name);
  // CONST variables ({IP} = 202.283.242.97): saved with their values, filled into commands as written
  const [constVars, setConstVars] = useState<ConstVar[]>(loadConstVars);
  const constVarsRef = useRef(constVars);
  constVarsRef.current = constVars;
  const consts = () => constMap(constVarsRef.current);
  // The command line tabs fill in placeholders typed at the prompt from these values (cmdvars.rs session file)
  useEffect(() => {
    invoke('write_vars_file', { vars: pathVars, consts: constMap(constVars) }).catch(() => {});
  }, [pathVars, constVars]);

  // Replace what is on the prompt line: Esc clears the line (PSReadLine and cmd). The pause keeps ConPTY from
  // reading Esc plus the next character as one Alt+key chord.
  const rewritePromptLine = async (text: string) => {
    await ptyWrite('\x1b');
    await new Promise((r) => setTimeout(r, 60));
    await ptyWrite(text);
  };

  // A command template as it is typed: baskets ({BASKET:name}, or a Global Var holding a basket, become the
  // basket's linked items), Global Vars and CONSTs. The rules are in src-tauri/src/cmdvars.rs, shared with
  // placeholders the user types at a PowerShell prompt. Throws when a basket is not found.
  const expandCommand = (template: string, vars = pathVarsRef.current, base = currentPathRef.current) =>
    invoke<string>('expand_command', { text: template, cwd: base, vars, consts: consts() });

  // Type a command template at the prompt, expanded against the current folder.
  const pickCommand = async (template: string) => {
    let text: string;
    try {
      text = await expandCommand(template);
    } catch (err) {
      alert(String(err));
      return;
    }
    const replace = pendingCmdRef.current !== null;
    pendingCmdRef.current = hasPlaceholder(template, varNames()) ? template : null;
    if (replace) await rewritePromptLine(text);
    else await ptyWrite(text);
  };

  const setPathVarValues = (next: PathVars) => {
    pathVarsRef.current = next;
    setPathVars(next);
    const template = pendingCmdRef.current;
    if (template !== null) {
      expandCommand(template, next)
        .then(rewritePromptLine)
        .catch(() => {});
    }
  };

  const assignPathVar = (name: PathVarName, paths: string[]) => {
    setPathVarValues({ ...pathVarsRef.current, [name]: paths });
  };

  // {OLD} -> {NEW} in every command's text and usage
  const renameInCommands = (commands: CommandGroup[], from: string, to: string) =>
    commands.map((g) => ({
      ...g,
      items: g.items.map((i) => ({
        ...i,
        insertText: renameInText(i.insertText, from, to),
        usage: renameInText(i.usage, from, to),
      })),
    }));

  // Settings added, renamed or deleted variables. A rename keeps the value and updates {OLD} in the commands;
  // a deleted variable loses its value.
  const handleGlobalVarsChange = (next: GlobalVarDef[]) => {
    const old = globalVarsRef.current;
    const values: PathVars = {};
    let commands = commandGroups;
    for (const def of next) {
      const before = old.find((o) => o.id === def.id);
      const key = before ? before.name : def.name;
      if (pathVarsRef.current[key]?.length) values[def.name] = pathVarsRef.current[key];
      if (before && before.name !== def.name) commands = renameInCommands(commands, before.name, def.name);
    }
    if (commands !== commandGroups) handleCommandGroupsChange(commands);
    globalVarsRef.current = next;
    setGlobalVars(next);
    saveGlobalVars(next);
    pendingCmdRef.current = null; // names changed under the prompt line; leave it as it is
    setPathVarValues(values);
  };

  // Settings added, renamed, edited or deleted CONST variables. A rename updates {OLD} in the commands.
  const handleConstVarsChange = (next: ConstVar[]) => {
    const old = constVarsRef.current;
    let commands = commandGroups;
    for (const def of next) {
      const before = old.find((o) => o.id === def.id);
      if (before && before.name !== def.name) commands = renameInCommands(commands, before.name, def.name);
    }
    if (commands !== commandGroups) handleCommandGroupsChange(commands);
    constVarsRef.current = next;
    setConstVars(next);
    saveConstVars(next);
  };

  return {
    commandGroups,
    handleCommandGroupsChange,
    resetCommands,
    globalVars,
    pathVars,
    pathVarsRef,
    constVars,
    handleGlobalVarsChange,
    handleConstVarsChange,
    assignPathVar,
    rewritePromptLine,
    expandCommand,
    pickCommand,
  };
}
