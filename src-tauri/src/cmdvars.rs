// Filling {NAME} placeholders into a command line: Global Vars (paths), CONSTs (text) and baskets ({BASKET:name},
// or a Global Var holding a .basket file). One engine for both ways a command reaches the shell:
// - boonsh types it (Commands menu, hot keys, the Global Var button): the `expand_command` tauri command;
// - the user types it and presses Enter in a PowerShell tab: the Enter key handler in pty.rs asks
//   `boonsh.exe --basket` (op "expand"), which reads the values from the session file the app keeps up to date
//   (`write_vars_file`; its path reaches every shell as BOONSH_VARS).
// Unknown or unset names stay as typed, so normal PowerShell script blocks are left alone.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::basket;

/// A command line holds about 32,000 characters; leave room for the rest of the command.
pub const MAX_EXPANDED: usize = 30_000;

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct VarValues {
    /// Global Var values, NAME (capitals) -> absolute paths
    #[serde(default)]
    pub vars: HashMap<String, Vec<String>>,
    /// CONST values, NAME (capitals) -> text
    #[serde(default)]
    pub consts: HashMap<String, String>,
}

// ---------- the session file ----------

static VARS_FILE: OnceLock<PathBuf> = OnceLock::new();

/// The app's session file (in %TEMP%, one per running app). A helper process (Administrator tab) is given the
/// app's path with `set_vars_file`, so its shell reads the same values.
pub fn vars_file() -> &'static PathBuf {
    VARS_FILE.get_or_init(|| std::env::temp_dir().join(format!("boonsh-vars-{}.json", std::process::id())))
}

pub fn set_vars_file(path: &str) {
    let _ = VARS_FILE.set(PathBuf::from(path.trim_matches('"')));
}

/// Session files of apps that are no longer running (closed by a crash or a forced kill, so their exit clean-up
/// never ran). Called once at startup.
pub fn remove_stale_vars_files() {
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(pid) = name.strip_prefix("boonsh-vars-").and_then(|r| r.strip_suffix(".json")).and_then(|p| p.parse::<u32>().ok()) else {
            continue;
        };
        if pid != std::process::id() && !process_running(pid) {
            let _ = fs::remove_file(e.path());
        }
    }
}

#[cfg(target_os = "windows")]
fn process_running(pid: u32) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        // same signatures as in fs_ops.rs (HANDLE = *mut c_void)
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn GetExitCodeProcess(handle: *mut std::ffi::c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        let alive = GetExitCodeProcess(h, &mut code) != 0 && code == STILL_ACTIVE;
        CloseHandle(h);
        alive
    }
}

#[cfg(not(target_os = "windows"))]
fn process_running(_pid: u32) -> bool {
    true
}

pub fn remove_vars_file() {
    if let Some(p) = VARS_FILE.get() {
        let _ = fs::remove_file(p);
    }
}

