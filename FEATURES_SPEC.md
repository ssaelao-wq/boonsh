# boonsh Features Specification and User Manual

This document describes everything boonsh can do, how to use it, and where its limits are. It describes **version 0.10.0**. For what changed in each release see `RELEASE.md`. For how the code is built see `CLAUDE.md`.

**boonsh** is a Windows desktop app that puts a file manager and a PowerShell terminal side by side. Browse folders on the left, type commands on the right, and the two stay in sync.

**License.** boonsh is **free software under the MIT License**: anyone may use, copy, change and share it, for free, as long as the copyright line and the license text stay with it. There is no warranty. The text is in the file `LICENSE` ("Copyright (c) 2026 Somboon L."), it is shown by the Windows installer, and it is in the app under Settings, **About** (section 10). The licenses of the libraries boonsh is built with are in `THIRD_PARTY_LICENSES.txt`, which the installer puts next to the app. Downloads (the installers) are on the project's GitHub **Releases** page: https://github.com/ssaelao-wq/boonsh/releases.

## Contents

1. [Window layout](#1-window-layout)
2. [Starting the app](#2-starting-the-app)
3. [Navigating](#3-navigating)
4. [The file panel](#4-the-file-panel)
5. [Working with files](#5-working-with-files)
6. [Right-click menus](#6-right-click-menus)
7. [Search](#7-search)
8. [Preview drawer](#8-preview-drawer)
9. [Terminal](#9-terminal)
10. [Settings: customize terminal commands](#10-settings-customize-terminal-commands)
11. [Keyboard shortcuts](#11-keyboard-shortcuts)
12. [Status bar](#12-status-bar)
13. [Appearance and saved settings](#13-appearance-and-saved-settings)
14. [Limits and known issues](#14-limits-and-known-issues)
15. [Keeping this document current](#15-keeping-this-document-current)
16. [AI Assistant](#16-ai-assistant)

---

## 1. Window layout

```
+---------------------------------------------------------------------------------+
| Header bar: up, refresh, cut/copy/paste/delete | path | search ? | view icons ... |
+------------------------------------------------+--------------------------------+
| Quick Access chips                             |  Terminal bar (Commands, user) |
+-----------------+------------------------------+                                |
| Folder tree     |  File panel                  |  PowerShell terminal           |
|                 |  (details / tiles / thumbs)  |                                |
+-----------------+------------------------------+                                |
| Preview drawer (hidden until you open it)      +--------------------------------+
|                                                |  AI Assistant (when shown)     |
+------------------------------------------------+--------------------------------+
| Status bar: counts, total size, selection, shell                                |
+---------------------------------------------------------------------------------+
```

- The app starts **maximized**. The window never scrolls; each panel scrolls on its own.
- The **window title** shows `boonsh - <path>` of the selected file, or of the current folder when nothing is selected.
- **Resizing:** drag the thin bars between panels. The bar between the left side and the terminal moves from 15% to 85% of the width. The bar between the folder tree and the file panel moves the tree width (from 100 px up to 40% of the window). The bar above the preview drawer sets its height, and the bar above the AI Assistant sets its height. Panel sizes are not saved between runs.
- The **header bar** holds, from left to right:
  - Up, Refresh | Cut, Copy, Paste, Delete
  - the path bar
  - Search (and the `?` help button when search is open)
  - Details, Tiles and Thumbnails views | file panel toggle, Preview (Eye), terminal show/hide | Settings (gear) | Theme (sun or moon), AI Assistant show/hide (sparkles, the last icon on the right; see section 16)

## 2. Starting the app

- **Normal start:** opens in your **Downloads** folder (or the current folder if Downloads doesn't exist).
- **Start in a chosen folder:** run `boonsh.exe "C:\some\folder"`. Both the file panel and the terminal open there.
- **Administrator mode (per tab):** the button at the right of the terminal bar shows the login of the **active tab**: your user name for a normal tab, a green `<name> (Admin)` for an Administrator tab. Click it to switch **that tab only** to the other login; the other tabs are not touched and boonsh does not restart. Switching to Administrator makes Windows ask for permission once (if you refuse, the tab goes back to a normal tab). The tab's shell is **restarted** in the same folder (it asks first when a program is running in it). An Administrator tab has a green shield icon on its tab, the small shield at the left of the bar turns green, and its prompt reads `admin >`. New tabs start with the login boonsh itself was started with, and the same works the other way round when boonsh was started as Administrator (a tab can be switched to a normal user). An Administrator tab runs in a small helper process; boonsh sends it your typing and shows its output, so only use it on a PC you trust.

## 3. Navigating

### Header buttons and path bar
- **Up** (folder-up icon) goes to the parent folder. It is greyed out at the top of a drive.
- **Refresh** (or F5) reloads the current folder.
- **Path bar:** shows the current path as clickable pieces (`C:\ > Users > ...`). Click any piece to jump there. Click the empty part or the pencil icon to **type a path**: Enter goes there, Esc cancels.

### Folder tree
- Shows **This PC** with all your drives. Click the arrow to expand a folder, or click the name to open it and expand it.
- The tree follows you: when you open a folder elsewhere, the tree expands to it and scrolls it into view.
- Right-click a folder: New (Folder, Text Document, Shortcut), Open, Add to Quick Access, Refresh. Right-clicking also opens that folder.

### Frequently Accessed (above the Folder Tree)
A short list of the folders you open most, so you can jump back to them in one click.
- It sits **above the Folder Tree** and lists the folder names only. Hover a folder to see its full path and how many times you have opened it.
- **Click** a folder to open it. The folder you are in is highlighted.
- **What counts as a visit:** each time a different folder becomes the open folder: a double-click, a click in the folder tree, in Quick Access or in this panel, the path bar, going up, or `cd` in the terminal. Refreshing, searching and opening the same folder again without leaving it do not count. The folder boonsh starts in counts once per start.
- **Order:** most visits first; when two folders have the same number of visits, the one opened most recently comes first.
- **How many:** the panel shows as many folders as you chose in Settings (3 to 10, default 3). If you have visited fewer folders than that, it shows only those; before the first visit it says "Folders you open often will show up here."
- **Remove a folder:** right-click it, **Remove from Frequently Accessed**. Its count goes back to **0** and builds up again from the next visit. The list stays as long as the number set in Settings, because the next most visited folder takes the empty place.
- A folder that can no longer be opened (deleted, drive gone) drops out of the list on its own the first time you click it.
- It is remembered between runs (up to 300 folders; the least used are forgotten first). Turn the panel on or off, and set the number, in Settings, **Frequently Accessed** (section 10).

### Quick Access (chips above the folders)
- One click opens the folder. At first it shows **Home, Desktop, Downloads, Documents and the C: drive**.
- **Choose what is shown:** Settings (gear), **Quick Access**: tick the items you want, untick the ones you don't (section 10).
- **Add:** right-click a folder (in the file panel or the tree) and choose *Add to Quick Access*. Right-click empty space in the file panel to add the **current** folder. 
- **Remove:** right-click a chip and choose *Remove from Quick Access* (or untick it in Settings).
- Limits: **6 items** at most, and the same folder can't be added twice. Your list is remembered, also when it is empty.

### Two-way sync with the terminal
- Open a folder in the file panel and the terminal (its active tab) runs `cd` to it.
- Type `cd` in the terminal (any form, including `cd ..`) and the file panel and tree switch to that folder when the next prompt appears.
- **Only at the prompt:** the `cd` is sent only while the terminal sits at its prompt. While you run a program in it (Claude, vim, `npm run dev`, a long command ...) boonsh does **not** type into it; the file panel still moves, and when the program ends and the prompt returns, the terminal is moved to the folder the file panel is in. boonsh knows a program is running from the moment you press Enter until the next prompt appears.

## 4. The file panel

### Auto refresh
The open folder updates by itself when another program changes it: a file saved from an app, a download that finishes, a file deleted or renamed in Explorer or from the terminal. It shows within about half a second. Your selection, the focused file and the scroll position stay as they were; a selected file that was deleted simply drops out of the selection.

- Only the open folder is watched, not its sub-folders (a change deep inside a sub-folder does not reload the list; the folder's own size and date do not change either).
- Many changes at once (a program copying hundreds of files) arrive as one update. A file that keeps growing (a long download) is updated at most every 2 seconds.
- Search results are not refreshed automatically, since they are not the folder's listing. Edit the search text to run it again, or clear it to see the folder as it is now.
- **Refresh** (F5) still works, for example for a network folder that does not report its changes.

### View modes (header icons, remembered between runs)
| View | What it shows |
| --- | --- |
| **Details** | A table with Name, Date Modified, Type and Size. |
| **Tiles** | An icon with name, type, size and date. |
| **Thumbnails** | Large cards. Image files show a real thumbnail; other files show an icon. |

### Sorting and columns (Details view)

**Basic sorting**
- **Click** a column header to sort by that column alone; **click again** to reverse (the arrow shows the direction). This works like Explorer.
- Names sort in natural order (`file2` comes before `file10`). Type sorts by the extension (folders count as "File Folder"), not by the app name, so the order does not change when the apps are looked up.
- **Folders are listed first** by default, in either direction. You can turn this off in Settings, Files Column.
- Drag the right edge of a column header to resize it (minimum 60 px).
- Date Modified is shown as `YYYY-MM-DD HH:MM` in **your local time**. Folders show `--` for size.

**Smart sort: several levels at once.** Sort by one column, then break ties with a second, then a third. For example: **file type**, then **date**, then **file name**.
- **Shift+click** (or Ctrl+click) a column header to **add it as the next level**. The headers show an arrow for the direction and, once there is more than one level, a number: `1` is the main sort, `2` breaks ties in `1`, and so on.
- Shift+click a column that is already a level to **reverse it**; Shift+click it once more to **take it out** of the sort.
- A plain click (without Shift) always starts over with that one column.
- **Right-click a column header** for the full menu:

| Menu entry | What it does |
| --- | --- |
| Sort *column* ascending / descending | Sort by this column alone. |
| Then sort by *column*: ascending / descending (level N) | Add it as the next level. If it is already a level, the entry reads **Level N: ascending / descending** and changes its direction in place. |
| Remove *column* from the sort | Takes it out of the levels (shown when there is more than one level). |
| Sort by date and time / Sort by date only (ignore the time) | Date columns only; see below. |
| Hide this column | Removes the column from the file panel (not for Name). |
| Choose columns... | Opens Settings, Files Column. |

- When two files tie on every level, the **name** decides, so the order never jumps around.
- The levels are **remembered** between runs.
- A column that is hidden stops sorting: hiding it removes it from the levels.

**Date only or date and time.** The two date columns (Date Modified, Date Created) can be compared in two ways:
- **Date and time** (the default): the exact moment decides.
- **Date only**: files from the same day count as equal, so the **next sort level** puts them in order. Example: `file1.txt` (15:00), `file2.txt` (09:00) and `file3.txt` (12:00), all modified on 2026-09-30. Sorted by Date Modified (date only) and then Name, they list as `file1`, `file2`, `file3`. Sorted by date and time, they list as `file2` (09:00), `file3` (12:00), `file1` (15:00).
- Choose it in the header right-click menu, or in Settings, Files Column, **Sort by**. The same Settings row has **Show**, to display the date only (`YYYY-MM-DD`) instead of date and time.

**Empty values always sort last,** in both directions (for example files with no Length or no Artist).

### Group view (headers over the files)
Group the file list under headers, for example **by month, then by file type, then the file names**. Each group gets **one line** that names the path through the layers:

```
2026 August  >  Images
      k.png
2026 August  >  Documents
      m.pdf
2026 September  >  Images
      a.png
      b.png
2026 September  >  Videos
      v.mp4
```

There is no item count or size on the line (hover a line to see them in a tooltip), so the list stays clean.

**Grouping is separate from sorting.** Sorting orders the files; grouping adds the headers. Once you turn grouping on it **stays on for every folder and every search result** until you cancel it, and it is remembered when you restart boonsh.

**Turn it on:** right-click a column header and choose **Group by**. A list opens beside it with the ways that column can be grouped; tick what you want (the menu stays open so you can tick more than one, and click outside it when you are done). Each column offers its own list:

| Column | Group by |
| --- | --- |
| Date Modified, Date Created | The date parts **Year, Month, Week, Day** (tick one or several, see below), or **Relative date** (Today, Yesterday, Earlier this week, Last week, Earlier this month, Last month, Earlier this year, A long time ago) |
| Type | **File category** (Folders, Images, Videos, Audio, Documents, Archives, Code, Other) or each extension |
| Size | Size range (Empty, Tiny under 10 KB, Small to 1 MB, Medium to 100 MB, Large to 1 GB, Huge) |
| Name | First letter (A to Z, `0-9`, `#`) |
| Location | The folder the item is in (handy for search results) |
| Dimensions | Megapixels (Under 1 MP, 1 to 4, 4 to 12, 12 to 24, 24 and more) |
| Length | Duration (under 1 minute, 1 to 5, 5 to 30, 30 to 60, over 1 hour) |
| Album, Artist, Actor, Genre | Each value |
| Rating | Stars |

**Combining date parts.** For the date columns you can tick several parts, and they are joined **in the order you tick them**; the groups are also ordered in that order. Say the files are from May 2023, June 2025, May 2026 and July 2026:

| You tick | The groups are | Reads as |
| --- | --- | --- |
| Year, then Month | `2023 May`, `2025 June`, `2026 May`, `2026 July` | year first (the usual time line) |
| Month, then Year | `May 2023`, `May 2026`, `June 2025`, `July 2026` | all the Mays together, then the Junes |
| Month only | `May`, `June`, `July` | the same month of every year in one group |
| Year only | `2023`, `2025`, `2026` | |
| Year, Month, Day | `2026 May 12` | |
| Week | `Week 20` | the ISO week number (weeks start on Monday); with Year the year is the one the week belongs to |

Small numbers `1`, `2` beside the ticked parts show the order. Untick a part to take it out; unticking the last one stops grouping that column. **Relative date** stands alone: ticking it replaces the parts, and ticking a part replaces it. The other columns allow one choice at a time (for Type: File category or each extension; ticking the other one replaces it).

**The order of the layers follows the sort numbers.** The sort numbers `1, 2, 3` on the column headers (section 4, Smart sort) decide which grouped column is the first layer, which the second, and so on. If you group a column that is not part of the sort yet, it is added to the sort as the next number, so it always has a place. A grouped column shows a small layers icon in its header.
- Each layer lists its groups in that column's **sort direction**: with Date Modified ascending, August comes before September; Shift+click the header to make it descending and September comes first.
- Inside the innermost group the files follow the **other sort levels** (usually the name). A column that is used as a layer is not used again to order the files inside its groups, so "month, then type, then name" gives the files by name inside each type group.
- Files with no value for the grouped column (for example no Length) go into a **(none)** group at the end, in either direction.
- A layer where every file falls in one single group (all files from the same month) shows no header at all, so you never see a pointless header.

**Working with the groups**
- **Every name on a line has a `>` after it**, for example `2026 July  >  CSV  >`, `2026 July  >  DOCX  >`, `2026 July  >  MD  >`. Click the `>` after a name to collapse that group.
- Click the **`>` after `CSV`**: only the CSV files hide, and the line becomes `2026 July  >  CSV  v` (the DOCX and MD lines stay open).
- Click the **`>` after `2026 July`**: everything under July, every type, hides, and one line is left: `2026 July  v`.
- Click a line with a **down arrow** (or the arrow) to open it again. Clicking elsewhere on a line also collapses / opens the group that the whole line stands for.
- With only **one layer**, a line is `Images  >`; click it to collapse it to `Images  v`.
- The line stays visible at the top while you scroll through a long group (it covers the rows that slide under it).
- Collapsed groups are forgotten when you change the grouping or restart.
- **Right-click a line**: *Select ...* once for every level of the line (for `2026 July > CSV`: *Select 2026 July* and *Select 2026 July > CSV*, each with the number of files), ready for Bulk Rename, Delete, Compress ...; *Collapse / Open this group*; *Collapse all groups* (leaves one line per outermost group); *Expand all groups*; *Ungroup all*.
- Files in a **collapsed** group are not selected by Ctrl+A or Shift+click ranges, so you never act on files you cannot see.

**Cancel it:** right-click a column header, **Group by**, untick everything or choose **No grouping by *column*** (removes just that layer), or choose **Ungroup all**. The sort stays as it is.

**What the headers look like.** A group header is deliberately plain: the same font, size and colour as the file list, with no coloured band, so the list stays easy to read. The grouping shows through the small **`>`** between the layers and the **down arrow** at the end of a collapsed line. Hovering a line highlights it like a file row, and hovering a `>` highlights just the `>`.

**Good to know**
- The headers appear in the **Details view**. The Tiles and Thumbnails views show the same files in the grouped order, without header rows.
- Hiding a grouped column (Hide this column, or Settings, Files Column) also removes that grouping.
- Relative dates are worked out from the date on your computer when the list is drawn; the groups follow the clock.
- Grouping by Dimensions, Length, Album, Artist, Actor, Genre or Rating uses the file properties (see "More columns"); files whose properties are not read yet appear in **(none)** until they are.

### The Type column and the default app
The Type column shows the file's extension **and the app that opens it by default**:

| Shows | Means |
| --- | --- |
| `MP4 (VLC media player)` | `.mp4` files open with VLC. |
| `JPG (XnView MP)` | `.jpg` files open with XnView MP. |
| `TXT (Notepad)` | `.txt` files open with Notepad. |
| `ENV File (-)` | Nothing is set to open `.env` files (Windows would ask "Pick an app"). |
| `File (-)` | The file has no extension. |
| `File Folder` | A folder. |

- The app name is the one Windows gives (the name Explorer shows for the default app), so it is spelled the way the app names itself, for example "VLC media player" rather than "VLC".
- It follows your Windows settings (Settings, Apps, Default apps). Change a default app in Windows and switch back to boonsh: the column updates.
- Each file type is looked up once per folder view, so it is quick. Until the answer arrives, the cell shows just the extension.
- Programs and shortcuts (`EXE`, `LNK`, `BAT`) have no "open with" app, so they show `(-)`: they run themselves.

### More columns
Besides Name, Date Modified, Type and Size, the file panel can show: **Date Created**, **Location** (the folder the item is in, handy for search results), **Dimensions**, **Length**, **Album**, **Artist**, **Actor**, **Genre** and **Rating**. Choose them in Settings, Files Column (section 10), or right-click a column header, Choose columns.
- **Date Created** comes from the file system, like Date Modified.
- **Dimensions, Length, Album, Artist, Actor, Genre and Rating** are read from the file's own properties, **the same way Windows Explorer shows them**, so they appear for the pictures, videos and audio files that carry them. Other files show the cell empty. Properties are read in the background in small batches and fill in a moment after the folder opens, and only while one of these columns is shown or used in the sort.
- Windows has **no separate "Actor" property**. For video files the Actor column shows the "Contributing artists" tag, which is where video taggers normally put the cast. For audio files the same tag is shown in the Artist column. So Artist is filled for audio and Actor for video.
- **Rating** shows five stars (`★★★☆☆`) from the rating stored in the file.
- Columns can be as wide as you like; the file panel scrolls sideways when they do not fit.

### Selecting
| Do this | Result |
| --- | --- |
| Click | Selects one item. |
| **Ctrl+Click** | Adds or removes one item. |
| **Shift+Click** | Selects everything from the last clicked item to this one, following the current sort order. |
| **Ctrl+A** | Selects everything in the folder. |
| Click empty space | Clears the selection. |
| Right-click an item | Keeps the selection if the item is part of it, otherwise selects only that item. |

### Opening
- **Double-click a folder** to open it.
- **Double-click a file** to open it in its default Windows application.

### Dragging into the terminal
Drag a file or folder onto the terminal to type its quoted path there. Drag one of several selected items and **all selected** paths are typed, separated by spaces.

## 5. Working with files

| Action | How | Details |
| --- | --- | --- |
| **New folder / text document** | Right-click, *New* | Named `New folder` or `New Text Document.txt`. In the file panel, `(2)`, `(3)` are added if the name is taken. From the folder tree they always use the plain name, so you get an error message if it already exists. |
| **New shortcut** | Right-click, *New*, *Shortcut* | Opens a dialog for the shortcut name (`.lnk`) and its target path. |
| **Rename** | **F2**, or right-click one item, *Rename* | Only for a single item. The name (not the extension) is selected for you. Refused if the new name already exists. A change of letter case only (`photo.JPG` to `photo.jpg`) is allowed. |
| **Bulk rename** | Select 2 or more items, then F2 or right-click *Bulk Rename...* | Renames many items by rules, with a preview and Undo. See [Bulk rename](#bulk-rename) below. |
| **Cut / Copy** | Ctrl+X / Ctrl+C, the right-click menu, or the header icons | Works on the whole selection. Cut items are dimmed until pasted. |
| **Paste** | Ctrl+V, the right-click menu, or the header icon | Always pastes into the folder you are viewing. |
| **Delete** | Del key, the right-click menu, or the header trash icon | Asks first, then moves everything selected to the **Recycle Bin**. |
| **Compress to ZIP** | Right-click, *Compress to ZIP* | See below. |
| **Extract ZIP** | Right-click a `.zip`, *Extract ZIP* | See below. |

**Paste rules**
- Nothing is ever overwritten. A clash gets a new name: `report - Copy.txt`, `report - Copy (2).txt` when copying, and `report (2).txt` when moving.
- Cut then paste moves the items (across drives too). Pasting a cut item into its own folder does nothing. Pasting a folder into itself is refused with a message.
- After a paste, the pasted items are selected. Large copies run in the background.
- Cut and Copy stay **inside boonsh**: you can't copy in Windows Explorer and paste here, or the other way round.

**Compress to ZIP**
- Compresses everything selected into one new zip in the current folder. It is named after the first item (`photos` becomes `photos.zip`, or `photos (2).zip` if that exists).
- Folders keep their structure and everything keeps its modified date. Compression is Deflate, the same as Windows' own zip.
- The status bar shows "Compressing..." and the window stays usable. The new zip is selected when done. A failed zip is deleted, never left half written.

**Extract ZIP**
- Extracts into a **new folder** next to the zip, named after it (`photos.zip` becomes `photos\`, or `photos (2)\`). Select several zips to extract them one after another.
- Entries can't write outside that folder, so a crafted zip can't drop files elsewhere. A file that isn't a valid zip gives a clear error. If an extraction fails partway, the error says where the partly extracted folder is.

### Bulk rename

Rename many files and folders at once with rules, check the result in a preview, and undo it if you change your mind.

**How to open it**
- Select **2 or more** items (files and folders, or search results), then press **F2** or right-click and choose **Bulk Rename...**.
- With **one** item selected, **F2** (or right-click, *Rename*) opens the single Rename box instead. It selects just the name, not the extension, so typing replaces only the name; Enter renames and Esc closes it. In search results it shows the real file name, not the display path.
- With **one folder** selected, right-click also offers **Bulk Rename inside this folder...**, to rename what is inside it (see *Include sub-folders* below).

**Which items are renamed: Include sub-folders**
- The checkbox **Include sub-folders** (next to the Preview button) is **off by default**. Off: only the items you selected are renamed, so selecting a folder renames that folder itself and nothing inside it. This is the "current folder only" mode.
- On: every selected **folder** also brings in everything inside it, at any depth: its files and its sub-folders, each folder followed by its contents. Items you selected twice (or that are also inside a selected folder) count once. Folders reached through shortcuts or links are not entered.
- The checkbox is greyed out when no folder is selected, with a tooltip that says so. It is not saved in presets, because it depends on what is selected. Switching it makes the preview stale.
- The line above the preview then counts all the items, for example "13 of 14 names will change". Items in different folders show a **Folder** column, and **Numbering** and `{n}` can start again in each folder.
- At most 20,000 items at a time. If the selected folders hold more, you get a message and nothing is previewed.
- **To rename everything in the current folder, sub-folders included:** click in the file panel, press **Ctrl+A**, press **F2** and tick **Include sub-folders**. Or go up one level, select the folder, right-click it and choose **Bulk Rename inside this folder...**. You never have to select the inner files yourself.
- Folders inside the tree are renamed along with their contents in one go (the contents are renamed first), and Undo puts it all back.
- To rename only the files, not the folders, leave the folders unselected, or use a rule that doesn't match folder names. For example, *Extension* never changes folders.

**The window**

The **rules are at the top** and the **preview is below**, full width, so a long list has room and scrolls. A rule that is switched off folds up to a single line, so the preview keeps its space; if you open many rules, the rules area scrolls by itself.

Above the rules is the **Preset** row (see [Presets](#presets) below).

**The rules are a list that you build.** They run **from top to bottom**, in the order shown, and each rule's result is what the next one works on.
- It starts with one *Find & Replace* rule. Use **+ Add a rule...** below the list to add more, in any number: you can add the same kind twice (for example two *Find & Replace* rules).
- Each rule has a checkbox (switch it off without deleting it), **up and down arrows** (change when it runs) and an **X** (remove it). Up to 30 rules.
- The order matters: *Change case* then *Find* (which ignores case) finds different text than *Find* then *Change case*. If you change the order, preview again.
- A rule that has nothing to do is skipped: an empty *Find*, an *Insert* without text, a *Remove* of 0 characters, an empty *Template*.

The kinds of rule:

- **Find & Replace**
   - **Find** and **Replace with**: leave *Replace with* empty to remove the found text. An empty *Find* means this rule does nothing.
   - **Apply to**: *Name only* (the part before the extension, the default), *Extension only*, or *Whole file name*. Folders have no extension. A name starting with a dot, like `.gitignore`, has none either.
   - **Regular expression** (off by default): with it off, both fields are plain text, so `(1)` means exactly `(1)` and `$` is a dollar sign. With it on, *Find* is a regular expression, using the same engine and syntax as the `filename:` search (see [Regular expressions](#regular-expressions-filename)). It is matched against the name part only.
   - **Match case** (off by default) and **Replace all matches** (on by default; off replaces only the first match in each name).
   - In a regex replacement, `$1`, `$2` insert what the brackets matched, `${1}` is the same but safe when a letter or `_` follows (write `${1}_x`, because `$1_x` is read as a group called `1_x`), and `$$` is a dollar sign.
   - **Regex help** button: a list of ready recipes. Click one to fill in the fields.

| Goal | Find (regular expression on) | Replace with |
| --- | --- | --- |
| Remove a "(1)" suffix | `\s*\(\d+\)$` | (empty) |
| Spaces to underscores | `\s+` | `_` |
| "Last, First" to "First Last" | `^(\w+),\s*(\w+)$` | `$2 $1` |
| 31-12-2026 to 2026-12-31 | `(\d{2})-(\d{2})-(\d{4})` | `$3-$2-$1` |
| Remove a leading "IMG_" | `^IMG_` | (empty) |

- **Change case**: *lower case*, *UPPER CASE*, *Title Case* or *Sentence case*, applied to the name, the extension, or both.
   - Title Case capitalizes the first letter of each word; a word starts at the beginning or after a space, `_`, `-`, `.`, `(`, `[` or `{`. Everything else becomes lower case, and apostrophes stay inside the word (`don't` becomes `Don't`).
   - Sentence case capitalizes only the first letter and lowers the rest.
- **Insert / Remove**: add text, or remove characters, at a place in the name. Characters are counted as letters, not bytes, so accented letters count as one.
   - **Action**: *Insert text* or *Remove characters*. **Apply to**: *Name only* (the default), *Extension only* or *Whole file name*.
   - **Insert text**: type the **Text to insert**, then choose **Where**: *at the start*, *at the end (before the extension)* (for *Name only*), or *before character number...* (1 is the first character; a number past the end adds the text at the end). An empty text means the rule does nothing.
   - **Remove characters**: **How many**, **From** *the start* (the first N), *the end* (the last N) or *character number...* (N characters beginning at that position). Removing more than the name has leaves it empty, which is flagged as a problem. A count of 0 means the rule does nothing.
- **Numbering**: adds a counter to every selected item. Each Numbering rule counts on its own.
   - **Start** (default 1), **Step** (default 1; 0 gives every item the same number) and **Digits** (zero padding: 3 gives `001`, `002`, up to 12).
   - Numbers you type are never changed silently: a wrong value shows a message naming the rule and the allowed range (Start 0 to 999999999, Step 0 to 999999, Digits 0 to 12). Tip: to turn `1`..`9` into `01`..`09`, use Start 1, Step 1, Digits 2, *instead of the name*; or use Find & Replace with the regex recipe `^(\d)$` -> `0$1`.
   - **Put the number**: *after the name*, *before the name* or *instead of the name*, with a **Separator** between the number and the name (not used for *instead*). The extension is kept.
   - **Start again in each folder** (on by default) matters when the items come from different folders, for example search results.
   - Numbers follow the **order of the file panel**, so sort the panel first (by date, size, name...) and then number.
- **Extension**: change the extension of **files** (folders are never changed). Put it last if it should see the result of the other rules.
   - **Action**: *Set the extension to...* (type the **New extension**; a leading dot is ignored; a file without an extension gets one), *lower case*, *UPPER CASE*, or *Remove the extension* (only the last one: `a.tar.gz` becomes `a.tar`).
   - **Only files that now end in** (optional): a comma separated list such as `jpeg, jpe`. Only files with one of those extensions are changed; the others are left alone. Capital letters and dots don't matter. Empty means all files.
   - Setting the extension with an empty *New extension* does nothing.
- **Name template**: build the name from a template made of your own text and **tokens** in curly braces.
   - **Template**: type it, or click the token buttons under it to add them. **Builds**: *the name (keeps the extension)* (the default: the template result becomes the name part and the extension stays), or *the whole file name* (then write the extension yourself, for example `{name}.{ext}`).
   - Tokens:

| Token | What it gives |
| --- | --- |
| `{name}` | The current name without its extension (as the earlier rules left it) |
| `{ext}` | The extension, without the dot (empty for folders and files without one) |
| `{parent}` | The name of the folder the item is in |
| `{n}` | A counter that grows by the **Step** from the **Start** (these fields appear when the template uses `{n}`) |
| `{n:3}` | The same counter with 3 digits: `001`, `002`... (0 to 12 digits) |
| `{date}` | The item's **modified date**, like `2026-07-06` |
| `{date:yyyyMMdd}` | The same date in your own format. Letters: `yyyy` year, `yy` two-digit year, `MM` month, `dd` day, `HH` hour, `mm` minute, `ss` second. Other characters stay as they are |
| `{today}` | Today's date; also takes a format, like `{today:yyyy}` |
| `{{` and `}}` | A literal `{` and `}` |

   - Examples: `{date}_{name}` gives `2026-07-06_photo.jpg`; `{parent}_{n:3}` gives `Holiday_001.jpg`, `Holiday_002.jpg`...; with *the whole file name*, `{date:yyyyMMdd}-{name}.{ext}`.
   - The counter follows the order of the file panel and can start again in each folder. A date comes from the file's own modified time, in local time; if it can't be read the text `unknown` is used.
   - A mistake is reported when you click Preview, for example `Template: unknown token {foo}. Tokens: {name} {ext} {parent} {n} {n:3} {date} {date:yyyyMMdd} {today}`, or a `{` without its `}`.

**The preview**
- Nothing is computed while you type. Click **Preview**, or press **Enter** in any field. This keeps big renames fast.
- It lists **only the names that will change**, plus the items that would change but are **skipped** because the new name is taken (dimmed, see *If a new name is already taken*). Unchanged names are not listed; the line above the list tells you how many there are, for example "5 of 8 names will change · 1 skipped (new name already taken) · 3 unchanged (not listed) · 2 with problems".
- In each row the old and new names are compared letter by letter: text that is removed is struck through in red in the old name, and text that is added is green in the new name, wherever in the name it happens. When the items come from more than one folder, a **Folder** column appears.
- **Show only problems** (a checkbox at the right of the line above the list, shown when there are problems) hides the rows that are fine, so a few problems in a long list are easy to find.
- Each row has a **checkbox**. Untick a row to leave that item out; the line above the list says how many are left out. The header checkbox ticks or unticks all. After you tick or untick, the remaining rows are checked again straight away (a collision disappears when one of its two rows is left out), with no new preview.
- If you change **any rule**, the preview turns grey and says "Rules changed. Click Preview to update.", and **Rename is disabled** until you preview again. So Rename always applies exactly the names you saw.

**Problems** (shown in red in the Status column; Rename stays disabled while a ticked row has one: change the rules or untick the row)
- the new name is empty, or contains a character Windows doesn't allow (`< > : " / \ | ? *`)
- the name ends with a dot or a space, or is a reserved Windows name (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`, also with an extension)
- the name is longer than 255 characters, or the full path would be longer than 259
- another item in the batch gets the same new name (letter case is ignored)
- a file or folder with that name already exists and is not part of the batch
- the item no longer exists

**If a new name is already taken** (a dropdown next to the Preview button; the default is *skip that item*)

A new name is "taken" when another item in the batch gets it first (in the order of the file panel), or when a file or folder that stays in the folder already has it (letter case is ignored). Names freed by items that are renamed away don't count, so swaps and chains still work. You choose what happens:
- **skip that item** (the default): the item is **not renamed**, and everything else is. The first item keeps a name that several items want; the later ones are skipped. A name held by a file that stays is never taken over. Skipped items are still listed, dimmed, with the status "Skipped: name already taken" (hover for the exact reason), they can't be ticked, and they are not problems. The line above the list counts them: "4 of 8 names will change · 1 skipped (new name already taken)".
  - Example: `IMG (1).jpg`, `IMG (2).jpg` and `IMG (3).jpg` with a rule that removes the suffix: `IMG (1).jpg` becomes `IMG.jpg`; the other two are skipped. If a file `IMG.jpg` is already there, all three are skipped.
  - Skipping one item can make another collide (it stays where it is, so its name stays in use). That is worked out for you.
- **show a problem**: the colliding items are shown in red as problems and Rename stays disabled until you change the rules or untick them. Use this when you want to be told.
- **add (2), (3)...**: the colliding names get " (2)", " (3)"... before the extension, in the order of the file panel: `IMG.jpg`, `IMG (2).jpg`, `IMG (3).jpg`. If `IMG.jpg` already exists, the numbers start at (2). A name that ends up equal to the item's own current name is not a change, so it isn't listed.

This only deals with names that are taken. Empty names, illegal characters, reserved names and too-long names are still reported as problems. Changing the choice makes the preview stale, like any rule change, and it is saved in presets.

**Renaming**
- Click **Rename N items**. For more than 100 items it asks you to confirm.
- Afterwards the renamed items are selected (or the search is run again), and a small message appears with an **Undo** button for 15 seconds.
- Just before renaming, everything is checked again, because files can change after the preview. If a name was taken in the meantime, **nothing is renamed**, the dialog shows why, and you preview again.
- **Swaps and chains work**: `a` to `b` together with `b` to `a`, or `a` to `b` together with `b` to `c`. Where needed a temporary name (starting with `.boonsh-tmp-`) is used for a moment.
- **A folder and the files inside it** can be renamed in the same batch (the contents are renamed first).
- **Letter-case-only changes** (`notes.txt` to `NOTES.TXT`) work.
- **If one rename fails** partway (for example a file is open in another program), everything already renamed in that batch is **put back**, and the message says which item failed and why.

**Undo**
- Click **Undo** in the message, or press **Ctrl+Z** while the file panel (not a text box) has focus. Ctrl+Z asks you to confirm first.
- The **last 5 batches** are remembered, even after you close boonsh. Each Ctrl+Z undoes the newest one. Ctrl+Z only undoes bulk renames, not other file actions.
- Undo puts the old names back, newest change first. If something changed since (an item was moved or deleted, or the old name is taken again), that part is **skipped and reported**, and nothing is ever overwritten.

**Presets**

A preset is a saved list of rules, in their order with all their settings, plus the "If a new name is already taken" choice (but not *Include sub-folders*). Use the **Preset** list above the rules.
- **Built-in presets** are ready to use: *Spaces to underscores*, *Remove a "(1)" suffix*, *Remove "(1)" suffixes, add (2), (3) if names collide*, *lower case (name and extension)*, *Title Case (name only)*, *Add a date prefix 2026_*, *Remove the first 4 characters*, *Number 001, 002... after the name*, *File's own date in front: 2026-07-06_name*, *Folder name + number: Trip_001*, *Extension .jpeg to .jpg* and *Extension to lower case*. Choosing one **replaces the whole list of rules**; you can then adjust it. If the preview already exists, it becomes stale until you click Preview.
- **Save your own:** set up the rules, click **Save rules as...**, type a name and press **Enter** (or click **Save**). Enter in the name box only saves the preset; it does not start a preview. If the name already belongs to one of your presets, it asks before replacing it. A built-in name is refused, names can be up to 40 characters, and you can keep up to 30 presets.
- **Your presets** appear in the list under "Your presets" and are remembered after you close boonsh. **Delete preset** removes the selected one of yours (it asks first); built-in presets can't be deleted.
- As soon as you change any rule, the list goes back to "Choose a preset..." because the rules no longer match the preset.
- Presets you saved with an earlier version of boonsh (before the rules became a list) still load: their rules appear in the old fixed order.

**Not available yet**
- Dragging rules to reorder them (use the up and down arrows).
- Other template tokens, such as the file size, the creation date or a picture's shooting date.

## 6. Right-click menus

**On a file or folder in the file panel**

| Entry | Notes |
| --- | --- |
| New | **First entry.** Folder, Text Document, Shortcut. |
| Open | Second entry. Opens a folder, or a file in its default app. |
| Open with | Files only. A submenu with up to **3 programs you used most for this file type** (hover for the full path; a type you have never opened this way, such as `.zip`, shows only Choose App...), then **Choose App...**, which opens a dialog with two lists: the programs Windows has registered for this file type (the ones Explorer's *Open with* offers), then **Other programs** (everything else Windows or an installer has registered, such as Notepad++); click one to open the file with it, or **Browse...** to pick any `.exe`. Microsoft Store apps are started through their app alias. Opening a file through either one counts as a use, so the list fills as you work; each file type keeps its own counts. A program that no longer exists is shown in an error and dropped from the list. The list is saved in this app (`boonsh_open_with`) and is not the same as Windows' own *Open with* list. |
| Add to Quick Access | For folders. For files it adds the current folder instead. |
| Cut, Copy | Show the number of items when more than one is selected. |
| Paste | Greyed out until you've cut or copied something. |
| Compress to ZIP | Greyed out while another zip task runs. |
| Extract ZIP | Only when the selection includes a `.zip`. |
| Assign to Global Var | A submenu that opens **level with this row**, with one entry per global variable, such as `{SELEC}=.\a.txt` (the value is shown once set; long values are cut with "..." and the full path is in the tooltip). Near the bottom of the window it slides up to stay visible. Click one to store the selection or the clicked item in it (see [section 9](#selec-and-dest-files-for-terminal-commands)). |
| Rename | Only when one item is selected (also F2). |
| Bulk Rename... | Instead of Rename when 2 or more items are selected (also F2). |
| Delete | Shows the number of items when more than one is selected. |
| Refresh | Reloads the folder. |

**On a column header in the file panel:** Sort ascending / descending, Then sort by (add a level), Remove from the sort, date and time or date only (date columns), **Group by** (a list to tick: the ways that column can be grouped), Ungroup all, Hide this column, Choose columns (see section 4).

**On a group line** (when grouping is on): Select (one entry for each level of the line), Collapse / Open this group, Collapse all groups, Expand all groups, Ungroup all.

**On empty space in the file panel:** New, Add Current Folder to Quick Access, Paste, Assign to Global Var (stores the current folder), Refresh.

**On a folder in the folder tree:** Open, New, Add to Quick Access, Refresh. **On a Quick Access chip:** Remove from Quick Access.

All menus stay **fully inside the window**. Near the bottom edge a menu opens upward; near the right edge it moves left (and the New submenu opens to the left).

## 7. Search

Click the **magnifier icon** in the header to open the search box. Type, and the file panel shows only the matches (it waits a moment after you stop typing). Clear the box (or click its **X**) to return to the normal folder view.

**The search box is a floating, two-line box.** It is 360 px wide and sits on top of the panels below it (the header keeps its height). A long query **wraps onto the next line** instead of running out of sight, and when it is longer than two lines you can **scroll it** with the mouse wheel or the scrollbar. The query is still one line of text: Enter does nothing, and line breaks in pasted text become spaces. Messages (red errors, amber notes, "Searching...") and the `?` options panel appear just below the box.

- **Subfolders button** (next to the search box): on by default, so subfolders are searched too (up to 8 levels deep). Click it to turn it **off** and search only the current folder, and click again to turn it back on. The button is highlighted while it is on, its tooltip says "Subfolders: ON" or "OFF", and the results update at once. It works with every filter, and with Bulk Rename: search with Subfolders on, select the results, then press F2.
- **Results** show the path relative to the current folder, like `./sub/report.txt`, and are limited to the first **300** matches.
- **`?` button:** opens a cheat sheet. Click any example to add it to your search.
- **Errors in plain words:** if a query can't be read, the box gets a red border and a message below it says why, instead of silently finding nothing. For example `filesize:12Q` shows `filesize: unknown unit "Q". Use B, K, M, G or T`.
- **A filter with no value yet is ignored.** While you are still typing `filesize:`, the normal folder listing stays on screen instead of going empty.

### Quick reference

| Filter | What it matches | Examples |
| --- | --- | --- |
| plain words | The name contains the text (wildcards work). Quotes keep spaces together. | `report`, `*.md`, `rep*t`, `"my file"` |
| `filename:<regex>` | The name matches a regular expression (case doesn't matter). See [Regular expressions](#regular-expressions-filename). | `filename:^inv.*\.pdf$` |
| `filesize:` range | A size range, both ends included. Units B, K, M, G, T, with 1K = 1024 bytes (same as Explorer). Decimals are fine. | `filesize:0-1M`, `filesize:250K-1.2M`, `filesize:800M-1G` |
| `filesize:` limits | At least, at most, greater, smaller, exactly. | `filesize:1G+`, `filesize:-10K`, `filesize:>1M`, `filesize:<100K`, `filesize:0` |
| `filetype:` | That extension (`.exe` and `*.exe` also work). A comma means OR, and groups are built in. | `filetype:exe`, `filetype:jpg,png`, `filetype:image`, `filetype:folder` |
| `filedate:` | The modified date. Blank parts mean "any". | `2026`, `2026-07`, `2026-07-06`, `-07-06` (July 6 of any year), `-07-` (any July), `--06` (the 6th of any month) |
| `filedate:` ranges | A range, or a relative date. | `filedate:2026-01..2026-03`, `filedate:2026-07-01..`, `filedate:7d`, `filedate:today`, `filedate:yesterday` |
| `path:` | The **full path** (the folders above the item, plus its name) contains the text. Comma = OR, ` +word` = AND, quotes = a whole name, `( )` group. See [Where words and places are combined](#combining-words-and-places-and-or-and-parentheses). | `path:legal`, `path:client-xyz,client-abc`, `path:client-xyz +legal`, `path:'legal'` |
| `input:` | **Where to search** (default: the current folder). One or more folders or files. Same comma / ` +` / `( )` rules; AND keeps the **same file names** found on both sides. `{NAME}` uses a Global Var. | `input:.\client\`, `input:.\abc +.\xyz name.txt`, `input:{INPUT01}` |
| `type:folder size:` | Folders, measured by the total size of everything inside. | `type:folder size:>20G` |
| `!` in front | Excludes matches. | `!backup`, `!filetype:tmp` |
| Short forms | The same filters under shorter names. | `name:`, `size:`, `type:`, `ext:`, `date:` |

Details and more examples follow.

### How a query is read
- A query is made of **terms separated by spaces**. **All terms must match** (AND).
- **Plain word:** the name contains it, ignoring case. Wildcards work: `*.md`, `rep*t`, `*.tmp`.
- **Quotes** keep words together: `"my report"`.
- **`!` in front of a term excludes** it: `!backup`, `!filetype:tmp`.
- Filter names are not case sensitive, and have short forms: `name:`, `size:`, `type:`, `ext:`, `date:`.

### Combining words and places: AND, OR and parentheses
`path:` and `input:` can hold several words or places in one go. They use the **same three rules**, so learn them once:

| You write | It means | Example |
| --- | --- | --- |
| a **comma** `,` between two things | **OR**: either one is enough. Spaces around the comma are fine (`a,b`, `a, b`, `a ,b`, `a , b`). | `path:legal, contract` |
| a **space and `+`** in front of a word | **AND**: both are needed. The `+` goes **directly in front of the word**, with a space before it and none after it. | `path:client-xyz +legal` |
| **parentheses** `( )` | **Group** things so they are worked out first. | `path:client-xyz +(legal, contract)` |

**What happens when you mix them.** Like in arithmetic, AND is worked out **before** OR (the way `2 + 3 x 4` does the multiplication first). Operators of the same kind are worked out **from left to right**.

| You write | boonsh reads it as | In plain words |
| --- | --- | --- |
| `a +b, c` | `(a AND b) OR c` | both `a` and `b`, or just `c` |
| `a, b +c` | `a OR (b AND c)` | just `a`, or both `b` and `c` |
| `a, b, c` | `(a OR b) OR c` | any of the three |
| `a +b +c` | `(a AND b) AND c` | all three |
| `a +(b, c)` | `a AND (b OR c)` | `a`, together with `b` or `c` |
| `(a, b) +c` | `(a OR b) AND c` | `c`, together with `a` or `b` |

**Example with `path:`.** These four files exist:

| | Path |
| --- | --- |
| 1 | `D:\Clients\Acme\legal\a.pdf` |
| 2 | `D:\Clients\Xyz\contract\b.pdf` |
| 3 | `D:\Clients\client-xyz\contract\c.pdf` |
| 4 | `D:\Clients\client-xyz\invoices\d.pdf` |

| Query | Finds | Why |
| --- | --- | --- |
| `path:legal, contract +client-xyz` | 1 and 3 | `legal` alone is enough (file 1). Otherwise a file needs `contract` **and** `client-xyz` (file 3, but not file 2). |
| `path:(legal, contract) +client-xyz` | 3 only | The parentheses make it "(legal or contract) and client-xyz". Only file 3 has `client-xyz` together with one of them. |
| `path:client-xyz +legal, contract` | 2 and 3 | "(client-xyz and legal) or contract": nothing has both `client-xyz` and `legal`, so the `contract` files win. |

**Good to know**
- **When in doubt, use parentheses.** They make the meaning obvious to the next person who reads the query, and they always win over the order.
- **`+` is only AND when it starts a word.** `a +b` is AND. `a+b` is just the text `a+b`. `a+ b` and `a + b` are not AND (a lone `+` is ignored, and the word after it becomes an ordinary name term). Inside quotes, `"a +b"` is the plain text `a +b`.
- **Two words with no comma or `+` between them** are not allowed inside `path:` or `input:` (put a comma for OR, or `+` for AND). Names with spaces must be in quotes: `path:'my client'`.
- **Typing is forgiving.** A comma or `+` at the end, or a `+` on its own, is ignored until you add the next word. An open `(` that is not closed shows an error.
- A `(` only starts a group at the start of a word, so a folder called `setup(1)` is plain text. Put names that begin with `(` in quotes.
- **`!` negates the whole thing:** `!path:client-xyz +legal` means "not (client-xyz and legal)".
- **Several separate `path:` terms** in one query (`path:a path:b`) must all match, the same as `path:a +b`.
- The same comma rule also works for `filetype:jpg, png`.

### Filters

**`filename:<regex>`**: the name matches a regular expression, ignoring case. Example: `filename:^inv.*\.pdf$`. See [Regular expressions](#regular-expressions-filename) below for everything the pattern can use, with samples.

**`input:`**: **where** the search runs. Without it, boonsh searches the **current folder** (and its subfolders, when the Subfolders button is on). With it, boonsh searches only the places you list.

The places can be folders or single files, written as relative or absolute paths:

| Write | Meaning |
| --- | --- |
| `input:.\client\` | The `client` folder inside the current folder. A `\` at the end makes no difference: `.\client` is the same. |
| `input:d:\work` | An absolute path (a drive letter, or `\\server\share`). |
| `input:'my client'` | Names with spaces need quotes (single or double). |
| `input:d:\work\report.pdf` | A single file is a place too. It is tested against the rest of the query. |
| `input:{INPUT01}` | Every file and folder stored in the Global Var `{INPUT01}` (see [Using a Global Var as the search place](#using-a-global-var-as-the-search-place)). They count as alternatives, like a comma list. |

**OR: more places.** A comma lists places to search together; you get everything found in any of them. `input:.\client, .\documents, d:\work`

**AND: the same file name on both sides.** Putting ` +` between places keeps only the **file names that exist on every side**, and shows **every copy** of those names. It compares **names, not the files themselves**: two different files that happen to have the same name both count.

*Worked example.* The current folder is `D:\movie`:

```
D:\movie
├── abc
│   ├── tmp-title.txt
│   ├── notes.txt
│   └── cover.jpg
└── xyz
    ├── tmp-title.txt
    └── readme.txt
```

| Query | Result | Why |
| --- | --- | --- |
| `input:.\abc, .\xyz txt` | all four `.txt` files | Comma = OR: everything in either folder. |
| `input:.\abc +.\xyz txt` | `.\abc\tmp-title.txt` and `.\xyz\tmp-title.txt` | AND: only the name `tmp-title.txt` exists in both folders. `notes.txt` and `readme.txt` exist on one side only, so they are left out. |
| `input:.\abc +.\xyz tmp-title.txt` | the same two files | Add a name to narrow it down. This is the way to find same-named files in two folders so you can select and delete them. |
| `input:.\abc +.\xyz filename:^tmp-` | the same two files | Any other term works too. |

- The names are compared **ignoring case**, and only the file or folder **name** counts, not the folders below the place.
- **Mixing** works as in [the rules above](#combining-words-and-places-and-or-and-parentheses): `input:.\a +.\b, .\c` is `(a AND b) OR c`, which gives the same-named files of `a` and `b` plus everything found in `c`. `input:.\a, .\b +.\c` is `a OR (b AND c)`. `input:.\a +(.\b, .\c)` is `a AND (b OR c)`.
- A second `input:` term is ANDed with the first: `input:.\abc input:.\xyz` is the same as `input:.\abc +.\xyz`.
- **Relative places start at the current folder**: `.\client`, `client` and `..\other` all work.
- **The Subfolders button applies to every place:** on means up to 8 levels deep in each place, off means only the top level of each.
- Results **outside the current folder** are listed with their full path; results inside it as `./sub/file`.
- `input:` on its own lists everything in the places. It combines with any other term: `input:.\client path:legal filetype:pdf`. It cannot be excluded with `!`.
- **Limits:** a normal search shows at most 300 results. When there is an AND, up to 5,000 results per side are compared first, then at most 300 are shown.
- **Error:** *input: not found: ...* appears for a place that does not exist.

#### Using a Global Var as the search place
A Global Var lets you pick the places with the mouse instead of typing paths.
1. **Create it once:** Settings (gear), **Global Var**, **Add variable**, name it `INPUT01`, and choose *Every selected item* for what Assign stores (so it can hold several folders). It is saved, so you only do this once.
2. **Give it a value:** in the file panel select one or more folders or files, right-click, **Assign to Global Var**, `{INPUT01}`. The right-click entry now shows the value, for example `{INPUT01}=.\client (+1 more)`.
3. **Search with it:** open the search box and type `input:{INPUT01} report`. The search runs at once, and runs again by itself whenever you assign a new value.

**What if the variable has no value yet?** It is **not an error**. The variable is skipped, the search still runs, and an amber note under the search box says so, for example *{INPUT01} has no value yet, so it is skipped; searching the current folder. Right-click a file or folder, then Assign to Global Var.* The text you typed (`{INPUT01}`) stays in the box, so you can see what is missing. If the query lists other places, only the variable is skipped and the other places are still used.

Values are kept only while boonsh is open. Relative paths in a value (shown as `.\x`) are always stored as absolute paths, so a value keeps working after you open another folder.

**`path:`**: the **full path** of an item contains the text. The full path is every folder above the item plus the item's own name, so you can find files by the folders they live in. `path:legal` finds everything inside any folder with "legal" in its name, even when the file names say nothing about it. It ignores case, and `/` and `\` both work.

| Write | Meaning |
| --- | --- |
| `path:legal` | The path contains `legal` anywhere (it also matches `illegal` and `legality`). |
| `path:client-xyz,client-abc` | **OR**: either one. |
| `path:client-xyz +legal` | **AND**: both. More: `path:client-xyz +invoices +legal`. |
| `path:legal, contract +client-xyz` | `legal` OR (`contract` AND `client-xyz`). AND is worked out first. |
| `path:client-xyz +legal, contract` | (`client-xyz` AND `legal`) OR `contract`. |
| `path:client-xyz +(legal, contract)` | Parentheses win: `client-xyz` AND (`legal` OR `contract`). |
| `path:'legal'` or `path:"legal"` | A **whole** folder or file name that is exactly `legal` (not `illegal`). Everything inside quotes is plain text. |
| `path:'my client'` | Names with **spaces need quotes**. Matches the name `my client` exactly. |
| `path:'my client'*` | A `*` **outside** the quotes is a wildcard: names that start with `my client`, such as `my client 2026`. Also `path:*'client'` (ends with) and `path:'my'*'2026'`. |
| `path:cl*nt-xyz` | An unquoted `*` is a wildcard as well. |
| `path:'client-xyz\invoices'` | **One text** with a folder separator in it: `invoices` directly inside `client-xyz`, at any depth. It matches `D:\client\client-xyz\invoices\a.pdf`, `D:\documents\client-xyz\invoices\a.pdf` and `D:\client-xyz\invoices\2026\a.pdf`, but not `D:\client\client-xyz\doc\invoices\a.pdf`. |
| `!path:archive` | Excludes anything with `archive` in the path. |

- **Unquoted = part of a name, quoted = the whole name.** Without quotes `path:legal` matches `illegal`; with quotes `path:'legal'` only matches a folder or file called exactly `legal`. A `*` **inside** quotes is just a character (names cannot contain one, so it never matches), so put wildcards outside the quotes.
- A quoted text that contains `\` is matched as folder names **next to each other**, and it must start and end on a folder-name boundary: `'client-xyz\invoices'` does not match `my-client-xyz\invoices`. Use `path:*'client-xyz\invoices'` for that.
- **It reads the whole absolute path,** including the folders above the one you are searching in. If you search from `D:\legal-stuff`, then `path:legal` matches everything there. Use `path:'legal'` to avoid that when your folder is called something else.
- **Examples:** the legal files of one client in `/client-xyz/invoices/...`: `path:client-xyz +legal`. One client's files in `/2026-Q4/invoices/legal/<clients>`: `path:'legal' +acme`. Mixed with other filters: `path:legal filetype:pdf filedate:2026`.

**`filesize:`**: the file size.

| Query | Matches |
| --- | --- |
| `filesize:0-1M` | From 0 up to 1 MB (both ends included). |
| `filesize:250K-1.2M` | Decimals are fine. |
| `filesize:800M-1G` | |
| `filesize:1G+` | At least 1 GB. |
| `filesize:-10K` | At most 10 KB. |
| `filesize:>1M`, `>=1M`, `<100K`, `<=100K` | Greater and smaller than. |
| `filesize:0` | Exactly 0 bytes (empty files). A bare number is an exact size in bytes. |

Units are B, K (or KB), M, G and T, and **1K = 1024 bytes** (the same as Explorer). A backwards range like `2M-1M` is an error.

**`filetype:`**: the file extension.
- `filetype:exe` (also `.exe` or `*.exe`). A comma means OR: `filetype:jpg,png`.
- **Groups:** `image` (png, jpg, jpeg, gif, bmp, webp, svg, ico, tif, tiff, heic), `video` (mp4, mkv, avi, mov, wmv, webm, m4v, flv), `audio` (mp3, wav, flac, aac, ogg, m4a, wma), `doc` (pdf, doc, docx, xls, xlsx, ppt, pptx, txt, md, rtf, odt, csv), `archive` (zip, 7z, rar, tar, gz, bz2, xz, cab, iso), `code` (rs, js, ts, tsx, jsx, py, ps1, json, toml, yaml, yml, html, css, c, cpp, h, cs, java, go, sh, bat). Plurals like `images` work.
- `filetype:folder` lists folders only and `filetype:file` lists files only.

**`filedate:`**: the **modified date**, in your local time. Blank parts mean "any".

| Query | Matches |
| --- | --- |
| `filedate:2026` | Modified in 2026. |
| `filedate:2026-07` | Modified in July 2026. |
| `filedate:2026-07-06` | Modified on that day. |
| `filedate:-07-06` | July 6 of any year. |
| `filedate:-07-` or `filedate:-07` | Any day in July, any year. |
| `filedate:--06` | The 6th of any month. |
| `filedate:2026-01..2026-03` | A range, January through March 2026. |
| `filedate:2026-07-01..` | From that day on. `filedate:..2025` means up to 2025. |
| `filedate:7d` | The last 7 days, including today. |
| `filedate:today`, `filedate:yesterday` | |

Both sides of a range need a year. Invalid dates (month 13, day 32) are errors.

### Regular expressions (`filename:`)

`filename:` understands regular expressions ("regex"), a way of describing a pattern of text. boonsh uses the compact **regex-lite** engine, which follows the usual Perl/Rust-style syntax listed here.

**How boonsh applies your pattern**
- It is tested against the **file or folder name only** (like `report.pdf`), never the folder path.
- It matches **anywhere in the name** unless you anchor it: `^` means "the name starts here" and `$` means "the name ends here". So `filename:report` finds `my report.txt`, while `filename:^report` does not.
- It **ignores upper/lower case**. To make part of a pattern case sensitive, add `(?-i)` before it. `(?i)` switches case-insensitive matching back on.
- Terms are separated by spaces, so a pattern **can't contain a plain space**. Either put quotes around the value or the whole term (`filename:"^my report"` or `"filename:^my report"`), or write `\s` for a space (`filename:^my\sreport`).
- A `.` in a regex means "any character". To match a real dot, write `\.`. For example `filename:report.pdf` also matches `report_pdf`, but `filename:report\.pdf` doesn't.
- Plain words and `*` wildcards (`report`, `*.md`) are **not** regex: there, characters like `.`, `(` and `[` mean themselves. Use `filename:` only when you need a pattern.
- You can use several `filename:` terms (all must match), exclude with `!filename:`, and use the short form `name:`.
- The engine does not use unbounded backtracking, so a tricky pattern is designed not to make a search slow or freeze.

**One character**
| Pattern | Matches |
| --- | --- |
| `.` | Any one character |
| `\d` / `\D` | A digit (0 to 9) / anything but a digit |
| `\w` / `\W` | A letter A-Z or a-z, a digit or `_` / anything else |
| `\s` / `\S` | A space or tab / anything but whitespace |
| `[abc]` | One of a, b or c |
| `[^abc]` | Any character except a, b and c |
| `[a-z]`, `[0-9]`, `[a-f0-9]` | A character in a range |
| `[[:alpha:]]`, `[[:digit:]]`, `[[:alnum:]]`, `[[:upper:]]`, `[[:lower:]]`, `[[:punct:]]`, `[[:space:]]`, `[[:xdigit:]]` | Named ASCII groups (letters, digits, letters and digits, capitals, small letters, punctuation, whitespace, hex digits) |
| `\.` `\(` `\)` `\[` `\]` `\$` `\^` `\*` `\+` `\?` `\{` `\\` | The symbol itself, when it would otherwise have a special meaning |
| `\x41`, `é` | A character by its hex code |

**Repeating**
| Pattern | Matches |
| --- | --- |
| `x*` | Zero or more x |
| `x+` | One or more x |
| `x?` | Zero or one x (optional) |
| `x{3}` | Exactly 3 x |
| `x{2,4}` | From 2 to 4 x |
| `x{2,}` | 2 or more x |

`x` can be a single character, a class like `[0-9]`, or a group like `(ab)`. Adding `?` after a repeat (like `x*?`) makes it lazy; that rarely matters because boonsh only asks "does the name match?".

**Position**
| Pattern | Matches |
| --- | --- |
| `^` | The start of the name |
| `$` | The end of the name |
| `\b` | A word edge: a letter, digit or `_` on one side and something else (or nothing) on the other |
| `\B` | Not a word edge |
| `\<` / `\>` | The start / the end of a word |

**Choosing and grouping**
- `a|b` means a or b: `filename:\.(jpg|png)$`.
- `( )` groups part of a pattern so you can repeat it or choose within it: `(\.\d+)+`.
- `(?:a|b)` groups without remembering the match. The result is the same here; use whichever you like. A `:` inside a pattern is fine.
- `(?i)` and `(?-i)` turn case-insensitive matching on and off.

**Sample file names**

The samples below are tried against this list of 19 names:

```
Report.pdf          report_final.PDF    inv-2026-001.pdf    Invoice_2025.pdf
IMG_0001.JPG        IMG_0002.png        photo.jpeg          2026-07-06 notes.txt
my report.txt       cat.txt             category.txt        cat_1.txt
backup.tmp          setup.exe           setup(1).exe        README.md
v1.2.3.zip          café.txt            Makefile
```

| Goal | Search | Names it finds |
| --- | --- | --- |
| Start with "report" | `filename:^report` | Report.pdf, report_final.PDF |
| End with .pdf | `filename:\.pdf$` | Report.pdf, report_final.PDF, inv-2026-001.pdf, Invoice_2025.pdf |
| Start with "inv", end with .pdf | `filename:^inv.*\.pdf$` | inv-2026-001.pdf, Invoice_2025.pdf |
| Camera photos: IMG_ plus 4 digits | `filename:^IMG_\d{4}\.` | IMG_0001.JPG, IMG_0002.png |
| Any of three extensions | `filename:\.(jpg\|jpeg\|png)$` | IMG_0001.JPG, IMG_0002.png, photo.jpeg |
| Starts with a date (YYYY-MM-DD) | `filename:^\d{4}-\d{2}-\d{2}` | 2026-07-06 notes.txt |
| The whole word "cat" only | `filename:\bcat\b` | cat.txt (not category.txt or cat_1.txt) |
| Contains one of two words | `filename:(setup\|install)` | setup.exe, setup(1).exe |
| A number in brackets, like (1) | `filename:\(\d+\)` | setup(1).exe |
| Version-style names | `filename:^v\d+(\.\d+)+\.zip$` | v1.2.3.zip |
| No dot in the name at all | `filename:^[^.]+$` | Makefile |
| Four or more digits in a row | `filename:\d{4}` | inv-2026-001.pdf, Invoice_2025.pdf, IMG_0001.JPG, IMG_0002.png, 2026-07-06 notes.txt |
| Start with cat or setup | `filename:^(?:cat\|setup)` | cat.txt, category.txt, cat_1.txt, setup.exe, setup(1).exe |
| Case sensitive | `filename:(?-i)^Report` | Report.pdf only |
| A space in the pattern (quotes) | `filename:"^my report"` | my report.txt |
| A space in the pattern (whole term quoted) | `"filename:^my report"` | my report.txt |
| A space in the pattern (`\s`) | `filename:^my\sreport` | my report.txt |
| Two patterns, both must match | `filename:^IMG filename:JPG$` | IMG_0001.JPG |
| Everything except names starting with "report" | `!filename:^report` | All the other 17 names |
| Short form | `name:^v\d` | v1.2.3.zip |
| Mix with other filters | `filename:^inv filetype:pdf filedate:2026` | PDFs starting with "inv" modified in 2026 |

In the samples with a choice, `\|` is only how the symbol has to be written inside a table. In the search box type a plain `|`, for example `filename:(setup|install)`.

**Accented and non-English names**
- Literal text works as it is: `filename:café` finds `café.txt`.
- Upper/lower-case matching, and `\w`, `\d` and `\s`, cover **plain English letters only**. So `filename:CAFÉ` does not find `café.txt`, and `filename:^\w+\.txt$` finds `cat.txt` but not `café.txt`. For names in other alphabets use `.`, `[^.]` or the literal text instead of `\w`.

**Not supported**

A pattern using any of these is rejected, and the search box shows the reason in red:

| You type | Why it fails |
| --- | --- |
| `filename:(?=x)`, `filename:(?<!x)y` | `look-around is not supported` (no "followed by" or "preceded by" tests) |
| `filename:(a)\1` | `backreferences are not supported` (no "same text again") |
| `filename:\p{L}` | `Unicode character classes are not supported` (use `[a-z]` instead) |
| `filename:(` | `found open group without closing ')'` (a typo, not a limit) |
| `filename:[` | `found unclosed character class` |
| `filename:*abc` | `uncounted repetition operator must be applied to a sub-expression` (a `*` needs something before it) |

The samples above are checked by an automated test (`search::tests::regex_samples`), so they match what boonsh really does.

### Finding folders by size
Add `type:folder` to a size filter and the size means **the total of all files inside the folder**, at any depth. For example `type:folder size:>20G` lists folders holding more than 20 GB.
- The Size column of those results shows each folder's total, and sorting by Size ranks the biggest first.
- Without `type:folder`, a size filter matches **files only**. This keeps a plain `size:>1G` from scanning whole drives.
- Folders you don't have permission to read are skipped, so their totals come out low. Sizes are real file sizes, not "size on disk".
- On a drive with millions of files the scan can take a while. The search box shows "Searching...", and typing a new query stops the old scan.

### Handy examples
| Goal | Query |
| --- | --- |
| Recent screenshots | `filetype:png filedate:7d` |
| Large videos from before 2025 | `filetype:video filesize:1G+ filedate:..2024` |
| Empty files | `filesize:0` |
| Executables under 10 KB | `filetype:exe filesize:-10K` |
| Anything modified on July 6 | `filedate:-07-06` |
| Name, type and year together (all must match) | `report filetype:pdf filedate:2026` |
| Biggest folders | `type:folder size:>1G` |
| Folders with more than 1 KB inside (hides empty ones) | `type:folder size:>1K` |
| Documents but no backups | `filetype:doc !backup` |
| Invoices (regex) in a specific year | `filename:^inv filedate:2026` |
| Everything of one client that is legal | `path:client-xyz +legal` |
| Legal or contract files, but only of client-xyz | `path:(legal, contract) +client-xyz` |
| Search only two folders | `input:.\client, .\documents report` |
| Same file name in two folders (to delete the copies) | `input:.\movie\abc +.\movie\xyz tmp-title.txt` |
| Search inside the folders you selected earlier | `input:{INPUT01} filetype:pdf` |

## 8. Preview drawer

Open it with the **Eye icon** or **Ctrl+P**. It appears below the file panel and shows the **selected** file.

- **Text and code files** show their contents (the first 500 KB; larger files end with a note that they were cut off). Files that can't be read as text show "Binary or unreadable file content." Folders and files with no preview show "No preview available".
- **Images** (png, jpg, jpeg, webp, gif, bmp, svg) open in an image viewer:

| Control | Key | Action |
| --- | --- | --- |
| First / Previous / Next / Last | Home, Left or PageUp, Right or PageDown, End | Move through the images in the folder. The header shows the position, like `3/12`. |
| Go to image | Ctrl+G | Jump to an image number. |
| Zoom in / out | `+` / `-` | Zoom from 0.2x to 8x. |
| 1:1 | `1` | Toggle an actual-size style view. |
| Fit to window | `0` or `F` | Reset zoom and position. |
| Lock zoom | `L` | Keep your zoom and position when you move to another image. |
| Pan | Drag with the mouse | Move the image around. |

- **Videos** (mp4, m4v, mov, webm, ogv; mkv, avi, wmv, mpg, mpeg, 3gp and ts are tried) open in a video player. Selecting a video shows its first picture and **does not start playing** by itself. A **timing bar** with the elapsed and total time sits above the buttons; click or drag it to jump.

| Button (left to right) | Key | Action |
| --- | --- | --- |
| Play / Pause | Space | Start or pause. Click the picture does the same. |
| Back 10 | J | Step back 10 seconds. |
| Stop | | Pause and go back to 0:00. |
| Forward 10 | L | Step forward 10 seconds. |
| Capture (camera) | C | Save the current picture as a PNG. |
| Record (circle) | | Start / stop recording what is playing as a WebM clip, with sound. A red **REC 0:07** shows while recording. If an A-B part is set, recording starts at A and stops by itself at B. |
| A-B | | First click sets **A** (the button shows `A 0:05`), the second sets **B** and that part **repeats**, the third clears both. The timing bar shades the A-B part. |
| Subtitles | | A menu: **Off**, the subtitle files found, **Load a subtitle file...** |
| Speed (`1x`) | | Each click steps 0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x. |
| Volume (right side) | M (mute) | Mute button and a volume slider. The level is remembered for next time. |
| Open medium (folder icon, far right) | | Opens a file dialog and plays **another video** in the player. |

- **Captures and clips** are saved in a folder named **boonsh captures** next to the video, named like `movie_00-01-23.png` and `movie_00-00-05_to_00-00-08.webm`. Nothing is overwritten (a number is added). A message at the bottom of the picture shows the full path; click it to open the folder. Clips are recorded in real time and are WebM, not the original format.
- **Subtitles:** a `.srt` or `.vtt` file in the same folder whose name starts with the video's name (`movie.srt`, `movie.en.srt`) is found and shown automatically. UTF-8 files are read as they are; other files are read as Thai (TIS-620). The text appears in the picture's own subtitle style.
- **Full screen:** the maximize button in the header, a double-click on the picture, or **F**; Esc leaves it. The controls stay at the bottom.
- **If a video will not play** (the built-in player does not decode every format; MKV, AVI, WMV and some HEVC files often fail), the panel says so and offers **Open in the default player**.
- The video keys only work when you are not typing in a text box (Space is not taken from the terminal or the search box).
- The image keys only work when you are **not typing in a text box**, so typing in the search box, path bar, rename or Settings dialogs, or the Go-to box never moves or zooms the image.
- **Full screen:** the maximize button in the preview header; **Esc** exits. The **X** (or Ctrl+P) closes the drawer.

## 9. Terminal

The right side is a real **PowerShell** terminal. boonsh uses PowerShell 7 (`pwsh`) if installed, else Windows PowerShell, else `cmd`. It uses a fixed-width font (Cascadia Code) at 12 px, remembers 5,000 lines of scrollback, follows the dark or light theme, and the prompt is short: `<username> >` (or `admin >` in admin mode). The button at the top-right of the terminal header shows **User: <name>** (with **(Admin)** in an Administrator tab); click it to switch that tab's login.

- **Copy / cut / paste:** select text with the mouse. **Ctrl+C** copies it (with nothing selected, Ctrl+C still interrupts the running command). **Ctrl+V** pastes the clipboard at the prompt. **Ctrl+X** with a selection copies it (output text cannot be removed, so cut = copy; with no selection it goes to the shell). Right-click in the terminal for **Cut**, **Copy** and **Paste** (Cut and Copy are greyed out with no selection), and for **Explain with AI** / **Ask AI about this...**, which send the selected text to the AI Assistant (see section 16, *Ask about the command line*).
- **Tabs:** the terminal can hold several command lines at once, one per tab, in a tab bar above the terminal header.
  - There is **always at least one command line**. It opens when boonsh starts. The **tab bar is always shown**, also with one tab. Every tab is named after your user name; use **Rename Tab** to tell them apart.
  - **New tab:** the **+** at the end of the tab bar, or right-click the terminal header (the bar with the Commands button) and choose **New Tab**. The new tab opens in the folder the file panel shows and becomes the active tab.
  - **Close a tab:** the **x** on the tab (a lone tab has none), or right-click the tab and choose **Close Tab**. **Close All Tabs** is in the header's right-click menu (greyed out with one tab) and leaves one fresh tab. If a program is still running in the tab (boonsh knows between pressing Enter and the next prompt), boonsh asks before closing it. Typing `exit` in a tab closes that tab; closing the last tab (or `exit` in it) opens a fresh one.
  - **Colors:** every tab header has a color, taken in turn from 10 predefined colors (blue, red, green, orange, purple, teal, pink, brown, indigo, cyan) so tabs next to each other look different. The tab names are **white in both the dark and the light theme**; the active tab is drawn in the full color and the others in a slightly darker shade of it. Right-click a tab and choose **Change Tab Color** (below Rename Tab) to see the 10 colors and pick one. Colors are not saved when you close boonsh.
  - **Reorder:** press a tab and drag it sideways; it swaps places with the tabs it passes. The order is not saved when you close boonsh.
  - **Rename:** right-click the tab, **Rename Tab**, type the name, press Enter (Esc cancels, an empty name is ignored). The name is not saved when you close boonsh.
  - **Tabs and the file panel:** the file panel follows the **active** tab. Click another tab and the file panel switches to the folder that tab's shell is in. Open a folder in the file panel and only the active tab gets the `cd`. A `cd` typed in a background tab does not move the file panel; it is remembered for when you switch to that tab.
  - Each tab keeps its own history, running program and scrollback. Hiding the terminal (below) keeps all tabs running.
- **Show / hide the terminal:** the green terminal icon in the top-right toolbar (before the gear) hides the whole terminal side so the file panel gets the full width, and shows it again. The terminal is only hidden, not closed: the shell and any program in it keep running, and the folder `cd` still follows you. It is shown when boonsh starts.
- Everything you can do in PowerShell works. Drop files onto the terminal to type their paths.
- Folder sync works both ways (see [section 3](#two-way-sync-with-the-terminal)).
- Keys like Ctrl+A, Ctrl+C, Ctrl+V and Del go **to the terminal**, not the file panel, while you are typing in it.

### Commands menu (the "Commands" button)
A helper for beginners: click **Commands**, point at a group on the left, then click a command on the right.
- The command's text is **typed at the prompt for you** (it is not run, so you can add arguments and press Enter yourself).
- A **usage hint** appears under the bar, like `ren "oldname.txt" "newname.txt"`. Close it with its X.
- Groups and commands are editable in Settings (next section), and you can add groups of your own, which appear in this menu after the built-in ones. Built-in groups:

| Group | Commands |
| --- | --- |
| Basic Commands | ren, del, copy, move, mkdir, dir / ls, cls. **move** and **copy** type `move {SELEC} {DEST}` and `copy {SELEC} {DEST}` at the prompt (their usage hint still shows `move "source.txt" "destination.txt"`), ready-made examples of Global Variables (see below): assign the files to `{SELEC}` and the target folder to `{DEST}`, then pick the command. A `move` or `copy` saved by an older version that you never edited is updated to this; reset the list to get it back if you changed it. |
| Network Commands | ping, ipconfig, netstat, tracert, nslookup, Test-NetConnection |
| System Commands | tasklist, taskkill, systeminfo, whoami |
| Customize | (empty: yours to fill) |

If a group is empty, the menu shows a link that opens Settings. Groups you add yourself (for example **Cisco Network**) are listed below Customize.

### {SELEC} and {DEST}: files for terminal commands
Two variables link the file panel and the terminal. They exist only while boonsh is open.
1. Click files or folders, right-click and choose **Assign to Global Var**, then a variable. `{SELEC}` stores everything selected; `{DEST}` stores only the item you right-clicked. Right-click on empty space stores the **current folder**.
2. Write a command that uses them in Settings, for example `resize-images --width 800 {SELEC} {DEST}/file2.jpg` or `ren {SELEC} {DEST}`.
3. Pick it from the Commands menu. The text is typed at the prompt with the values filled in. A variable with no value stays as `{SELEC}` / `{DEST}`, so you see exactly what would run.

How values are written:
- A path **inside the current folder** is relative (`.\AITutor\server.js`, or `.` for the folder itself). Any other path is absolute (`D:\somboon-data\Dev\AITutor\server.js`). The same text is shown in the right-click menu.
- Several selected items become several separate paths. Paths with spaces or special characters are quoted (`".\my folder\a.txt"`); in `{DEST}/x.jpg` the whole word is quoted. If you put your own quotes around a variable, boonsh does not add more.
- While the command is **still waiting at the prompt** (you have not typed in the terminal), assigning a variable, clearing one, or opening another folder in the file panel **rewrites that line**: it is cleared (Esc) and typed again with the new values and paths relative to the new folder. Once you type anything in the terminal, boonsh leaves the line alone.
- The buttons in the terminal's top bar have colored icons: **Commands** (amber book), **Global Var** (cyan) and **CONST Global Var** (purple lock; see section 10). The same colors mark the sections in Settings.
- The terminal's top bar has a **Global Var** button next to Commands. Click it to see every variable with its full value (relative to the current folder where possible) and an X to clear it. Only variables that have a value are listed, and the button is hidden while none is set. Hover a path for its absolute form.

**Create your own variables.** In Settings (gear), **Global Var**, you can add more variables, rename or delete them (see section 10). Every variable you create appears in the right-click **Assign to Global Var** submenu, in the terminal's **Global Var** button, and can be used as `{NAME}` in your commands and in the search (`input:{NAME}`, see section 7).

**Step by step: a command with your own variable**
1. Settings, **Global Var**, **Add variable**: name `SOURCE`, Assign stores *Every selected item*. Click **Add variable**.
2. Settings, **Commands**, tab **Customize**, **Add command**: Name `copy to dest`, Terminal text `copy {SOURCE} {DEST}`. Click **Add command**.
3. In the file panel select two files, right-click, **Assign to Global Var**, `{SOURCE}`. Right-click a folder, **Assign to Global Var**, `{DEST}`.
4. Terminal, **Commands**, **Customize**, **copy to dest**. The prompt now shows the full command with the paths filled in, for example `copy .\a.txt .\b.txt .\backup`. Nothing runs until you press Enter.
5. You can do step 3 **after** step 4 as well: while the command is still sitting at the prompt, assigning a variable rewrites the line with the new value.

## 10. Settings: customize terminal commands

Click the **gear icon** (next to the Eye icon). The left bar has eight sections, **Commands**, **Global Var**, **CONST Global Var**, **Files Column**, **Quick Access**, **Frequently Accessed**, **Manual** and **About**; the details open on the right. Changes are **saved automatically** and show up straight away. **Reset** (bottom left) resets only the section you are in.

### Global Var
Manage the variables that commands can use as `{NAME}`.
- **Add variable**: a **Name** (letters, digits and `_`, up to 30 characters, saved in capitals, no duplicates), what right-click **Assign stores** (*only the item you right-clicked*, or *every selected item*) and an optional description.
- **Edit** (pencil or double-click) can **rename** a variable. The value is kept, and `{OLD}` is replaced by `{NEW}` in your command texts and usage examples.
- **Delete** (trash) removes it and its value. Commands that still mention it keep the text `{NAME}` as typed.
- Each row shows the variable's current value or *Not set*. Reset variables brings back just `{SELEC}` and `{DEST}`.
- Only the list of variables is stored; the values are forgotten when boonsh closes.
- The variables show up automatically in the right-click **Assign to Global Var** submenu and in the terminal's **Global Var** button.

### CONST Global Var
Constants: a name with a **fixed value** that commands can use as `{NAME}`, for example `{IP}` = `202.283.242.97`. The section sits below **Global Var**.
- **Add constant**: a **Name** (letters, digits and `_`, up to 30 characters, saved in capitals), a **Value** (the text that is typed in place of `{NAME}`; required, one line) and an optional **Description**, for example *This is the IP of XYZ server*. A name cannot be used twice, and cannot be the name of a Global Var either.
- Each row shows `{IP} = 202.283.242.97` and the description. **Edit** (pencil or double-click) can change the value, the description and the **name**; a rename replaces `{OLD}` by `{NEW}` in your command texts and usage examples.
- **Delete** (trash) removes it after you confirm. Commands that still mention it keep the text `{NAME}` as typed. There is no Reset button here: a constant stays until you delete it, also after you close boonsh.
- Use it like any variable: write `ping {IP}` as the **Terminal text** of a command (Settings, Commands). When you pick the command, the value is typed in as written: it is not quoted and not turned into a relative path. In a larger word it works too (`ssh admin@{IP}`). A `{NAME}` that is not defined stays as typed.
- The terminal header shows a purple **CONST Global Var** button next to **Global Var** as soon as there is at least one constant (hidden when there are none). Click it to list every constant with its value and description; **click a row to type its value at the prompt**.
- Constants are not offered in the right-click **Assign to Global Var** menu or the search (`input:`), because they hold text, not files.

### Files Column
Choose what the file panel's Details view shows. Changes apply at once and are saved.
- **Checkboxes** show or hide each column. **Name** is always shown and always first.
- **Up / down arrows** move a column to the left or right of its neighbours.
- **Date Modified** and **Date Created** have two choices each: **Show** (date and time, or date only) and **Sort by** (date and time, or date only; see section 4).
- **Keep folders above files when sorting** (on by default). Turn it off to let folders mix in with the files according to the sort.
- The choices include Dimensions, Length, Album, Artist, Actor, Genre and Rating, which come from the file's properties (section 4, "More columns").
- **Reset columns** (bottom left) brings back Name, Date Modified, Type and Size, and the default date options.

### Quick Access
Choose what the Quick Access row (above the folder tree, section 3) shows. Each change applies at once and is saved.
- The list shows **Drive (C:)**, **Home**, **Desktop**, **Downloads** and **Documents**, then your other drives (for example Drive (D:)), each with its path. The first five are **ticked** at first; the other drives are not.
- **Tick** an item to show it in the bar (it goes to the end of the row); **untick** it to take it off.
- The bar holds **6 items** at most. The header of the list says how many are shown ("5 of 6 shown"). Ticking a seventh item is refused with a message; untick one first.
- Folders you added by right-click (*Add to Quick Access*) are listed at the end, ticked. Unticking one **removes** it, so it also leaves this list; add it again by right-click.
- Everything unticked is allowed: the bar is then empty, and stays empty the next time boonsh starts.
- Right-clicking a folder to add it, and right-clicking a button to remove it, work as before.
- **Reset Quick Access** (bottom left) brings back Home, Desktop, Downloads, Documents and the C: drive; folders you added are removed.

### Manual
This document, shown inside the app (the dialog grows wider for it). It is the manual of the version you have installed, because the file is built into the app. Click an item in the **Contents** list, or any `#` link, to jump to that section; links to web pages open in your browser. You can select and copy the text. The Reset button is not shown on this page.

### About
Information about boonsh itself. Nothing here can be changed.
- The **name and version** (the version of the installed app), a one-line description and the copyright line.
- A note that boonsh is **free software** that anyone may use, copy, change and share under the **MIT License**, and the **full license text** in a box you can scroll and select.
- **Project page on GitHub** opens the project's page in your browser.
- **Open the licenses of the libraries inside boonsh** opens `THIRD_PARTY_LICENSES.txt` in your text editor: the license texts and copyright notices of the open-source libraries boonsh uses (Tauri, React, xterm.js, the Rust crates and so on). The installer puts this file next to the app.
- A short list of the main open-source components and the license of each.
- The *Reset* button at the bottom is not shown on this page.

### Frequently Accessed
Settings for the panel above the Folder Tree (section 3). Changes apply at once and are saved.
- **On: show the Frequently Accessed panel**: the check mark. Off hides the panel; the folders keep being counted, so it is filled when you switch it on again.
- **Folders to show**: 3 to 10 (default 3). The panel always shows this many folders as long as that many have been visited, also after you remove one.
- **Visit history**: how many folders have been counted, and **Clear history**, which forgets all of them (every count goes back to 0).
- **Reset settings** (bottom left) goes back to On and 3 folders; the visit counts are kept.

### Commands
The **Group** drop-down at the top lists every group with the number of commands in it; pick one to see its commands.

The icons beside the drop-down have no text, to save room; **hold the mouse over one to read what it does**: **New group** (green folder with +), **Rename** (blue pencil), **Delete** (red trash can), then **Import** (cyan arrow down) and **Export** (orange arrow up).

### Export and import a group
Share a group's commands with a colleague, back them up, or edit them in Excel.
- **Export** (orange arrow up): choose the file name and the type in the Save dialog. **JSON file (*.json)** is first in the list; **CSV file for Excel (*.csv)** is the other. A group with no commands cannot be exported. Every command is written with its name, terminal text, description, usage example and hot key. Built-in and your own groups can be exported.
- **Import** (cyan arrow down): choose a `.json` or `.csv` file. Its commands are **added to the group that is selected** in the drop-down (the group name inside a JSON file is not used, so you can import into any group). A message tells you the result, for example *Imported 3 commands. Skipped 1 duplicate (already in the group). 1 hot key not kept (not valid or already used).* A command is a **duplicate** when the group already has one with the same name and terminal text; it is skipped, so importing the same file twice changes nothing. A hot key is kept only when it is valid and not used by another command; the command is imported without it otherwise. Rows with no name or no terminal text are skipped. A file that cannot be read shows the reason.
- **Which format?** **JSON is the better choice** for sharing and backups: it keeps every character exactly (commas, quotes, line breaks, Thai text), has the group name and a version, and cannot be broken by a spreadsheet. **CSV** is for editing many commands in Excel or Google Sheets; save it as **CSV UTF-8** so Thai text stays right. boonsh's CSV starts with a header row `name,insertText,description,usage,hotkey`, so Excel opens it in columns; on import the column names are matched by name (the order does not matter; `terminalText` / `text` also work for `insertText`).
- The JSON file looks like: `{ "format": "boonsh-commands", "version": 1, "group": "Cisco Network", "commands": [ { "name": "show ip", "insertText": "show ip route ", "description": "...", "usage": "...", "hotkey": "Ctrl+Alt+R" } ] }`. A plain list of commands (`[ {...}, {...} ]`) is accepted too.

### Add a group
Click **New group** (the green folder icon), type a name (up to 30 characters, no duplicates, for example `Cisco Network`) and click **Add group** (Enter also works; Esc or **Cancel** stops). The new group is selected, and it shows in the terminal's **Commands** menu after the built-in groups. Add commands to it as below.
- **Rename** and **Delete** work only on groups you added (they are greyed out for the four built-in groups). Deleting a group asks first and removes its commands too.

### Add a command
1. Open Settings and pick a group in the **Group** drop-down (for example **Customize**, or a group of your own).
2. Click **Add command**.
3. Fill in the form, then click **Add command**:

| Field | What to put | Example |
| --- | --- | --- |
| **Name** (required) | The label shown in the menu. | `ren (rename)` |
| **Terminal text** (required) | What gets typed at the prompt when you pick it. Keep a **trailing space** if you will add arguments. `{SELEC}` and `{DEST}` are filled in from your file-panel choices. | `ren {SELEC} {DEST}` |
| **Description** | One line explaining it. | `Rename a file or folder` |
| **Usage example** | Shown as the hint after you pick it. | `ren "oldname.txt" "newname.txt"` |
| **Hot key** | Optional. Pick a key after the fixed **Ctrl + Alt +** (see below). | `K` (Ctrl+Alt+K) |
| **Group** | Which group it belongs to. | `Customize` |

### Hot keys for commands
Give a command a hot key and you can type it at the prompt from the keyboard, without opening **Commands** and choosing the group and command. Pressing the hot key does exactly what picking the command in the menu does (the text is typed at the prompt with `{SELEC}`, `{DEST}` and your constants filled in, the usage hint appears, nothing runs until you press Enter).
- **Set it:** in the command's form (Add or Edit) the **Hot key** line shows the fixed group **Ctrl + Alt +** and a **drop-down** of keys: the letters A-Z, the digits 0-9 and F1-F12. Pick one (or **(no hot key)**). The drop-down lists only the keys **no other command uses**, so a clash cannot be chosen.
- **Only while the command line is active:** a hot key works only when the **command line has the keyboard focus** (you clicked in the terminal, so a command line tab is active). With the focus in the file panel, the search box or anywhere else, **nothing happens**, so a Ctrl+Alt combination used by another program or by the rest of boonsh never clashes. It is also off while Settings is open and while the terminal is hidden.
- The hot key is shown beside the command in the Commands menu and on its row in Settings.
- **Suggestions** (mnemonic letters): `Ctrl+Alt+K` taskkill, `Ctrl+Alt+P` ping, `Ctrl+Alt+I` ipconfig, `Ctrl+Alt+N` netstat, `Ctrl+Alt+T` tasklist, `Ctrl+Alt+D` dir. None is set until you set it.
- Limits: another program may use a Ctrl+Alt combination as a global hot key (then it never reaches boonsh; choose another key). On keyboards where **AltGr** types characters (some European layouts), Ctrl+Alt+letter is also AltGr+letter, so a hot key swallows that character in the terminal. The key is the physical key, so it is the same on every layout.

### Edit a command
Click the **pencil icon** on its row (or **double-click** the row), change the fields, and click **Save changes**. Changing the **Group** field **moves** the command to that group.

### Delete a command
Click the **trash icon** on its row and confirm. This works on the built-in commands too.

### Other things to know
- **Reset to defaults** (bottom left) brings back the original command list. It asks first, and your added and edited commands, and the groups you added, are lost.
- **Esc** closes an open form first, then the Settings window. **Done** closes the window.
- The four built-in groups (Basic, Network, System, Customize) can't be renamed or deleted, but you can change their commands. Groups you add can be renamed and deleted.
- The list is stored on this computer by the app. It stays after you close boonsh.
- Keyboard shortcuts for files are switched off while Settings is open.

## 11. Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+A | Select all items in the folder |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy / Cut / Paste files |
| Del | Delete the selection (to the Recycle Bin) |
| F2 | Rename: opens the Rename box for one selected item, or Bulk Rename for 2 or more |
| Ctrl+Z | Undo the last bulk rename (asks first) |
| F5 | Refresh the folder |
| Ctrl+P | Show or hide the preview drawer |
| Ctrl+Shift+F | Show or hide the file panel (leaves the folder tree and terminal) |
| Home, End, Left, Right, PageUp, PageDown | Move between images (when an image is previewed) |
| `+`, `-`, `1`, `0` or `F`, `L`, Ctrl+G | Image zoom, 1:1, fit, lock zoom, go to image |
| Ctrl+Alt+(letter, digit or F1-F12) | A command hot key you set in Settings, Commands: types that command at the prompt, only while the command line has the focus |
| Esc | Exit full-screen preview; close Settings or its open form; cancel path editing |
| Enter / Esc in the path bar | Go to the typed path / cancel |

The file keys (Ctrl+A, Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+Z, F2, Del) are ignored while you are typing in the terminal or any text box, so they keep their normal text meaning there.

## 12. Status bar

The thin bar at the bottom shows, from left to right:
- The number of **folders and files** in the current folder and their **total size** (files directly inside the folder).
- A progress note while a zip task runs (for example "Compressing 3 item(s)...").
- On the right, the **selection** (the name and size of one item, or "N items" and their total size) and the active **shell**.

## 13. Appearance and saved settings

- **Theme:** the sun and moon icon switches between the **dark** (black) and **light** (white) theme. The terminal follows it.
- The right-click menu of the browser is turned off everywhere except in text boxes.

**What is remembered between runs**

| Setting | Remembered |
| --- | --- |
| Theme | Yes |
| View mode (Details, Tiles, Thumbnails) | Yes |
| Quick Access list | Yes |
| Terminal commands (Settings) | Yes |
| Bulk rename undo history (last 5 batches) | Yes |
| Bulk rename presets you saved (up to 30) | Yes |
| Sort levels, the columns shown and their order, the date options, the grouping | Yes |
| Frequently Accessed: the visit counts, on / off and the number of folders | Yes |
| AI Assistant: shown or hidden | Yes |
| AI Assistant: the API key | Yes, in Windows Credential Manager (not in a file) |
| AI Assistant: the conversation | While boonsh is open, also when the panel is hidden (cleared by the eraser button or when boonsh closes) |
| Panel sizes, column widths, preview open or closed, search box and Subfolders switch | No (reset on each start) |

## 14. Limits and known issues

**By design**
- Windows only.
- **Quick Access:** 6 items at most. **Search:** 8 levels deep, 300 results, regular expressions without look-around. **Zip:** Deflate only, so zips made with LZMA, Zstandard or similar can't be extracted.
- **Cut/Copy** work only inside boonsh, and **Paste** always goes into the folder you are viewing, even if you right-clicked a subfolder.
- **Command groups** can't be added, renamed or deleted.
- **File columns:** Dimensions, Length, Album, Artist, Actor, Genre and Rating depend on what Windows can read from the file (a property handler or codec for the file type must be installed), exactly as in Explorer. The sort by these columns works on the files whose properties have been read; reading goes on in the background for big folders. There is no Actor property in Windows: videos use the "Contributing artists" tag.
- **Global variables:** their values are kept only while boonsh is open (the list of variables is saved). The AND in `input:` compares file names, not file contents. `path:` and `input:` do not allow two words next to each other without a comma or `+`.
- **Bulk rename:** up to 20,000 items and 30 rules at a time. The extension is the text after the last dot, so for `archive.tar.gz` the extension is `gz` and the name part is `archive.tar`. A very long list of undo steps may not be kept after a restart (the stored history is limited to about 2 MB, oldest batches first). Undo can't help if the files were changed outside boonsh in the meantime; those parts are skipped and reported.
- Folder-size totals skip folders you can't read, and count real size, not size on disk.
- Switching between normal and Administrator mode restarts the app. If Windows can't relaunch it as a normal user directly, it falls back to a method that can't pass the folder, so the app opens in the default folder.
- **AI Assistant:** needs an internet connection and your own API key from Anthropic (Claude), OpenAI or Google Gemini (each request is billed to that key). Other services are not supported. It only acts on the folder that is open and only on boonsh features; it does not read the contents of files.
- The "1:1" image button toggles an enlarged view, which is not guaranteed to be the image's exact pixel size.

**Known issues**
- None at the moment.

## 15. Keeping this document current

Update this file whenever a feature is added, changed or removed, and change the version number at the top when the version changes. Record what changed in `RELEASE.md` too.

## 16. AI Assistant

The **AI Assistant** is a chat panel under the command line panel. Tell it in plain words what you want done in boonsh, and it does it for you on the folder that is open: *"sort by size, largest first"*, *"group by month"*, *"show only the PDF files"*, *"rename these photos to Trip_001, Trip_002..."*, *"write a command that lists the 10 biggest files here"*.

**Showing it.** Click the **sparkles icon** at the top right of the window (the last icon of the header bar). The panel opens under the command line; drag the bar above it to change its height. Click the icon again, or the **x** in the panel header, to hide it. Hiding only hides it: the conversation is still there when you show the panel again. When the command line panel is hidden, the assistant takes the whole right side. boonsh remembers whether the panel was open.

**Your API key.** The assistant works with **your own API key** from any of three services: **Anthropic (Claude)**, **OpenAI** or **Google Gemini**.
1. Click the **key button** in the panel header and paste the key.
2. The list in front of the key says which service it is for. **Auto-detect** recognises the key by its beginning: `sk-ant-` is Anthropic, `AIza` is Gemini, any other `sk-` is OpenAI. If it guesses wrong, or the key looks different, choose the service yourself.
3. Click **Check**. boonsh asks the service for the models the key may use (this costs nothing) and proposes the **cheapest chat model**, marked *(cheapest)*: a Claude **Haiku** model, OpenAI's newest **nano** model (else *mini*), or Gemini's newest **Flash-Lite** model (else *Flash*). The tasks are simple, so a bigger model is not needed. You can pick another model from the list.
4. Click **Save**. The key, its service and the model are kept in **Windows Credential Manager** for your Windows account.

The panel header shows the model in use. The key button is red while no key is saved and amber when one is. Open the key form again to change the model (the **Saved** line), to replace the key with another one (any service), or to **Remove key**. A new key or model starts a new conversation. The **Get a key** links open the key pages of the three services in your browser. Each request is billed by the service to the key's account.

**Asking.** Type in the box at the bottom and press **Enter** (**Shift+Enter** for a new line), or click a quick prompt (below). Each step the assistant takes is listed as a short line with a check mark (or a red warning when it failed), followed by its answer. **Stop** (the square button) ends a request that is still running. Every message has its **date and time** under it (each action line shows its time as a tooltip). The **eraser button** starts a new conversation (after you confirm). The assistant remembers the conversation until then, so you can follow up (*"now only the jpg files"*), and the panel keeps the last **500 lines** to scroll back through (older lines are dropped from the screen, not from what the assistant remembers).

**Quick prompts.** The line of buttons above the box holds requests you use often. Click one to send it at once. It starts with a few examples (*Sort by date modified, newest first*, *Group by type* ...).
- **Add:** type the request in the box and click **+** at the end of the line, or right-click one of your messages in the conversation and choose **Save as quick prompt**.
- **Right-click a quick prompt** for **Put in the box (to edit first)** or **Remove quick prompt**.
- Up to 20; the line scrolls sideways when they do not fit. They are kept between runs (removing them all keeps the line empty).

**Earlier requests (Up / Down).** In the box, **Up** brings back what you sent before, newest first, and **Down** goes forward again; past the newest, the text you had started typing comes back. In a box with several lines, Up works on the first line and Down on the last (elsewhere they move the cursor as usual). The last 50 requests are kept between runs. Quick prompts you clicked are not added.

**Ask about the command line.** Select text in the command line panel (an error, or a command with its output), right-click it and choose:
- **Explain with AI**: opens the assistant and sends the text at once, asking what it means. For an error it explains what went wrong and, when a command would fix it, types the corrected command at the prompt (not run, as always).
- **Ask AI about this...**: opens the assistant with the text attached (a green dashed line above the box says so) and puts the cursor in the box for your own question, for example *"how do I run this as administrator?"*. Enter with an empty box asks for an explanation. The **x** on that line drops the attached text.

The text appears in your message in a small box. Only the last 6,000 characters of a long selection are sent. The selected text goes to the AI service, so do not select passwords or other secrets. Text from the command line is treated as data, like file names: instructions written inside it are not followed.

**Saved conversations (off until you turn it on).** The **clock button** in the panel header opens the list of saved conversations.
- Tick **Keep conversations on this computer** to save them. Each conversation is then saved as you go, and when boonsh starts it reopens the latest one, so you can carry on where you stopped. The eraser starts a new conversation and the previous one stays in the list.
- The list shows each conversation's first request, when it last changed, how many messages it has and what it used (tokens, and the cost when known), newest first. Click one to open it (not while the assistant is working); the open one is marked with a purple bar. The trash button deletes one; **Delete all saved conversations** deletes them all (the one on screen stays open).
- The assistant gets an opened conversation's earlier messages and actions as context with your next request, so a follow-up like *"now the other way round"* works after a restart. It knows those actions are already done. The same happens after you change the key or the model.
- Unticking it stops saving and asks whether to delete the saved conversations too (Cancel keeps them; you can still open or delete them in the list).
- They are saved in your Windows user profile (`%APPDATA%\com.boonsh.app\ai-chats`, one file per conversation) as plain text: what you asked, the answers, file names and any command line text you sent. Up to 100 are kept; the oldest go first. With the option off nothing is written.

**Tokens and cost.** The services count **tokens** (pieces of words) and bill by them. boonsh shows:
- in the panel header, the tokens of the open conversation and, when the model's price is known, about what it cost (*12k tokens · ~$0.0021*);
- after the time under the last message of each request, what that request used (one request can take several steps when the assistant uses tools).
Point at either for the details: input, output (thinking included), input read from the service's cache (about 10% of the input price) and, for Claude, input written to the cache (125%).

The token counts come from the service and are exact. The **cost is an estimate**: boonsh knows the prices of a few models from public price lists (October 2026): Claude Haiku 4.5, GPT-5 nano / mini, GPT-5.4 nano / mini, GPT-4.1 nano / mini, Gemini 2.5 Flash-Lite / Flash and Gemini 3.1 Flash-Lite. For any other model, or when a price changes, enter the price yourself: open the key form, fill in **Price per 1M tokens, USD** (input and output, as on the service's price page; the **price list** link opens it) and click **Set price**. **Built-in price** / **Clear price** removes your own price again. Without a price only the tokens are shown. Taxes, free tiers and discounts are not included: the service's bill is the real amount.

**Search the conversation.** The **magnifier button** in the panel header opens a search box. It shows only the messages and action lines that contain the text (ignoring upper / lower case, dates and times included), marks the matches in yellow and shows how many were found (*2 of 14*). **Esc** or the **x** closes the search and shows everything again.

**Copying.** The text in the panel can be selected with the mouse and copied with **Ctrl+C**. Click in the conversation and press **Ctrl+A** to select all of it. Right-click in the conversation for **Copy** (the selected text), **Copy message** (the message under the pointer), **Copy conversation** (every line with its date and time; while searching, only the lines found) and **Select all**.

Each request also tells it the current folder, the selection, the sort, the grouping, the columns, the view and which panels are open. It sees file names and sizes when it needs them, never the contents of files. It sees command line text only when you send it with **Explain with AI** / **Ask AI about this...**.

**What it can do**

| Area | Examples |
| --- | --- |
| Folders | open a folder (absolute, or relative such as `..` or `Projects\2026`), open a file in its program |
| Selection | select by names or a wildcard (`*.pdf`), select all, clear the selection |
| Sorting, grouping, columns | sort levels, Group by (dates by year / month / week / day or relative, type, size ...), show or hide columns, folders first |
| View | Details / Tiles / Thumbnails, dark / light theme, show or hide the preview, the file panel and the command line |
| Search | writes a query in boonsh's search language and puts it in the search box (see section 7) |
| Files | rename one item, new folder or file, copy / cut / paste, compress to zip, extract zips, delete to the Recycle Bin |
| Bulk rename | opens the Bulk Rename dialog with the rules filled in and the preview already made |
| Command line | types a command at the prompt of the active tab, **without running it** |
| Settings | Global Var values, Quick Access, Frequently Accessed (on / off, how many), opens a Settings section |
| Help | answers how-to questions about boonsh from this manual |

**Safety**
- A **command** is only typed at the prompt; it never presses Enter. Read it, then press Enter yourself. If you change folder before running it, boonsh clears the line, sends the `cd` and types the command again, as it does for commands with `{SELEC}`. Nothing is typed while a program is running in the tab.
- **Delete** always asks you to confirm first, and the items go to the Recycle Bin.
- **Bulk rename** only opens the dialog with its preview: you check the new names and click **Rename** yourself (and Ctrl+Z undoes it as usual).
- The assistant only answers about boonsh, your files and folders, and command line commands. Questions about anything else (songs, movies, celebrities, K-pop, weather, news ...) get the reply *"Sorry, I can only help with boonsh: files and folders, sorting, grouping, renaming, search, command line commands and settings."*
- File names are treated as data: text inside a file name cannot give the assistant instructions.

**Problems.** *"... rejected the API key"* opens the key form: save a valid key. *"Could not reach ..."* means there is no internet connection. *"Too many requests or the quota is used up"* means the service's rate limit or the account's credit was reached. *"The key works, but it has no chat model the assistant can use"* means the key's account has no suitable model. A failed request leaves the conversation as it was, so you can simply ask again.
