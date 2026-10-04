# Release Notes

New features and fixes of each boonsh release, newest first. Changes go under **Unreleased** as they are made, and move under a version heading when the version is bumped.

## Unreleased

(none yet)

## 0.9.2 (2026-10-04)

### Fixed

- Terminal: the bottom pixels of the last prompt line were cut off. One empty row is now kept under the prompt.

### Changed

- Status bar text is colored (counts blue, selection amber, shell green, busy message orange) with separate tones for the dark and light themes.

### Added

- Colored icons on the toolbar buttons, the Quick Access chips and the terminal right-click menu.
- Terminal: select text with the mouse, then copy it with **Ctrl+C**, paste with **Ctrl+V**, or use the right-click menu (**Cut**, **Copy**, **Paste**). Without a selection Ctrl+C still interrupts the running command.


## 0.9.1 (2026-10-03)

### Changed
- **The built-in `move` and `copy` commands now type `move {SELEC} {DEST}` and `copy {SELEC} {DEST}`** at the prompt (they typed just `move ` / `copy `), so new users see Global Variables at work. The usage hint under the bar is unchanged. A saved `move` / `copy` that was never edited is updated; an edited one is kept.

### Added
- **Manual** in the Settings gear: the whole `FEATURES_SPEC.md` shown inside the app (headings, tables, contents list that jumps to a section, links), always the manual of the installed version. The dialog is wider on that page. New library `marked` (MIT), listed in `THIRD_PARTY_LICENSES.txt` and in Settings > About.

## 0.9.0 (2026-10-03)

### Added
- **Video player in the preview drawer.** Select a video (mp4, m4v, mov, webm and more) and the drawer plays it: a timing bar with the times above the buttons Play/Pause, Back 10 s, Stop, Forward 10 s, Capture (PNG), Record (WebM clip), A-B repeat, Subtitles; on the right Volume (remembered), Open medium (play another video file). Extras: playback speed, keys Space / J / L / M / C / F, full screen like the image viewer (button, double-click or F), a message with an "Open in the default player" button when the built-in player cannot decode a file. Captures and clips go to a `boonsh captures` folder next to the video. A `.srt` / `.vtt` with the video's name is picked up by itself (Thai TIS-620 files are read correctly).
- New backend commands `read_subtitle`, `save_capture` and `pick_file` (Windows file dialog); the asset protocol is on so videos stream from disk with seeking. One more library (`http-range`, MIT) in `THIRD_PARTY_LICENSES.txt`.

## 0.8.2 (2026-10-03)

### Changed
- **Group lines now end with a `>` too:** `2026 July > CSV >`. The `>` after a name collapses that group (after `CSV`: only CSV, giving `2026 July > CSV v`; after `2026 July`: all of July, giving `2026 July v`). Before, the last name had no `>`.
- **A proper `README.md`** for the project's GitHub page: what boonsh is, screenshots, which installer to download, step-by-step installation of the setup .exe and of the .msi (with silent-install commands), updating, uninstalling, first steps, troubleshooting, building from source and the license. Documentation only; the app itself is unchanged.

## 0.8.1 (2026-10-03)

### Added
- **boonsh is now free software under the MIT License** ("Copyright (c) 2026 Somboon L."). The license text is in the new `LICENSE` file, and the Windows installers (MSI and setup .exe) now show it.
- **Settings, About.** A new group at the bottom of the Settings dialog shows the name and version, the copyright line, the full MIT license text, the main open-source components with their licenses, a button to open the project page on GitHub, and a button that opens the licenses of all the libraries inside boonsh.
- **`THIRD_PARTY_LICENSES.txt`** is installed next to the app. It holds the license texts and copyright notices of the 276 libraries boonsh includes (268 Rust crates and 8 JavaScript packages), grouped by identical text. `scripts/gen-third-party.py` writes it.
- The installers are published on the project's GitHub Releases page.

## 0.8.0 (2026-10-03)