#[tauri::command]
pub fn write_vars_file(vars: HashMap<String, Vec<String>>, consts: HashMap<String, String>) -> Result<(), String> {
    let path = vars_file();
    let text = serde_json::to_string(&VarValues { vars, consts }).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The values for a typed command line (missing or broken file = no values).
pub fn read_vars_file(path: &Path) -> VarValues {
    fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

#[tauri::command]
pub fn expand_command(
    text: String,
    cwd: String,
    vars: HashMap<String, Vec<String>>,
    consts: HashMap<String, String>,
) -> Result<String, String> {
    expand_line(&text, &cwd, &VarValues { vars, consts })
}

// ---------- the rules ----------

fn safe(p: &str) -> bool {
    !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || "_-.\\/:~@+=,%#".contains(c))
}

/// Double quotes for PowerShell; $ and ` are escaped so a name like "a$b" stays literal.
fn escape(p: &str) -> String {
    p.replace('`', "``").replace('$', "`$")
}

pub fn quote_path(p: &str) -> String {
    if safe(p) {
        p.to_string()
    } else {
        format!("\"{}\"", escape(p))
    }
}

fn trim_slashes(p: &str) -> &str {
    p.trim_end_matches(['\\', '/'])
}

fn fold(p: &str) -> String {
    p.to_lowercase().replace('/', "\\")
}

/// Inside (or equal to) the current folder -> ".\sub\file" (or "."); anywhere else -> the path as given.
pub fn display_path(path: &str, base: &str) -> String {
    if base.is_empty() {
        return path.to_string();
    }
    let b = fold(trim_slashes(base));
    let p = fold(trim_slashes(path));
    if p == b {
        return ".".to_string();
    }
    if p.starts_with(&format!("{}\\", b)) {
        let tp = trim_slashes(path);
        return format!(".\\{}", tp[trim_slashes(base).len() + 1..].replace('/', "\\"));
    }
    path.to_string()
}

fn is_name(s: &str) -> bool {
    let mut cs = s.chars();
    matches!(cs.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && cs.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Every `{NAME}` in `text`: (start, end, name), end exclusive.
fn placeholders(text: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(open) = text[i..].find('{').map(|k| k + i) {
        match text[open + 1..].find(['{', '}']).map(|k| k + open + 1) {
            Some(close) if text.as_bytes()[close] == b'}' => {
                let name = &text[open + 1..close];
                if is_name(name) {
                    out.push((open, close + 1, name.to_string()));
                }
                i = close + 1;
            }
            Some(next) => i = next,
            None => break,
        }
    }
    out
}

/// Whitespace-separated tokens, keeping quoted spans together, with their whitespace (joined = the input).
fn split_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut was_space: Option<bool> = None;
    for ch in text.chars() {
        if quote.is_none() && ch.is_whitespace() {
            if was_space == Some(false) {
                out.push(std::mem::take(&mut cur));
            }
            cur.push(ch);
            was_space = Some(true);
            continue;
        }
        if was_space == Some(true) {
            out.push(std::mem::take(&mut cur));
        }
        was_space = Some(false);
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => {}
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None => {}
        }
        cur.push(ch);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Paths and texts: a token that is exactly {SELEC} becomes one quoted path per item; a placeholder inside a
/// bigger token ("{DEST}/a.jpg") is substituted and the whole token quoted if it needs it (not when the user
/// wrote quotes). CONSTs go in as written. Unset or unknown names stay as typed.
fn expand_template(template: &str, v: &VarValues, base: &str) -> String {
    let const_of = |n: &str| v.consts.get(&n.to_uppercase()).cloned();
    let values = |n: &str| -> Vec<String> {
        v.vars.get(&n.to_uppercase()).map(|ps| ps.iter().map(|p| display_path(p, base)).collect()).unwrap_or_default()
    };
    split_tokens(template)
        .into_iter()
        .map(|tok| {
            if !tok.contains('{') {
                return tok;
            }
            let found = placeholders(&tok);
            if found.len() == 1 && found[0].0 == 0 && found[0].1 == tok.len() {
                let name = &found[0].2;
                if let Some(c) = const_of(name) {
                    return c;
                }
                let vals = values(name);
                return if vals.is_empty() { tok } else { vals.iter().map(|p| quote_path(p)).collect::<Vec<_>>().join(" ") };
            }
            let mut out = String::new();
            let mut last = 0;
            let mut changed = false;
            for (s, e, name) in found {
                out.push_str(&tok[last..s]);
                if let Some(c) = const_of(&name) {
                    out.push_str(&c);
                } else {
                    let vals = values(&name);
                    if vals.is_empty() {
                        out.push_str(&tok[s..e]);
                    } else {
                        changed = true;
                        out.push_str(&vals.join(" "));
                    }
                }
                last = e;
            }
            out.push_str(&tok[last..]);
            if changed && !out.contains(['"', '\'']) && !safe(&out) {
                quote_path(&out)
            } else {
                out
            }
        })
        .collect()
}

/// Always quoted: a comma in a name must not split the PowerShell list.
fn join_list(paths: &[String], base: &str) -> String {
    paths.iter().map(|p| format!("\"{}\"", escape(&display_path(p, base)))).collect::<Vec<_>>().join(", ")
}

fn is_basket_value(p: &str) -> bool {
    p.to_lowercase().ends_with(".basket")
}

fn basket_path(reference: &str, base: &str) -> Result<PathBuf, String> {
    let path = basket::resolve(base, reference);
    if !path.is_file() {
        return Err(format!("No basket {}. Check the basket name in the command.", path.display()));
    }
    Ok(path)
}

/// The basket's linked items: all of them, or those named by `sub` ("testfile.txt", "Reports\q1.txt", "*.pdf").
fn basket_items(reference: &str, sub: Option<&str>, base: &str) -> Result<Vec<String>, String> {
    let path = basket_path(reference, base)?;
    match sub {
        Some(s) => basket::select(&path, s),
        None => basket::expand(&path),
    }
}

/// What follows a basket placeholder that ends at `after` (just past its `}`): `\name` picks items inside the
/// basket. When the placeholder is inside quotes (`"{BASKET:x}\my file.txt"`), the name runs to the closing
/// quote and the quotes are taken away (the list brings its own); otherwise it runs to a space or , ; |.
/// Returns (the name, where the reference ends, whether a closing quote was taken).
fn sub_path(line: &str, after: usize, quoted: bool) -> (Option<String>, usize, bool) {
    let rest = &line[after..];
    if rest.starts_with(['\\', '/']) {
        let body = &rest[1..];
        let (len, quote) = if quoted {
            match body.find('"') {
                Some(q) => (q, true),
                None => (body.len(), false),
            }
        } else {
            (body.find(|c: char| c.is_whitespace() || ",;|\"'".contains(c)).unwrap_or(body.len()), false)
        };
        let sub = &body[..len];
        if sub.trim().is_empty() {
            return (None, after, false);
        }
        let end = after + 1 + len + usize::from(quote);
        return (Some(sub.to_string()), end, quote);
    }
    if quoted && rest.starts_with('"') {
        return (None, after + 1, true);
    }
    (None, after, false)
}

/// The whole command line: baskets first ({BASKET:name} in `base` or a full path, and any {VAR} whose value
/// holds a basket, become the linked items as a PowerShell list "a", "b"; a `\name` after it picks items inside
/// the basket), then the other placeholders. Errors for a basket or a name that is not found, a basket with
/// nothing linked, and a result too long for one command line.
pub fn expand_line(line: &str, base: &str, v: &VarValues) -> Result<String, String> {
    let mut text = String::new();
    // {BASKET:name}
    let lower = line.to_lowercase();
    let mut i = 0;
    let mut used = false;
    while let Some(k) = lower[i..].find("{basket:").map(|k| k + i) {
        let rest = &line[k + 8..];
        match rest.find(['{', '}']) {
            Some(e) if rest.as_bytes()[e] == b'}' && !rest[..e].trim().is_empty() => {
                let name = rest[..e].trim();
                let quoted = k > i && line.as_bytes()[k - 1] == b'"';
                let (sub, end, took_quote) = sub_path(line, k + 8 + e + 1, quoted);
                let items = basket_items(name, sub.as_deref(), base)?;
                if items.is_empty() {
                    return Err(format!("The basket \"{}\" has no linked items to use.", name));
                }
                text.push_str(&line[i..if took_quote { k - 1 } else { k }]);
                text.push_str(&join_list(&items, base));
                used = true;
                i = end;
            }
            _ => {
                text.push_str(&line[i..k + 8]);
                i = k + 8;
            }
        }
    }
    text.push_str(&line[i..]);
    // {VAR} holding a basket
    let mut out = String::new();
    let mut last = 0;
    for (s, e, name) in placeholders(&text) {
        if s < last {
            continue; // inside a part already used as a basket item name
        }
        let Some(values) = v.vars.get(&name.to_uppercase()) else { continue };
        if !values.iter().any(|p| is_basket_value(p)) {
            continue;
        }
        let quoted = s > last && text.as_bytes()[s - 1] == b'"';
        let (sub, end, took_quote) = sub_path(&text, e, quoted);
        let mut paths = Vec::new();
        for p in values {
            if is_basket_value(p) {
                paths.extend(basket_items(p, sub.as_deref(), base)?);
            } else {
                // a plain path in the same variable: the name is added to it, as for {DEST}\a.jpg
                paths.push(match &sub {
                    Some(sp) => format!("{}\\{}", p.trim_end_matches('\\'), sp),
                    None => p.clone(),
                });
            }
        }
        if paths.is_empty() {
            return Err(format!("{{{}}} holds a basket with no linked items to use.", name));
        }
        out.push_str(&text[last..if took_quote { s - 1 } else { s }]);
        out.push_str(&join_list(&paths, base));
        last = end;
        used = true;
    }
    out.push_str(&text[last..]);
    let result = expand_template(&out, v, base);
    if used && result.len() > MAX_EXPANDED {
        return Err(format!(
            "The basket has too many links for one command line ({} characters; the limit is about 32,000).\n\nUse the pipe command instead, for example:\nbasket \"name\" | Copy-Item -Destination D:\\Send",
            result.len()
        ));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vals(pairs: &[(&str, &[&str])], consts: &[(&str, &str)]) -> VarValues {
        VarValues {
            vars: pairs.iter().map(|(k, v)| (k.to_string(), v.iter().map(|s| s.to_string()).collect())).collect(),
            consts: consts.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    #[test]
    fn template_rules_match_the_old_frontend_ones() {
        let base = "C:\\work";
        let v = vals(
            &[("SELEC", &["C:\\work\\a.txt", "C:\\work\\my file.txt"]), ("DEST", &["D:\\out"]), ("SRC-1", &["C:\\work"])],
            &[("IP", "10.0.0.1")],
        );
        assert_eq!(expand_template("copy {SELEC} {DEST}", &v, base), "copy .\\a.txt \".\\my file.txt\" D:\\out");
        assert_eq!(expand_template("x {DEST}/a.jpg", &v, base), "x D:\\out/a.jpg");
        assert_eq!(expand_template("ping {IP}", &v, base), "ping 10.0.0.1");
        assert_eq!(expand_template("ssh user@{IP}:22", &v, base), "ssh user@10.0.0.1:22");
        assert_eq!(expand_template("cd {SRC-1}", &v, base), "cd .", "names may contain -");
        assert_eq!(expand_template("x {NOPE} {unset}", &v, base), "x {NOPE} {unset}", "unknown names stay");
        assert_eq!(expand_template("ls | % { $_.Name }", &v, base), "ls | % { $_.Name }", "script blocks are left alone");
        assert_eq!(expand_template("x \"{DEST}\\a b\"", &v, base), "x \"D:\\out\\a b\"", "own quotes kept");
        assert_eq!(expand_template("x {dest}", &v, base), "x D:\\out", "names ignore case");
        assert_eq!(quote_path("C:\\a$b"), "\"C:\\a`$b\"");
    }

    #[test]
    fn baskets_in_a_line() {
        let d = std::env::temp_dir().join(format!("boonsh-cmdvars-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("Work")).unwrap();
        fs::write(d.join("Work\\a.txt"), "a").unwrap();
        fs::write(d.join("Work\\b, c.txt"), "b").unwrap();
        let b = d.join("TestBasket.basket");
        let s = |p: &Path| p.to_string_lossy().to_string();
        let cli = |op: &str, paths: Vec<String>| {
            let r = serde_json::json!({ "op": op, "basket": "TestBasket", "cwd": s(&d), "paths": paths });
            let req = d.join("req.json");
            let ans = d.join("ans.json");
            fs::write(&req, r.to_string()).unwrap();
            basket::run_cli(&[s(&req), s(&ans)]);
        };
        cli("new", vec![]);
        cli("add", vec![s(&d.join("Work\\a.txt")), s(&d.join("Work\\b, c.txt"))]);
        let base = s(&d);
        let v = vals(&[("BASKET-01", &[&s(&b)]), ("DEST", &["D:\\out"])], &[]);

        let by_name = expand_line("copy {BASKET:TestBasket} d:\\", &base, &v).unwrap();
        assert_eq!(by_name, "copy \".\\Work\\a.txt\", \".\\Work\\b, c.txt\" d:\\");
        assert_eq!(expand_line("copy {basket:testbasket} d:\\", &base, &v).unwrap(), by_name, "case does not matter");
        assert_eq!(expand_line("copy {BASKET-01} {DEST}", &base, &v).unwrap(), "copy \".\\Work\\a.txt\", \".\\Work\\b, c.txt\" D:\\out");
        let full = expand_line(&format!("x {{BASKET:{}}}", s(&b)), "C:\\elsewhere", &v).unwrap();
        assert!(full.contains(&s(&d.join("Work\\a.txt"))), "{}", full);
        let err = expand_line("copy {BASKET:Nope} d:\\", &base, &v).unwrap_err();
        assert!(err.contains("No basket") && err.contains("Nope.basket"), "{}", err);
        assert_eq!(expand_line("echo {plain}", &base, &v).unwrap(), "echo {plain}");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn items_picked_by_name() {
        let d = std::env::temp_dir().join(format!("boonsh-cmdvars-pick-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        for sub in ["A", "B", "Reports\\2025"] {
            fs::create_dir_all(d.join(sub)).unwrap();
        }
        fs::write(d.join("A\\testfile.txt"), "a").unwrap();
        fs::write(d.join("A\\my file.txt"), "m").unwrap();
        fs::write(d.join("A\\report.pdf"), "1").unwrap();
        fs::write(d.join("B\\report.pdf"), "2").unwrap();
        fs::write(d.join("Reports\\2025\\q1.txt"), "q").unwrap();
        fs::write(d.join("Reports\\summary.txt"), "s").unwrap();
        let s = |p: &Path| p.to_string_lossy().to_string();
        let run = |op: &str, paths: Vec<String>| {
            let r = serde_json::json!({ "op": op, "basket": "TestBasket", "cwd": s(&d), "paths": paths });
            let (req, ans) = (d.join("req.json"), d.join("ans.json"));
            fs::write(&req, r.to_string()).unwrap();
            basket::run_cli(&[s(&req), s(&ans)]);
        };
        run("new", vec![]);
        run(
            "add",
            ["A\\testfile.txt", "A\\my file.txt", "A\\report.pdf", "B\\report.pdf", "Reports"].iter().map(|p| s(&d.join(p))).collect(),
        );
        fs::write(d.join("Reports\\new.txt"), "n").unwrap(); // appeared later: not linked
        let base = s(&d);
        let v = vals(&[("BASKET-01", &[&s(&d.join("TestBasket.basket"))])], &[]);
        let x = |line: &str| expand_line(line, &base, &v);

        assert_eq!(x("copy {BASKET:TestBasket}\\testfile.txt d:\\").unwrap(), "copy \".\\A\\testfile.txt\" d:\\");
        assert_eq!(x("copy {basket:testbasket}\\TESTFILE.TXT d:\\").unwrap(), "copy \".\\A\\testfile.txt\" d:\\", "names ignore case");
        assert_eq!(x("copy {BASKET:TestBasket}\\Reports\\2025\\q1.txt d:\\").unwrap(), "copy \".\\Reports\\2025\\q1.txt\" d:\\");
        assert_eq!(
            x("copy {BASKET:TestBasket}\\*.pdf d:\\").unwrap(),
            "copy \".\\A\\report.pdf\", \".\\B\\report.pdf\" d:\\",
            "a wildcard gives every match"
        );
        assert_eq!(
            x("copy {BASKET:TestBasket}\\report.pdf d:\\").unwrap(),
            "copy \".\\A\\report.pdf\", \".\\B\\report.pdf\" d:\\",
            "the same name twice: both"
        );
        assert_eq!(x("copy \"{BASKET:TestBasket}\\my file.txt\" d:\\").unwrap(), "copy \".\\A\\my file.txt\" d:\\", "quoted name with a space");
        assert_eq!(x("copy {BASKET-01}\\testfile.txt d:\\").unwrap(), "copy \".\\A\\testfile.txt\" d:\\", "through a Global Var");
        // 6 items (Reports gives its 2 linked parts: it has an unlinked new file), and no quotes around the list
        let all = x("copy \"{BASKET:TestBasket}\" d:\\").unwrap();
        assert!(all.matches(", ").count() == 5 && all.starts_with("copy \".\\") && all.ends_with("\" d:\\"), "{}", all);
        let e = x("copy {BASKET:TestBasket}\\Reports\\new.txt d:\\").unwrap_err();
        assert!(e.contains("Nothing named") && e.contains("Reports\\new.txt"), "an unlinked new item is not found: {}", e);
        assert!(x("copy {BASKET:TestBasket}\\nope.txt d:\\").is_err());
        // a partly linked folder by name gives its linked parts only
        let r = x("copy {BASKET:TestBasket}\\Reports d:\\").unwrap();
        assert!(r.contains("2025") && r.contains("summary.txt") && !r.contains("new.txt"), "{}", r);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn session_file_round_trip() {
        let p = std::env::temp_dir().join(format!("boonsh-vars-test-{}.json", std::process::id()));
        let v = vals(&[("A", &["C:\\x"])], &[("IP", "1.2.3.4")]);
        fs::write(&p, serde_json::to_string(&v).unwrap()).unwrap();
        let back = read_vars_file(&p);
        assert_eq!(back.vars["A"], vec!["C:\\x".to_string()]);
        assert_eq!(back.consts["IP"], "1.2.3.4");
        assert!(read_vars_file(Path::new("C:\\no\\such.json")).vars.is_empty());
        let _ = fs::remove_file(&p);
    }
}
