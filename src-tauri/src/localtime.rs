//! Local wall-clock time for Unix timestamps (file modified dates, zip entries, `filedate:` search).
//! Windows: converted with the system time zone rules (incl. DST for that date). Elsewhere: UTC.

#[derive(Clone, Copy, Debug)]
pub struct LocalTime {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

impl LocalTime {
    pub fn ymd(&self) -> (i32, u32, u32) {
        (self.year, self.month, self.day)
    }
}

pub fn from_unix(ts_secs: u64) -> LocalTime {
    #[cfg(target_os = "windows")]
    if let Some(t) = win_local(ts_secs) {
        return t;
    }
    utc(ts_secs)
}

/// Today's local date.
pub fn today() -> (i32, u32, u32) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    from_unix(now).ymd()
}

fn utc(ts_secs: u64) -> LocalTime {
    let (year, month, day) = civil_from_days((ts_secs / 86_400) as i64);
    let secs = ts_secs % 86_400;
    LocalTime {
        year,
        month,
        day,
        hour: (secs / 3600) as u32,
        minute: ((secs % 3600) / 60) as u32,
        second: (secs % 60) as u32,
    }
}

#[cfg(target_os = "windows")]
fn win_local(ts_secs: u64) -> Option<LocalTime> {
    #[repr(C)]
    struct FILETIME {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct SYSTEMTIME {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        millis: u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn FileTimeToSystemTime(ft: *const FILETIME, st: *mut SYSTEMTIME) -> i32;
        fn SystemTimeToTzSpecificLocalTime(tz: *const std::ffi::c_void, utc: *const SYSTEMTIME, local: *mut SYSTEMTIME) -> i32;
    }

    // FILETIME = 100ns ticks since 1601-01-01
    let ticks = ts_secs * 10_000_000 + 116_444_736_000_000_000;
    let ft = FILETIME { low: ticks as u32, high: (ticks >> 32) as u32 };
    let mut utc = SYSTEMTIME::default();
    let mut local = SYSTEMTIME::default();
    unsafe {
        if FileTimeToSystemTime(&ft, &mut utc) == 0
            || SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) == 0
        {
            return None;
        }
    }
    Some(LocalTime {
        year: local.year as i32,
        month: local.month as u32,
        day: local.day as u32,
        hour: local.hour as u32,
        minute: local.minute as u32,
        second: local.second as u32,
    })
}

// Days <-> civil date (proleptic Gregorian), from Howard Hinnant's date algorithms.
pub fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = (yoe + era * 400 + if m <= 2 { 1 } else { 0 }) as i32;
    (y, m, d)
}

pub fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}
