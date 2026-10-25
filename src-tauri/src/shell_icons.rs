//! File icons as Explorer shows them: the icon of the program that opens the file type (a .pdf opened by Brave
//! shows Brave's icon), or the file's own icon for programs, shortcuts and icon files. Windows draws the icon
//! (IShellItemImageFactory, icon only) and it goes to the page as a PNG data URL. `get_thumbnails` asks the
//! same factory for Explorer's thumbnail instead (a frame of a video, for the Thumbnails view).

use base64::Engine;
use serde::Deserialize;
use std::collections::HashMap;

/// One icon to get: `key` is how the page caches it (an extension, or the path for files with their own
/// icon), `path` is an existing file to ask Windows about.
#[derive(Deserialize)]
pub struct IconRequest {
    pub key: String,
    pub path: String,
}

/// Straight (not premultiplied) RGBA from the BGRA rows Windows gives. An icon without any alpha is opaque;
/// premultiplied pixels (no colour above its alpha anywhere) are divided back.
pub fn to_rgba(bgra: &[u8]) -> Vec<u8> {
    let px = bgra.chunks_exact(4);
    let has_alpha = px.clone().any(|p| p[3] != 0);
    let premultiplied = has_alpha && px.clone().all(|p| p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]);
    let mut out = Vec::with_capacity(bgra.len());
    for p in px {
        let a = if has_alpha { p[3] } else { 255 };
        let un = |c: u8| if premultiplied && a > 0 { ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8 } else { c };
        out.extend_from_slice(&[un(p[2]), un(p[1]), un(p[0]), a]);
    }
    out
}

pub fn png_data_url(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
    let mut bytes = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut bytes, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().ok()?;
        w.write_image_data(rgba).ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(windows)]
mod imp {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY,
        SIIGBF_THUMBNAILONLY,
    };

    pub fn init_com() {
        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    }

    /// The icon of `path` at `size` x `size` pixels as a PNG data URL, or None.
    pub fn icon(path: &str, size: u32) -> Option<String> {
        image(path, size, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK)
    }

    /// The picture Explorer shows in its thumbnail views (a frame of a video), fitted in `size` x `size`
    /// keeping its shape, or None when Windows cannot make one (then the page keeps the icon).
    pub fn thumbnail(path: &str, size: u32) -> Option<String> {
        image(path, size, SIIGBF_THUMBNAILONLY)
    }

    fn image(path: &str, size: u32, flags: SIIGBF) -> Option<String> {
        unsafe {
            let wide = HSTRING::from(path);
            let factory: IShellItemImageFactory = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).ok()?;
            let side = size as i32;
            let hbm = factory.GetImage(SIZE { cx: side, cy: side }, flags).ok()?;
            let obj = HGDIOBJ(hbm.0);
            let mut bm = BITMAP::default();
            let ok = GetObjectW(obj, std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _)) != 0;
            let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
            let mut pixels = vec![0u8; (w.max(0) * h * 4) as usize];
            let mut got = 0;
            if ok && w > 0 && h > 0 {
                let mut info = BITMAPINFO::default();
                info.bmiHeader = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // top-down rows
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                };
                let dc = CreateCompatibleDC(None);
                got = GetDIBits(dc, hbm, 0, h as u32, Some(pixels.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
                let _ = DeleteDC(dc);
            }
            let _ = DeleteObject(obj);
            if got != h || got == 0 {
                return None;
            }
            super::png_data_url(w as u32, h as u32, &super::to_rgba(&pixels))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn init_com() {}
    pub fn icon(_path: &str, _size: u32) -> Option<String> {
        None
    }
    pub fn thumbnail(_path: &str, _size: u32) -> Option<String> {
        None
    }
}

/// `path -> PNG data URL` of each file's Explorer thumbnail ("" when there is none: the page shows the icon).
#[tauri::command]
pub async fn get_thumbnails(paths: Vec<String>, size: u32) -> Result<HashMap<String, String>, String> {
    let size = size.clamp(16, 512);
    tauri::async_runtime::spawn_blocking(move || {
        imp::init_com();
        paths
            .into_iter()
            .map(|p| {
                let url = imp::thumbnail(&p, size).unwrap_or_default();
                (p, url)
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// `key -> PNG data URL` ("" when Windows had no icon, so the page keeps its own drawing).
#[tauri::command]
pub async fn get_file_icons(requests: Vec<IconRequest>, size: u32) -> Result<HashMap<String, String>, String> {
    let size = size.clamp(16, 256);
    tauri::async_runtime::spawn_blocking(move || {
        imp::init_com();
        requests
            .into_iter()
            .map(|r| {
                let url = imp::icon(&r.path, size).unwrap_or_default();
                (r.key, url)
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgba_from_windows_pixels() {
        // no alpha anywhere: opaque, channels swapped
        assert_eq!(to_rgba(&[1, 2, 3, 0, 4, 5, 6, 0]), vec![3, 2, 1, 255, 6, 5, 4, 255]);
        // premultiplied half-transparent white is divided back to white
        assert_eq!(to_rgba(&[128, 128, 128, 128, 0, 0, 0, 0]), vec![255, 255, 255, 128, 0, 0, 0, 0]);
        // a colour above its alpha means straight alpha: left as it is
        assert_eq!(to_rgba(&[200, 10, 10, 100]), vec![10, 10, 200, 100]);
    }

    #[cfg(windows)]
    #[test]
    fn notepad_has_an_icon() {
        imp::init_com();
        let win = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
        let url = imp::icon(&format!("{}\\notepad.exe", win), 32).expect("an icon");
        assert!(url.starts_with("data:image/png;base64,"));
    }
}