### Added
- **Group view.** Right-click a column header, *Group by*, to put the files under headers, for example by month, then file type, then the file names. *Group by* opens a list to tick. For the date columns tick one or more of Year, Month, Week and Day and they are joined in the order ticked: Year then Month gives `2026 May`, Month then Year gives `May 2026`, Month alone gives `May` (the same month of every year); or tick Relative date (Today, Yesterday, Earlier this week ...). Other columns: Type by file category or each extension, Type by file category or each extension, Size by range, Name by first letter, Location by folder, Dimensions by megapixels, Length by duration, Album, Artist, Actor and Genre by value, Rating by stars. Grouping is separate from sorting: it stays on for every folder and search result until you cancel it (*Stop grouping by ...* or *Ungroup all*) and is remembered between runs. The layers follow the sort numbers on the column headers (a grouped column that is not sorted yet is added to the sort as the next number); each layer follows its column's sort direction, and inside the innermost group the other sort levels order the files. Each lowest-level group is **one line** that names the path through the layers, for example `2026 July > CSV` (no item counts or sizes; hover for them). Click the `>` to collapse the group on its left into a single line with a down arrow (`2026 July v`), click the line to collapse just that group, click the down arrow or the line to open it again. The line stays visible while scrolling. Group headers are plain, in the same font and colours as the file list; the arrow (down = open, right = collapsed) and the indent of each layer show the grouping. Right-click a line for *Select* (every level of the line), *Collapse all* and *Expand all*. Files in a collapsed group are not selected by Ctrl+A or Shift+click. A layer with only one group shows no header. Files with no value go to a *(none)* group at the end.
- **Settings, Quick Access.** A new group in the Settings dialog lists Drive (C:), Home, Desktop, Downloads, Documents and your other drives with a check box each. Tick or untick to show or hide an item in the Quick Access row. Folders added by right-click are listed at the end. A counter shows how many of the 6 allowed items are used, and a seventh is refused with a message. *Reset Quick Access* restores the defaults. Right-click *Add to Quick Access* and right-click *Remove* work as before.

### Changed
- **The default Quick Access row is now Home, Desktop, Downloads, Documents and the C: drive** (before: the first six of the folders and drives, which also put Drive D: in). Lists you already have are kept as they are.

### Fixed
- **Column headers no longer wrap onto a second line** (the sort arrow, number or group icon used to drop below the name in narrow columns); the Date Modified and Date Created columns are a little wider (165 px) to fit them.
- **A Quick Access row that was emptied came back with the defaults** the next time boonsh started. An empty row is now remembered.

## 0.7.0 (2026-10-03)

### Added
- **Frequently Accessed panel** above the Folder Tree: the folders you open most (names only; hover for the path and the number of visits). Click to open one; right-click, *Remove from Frequently Accessed* to forget it (its count restarts from 0 and the next most visited folder takes its place, so the list stays the length you chose). Every time a different folder becomes the open folder counts as a visit (double-click, tree, Quick Access, path bar, `cd` in the terminal); refresh and search do not. Folders that can no longer be opened drop out by themselves. Remembered between runs.
- **Settings, Frequently Accessed:** a check mark to turn the panel on or off, how many folders it shows (3 to 10, default 3), and a *Clear history* button. Counting continues while the panel is off.
- **Smart sort: sort by several columns at once.** Click a column header to sort by it alone (click again to reverse). **Shift+click** (or Ctrl+click) adds a header as the next sort level: the headers show an arrow and, with more than one level, the level number (1, 2, 3...). Shift+click again reverses that level, and once more removes it. Right-click a header for the full menu (sort ascending / descending, add as the next level, remove from the sort, hide the column, choose columns). The levels are remembered between runs.
- **Date only or date and time.** Date Modified and Date Created can be sorted by the exact date and time (default) or by the date only, so files from the same day tie and the next level (for example the name) puts them in order. Choose it in the header right-click menu, or in Settings, Files Column.
- **Files Column in Settings.** A third section in the Settings dialog chooses which columns the file panel shows and their order (Name is always first). It also holds the date options (show the time or not, sort by the time or not) and "Keep folders above files when sorting". The choices are remembered.
- **The Type column shows the default app:** `MP4 (VLC media player)`, `JPG (XnView MP)`, `TXT (Notepad)`. A type with no app set to open it shows `ENV File (-)`, and a file without an extension shows `File (-)`. The name comes from the Windows file associations (what Explorer shows as the default app) and follows the Windows Default apps settings; it refreshes when the window gets focus again. Sorting by Type still sorts by extension. The Type column is wider by default (200 px).
- **New columns:** Date Created, Location, Dimensions, Length, Album, Artist, Actor, Genre and Rating. Dimensions, Length, Album, Artist, Actor, Genre and Rating are read from the file's properties the way Windows Explorer shows them (pictures, videos and audio files), in the background, only while such a column is shown or sorted. Windows has no Actor property, so for videos Actor shows the "Contributing artists" tag. Empty values always sort last.

