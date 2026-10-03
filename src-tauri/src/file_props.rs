//! File properties for the extra file-panel columns (Dimensions, Length, Album, Artist, Actor, Genre, Rating).
//! They come from the Windows property system, the same source Explorer's Details view uses, so whatever
//! Explorer can show for a file (with the codecs / property handlers installed) shows up here too.
//! Values that a file doesn't have are returned empty (or 0).
//!
//! Windows has no "Actor" property. For videos the Actor column shows the "Contributing artists" tag
//! (`System.Music.Artist`), which is where video taggers normally put the cast; for audio files the same tag is
//! the Artist column. So Artist is filled for audio files and Actor for video files.

use serde::Serialize;

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
pub struct FileDetails {
    pub path: String,
    pub dimensions: String, // "1920 x 1080"
    pub pixels: u64,        // width * height, for sorting
    pub length: String,     // "3:45" or "1:02:03"
    pub length_secs: u64,
    pub album: String,
    pub artist: String,
    pub actor: String,
    pub genre: String,
    pub rating: u32, // stars, 0 = not rated
}

/// "1:02:03" / "3:45" from seconds.
pub fn format_length(secs: u64) -> String {
    let (h, m, s) = (secs / 3600, (secs / 60) % 60, secs % 60);
    if h > 0 {
        format!("{}:{:02}:{:02}", h, m, s)
    } else {
        format!("{}:{:02}", m, s)
    }
}

/// Windows stores a rating as 0..=99; Explorer shows 1..=12 as one star, 13..=37 as two, 38..=62 as three,
/// 63..=87 as four and 88..=99 as five.
pub fn stars(rating: u32) -> u32 {
    match rating {
        0 => 0,
        1..=12 => 1,
        13..=37 => 2,
        38..=62 => 3,
        63..=87 => 4,
        _ => 5,
    }
}

#[derive(PartialEq, Clone, Copy, Debug)]
pub enum Kind {
    Image,
    Video,
    Audio,
    Other,
}

pub fn kind_of(path: &str) -> Kind {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "tif" | "tiff" | "heic" | "ico" => Kind::Image,
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "webm" | "m4v" | "flv" | "mpg" | "mpeg" | "3gp" => Kind::Video,
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" | "opus" | "aiff" => Kind::Audio,
        _ => Kind::Other,
    }
}

/// Property values can carry invisible direction marks (Windows wraps "3840 x 2400" in them); drop those.
pub fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() && !matches!(*c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}'))
        .collect::<String>()
        .trim()
        .to_string()
}

