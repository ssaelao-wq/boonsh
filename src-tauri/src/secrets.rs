// The AI Assistant's API key, kept in Windows Credential Manager (a "generic" credential of the current user,
// protected by Windows with the user's login) instead of a plain file or the WebView's localStorage.
// Hand-rolled advapi32 FFI, like fs_ops.rs.

const TARGET: &str = "boonsh/ai-api-key";

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    pub type DWORD = u32;
    pub type BOOL = i32;

    pub const CRED_TYPE_GENERIC: DWORD = 1;
    pub const CRED_PERSIST_LOCAL_MACHINE: DWORD = 2; // this user on this computer (not roamed)
    pub const ERROR_NOT_FOUND: i32 = 1168;

    #[repr(C)]
    #[allow(non_snake_case)]
    pub struct FILETIME {
        pub dwLowDateTime: DWORD,
        pub dwHighDateTime: DWORD,
    }

    #[repr(C)]
    #[allow(non_snake_case)]
    pub struct CREDENTIALW {
        pub Flags: DWORD,
        pub Type: DWORD,
        pub TargetName: *mut u16,
        pub Comment: *mut u16,
        pub LastWritten: FILETIME,
        pub CredentialBlobSize: DWORD,
        pub CredentialBlob: *mut u8,
        pub Persist: DWORD,
        pub AttributeCount: DWORD,
        pub Attributes: *mut c_void,
        pub TargetAlias: *mut u16,
        pub UserName: *mut u16,
    }

    #[link(name = "advapi32")]
    extern "system" {
        pub fn CredWriteW(Credential: *const CREDENTIALW, Flags: DWORD) -> BOOL;
        pub fn CredReadW(TargetName: *const u16, Type: DWORD, Flags: DWORD, Credential: *mut *mut CREDENTIALW) -> BOOL;
        pub fn CredDeleteW(TargetName: *const u16, Type: DWORD, Flags: DWORD) -> BOOL;
        pub fn CredFree(Buffer: *const c_void);
    }

    pub fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

/// The saved key, or None when there is none.
#[tauri::command]
pub fn ai_key_get() -> Result<Option<String>, String> {
    read_secret(TARGET)
}

#[tauri::command]
pub fn ai_key_set(key: String) -> Result<(), String> {
    write_secret(TARGET, &key)
}

#[tauri::command]
pub fn ai_key_delete() -> Result<(), String> {
    delete_secret(TARGET)
}

fn read_secret(target_name: &str) -> Result<Option<String>, String> {
    #[cfg(windows)]
    unsafe {
        use win::*;
        let target = wide(target_name);
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) == 0 {
            let err = std::io::Error::last_os_error();
            return if err.raw_os_error() == Some(ERROR_NOT_FOUND) { Ok(None) } else { Err(err.to_string()) };
        }
        let c = &*cred;
        let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec();
        CredFree(cred as *const _);
        return Ok(Some(String::from_utf8_lossy(&bytes).to_string()));
    }
    #[cfg(not(windows))]
    Ok(None)
}

fn write_secret(target_name: &str, key: &str) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("The key is empty.".into());
    }
    #[cfg(windows)]
    unsafe {
        use win::*;
        let mut target = wide(target_name);
        let mut user = wide("boonsh");
        let mut blob = key.into_bytes();
        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            Comment: std::ptr::null_mut(),
            LastWritten: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            CredentialBlobSize: blob.len() as DWORD,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: user.as_mut_ptr(),
        };
        if CredWriteW(&cred, 0) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

fn delete_secret(target_name: &str) -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        use win::*;
        let target = wide(target_name);
        if CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) == 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() != Some(ERROR_NOT_FOUND) {
                return Err(err.to_string());
            }
        }
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn secret_round_trip() {
        let t = "boonsh/test-secret";
        delete_secret(t).unwrap();
        assert_eq!(read_secret(t).unwrap(), None);
        write_secret(t, "  sk-ant-test-123 ").unwrap();
        assert_eq!(read_secret(t).unwrap().as_deref(), Some("sk-ant-test-123"));
        write_secret(t, "second").unwrap();
        assert_eq!(read_secret(t).unwrap().as_deref(), Some("second"));
        delete_secret(t).unwrap();
        assert_eq!(read_secret(t).unwrap(), None);
        assert!(write_secret(t, "   ").is_err());
    }
}
