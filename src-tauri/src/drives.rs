//! The PC's drives with their name and space, as Explorer's "This PC" shows them: the Folder Tree's drive rows
//! ("OS (C:) Used 211GB/463GB") and the This PC view (meter bars).

use serde::Serialize;

#[derive(Serialize, Clone, Debug, Default)]
pub struct DriveInfo {
    pub path: String,   // "C:\"
    pub letter: String, // "C"
    pub label: String,  // the volume name ("OS"), or "" when it has none
    pub kind: String,   // fixed / removable / network / cd / ram / other
    pub ready: bool,    // false: no disc in the drive, a network drive that is not connected ...
    pub total: u64,
    pub free: u64,
    pub used: u64,
    pub file_system: String,
}

/// Explorer's name for a drive without a volume name.
pub fn default_name(kind: &str) -> &'static str {
    match kind {
        "removable" => "USB Drive",
        "network" => "Network Drive",
        "cd" => "DVD Drive",
        _ => "Local Disk",
    }
}

#[cfg(windows)]
fn read_all() -> Vec<DriveInfo> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW};

    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = ((b'A' + i as u8) as char).to_string();
        let path = format!("{}:\\", letter);
        let root = HSTRING::from(path.as_str());
        // GetDriveTypeW: 2 removable, 3 fixed, 4 network, 5 CD/DVD, 6 RAM disk
        let kind = match unsafe { GetDriveTypeW(&root) } {
            2 => "removable",
            3 => "fixed",
            4 => "network",
            5 => "cd",
            6 => "ram",
            _ => "other",
        }
        .to_string();
        let mut name = [0u16; 261];
        let mut fs_name = [0u16; 261];
        let ready = unsafe {
            GetVolumeInformationW(&root, Some(&mut name), None, None, None, Some(&mut fs_name)).is_ok()
        };
        let text = |b: &[u16]| String::from_utf16_lossy(&b[..b.iter().position(|&c| c == 0).unwrap_or(b.len())]);
        let (mut total, mut free) = (0u64, 0u64);
        let has_space = ready
            && unsafe { GetDiskFreeSpaceExW(&root, None, Some(&mut total), Some(&mut free)) }.is_ok();
        out.push(DriveInfo {
            path,
            letter,
            label: if ready { text(&name) } else { String::new() },
            kind,
            ready: has_space,
            total,
            free,
            used: total.saturating_sub(free),
            file_system: if ready { text(&fs_name) } else { String::new() },
        });
    }
    out
}

#[cfg(not(windows))]
fn read_all() -> Vec<DriveInfo> {
    Vec::new()
}

/// Every drive letter in use, A to Z. Runs in the background: a disconnected network drive can take a while.
#[tauri::command]
pub async fn get_drives() -> Result<Vec<DriveInfo>, String> {
    tauri::async_runtime::spawn_blocking(read_all).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn the_system_drive_has_space() {
        let sys = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let drives = read_all();
        let d = drives.iter().find(|d| d.path.eq_ignore_ascii_case(&format!("{}\\", sys))).expect("system drive");
        assert!(d.ready && d.kind == "fixed");
        assert!(d.total > 0 && d.free <= d.total && d.used + d.free == d.total);
        assert!(!d.file_system.is_empty());
    }

    #[test]
    fn names_for_drives_without_a_label() {
        assert_eq!(default_name("fixed"), "Local Disk");
        assert_eq!(default_name("removable"), "USB Drive");
    }
}
