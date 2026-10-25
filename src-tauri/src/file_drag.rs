//! Dragging files out of boonsh as real Windows files, the way Explorer does, so any program takes them: drop
//! a movie on VLC to play it, files on Explorer, a mail, another boonsh pane. The page's own HTML drag cannot do
//! this (it carries text, not files), and Tauri's window drop handler swallows HTML drops anyway. So the page
//! cancels its HTML drag and asks for `start_file_drag`, which builds the shell's data object for the paths
//! (CF_HDROP and the rest, `SHCreateDataObject`) and runs `SHDoDragDrop` (Explorer's drag picture and cursor) on
//! the main thread. A drop on boonsh itself comes back through Tauri's `drag-drop` window event with the paths,
//! like a drop from Explorer; `drag_keys` tells the page whether Shift / Ctrl were held at that moment.

use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
mod imp {
    use windows::core::{implement, BOOL, HRESULT, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, HWND, S_OK};
    use windows::Win32::System::Com::{CoTaskMemFree, IDataObject};
    use windows::Win32::System::Ole::{
        IDropSource, IDropSource_Impl, OleInitialize, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE,
        DROPEFFECT_NONE,
    };
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_ESCAPE, VK_LBUTTON, VK_SHIFT,
    };
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{BHID_DataObject, IShellItemArray, SHCreateShellItemArrayFromIDLists, SHDoDragDrop, SHParseDisplayName};
    use windows::Win32::Foundation::POINT;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowThreadProcessId, WindowFromPoint};

    fn down(vk: u16) -> bool {
        unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 }
    }

    /// Ends the drag when the left button is let go (drop) or Esc is pressed (cancel). It reads the buttons
    /// system-wide: the mouse was pressed in the WebView's own process, so this thread's key state (what the
    /// default drop source and the arguments here are built from) still says "up", and the drag would end on the
    /// spot with nothing dropped.
    #[implement(IDropSource)]
    struct Source;

    impl IDropSource_Impl for Source_Impl {
        fn QueryContinueDrag(&self, _escape: BOOL, _keys: MODIFIERKEYS_FLAGS) -> HRESULT {
            if down(VK_ESCAPE.0) {
                DRAGDROP_S_CANCEL
            } else if !down(VK_LBUTTON.0) {
                DRAGDROP_S_DROP
            } else {
                S_OK
            }
        }
        fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    /// Explorer's own data object for the items (CF_HDROP file list, shell ID lists, file names...), built from
    /// a shell item array so items of different folders work too. (`SHCreateDataObject` with no root folder
    /// offers no CF_HDROP, so VLC, Explorer and Tauri's drop handler saw nothing they could take.)
    unsafe fn data_of(list: &[*const ITEMIDLIST]) -> windows::core::Result<IDataObject> {
        let items: IShellItemArray = SHCreateShellItemArrayFromIDLists(list)?;
        items.BindToHandler(None, &BHID_DataObject)
    }

    /// The absolute item ID list of an existing path (freed by the caller with CoTaskMemFree).
    fn pidl_of(path: &str) -> Option<*mut ITEMIDLIST> {
        let wide = HSTRING::from(path);
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        unsafe { SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None).ok()? };
        (!pidl.is_null()).then_some(pidl)
    }

    /// Runs the drag (blocks until it ends, so it must be on the window's thread). Returns the drop effect
    /// the target chose: "copy", "move", "link" or "none" (cancelled / nothing took it).
    pub fn drag(hwnd: isize, paths: &[String]) -> &'static str {
        unsafe {
            let _ = OleInitialize(None); // already done by the window's drop handler; harmless again
            // The button was pressed on the WebView, whose window belongs to a thread of the browser process: it
            // owns the mouse (capture, button state) until the button is let go, so this thread's drag loop would
            // never see the mouse move and no window would get the files. Sharing that thread's input state for
            // the length of the drag hands the mouse to the drag, as when Explorer starts one from its own window.
            let me = GetCurrentThreadId();
            let mut at = POINT::default();
            let _ = GetCursorPos(&mut at);
            let owner = GetWindowThreadProcessId(WindowFromPoint(at), None);
            let attached = owner != 0 && owner != me && AttachThreadInput(me, owner, true).as_bool();
            let pidls: Vec<*mut ITEMIDLIST> = paths.iter().filter_map(|p| pidl_of(p)).collect();
            let effect = if pidls.is_empty() {
                DROPEFFECT_NONE
            } else {
                // absolute ID lists with no root folder: the items may come from different folders (search, baskets)
                let list: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| *p as *const _).collect();
                let data = data_of(&list);
                let source: IDropSource = Source.into();
                let res = data.and_then(|d| {
                    SHDoDragDrop(Some(HWND(hwnd as *mut _)), &d, &source, DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK)
                });
                res.unwrap_or(DROPEFFECT_NONE)
            };
            for p in pidls {
                CoTaskMemFree(Some(p as *const _));
            }
            if attached {
                let _ = AttachThreadInput(me, owner, false);
            }
            name(effect)
        }
    }

    fn name(e: DROPEFFECT) -> &'static str {
        if e.0 & DROPEFFECT_MOVE.0 != 0 {
            "move"
        } else if e.0 & DROPEFFECT_COPY.0 != 0 {
            "copy"
        } else if e.0 & DROPEFFECT_LINK.0 != 0 {
            "link"
        } else {
            "none"
        }
    }

    pub fn keys() -> (bool, bool) {
        (down(VK_SHIFT.0), down(VK_CONTROL.0))
    }

    /// The drag's data object for `paths` (what `drag` hands to the drop target), for the tests.
    #[cfg(test)]
    pub fn data_object(paths: &[String]) -> Option<IDataObject> {
        let pidls: Vec<*mut ITEMIDLIST> = paths.iter().filter_map(|p| pidl_of(p)).collect();
        let list: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| *p as *const _).collect();
        let data = unsafe { data_of(&list) }.ok();
        for p in pidls {
            unsafe { CoTaskMemFree(Some(p as *const _)) };
        }
        data
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn drag(_hwnd: isize, _paths: &[String]) -> &'static str {
        "none"
    }
    pub fn keys() -> (bool, bool) {
        (false, false)
    }
}