## 0.6.0 (2026-10-02)

### Added
- **Search: `path:` filter.** Matches when the item's full path (the folders above it, plus its own name) contains the text, so you can find files by the folders they live in. `path:legal`; comma = OR (`path:client-xyz,client-abc`, spaces around the comma are fine); a space and `+word` = AND (`path:client-xyz +legal`, with the + right in front of the word); AND is done before OR and equal operators go left to right (`path:a, b +c` is a OR (b AND c)), and parentheses group (`path:client-xyz +(legal,contract)`); quotes = the exact text as whole folder or file names rather than part of one (`path:'legal'`), names with spaces need quotes (`path:'my client'`), text in quotes is literal and a `*` goes outside them (`path:'my client'*` also fits `my client 2026`), and a quoted `\` is part of the text (`path:'client-xyz\invoices'` = `invoices` directly inside `client-xyz`); `!path:archive` excludes. Lists such as `filetype:jpg, png` may now have spaces around the commas, and single quotes work like double quotes for search terms. It is in the `?` cheat sheet.
- **Search: `input:` chooses where to search.** Without it the search runs in the current folder, as before. With it, it runs in the folders (or files) you list: `input:.\client, d:\work\`. A comma means OR (more places). A space and `+` means AND **by file name**, and AND is done before OR with parentheses to group (`input:.\a +.\b, .\c` is (a AND b) OR c; `input:.\a +(.\b, .\c)` is a AND (b OR c)): `input:.\movie\abc +.\movie\xyz tmp-title.txt` lists every copy of the names found in both, so you can find and delete duplicates across folders. Relative places start at the current folder, a trailing `\` makes no difference, and names with spaces need quotes (`input:'my client'`). `input:{INPUT01}` uses the paths of a Global Var (define it in Settings, Global Var, set it with right-click, Assign to Global Var), so a selection can be the search scope; if the variable has no value yet it is skipped, the search still runs (in the current folder if no other place is left) and an amber note says so. The Subfolders button applies to every place. Results outside the current folder show their full path. A place that doesn't exist shows an error in the search box.
- **{SELEC} and {DEST}: file panel and terminal working together.** Right-click files or folders in the file panel and choose **Assign to {SELEC}** (all selected items) or **Assign to {DEST}** (the clicked item). Right-click on empty space assigns the current folder. Commands from the Commands menu (typically your own in *Customize*, such as `ren {SELEC} {DEST}`) have `{SELEC}` / `{DEST}` replaced by the paths when typed at the prompt; unset ones stay as typed.
  - Paths inside the current folder are shown relative (`.\sub\file.txt`), all others absolute. Names with spaces are quoted.
  - If the command is still waiting at the prompt (you haven't typed in the terminal), assigning a variable or opening another folder in the file panel rewrites the line, so you can go and pick files after choosing the command.
  - The terminal's top bar has a **Global Var** button. The button appears only while a variable has a value. Its dropdown lists the variables that are set, each with its full value (relative to the current folder) and an X to clear it. The right-click menu shows the value (`Assign to {SELEC}=.\a.txt`).
  - Values live in memory only and are gone when the app closes.
  - **Your own variables.** Settings (gear) now has a left bar with **Commands** and **Global Var**. Commands shows its groups as tabs on the right. Global Var adds, renames and deletes variables (`{SELEC}` and `{DEST}` are just the starting two). Each variable chooses what Assign stores: every selected item, or only the right-clicked item. Renaming keeps the value and updates `{OLD}` in your commands. The variable list is saved; the values are not.
  - Right-click shows one entry, **Assign to Global Var**, with a submenu listing every variable and its value.

### Changed
- **The search box is now a floating two-line box,** 50% wider (360 px instead of 240 px). Long queries wrap and can be scrolled when they need more than two lines. The header keeps its height; the box floats over the panels below. Enter adds no line break, and pasted line breaks become spaces. Error and note bubbles and the `?` options panel now open below the box.

### Fixed
- **The Assign to Global Var submenu opened at the top of the right-click popup** instead of level with its row. It now opens beside its row (and slides up if it would run past the bottom of the window). The same fix applies to the *New* submenu.

## 0.5.3 (2026-10-01)

### Fixed
- **Bulk Rename, Numbering and `{n}`: a Step of 0 is now allowed.** Before, a Step of 0 was silently turned into 1, so `1.txt`..`9.txt` with Start 0, Step 0, Digits 1, *before the name* gave `01`, `12`, `23`... instead of `01`..`09`. Now Step 0 means every item gets the same number.
- **Typed numbers are never changed silently.** A wrong value (empty, text, negative, a decimal, out of range) now shows a message naming the rule and the allowed range, for example *Rule 2 (Numbering): Step must be a whole number from 0 to 999999, not "abc"*. Rules that are switched off are not checked.

### Added
- Regex help recipe **A single digit 1..9 to 01..09** (Find `^(\d)$`, Replace `0$1`): pads only names that are exactly one digit.

## 0.5.2 (2026-10-01)

### Added
- **Bulk Rename.** Select 2 or more items and press **F2** (or right-click, *Bulk Rename...*) to rename them all by rules:
  - **Include sub-folders** (off by default): also rename everything inside the selected folders, at any depth. Off means only the selected items. With one folder selected, right-click offers *Bulk Rename inside this folder...*. At most 20,000 items at a time.
  - **Find & Replace** in plain text or regular expression (same engine as the `filename:` search, with `$1` / `${1}` in the replacement), applied to the name, the extension or both.
  - **Change case** (lower, UPPER, Title, Sentence) and **Numbering** (start, step, zero padding, before / after / instead of the name, restart per folder). Numbers follow the file panel's order.
  - **Insert / Remove**: add text at the start, at the end of the name, or before a character number; or remove the first N, the last N, or N characters from a position.
  - **Extension**: set it (optionally only for files that now end in a list such as `jpeg, jpe`), lower or upper case it, or remove it. Folders are never changed.
  - **Name template**: build the name from your own text and tokens: `{name}`, `{ext}`, `{parent}` (the folder name), `{n}` / `{n:3}` (a counter), `{date}` / `{date:yyyyMMdd}` (the file's modified date) and `{today}`. Click-to-add token buttons, and clear messages for a wrong token or an unclosed brace.
  - **The rules are a list you build**: add rules of any kind, as many as you like (even the same kind twice), change their order with the up and down arrows, switch one off, or remove it. They run from top to bottom, and each Numbering or `{n}` counter counts on its own. A rule that is switched off folds up to one line, so the preview keeps its room.
  - **"If a new name is already taken"**: by default the item is **skipped** (not renamed) and the rest go ahead. The first item keeps a name several items want, and a file that stays is never taken over. Skipped items are listed dimmed and counted. The other two choices are *show a problem* (Rename is blocked until you fix it) and *add (2), (3)...* (colliding names get a free " (2)", " (3)").
  - **Presets**: twelve built-in ones (such as "Spaces to underscores", "File's own date in front" and "Extension .jpeg to .jpg") plus your own, saved by name (up to 30) and remembered after a restart. A preset keeps the whole list of rules in order, and presets saved by the earlier version still load.
  - **Show only problems** in the preview, and character-by-character highlighting of what changed in each name.
  - **Preview on demand**: nothing is computed while you type; click **Preview** (or press Enter). The preview lists only the names that will change, with the changed part highlighted. Rename is disabled until the preview matches the current rules, and while a ticked row has a problem.
  - Each row can be left out with its checkbox, and the remaining rows are re-checked straight away.
  - **Safety:** empty names, illegal characters, reserved Windows names, too-long names, duplicate names and names that already exist are flagged. Everything is checked again just before renaming. Swaps and chains (`a` to `b`, `b` to `a`) work, folders can be renamed together with their contents, and if one rename fails the whole batch is rolled back.
  - **Undo:** an Undo button after renaming, or **Ctrl+Z** (asks first). The last 5 batches are remembered, even after a restart.
  - Works on search results from different folders, and on 20,000 items at a time (1,500 items preview in about a quarter of a second).

- **F2 on a single item** opens the Rename box (with 2 or more items it opens Bulk Rename). The box selects just the name, not the extension, Enter renames and Esc closes it.

- **`FEATURES_SPEC.md`**: a user manual and feature specification covering every feature (navigation, file operations, search syntax, preview, terminal, Settings, shortcuts, limits and known issues). It includes a regular-expression guide for `filename:` (supported syntax, sample names with searches and results, and what isn't supported), and the samples are checked by an automated test.

### Fixed
- **Single Rename of a search result showed `./sub/file.txt` as the name** in the Rename box, which would have renamed to the wrong path. It now shows the real file name.
- **Single Rename now accepts a change of letter case only** (`photo.JPG` to `photo.jpg`). It used to refuse with "already exists".
- **Image preview keys no longer fire while you type.** With an image in the preview drawer, arrow keys, Home/End, PageUp/PageDown, `+`, `-`, `1`, `0`, `F` and `L` also acted on the image while you typed in the search box, the path bar, dialogs or the Go-to box (for example Left Arrow changed the image, `+` zoomed it). They are now ignored in any text field. The terminal was never affected.

## 0.5.1 (2026-10-01)

### Added
- **Search query language.** The search box accepts filters, and all terms must match:
  - `filename:<regex>` matches the name against a regular expression.
  - `filesize:0-1M`, `250K-1.2M`, `800M-1G`, `1G+` (also `-10K`, `>1M`, `<100K`, `0`).
  - `filetype:exe`, with comma lists (`jpg,png`) and groups (`image`, `video`, `audio`, `doc`, `archive`, `code`, `folder`, `file`).
  - `filedate:2026`, `2026-07`, `2026-07-06`, `-07-06`, `-07-`, `--06`, ranges (`2026-01..2026-03`) and relative dates (`7d`, `today`, `yesterday`).
  - `!` excludes a term (`!filetype:tmp`). Quotes keep spaces together (`"my file"`). Short forms: `name:`, `size:`, `type:`, `ext:`, `date:`.
- **Folder size search.** `type:folder size:>20G` lists folders by the total size of everything inside them. Folder results show that total in the Size column.
- **Search help.** A `?` button next to the search box opens a cheat sheet, and clicking an example adds it to the search.
- **Search errors in plain words.** A query that can't be read gets a red border and a message instead of silently finding nothing. A "Searching..." note shows during long scans.

### Changed
- **Dates are shown in local time.** The Date Modified column used to show UTC. Zip timestamps and `filedate:` use local time too.
- **Search runs in the background.** It waits for a pause in typing, a newer search cancels an older one, and the window stays responsive.

### Fixed
- **Right-click menus stay fully on screen.** Near the bottom of the screen the menu opens upward, and near the right edge it moves left (the "New" submenu opens left). This applies to the file panel, folder tree and Quick Access menus.

### Notes
- The 0.5.1 installers were built twice under the same file names. The first build (2026-09-30) had the same features as 0.5.0 below. The second added everything in this section.

## 0.5.0 (2026-09-30)

### Already in 0.5.0 before this log started (from `boonsh-PRD.md`)
- Double-click opens files in their default Windows application.
- Eye icon toggles the preview drawer (Ctrl+P).
- Two-step command helper menu (Basic, Network, System commands).
- Clean `Surface >` / `admin >` prompt.
- Natural number sorting of files, a one-line status bar, and terminal clipping and auto-scroll fixes.

### Added
- **Two-way folder sync.** Typing `cd` in the terminal now updates the file panel (the other direction already existed).
- **Settings (gear icon, next to the Eye icon).** Add, edit, delete and move the terminal's helper commands. There is a new **Customize** group, and a Reset to defaults button.
- **Select multiple files.** Ctrl+Click, Shift+Click and Ctrl+A; the status bar shows the count and total size, and dragging several files into the terminal drops all their paths.
- **Cut, Copy, Paste and Delete** with Ctrl+X, Ctrl+C, Ctrl+V and Del, the right-click menu and header icons. Cut items are dimmed, pasted files never overwrite (names like `file - Copy.txt`), and Delete moves everything selected to the Recycle Bin.
- **Compress to ZIP / Extract ZIP** in the right-click menu. Both never overwrite and run in the background.
- **Open a folder from the command line.** `boonsh.exe "C:\some\folder"` starts there. Switching between Administrator and normal mode now keeps the current folder.
- **Compact header.** Icons sit closer together, with a divider between the navigation and clipboard icons.

### Changed
- The terminal uses the app's fixed-width font (Cascadia Code) at 12px, the same text size as the file panel.

### Fixed
- The window title now shows the current path (missing window permissions were blocking it).
- Pressing Del while typing in the terminal or any text box no longer asks to recycle the selected file.
- Removed the unused legacy `xterm` package.
