# Product Requirement Document (PRD): boonsh

**Project Name:** boonsh (Hybrid PowerShell & Advanced File Manager)  
**Version:** 0.5.0  
**Status:** Implemented & Verified  
**Target Environment:** Windows 10/11 (Standalone Executable - `.exe`)  
**Deployment Model:** Self-contained single-file executable (`boonsh.exe`)  

---

## 1. Executive Summary & Vision

**boonsh** is a standalone, high-productivity Windows desktop application compiled into a single executable (`boonsh.exe`). It seamlessly merges an **Advanced Graphical File Manager** with a **PowerShell-Driven Interactive Terminal**.

### Key v0.5.0 Features & Enhancements:
1. **OS Default Application Double-Click Launch**: Double-clicking files now opens them using native Windows default applications.
2. **Dedicated Eye-Icon Preview Drawer**: Preview drawer is toggled cleanly via the header Eye icon (`<Eye size={14} />`).
3. **2-Step Categorized Command Helper Menu**: Interactive 2-step Group ▶ Sub-menu for beginner CLI users (`Basic Commands`, `Network Commands`, `System Commands`).
4. **Clean Username Prompt (`Surface >` / `admin >`)**: Cleaned PTY prompt removing redundant working directory strings.
5. **Natural Numerical File Sorting**: Files with numbers are sorted in human numeric order (`1, 2, 3 ... 10, 11, 12`).
6. **Strict 1-Line Status Bar**: All directory stats, file size, selection info, and active shell engine rendered on a single horizontal flex line.
7. **Character Clipping Fix & Auto-Scroll**: PTY padding and `ResizeObserver` guarantee prompt lines and cursor blocks are never cut off.

---

## 2. Core Functional Modules & Layout Architecture

```
+-----------------------------------------------------------------------------------+
|  [Icon Bar]  Full Path: C:\somboon-data\Dev\boonsh      [Search Icon | View Icons]|
+--------------------------------------------------+--------------------------------+
|  LEFT PANEL (Top): File Explorer & Folder Tree   |  RIGHT PANEL: PowerShell CLI   |
|  - ⭐ Quick Access (Desktop, Downloads, Pins)     |  +---------------------------+ |
|  - Drive Selector & Sidebar Folder Tree          |  | [Collapsible File Panel]   | |
|  - Main File View (Details / List / Thumbnails)  |  | Folder: boonsh            | |
|  - Independent Horizontal/Vertical Scrollbars    |  | Name | Date | Type | Size | |
|                                                  |  | (Click column header sort) | |
+===================== Splitter ===================+  +---------------------------+ |
|  LEFT PANEL (Bottom): File & Image Preview       |  - Interactive PowerShell TTY |
|  [ Collapsible Toggle: Ctrl+P - Default Hidden ]  |  - ANSI 24-bit TrueColor      |
|  - Image Viewer (Nav, Zoom, Lock-Zoom, 1:1)      |  - Independent Scrollbars     |
|  - Independent Horizontal/Vertical Scrollbars    |  - Bi-directional cd sync     |
+--------------------------------------------------+--------------------------------+
|<--------------- Resizable Left/Right Splitter ----------------------------------->|
+-----------------------------------------------------------------------------------+
| [Status Bar] Total: 42 items | Selected: 2 items (14.2 MB) | Shell: pwsh (Running)|
+-----------------------------------------------------------------------------------+
```

### 2.0 Panel Layout, Window Chrome & Scroll Architecture

1. **Default Startup Layout:**
   - **Left Panel:** Folder / File Tree & Main File Explorer View.
   - **Right Panel:** Interactive Command Line Terminal (PowerShell 7).
   - *Startup State:* Bottom Preview Drawer is hidden by default to maximize Left File Manager vs Right Terminal 50/50 view.
2. **Top Window Header & Full Path Display:**
   - **Window Title Bar Path:** Dynamically displays the full pathname of the active folder or selected file (e.g. `boonsh - C:\somboon-data\Dev\boonsh\main.rs`).
   - **No Traditional Menu Bar:** Sleek header containing essential action icons.
   - **Toggleable Icon Search:** Search input is hidden by default behind a minimalist Search Icon button. Clicking the Search Icon toggles the input field open/closed.
3. **Panel Scrollbar Autonomy (No Page/Screen Movement):**
   - Main application window layout is strictly constrained to `100vh` x `100vw` (`overflow: hidden`).
   - Moving content inside panels triggers independent vertical & horizontal scrollbars on the specific panel container only (File Tree, Main File Table, Terminal), preventing the overall application screen from moving.

---

## 3. Technology Stack & Component Selection

| Subsystem | Technology Choice | Rationale & Capability |
| :--- | :--- | :--- |
| **App Host & Runtime** | **Tauri v2 (Rust)** | Native Windows application wrapper. Extremely low memory (~40MB), high security, native Win32/COM API calls. |
| **Frontend Framework** | **React 18 + TypeScript + Vite** | High-speed UI rendering, state management, component ecosystem. |
| **UI Styling & Theme** | **Monochrome Black & White CSS** | Pure minimalist high-contrast theme, custom scrollbars, zero distraction UI. |
| **Terminal Frontend** | **`xterm.js`** (+ WebGL renderer & Fit addons) | High-performance canvas-based terminal emulator used by VS Code. |
| **Terminal Backend** | **Rust `portable-pty` / Windows `ConPTY`** | Spawns real native PowerShell instances with stdout/stdin/stderr streaming and resize signals. |
| **File System Backend** | **Rust (`std::fs`, `notify`, `walkdir`, `trash`)** | High-performance file operations, async directory listing, live OS file change notifications, native recycle bin deletion. |