#[derive(Clone, serde::Serialize)]
struct DragDone {
    effect: &'static str,
}

/// Starts a Windows file drag of `paths` from the main window. Returns at once; when the drag ends the page
/// gets `file-drag-done { effect }`. Queued on the event loop (not run inside this IPC call) because the drag
/// runs its own message loop until the mouse is released.
#[tauri::command]
pub fn start_file_drag(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let win = app.get_webview_window("main").ok_or("no main window")?;
    let hwnd = win.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let done = app.clone();
    app.run_on_main_thread(move || {
        let effect = imp::drag(hwnd, &paths);
        let _ = done.emit("file-drag-done", DragDone { effect });
    })
    .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct DragKeys {
    shift: bool,
    ctrl: bool,
}

#[cfg(all(test, windows))]
mod tests {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
    use windows::Win32::System::Ole::{ReleaseStgMedium, CF_HDROP};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    /// What a program like VLC or Explorer reads from the drag: the CF_HDROP file list, with every path, also
    /// when the files come from different folders (search results, baskets).
    #[test]
    fn drag_carries_the_files_as_a_windows_file_list() {
        let dir = std::env::temp_dir().join(format!("boonsh-drag-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let a = dir.join("movie one.mp4");
        let b = dir.join("sub").join("b.txt");
        std::fs::write(&a, b"x").unwrap();
        std::fs::write(&b, b"y").unwrap();
        let paths = vec![a.to_string_lossy().to_string(), b.to_string_lossy().to_string()];

        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let data = super::imp::data_object(&paths).expect("a data object");
            let fmt = FORMATETC {
                cfFormat: CF_HDROP.0,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            };
            let mut medium = data.GetData(&fmt).expect("CF_HDROP is offered");
            let drop = HDROP(medium.u.hGlobal.0);
            let count = DragQueryFileW(drop, u32::MAX, None);
            let mut got = Vec::new();
            for i in 0..count {
                let mut buf = vec![0u16; 1024];
                let n = DragQueryFileW(drop, i, Some(&mut buf)) as usize;
                got.push(String::from_utf16_lossy(&buf[..n]));
            }
            ReleaseStgMedium(&mut medium);
            let lower = |v: &[String]| v.iter().map(|s| s.to_lowercase()).collect::<Vec<_>>();
            assert_eq!(lower(&got), lower(&paths));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Whether Shift / Ctrl are held now: read when a drop arrives (Tauri's drop event does not carry the keys).
#[tauri::command]
pub fn drag_keys() -> DragKeys {
    let (shift, ctrl) = imp::keys();
    DragKeys { shift, ctrl }
}