/// "1920 x 1080" -> 2_073_600
pub fn pixels_of(dimensions: &str) -> u64 {
    let nums: Vec<u64> = dimensions
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    if nums.len() >= 2 {
        nums[0] * nums[1]
    } else {
        0
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::StructuredStorage::{PropVariantToStringAlloc, PropVariantToUInt64};
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::PropertiesSystem::{
        IPropertyStore, PSGetPropertyKeyFromName, SHGetPropertyStoreFromParsingName, GPS_DEFAULT,
    };

    fn key(name: &str) -> Option<PROPERTYKEY> {
        let mut k = PROPERTYKEY::default();
        unsafe { PSGetPropertyKeyFromName(&HSTRING::from(name), &mut k).ok()? };
        Some(k)
    }

    /// The first of these canonical property names that has a value, as text (lists are joined with "; ").
    fn text(store: &IPropertyStore, names: &[&str]) -> String {
        for n in names {
            let Some(k) = key(n) else { continue };
            let Ok(v) = (unsafe { store.GetValue(&k) }) else { continue };
            let Ok(p) = (unsafe { PropVariantToStringAlloc(&v) }) else { continue };
            let s = unsafe { p.to_string().unwrap_or_default() };
            unsafe { CoTaskMemFree(Some(p.0 as *const _)) };
            let s = clean(&s);
            if !s.is_empty() {
                return s;
            }
        }
        String::new()
    }

    fn number(store: &IPropertyStore, name: &str) -> u64 {
        let Some(k) = key(name) else { return 0 };
        let Ok(v) = (unsafe { store.GetValue(&k) }) else { return 0 };
        unsafe { PropVariantToUInt64(&v).unwrap_or(0) }
    }

    pub fn read(path: &str) -> FileDetails {
        let mut d = FileDetails { path: path.to_string(), ..Default::default() };
        let wide = HSTRING::from(path);
        let store: IPropertyStore =
            match unsafe { SHGetPropertyStoreFromParsingName(PCWSTR(wide.as_ptr()), None, GPS_DEFAULT) } {
                Ok(s) => s,
                Err(_) => return d,
            };

        let kind = kind_of(path);
        d.dimensions = text(&store, &["System.Image.Dimensions"]);
        if d.dimensions.is_empty() && kind == Kind::Video {
            let (w, h) = (number(&store, "System.Video.FrameWidth"), number(&store, "System.Video.FrameHeight"));
            if w > 0 && h > 0 {
                d.dimensions = format!("{} x {}", w, h);
            }
        }
        d.pixels = pixels_of(&d.dimensions);

        // System.Media.Duration is in 100-nanosecond units
        let dur = number(&store, "System.Media.Duration") / 10_000_000;
        if dur > 0 {
            d.length_secs = dur;
            d.length = format_length(dur);
        }
        if kind == Kind::Audio || kind == Kind::Video {
            d.album = text(&store, &["System.Music.AlbumTitle"]);
            d.genre = text(&store, &["System.Music.Genre"]);
            let people = text(&store, &["System.Music.Artist", "System.Music.AlbumArtist"]);
            if kind == Kind::Audio {
                d.artist = people;
            } else {
                d.actor = people;
            }
        }
        d.rating = stars(number(&store, "System.Rating") as u32);
        d
    }

    pub fn init_com() {
        // Each worker thread needs COM once; an "already initialized" result is fine.
        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    }
}

#[cfg(windows)]
fn read_all(paths: Vec<String>) -> Vec<FileDetails> {
    imp::init_com();
    paths.iter().map(|p| imp::read(p)).collect()
}

#[cfg(not(windows))]
fn read_all(paths: Vec<String>) -> Vec<FileDetails> {
    paths.into_iter().map(|path| FileDetails { path, ..Default::default() }).collect()
}

/// Properties of the given files, in the same order. Runs off the main thread.
#[tauri::command]
pub async fn get_file_details(paths: Vec<String>) -> Result<Vec<FileDetails>, String> {
    tauri::async_runtime::spawn_blocking(move || read_all(paths))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(format_length(5), "0:05");
        assert_eq!(format_length(225), "3:45");
        assert_eq!(format_length(3723), "1:02:03");
        assert_eq!([0, 1, 12, 13, 37, 38, 62, 63, 87, 88, 99].map(stars), [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
        assert_eq!(pixels_of("1920 x 1080"), 2_073_600);
        assert_eq!(pixels_of("640x480"), 307_200);
        assert_eq!(pixels_of(""), 0);
        assert_eq!(clean("\u{202a}3840 x 2400\u{202c}"), "3840 x 2400");
        assert_eq!(kind_of(r"D:\x\a.MP3"), Kind::Audio);
        assert_eq!(kind_of(r"D:\x\a.mkv"), Kind::Video);
        assert_eq!(kind_of(r"D:\x\a.JPG"), Kind::Image);
        assert_eq!(kind_of(r"D:\x\a.ts"), Kind::Other);
    }

    #[cfg(windows)]
    #[test]
    fn reads_real_files() {
        // Files that ship with Windows; skipped when they are missing
        let wav = r"C:\Windows\Media\Alarm01.wav";
        let jpg = r"C:\Windows\Web\Wallpaper\Windows\img0.jpg";
        if std::path::Path::new(wav).exists() {
            let d = &read_all(vec![wav.to_string()])[0];
            assert!(d.length_secs > 0 && !d.length.is_empty(), "{:?}", d);
            assert_eq!((d.dimensions.as_str(), d.actor.as_str()), ("", ""));
        }
        if std::path::Path::new(jpg).exists() {
            let d = &read_all(vec![jpg.to_string()])[0];
            assert!(d.dimensions.contains(" x ") && d.pixels > 0, "{:?}", d);
            assert!(!d.dimensions.contains('\u{202a}'));
        }
        // a missing file gives empty details, not an error
        let d = &read_all(vec![r"C:\no\such\file.mp3".to_string()])[0];
        assert_eq!((d.length_secs, d.rating), (0, 0));
    }
}

/// The friendly name of the app Windows opens a file extension with (what Explorer's "Open with" shows as
/// the default), e.g. "VLC media player". `None` when nothing is associated with it. `ext` has no dot.
#[cfg(windows)]
pub fn default_app(ext: &str) -> Option<String> {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::UI::Shell::{AssocQueryStringW, ASSOCF_NONE, ASSOCSTR, ASSOCSTR_EXECUTABLE, ASSOCSTR_FRIENDLYAPPNAME};
    if ext.is_empty() {
        return None;
    }
    let dotted = HSTRING::from(format!(".{}", ext));
    let query = |what: ASSOCSTR| -> Option<String> {
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        unsafe {
            AssocQueryStringW(ASSOCF_NONE, what, &dotted, &HSTRING::from("open"), Some(PWSTR(buf.as_mut_ptr())), &mut len)
        }
        .ok()
        .ok()?;
        let n = (len as usize).saturating_sub(1).min(buf.len()); // len counts the terminating NUL
        let s = clean(&String::from_utf16_lossy(&buf[..n]));
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    };
    // With no association Windows answers "Pick an app" (in the display language) and points at OpenWith.exe,
    // which is the more reliable thing to test for.
    if let Some(exe) = query(ASSOCSTR_EXECUTABLE) {
        if exe.to_lowercase().ends_with("openwith.exe") {
            return None;
        }
    }
    query(ASSOCSTR_FRIENDLYAPPNAME)
}

#[cfg(not(windows))]
pub fn default_app(_ext: &str) -> Option<String> {
    None
}

/// Default app of each extension (lowercase, no dot); an empty string means none.
#[tauri::command]
pub async fn get_default_apps(exts: Vec<String>) -> Result<std::collections::HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        exts.into_iter()
            .map(|e| {
                let app = default_app(&e.to_lowercase()).unwrap_or_default();
                (e, app)
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(all(test, windows))]
mod assoc_tests {
    use super::*;

    #[test]
    fn default_apps() {
        // nothing is associated with these, whatever the machine
        assert_eq!(default_app("xyzzyq"), None);
        assert_eq!(default_app(""), None);
        // .txt has an app on every Windows (Notepad or whatever the user picked)
        assert!(default_app("txt").map_or(false, |n| !n.is_empty()));
    }
}
