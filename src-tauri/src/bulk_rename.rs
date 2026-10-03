//! Bulk rename: rules -> new names (preview), safety checks, ordered rename operations (apply), undo.
//!
//! The user builds a stack of rules; they run top to bottom on each name, in the order given, and a kind of
//! rule may appear more than once: Find & Replace, Case, Insert/Remove, Numbering, Extension, and a Template
//! that builds the name from tokens ({name} {ext} {parent} {n} {date} {today}). Find, Case and Insert/Remove
//! can target the name (without extension), the extension, or both.
//! Regex uses the same regex-lite engine as the `filename:` search, so a pattern means the same in both.
//! If a new name is already taken, the item is skipped (default), reported as a problem, or numbered " (2)", " (3)".
//! Optionally the contents of the selected folders are included (`expand_paths`).
//!
//! Safety model:
//! - `preview_blocking` only computes; it renames nothing and lists only the names that would change.
//! - `validate_pairs` is shared by preview and apply (apply re-checks, because files can change in between).
//! - `plan_ops` turns the renames into an ordered list of single renames: children before parent folders,
//!   chains (a->b, b->c) in a safe order, and cycles/swaps (a->b, b->a) through a temporary name.
//! - `execute_ops` runs them in order and rolls everything back if one fails.
//! - Undo replays the executed operations in reverse.

use regex_lite::{NoExpand, Regex, RegexBuilder};
use walkdir::WalkDir;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::localtime;

const MAX_ITEMS: usize = 20_000;
const MAX_NAME_CHARS: usize = 255;
const MAX_PATH_CHARS: usize = 259;

// ---------- rules (from the dialog) ----------

#[derive(Deserialize, Clone, Debug)]
pub struct FindRule {
    pub find: String,
    pub replace: String,
    pub regex: bool,
    pub match_case: bool,
    pub all_matches: bool,
    pub apply_to: String, // "name" | "ext" | "both"
}

#[derive(Deserialize, Clone, Debug)]
pub struct CaseRule {
    pub mode: String,     // "upper" | "lower" | "title" | "sentence"
    pub apply_to: String, // "name" | "ext" | "both"
}

#[derive(Deserialize, Clone, Debug)]
pub struct NumberingRule {
    pub start: u64,
    pub step: u64,
    pub pad: usize,
    pub position: String, // "prefix" | "suffix" | "replace"
    pub separator: String,
    pub restart_per_folder: bool,
}

/// Insert text, or remove characters, at the start, the end or a position (counted in characters).
#[derive(Deserialize, Clone, Debug)]
pub struct InsertRemoveRule {
    pub mode: String,         // "insert" | "remove"
    pub apply_to: String,     // "name" | "ext" | "both"
    pub text: String,         // insert: the text to add
    pub insert_where: String, // "start" | "end" | "position"
    pub remove_where: String, // "first" (the first N) | "last" (the last N) | "position" (N from `position`)
    pub count: usize,         // remove: how many characters
    pub position: usize,      // 1-based: insert before this character / start removing at it
}

/// Change the extension (never for folders).
#[derive(Deserialize, Clone, Debug)]
pub struct ExtensionRule {
    pub mode: String,     // "set" | "lower" | "upper" | "remove"
    pub text: String,     // set: the new extension (a leading dot is ignored)
    pub only_ext: String, // optional: only files with one of these extensions (comma separated)
}

/// Build the whole name from a template with tokens:
/// `{name}` `{ext}` `{parent}` `{n}` `{n:3}` `{date}` `{date:yyyyMMdd}` `{today}` (`{{` and `}}` are literal braces).
#[derive(Deserialize, Clone, Debug)]
pub struct TemplateRule {
    pub template: String,
    pub apply_to: String, // "name" (the result is the new name part, the extension is kept) | "both" (the result is the whole name)
    pub start: u64,       // {n}: first number
    pub step: u64,        // {n}: increase per item (0 = every item gets the same number)
    pub restart_per_folder: bool,
}

/// One step of the rename. The dialog sends only the steps that are switched on.
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuleSpec {
    Find(FindRule),
    Case(CaseRule),
    InsertRemove(InsertRemoveRule),
    Numbering(NumberingRule),
    Extension(ExtensionRule),
    Template(TemplateRule),
}

/// What to do with an item whose new name is already taken (by another item in the batch, which came first,
/// or by a file or folder that stays where it is).
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum CollisionPolicy {
    /// Do not rename that item; the rest are renamed. The default.
    #[default]
    Skip,
    /// Report it as a problem, which blocks Rename until the user changes something.
    Block,
    /// Give it the first free " (2)", " (3)" ... before the extension.
    Number,
}

/// The rules run top to bottom in the order given; the same kind of rule may appear more than once.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct RenameRules {
    #[serde(default)]
    pub rules: Vec<RuleSpec>,
    #[serde(default)]
    pub on_collision: CollisionPolicy,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Target {
    Name,
    Ext,
    Both,
}

#[derive(Clone, Copy, Debug)]
enum CaseMode {
    Upper,
    Lower,
    Title,
    Sentence,
}

#[derive(Debug)]
struct CompiledFind {
    re: Regex,
    replace: String,
    regex_mode: bool,
    all: bool,
    target: Target,
}

#[derive(Clone, Copy, Debug)]
enum Where {
    Start,
    End,
    Position(usize),
}

#[derive(Debug)]
enum IrOp {
    Insert { text: String, at: Where },
    Remove { count: usize, at: Where },
}

#[derive(Debug)]
struct CompiledInsertRemove {
    op: IrOp,
    target: Target,
}

#[derive(Debug)]
enum ExtMode {
    Set(String),
    Lower,
    Upper,
    Remove,
}

#[derive(Debug)]
struct CompiledExtension {
    mode: ExtMode,
    only: Vec<String>, // lower-case, no dots; empty = every file
}

#[derive(Debug)]
enum TplPart {
    Lit(String),
    Name,
    Ext,
    Parent,
    Counter { pad: usize },
    Date { today: bool, fmt: String },
}

#[derive(Debug)]
struct CompiledTemplate {
    parts: Vec<TplPart>,
    target: Target, // Name or Both
    start: u64,
    step: u64,
    restart_per_folder: bool,
    uses_counter: bool,
}

#[derive(Debug)]
enum CompiledRule {
    Find(CompiledFind),
    Case(CaseMode, Target),
    InsertRemove(CompiledInsertRemove),
    Numbering(NumberingRule),
    Extension(CompiledExtension),
    Template(CompiledTemplate),
}

#[derive(Debug)]
pub struct Compiled {
    rules: Vec<CompiledRule>,
    on_collision: CollisionPolicy,
}

const TEMPLATE_TOKENS: &str = "{name} {ext} {parent} {n} {n:3} {date} {date:yyyyMMdd} {today}";

fn parse_template(t: &str) -> Result<Vec<TplPart>, String> {
    let chars: Vec<char> = t.chars().collect();
    let mut parts: Vec<TplPart> = Vec::new();
    let mut lit = String::new();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '{' if chars.get(i + 1) == Some(&'{') => {
                lit.push('{');
                i += 2;
            }
            '}' if chars.get(i + 1) == Some(&'}') => {
                lit.push('}');
                i += 2;
            }
            '}' => return Err("Template: a } has no matching {. Write }} for a literal }".to_string()),
            '{' => {
                let close = chars[i..]
                    .iter()
                    .position(|&c| c == '}')
                    .ok_or_else(|| "Template: a { has no matching }. Write {{ for a literal {".to_string())?;
                let token: String = chars[i + 1..i + close].iter().collect();
                if !lit.is_empty() {
                    parts.push(TplPart::Lit(std::mem::take(&mut lit)));
                }
                let (key, arg) = match token.split_once(':') {
                    Some((k, a)) => (k.trim(), Some(a)),
                    None => (token.trim(), None),
                };
                let no_arg = |part: TplPart| -> Result<TplPart, String> {
                    if arg.is_some() {
                        Err(format!("Template: {{{}}} takes nothing after the name", key))
                    } else {
                        Ok(part)
                    }
                };
                parts.push(match key {
                    "name" => no_arg(TplPart::Name)?,
                    "ext" => no_arg(TplPart::Ext)?,
                    "parent" => no_arg(TplPart::Parent)?,
                    "n" => {
                        let pad = match arg {
                            None => 0,
                            Some(a) => a
                                .trim()
                                .parse::<usize>()
                                .ok()
                                .filter(|p| *p <= 12)
                                .ok_or_else(|| format!("Template: {{n:{}}} needs a number of digits from 0 to 12, like {{n:3}}", a))?,
                        };
                        TplPart::Counter { pad }
                    }
                    "date" | "today" => TplPart::Date {
                        today: key == "today",
                        fmt: arg.map(|a| a.to_string()).unwrap_or_else(|| "yyyy-MM-dd".to_string()),
                    },
                    other => {
                        return Err(format!("Template: unknown token {{{}}}. Tokens: {}", other, TEMPLATE_TOKENS));
                    }
                });
                i += close + 1;
            }
            c => {
                lit.push(c);
                i += 1;
            }
        }
    }
    if !lit.is_empty() {
        parts.push(TplPart::Lit(lit));
    }
    Ok(parts)
}

/// Date/time with yyyy, yy, MM, dd, HH, mm, ss; any other character is kept as it is.
fn format_date(ts_secs: u64, fmt: &str) -> String {
    let t = localtime::from_unix(ts_secs);
    let chars: Vec<char> = fmt.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let rest: String = chars[i..].iter().take(4).collect();
        if rest.starts_with("yyyy") {
            out.push_str(&format!("{:04}", t.year));
            i += 4;
        } else if rest.starts_with("yy") {
            out.push_str(&format!("{:02}", t.year.rem_euclid(100)));
            i += 2;
        } else if rest.starts_with("MM") {
            out.push_str(&format!("{:02}", t.month));
            i += 2;
        } else if rest.starts_with("dd") {
            out.push_str(&format!("{:02}", t.day));
            i += 2;
        } else if rest.starts_with("HH") {
            out.push_str(&format!("{:02}", t.hour));
            i += 2;
        } else if rest.starts_with("mm") {
            out.push_str(&format!("{:02}", t.minute));
            i += 2;
        } else if rest.starts_with("ss") {
            out.push_str(&format!("{:02}", t.second));
            i += 2;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn parse_where(s: &str, position: usize) -> Result<Where, String> {
    match s {
        "start" | "first" => Ok(Where::Start),
        "end" | "last" => Ok(Where::End),
        "position" => Ok(Where::Position(position.max(1))),
        other => Err(format!("Insert/Remove: unknown place \"{}\"", other)),
    }
}

fn parse_target(s: &str) -> Result<Target, String> {
    match s {
        "name" => Ok(Target::Name),
        "ext" => Ok(Target::Ext),
        "both" => Ok(Target::Both),
        other => Err(format!("Unknown 'apply to' value \"{}\"", other)),
    }
}

fn first_line(s: &str) -> &str {
    s.lines().find(|l| !l.trim().is_empty()).unwrap_or(s).trim()
}

const MAX_RULES: usize = 30;

/// Compile one step. `None` = the step would do nothing (an empty Find, an Insert without text, a Remove of
/// 0 characters, an empty template...), so it is skipped.
fn compile_rule(spec: &RuleSpec) -> Result<Option<CompiledRule>, String> {
    Ok(match spec {
        // An empty Find text does nothing: an empty regex would match between every character.
        RuleSpec::Find(f) if f.find.is_empty() => None,
        RuleSpec::Find(f) => {
            let pattern = if f.regex { f.find.clone() } else { regex_lite::escape(&f.find) };
            let re = RegexBuilder::new(&pattern)
                .case_insensitive(!f.match_case)
                .build()
                .map_err(|e| format!("Find: invalid pattern \"{}\": {}", f.find, first_line(&e.to_string())))?;
            Some(CompiledRule::Find(CompiledFind {
                re,
                replace: f.replace.clone(),
                regex_mode: f.regex,
                all: f.all_matches,
                target: parse_target(&f.apply_to)?,
            }))
        }

        RuleSpec::Case(c) => {
            let mode = match c.mode.as_str() {
                "upper" => CaseMode::Upper,
                "lower" => CaseMode::Lower,
                "title" => CaseMode::Title,
                "sentence" => CaseMode::Sentence,
                other => return Err(format!("Case: unknown mode \"{}\"", other)),
            };
            Some(CompiledRule::Case(mode, parse_target(&c.apply_to)?))
        }

        RuleSpec::InsertRemove(r) => {
            let target = parse_target(&r.apply_to)?;
            match r.mode.as_str() {
                "insert" if r.text.is_empty() => None,
                "insert" => Some(CompiledRule::InsertRemove(CompiledInsertRemove {
                    target,
                    op: IrOp::Insert { text: r.text.clone(), at: parse_where(&r.insert_where, r.position)? },
                })),
                "remove" if r.count == 0 => None,
                "remove" => Some(CompiledRule::InsertRemove(CompiledInsertRemove {
                    target,
                    op: IrOp::Remove { count: r.count, at: parse_where(&r.remove_where, r.position)? },
                })),
                other => return Err(format!("Insert/Remove: unknown mode \"{}\"", other)),
            }
        }

        RuleSpec::Numbering(n) => {
            // A step of 0 is allowed: every item gets the same number (e.g. a fixed "0" in front of each name)
            if n.pad > 12 {
                return Err("Numbering: padding can be at most 12 digits".to_string());
            }
            if !matches!(n.position.as_str(), "prefix" | "suffix" | "replace") {
                return Err(format!("Numbering: unknown position \"{}\"", n.position));
            }
            Some(CompiledRule::Numbering(n.clone()))
        }

        RuleSpec::Extension(e) => {
            let only: Vec<String> = e
                .only_ext
                .split(',')
                .map(|s| s.trim().trim_start_matches('.').to_lowercase())
                .filter(|s| !s.is_empty())
                .collect();
            match e.mode.as_str() {
                "set" => {
                    let text = e.text.trim().trim_start_matches('.').to_string();
                    if text.is_empty() {
                        None
                    } else {
                        Some(CompiledRule::Extension(CompiledExtension { mode: ExtMode::Set(text), only }))
                    }
                }
                "lower" => Some(CompiledRule::Extension(CompiledExtension { mode: ExtMode::Lower, only })),
                "upper" => Some(CompiledRule::Extension(CompiledExtension { mode: ExtMode::Upper, only })),
                "remove" => Some(CompiledRule::Extension(CompiledExtension { mode: ExtMode::Remove, only })),
                other => return Err(format!("Extension: unknown mode \"{}\"", other)),
            }
        }

        RuleSpec::Template(t) if t.template.trim().is_empty() => None,
        RuleSpec::Template(t) => {
            let target = match t.apply_to.as_str() {
                "name" => Target::Name,
                "both" => Target::Both,
                other => return Err(format!("Template: apply to \"name\" or \"both\", not \"{}\"", other)),
            };
            let parts = parse_template(&t.template)?;
            let uses_counter = parts.iter().any(|p| matches!(p, TplPart::Counter { .. }));
            Some(CompiledRule::Template(CompiledTemplate {
                parts,
                target,
                start: t.start,
                step: t.step,
                restart_per_folder: t.restart_per_folder,
                uses_counter,
            }))
        }
    })
}

pub fn compile(rules: &RenameRules) -> Result<Compiled, String> {
    if rules.rules.len() > MAX_RULES {
        return Err(format!("Too many rules ({}). Use at most {}.", rules.rules.len(), MAX_RULES));
    }
    let mut compiled = Vec::new();
    for spec in &rules.rules {
        if let Some(c) = compile_rule(spec)? {
            compiled.push(c);
        }
    }
    Ok(Compiled { rules: compiled, on_collision: rules.on_collision })
}

// ---------- computing a new name ----------

/// (stem, extension without the dot). Folders and dot-files have no extension.
fn split_name(name: &str, is_dir: bool) -> (&str, &str) {
    if is_dir {
        return (name, "");
    }
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

fn join_name(stem: &str, ext: &str) -> String {
    if ext.is_empty() {
        stem.to_string()
    } else {
        format!("{}.{}", stem, ext)
    }
}

fn apply_target(name: &str, is_dir: bool, target: Target, f: impl Fn(&str) -> String) -> String {
    match target {
        Target::Both => f(name),
        Target::Name => {
            let (stem, ext) = split_name(name, is_dir);
            join_name(&f(stem), ext)
        }
        Target::Ext => {
            let (stem, ext) = split_name(name, is_dir);
            if ext.is_empty() {
                name.to_string()
            } else {
                join_name(stem, &f(ext))
            }
        }
    }
}

fn replace_text(f: &CompiledFind, text: &str) -> String {
    let out = match (f.regex_mode, f.all) {
        (true, true) => f.re.replace_all(text, f.replace.as_str()),
        (true, false) => f.re.replace(text, f.replace.as_str()),
        // Plain text mode: the replacement is literal, so "$" means a dollar sign
        (false, true) => f.re.replace_all(text, NoExpand(&f.replace)),
        (false, false) => f.re.replace(text, NoExpand(&f.replace)),
    };
    out.into_owned()
}

fn change_case(text: &str, mode: CaseMode) -> String {
    match mode {
        CaseMode::Upper => text.to_uppercase(),
        CaseMode::Lower => text.to_lowercase(),
        CaseMode::Title => {
            // A word starts at the beginning or after a space, _ - . ( [ {
            let mut out = String::with_capacity(text.len());
            let mut at_word_start = true;
            for ch in text.chars() {
                if at_word_start && ch.is_alphabetic() {
                    out.extend(ch.to_uppercase());
                } else {
                    out.extend(ch.to_lowercase());
                }
                at_word_start = matches!(ch, ' ' | '_' | '-' | '.' | '(' | '[' | '{');
            }
            out
        }
        CaseMode::Sentence => {
            let mut out = String::with_capacity(text.len());
            let mut done = false;
            for ch in text.chars() {
                if !done && ch.is_alphabetic() {
                    out.extend(ch.to_uppercase());
                    done = true;
                } else {
                    out.extend(ch.to_lowercase());
                }
            }
            out
        }
    }
}

fn apply_numbering(name: &str, is_dir: bool, n: &NumberingRule, number: u64) -> String {
    let (stem, ext) = split_name(name, is_dir);
    let num = format!("{:0width$}", number, width = n.pad);
    let new_stem = match n.position.as_str() {
        "suffix" => format!("{}{}{}", stem, n.separator, num),
        "replace" => num,
        _ => format!("{}{}{}", num, n.separator, stem),
    };
    join_name(&new_stem, ext)
}

fn insert_remove_text(text: &str, op: &IrOp) -> String {
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    // 1-based position -> 0-based index, kept inside the text
    let index = |at: Where| match at {
        Where::Start => 0,
        Where::End => len,
        Where::Position(p) => (p - 1).min(len),
    };
    match op {
        IrOp::Insert { text: add, at } => {
            let i = index(*at);
            let mut out: String = chars[..i].iter().collect();
            out.push_str(add);
            out.extend(chars[i..].iter());
            out
        }
        IrOp::Remove { count, at } => {
            let (from, to) = match at {
                Where::Start => (0, (*count).min(len)),
                Where::End => (len.saturating_sub(*count), len),
                Where::Position(_) => {
                    let s = index(*at);
                    (s, s.saturating_add(*count).min(len))
                }
            };
            let mut out: String = chars[..from].iter().collect();
            out.extend(chars[to..].iter());
            out
        }
    }
}

fn apply_extension(name: &str, is_dir: bool, e: &CompiledExtension) -> String {
    if is_dir {
        return name.to_string(); // folders have no extension
    }
    let (stem, ext) = split_name(name, false);
    if !e.only.is_empty() && !e.only.contains(&ext.to_lowercase()) {
        return name.to_string();
    }
    match &e.mode {
        ExtMode::Set(new_ext) => join_name(stem, new_ext),
        ExtMode::Lower => join_name(stem, &ext.to_lowercase()),
        ExtMode::Upper => join_name(stem, &ext.to_uppercase()),
        ExtMode::Remove => stem.to_string(),
    }
}

/// What the template tokens can ask about an item.
struct ItemCtx {
    parent_name: String,
    modified: Option<u64>, // Unix seconds
    now: u64,
}

/// Counter state: one sequence per (rule position, folder), so each numbering step and each template with
/// {n} counts on its own.
type Counters = HashMap<(usize, String), u64>;

fn next_number(counters: &mut Counters, rule: usize, folder_key: &str, start: u64, step: u64, restart: bool) -> u64 {
    let key = (rule, if restart { folder_key.to_string() } else { String::new() });
    let idx = counters.entry(key).or_insert(0);
    let n = start.saturating_add(step.saturating_mul(*idx));
    *idx += 1;
    n
}

fn apply_template(t: &CompiledTemplate, name: &str, is_dir: bool, ctx: &ItemCtx, number: u64) -> String {
    let (stem, ext) = split_name(name, is_dir);
    let mut out = String::new();
    for part in &t.parts {
        match part {
            TplPart::Lit(s) => out.push_str(s),
            TplPart::Name => out.push_str(stem),
            TplPart::Ext => out.push_str(ext),
            TplPart::Parent => out.push_str(&ctx.parent_name),
            TplPart::Counter { pad } => out.push_str(&format!("{:0width$}", number, width = *pad)),
            TplPart::Date { today, fmt } => {
                let ts = if *today { Some(ctx.now) } else { ctx.modified };
                out.push_str(&ts.map(|t| format_date(t, fmt)).unwrap_or_else(|| "unknown".to_string()));
            }
        }
    }
    match t.target {
        Target::Both => out,
        _ => join_name(&out, ext), // "name": the result is the name part, the extension stays
    }
}

/// Run all rules, in order, on one name.
fn compute_name(c: &Compiled, name: &str, is_dir: bool, ctx: &ItemCtx, counters: &mut Counters, folder_key: &str) -> String {
    let mut cur = name.to_string();
    for (i, rule) in c.rules.iter().enumerate() {
        cur = match rule {
            CompiledRule::Find(f) => apply_target(&cur, is_dir, f.target, |t| replace_text(f, t)),
            CompiledRule::Case(mode, target) => apply_target(&cur, is_dir, *target, |t| change_case(t, *mode)),
            CompiledRule::InsertRemove(ir) => apply_target(&cur, is_dir, ir.target, |t| insert_remove_text(t, &ir.op)),
            CompiledRule::Numbering(n) => {
                let number = next_number(counters, i, folder_key, n.start, n.step, n.restart_per_folder);
                apply_numbering(&cur, is_dir, n, number)
            }
            CompiledRule::Extension(e) => apply_extension(&cur, is_dir, e),
            CompiledRule::Template(t) => {
                let number = if t.uses_counter {
                    next_number(counters, i, folder_key, t.start, t.step, t.restart_per_folder)
                } else {
                    0
                };
                apply_template(t, &cur, is_dir, ctx, number)
            }
        };
    }
    cur
}

fn lower_path(p: &Path) -> String {
    p.to_string_lossy().to_lowercase()
}

struct ItemInfo {
    path: PathBuf,
    is_dir: bool,
    modified: Option<u64>,
}

/// New names for all items, in the order given (numbering follows that order).
fn compute_all(c: &Compiled, items: &[ItemInfo]) -> Vec<(String, String)> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut counters = Counters::new();
    items
        .iter()
        .map(|it| {
            let old = it.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let parent = it.path.parent();
            let folder_key = parent.map(lower_path).unwrap_or_default();
            let ctx = ItemCtx {
                parent_name: parent.and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                modified: it.modified,
                now,
            };
            let new = compute_name(c, &old, it.is_dir, &ctx, &mut counters, &folder_key);
            (old, new)
        })
        .collect()
}

/// "If names would collide, add (2), (3)...": give every colliding name the first free " (n)" (n from 2),
/// in item order. A name counts as taken if another item in the batch got it, or if something that stays
/// in the folder already has it (letter case is ignored, like Windows).
fn resolve_duplicates(pairs: &mut [Pair], is_dir: &[bool]) {
    let mut taken: HashMap<String, HashSet<String>> = HashMap::new(); // folder -> lower-case names in use
    for p in pairs.iter() {
        let dir = Path::new(&p.path).parent().unwrap_or(Path::new("")).to_path_buf();
        taken.entry(lower_path(&dir)).or_insert_with(|| {
            fs::read_dir(&dir)
                .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_lowercase()).collect())
                .unwrap_or_default()
        });
    }
    // Names that are being renamed away are free for others to use
    for p in pairs.iter() {
        let path = Path::new(&p.path);
        if let (Some(dir), Some(name)) = (path.parent(), path.file_name()) {
            if let Some(set) = taken.get_mut(&lower_path(dir)) {
                set.remove(&name.to_string_lossy().to_lowercase());
            }
        }
    }
    for (i, p) in pairs.iter_mut().enumerate() {
        let dir = Path::new(&p.path).parent().unwrap_or(Path::new("")).to_path_buf();
        let set = taken.get_mut(&lower_path(&dir)).expect("folder was loaded above");
        let mut candidate = p.new_name.clone();
        if set.contains(&candidate.to_lowercase()) {
            let (stem, ext) = split_name(&p.new_name, is_dir[i]);
            let mut n = 2;
            loop {
                candidate = join_name(&format!("{} ({})", stem, n), ext);
                if !set.contains(&candidate.to_lowercase()) {
                    break;
                }
                n += 1;
            }
        }
        set.insert(candidate.to_lowercase());
        p.new_name = candidate;
    }
}

// ---------- checks ----------

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Pair {
    pub path: String,
    pub new_name: String,
}

fn target_path(p: &Pair) -> PathBuf {
    Path::new(&p.path).parent().unwrap_or(Path::new("")).join(&p.new_name)
}

fn exists_any(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok() // also true for a dangling shortcut/link
}

fn check_name(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some("The new name is empty".to_string());
    }
    if name.chars().any(|c| (c as u32) < 32 || "<>:\"/\\|?*".contains(c)) {
        return Some("Contains a character Windows doesn't allow in names: < > : \" / \\ | ? *".to_string());
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Some("A name can't end with a dot or a space".to_string());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Some(format!("The name is longer than {} characters", MAX_NAME_CHARS));
    }
    let base = name.split('.').next().unwrap_or("").trim_end().to_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((base.starts_with("COM") || base.starts_with("LPT")) && base.len() == 4 && base.as_bytes()[3].is_ascii_digit() && base.as_bytes()[3] != b'0');
    if reserved {
        return Some(format!("\"{}\" is a reserved Windows name", base));
    }
    None
}

/// One entry per pair: `None` = fine, `Some(reason)` = can't be renamed.
pub fn validate_pairs(pairs: &[Pair]) -> Vec<Option<String>> {
    let sources: HashSet<String> = pairs.iter().map(|p| lower_path(Path::new(&p.path))).collect();
    let targets: Vec<PathBuf> = pairs.iter().map(target_path).collect();
    let mut target_counts: HashMap<String, usize> = HashMap::new();
    for t in &targets {
        *target_counts.entry(lower_path(t)).or_insert(0) += 1;
    }
    pairs
        .iter()
        .zip(&targets)
        .map(|(p, t)| {
            if let Some(e) = check_name(&p.new_name) {
                return Some(e);
            }
            let tl = lower_path(t);
            if tl.chars().count() > MAX_PATH_CHARS {
                return Some(format!("The full path would be longer than {} characters", MAX_PATH_CHARS));
            }
            if !exists_any(Path::new(&p.path)) {
                return Some("No longer exists (moved, renamed or deleted)".to_string());
            }
            if target_counts.get(&tl).copied().unwrap_or(0) > 1 {
                return Some("Another item gets the same new name".to_string());
            }
            // A name taken by an item that is itself being renamed away is fine (chains and swaps)
            if exists_any(t) && !sources.contains(&tl) {
                return Some("A file or folder with this name already exists".to_string());
            }
            None
        })
        .collect()
}

// ---------- preview ----------

#[derive(Serialize, Debug)]
pub struct PreviewRow {
    pub path: String,
    pub folder: String,
    pub old_name: String,
    pub new_name: String,
    pub is_dir: bool,
    pub error: Option<String>,
    /// Set when the item is left out because its new name is already taken (the Skip policy).
    pub skipped: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct PreviewResult {
    /// Only names that would change. Unchanged names are counted but not listed.
    pub rows: Vec<PreviewRow>,
    pub total: usize,
    /// Rows that will be renamed (not counting skipped ones).
    pub changed: usize,
    pub skipped: usize,
    pub unchanged: usize,
    pub problems: usize,
}

/// "Skip" policy: which items must be left out because their new name is already taken. The first item in the
/// order keeps a name that several items want, and a name held by a file or folder that stays is never taken over.
/// Leaving an item out keeps its own name occupied, which can make another item collide, so this repeats until
/// nothing new is skipped. Returns, per pair, the reason it is skipped (`None` = it will be renamed).
fn find_skips(pairs: &[Pair]) -> Vec<Option<String>> {
    let dir_key = |p: &Pair| lower_path(Path::new(&p.path).parent().unwrap_or(Path::new("")));
    let src_name = |p: &Pair| {
        Path::new(&p.path).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default()
    };
    // what is on disk now, per folder (lower case)
    let mut existing: HashMap<String, HashSet<String>> = HashMap::new();
    for p in pairs {
        let dir = Path::new(&p.path).parent().unwrap_or(Path::new("")).to_path_buf();
        existing.entry(lower_path(&dir)).or_insert_with(|| {
            fs::read_dir(&dir)
                .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_lowercase()).collect())
                .unwrap_or_default()
        });
    }

    let mut skipped: Vec<Option<String>> = vec![None; pairs.len()];
    loop {
        // names in use = what is on disk, minus the items that will move away
        let mut taken = existing.clone();
        for (i, p) in pairs.iter().enumerate() {
            if skipped[i].is_none() {
                if let Some(set) = taken.get_mut(&dir_key(p)) {
                    set.remove(&src_name(p));
                }
            }
        }
        let mut claimed_by_batch: HashSet<(String, String)> = HashSet::new();
        let mut any_new = false;
        for (i, p) in pairs.iter().enumerate() {
            if skipped[i].is_some() {
                continue;
            }
            let dir = dir_key(p);
            let name = p.new_name.to_lowercase();
            let set = taken.get_mut(&dir).expect("every folder was loaded above");
            if set.contains(&name) {
                skipped[i] = Some(if claimed_by_batch.contains(&(dir, name)) {
                    "Skipped: another item in this batch gets this name first".to_string()
                } else {
                    "Skipped: a file or folder with this name already exists".to_string()
                });
                any_new = true;
                set.insert(src_name(p)); // a skipped item stays where it is, so its name stays in use
            } else {
                set.insert(name.clone());
                claimed_by_batch.insert((dir, name));
            }
        }
        if !any_new {
            break;
        }
    }
    skipped
}

fn add_path(out: &mut Vec<PathBuf>, seen: &mut HashSet<String>, p: PathBuf, max_items: usize) -> Result<(), String> {
    // Collecting the components makes "a/b" and "a\b" the same key
    let key = p.components().collect::<PathBuf>().to_string_lossy().to_lowercase();
    if seen.insert(key) {
        out.push(p);
        if out.len() > max_items {
            return Err(format!(
                "Too many items: more than {} (counting what is inside the selected folders). Turn \"Include sub-folders\" off or select fewer items.",
                max_items
            ));
        }
    }
    Ok(())
}

/// The items to rename: the selection and, if asked, everything inside the selected folders at any depth, each
/// folder followed by its contents (sorted by name). An item that comes up twice is kept once. Folders reached
/// through links are not entered.
fn expand_paths(paths: &[String], include_subfolders: bool, max_items: usize) -> Result<Vec<PathBuf>, String> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for p in paths {
        let pb = PathBuf::from(p);
        let is_dir = fs::symlink_metadata(&pb).map(|m| m.is_dir()).unwrap_or(false);
        add_path(&mut out, &mut seen, pb.clone(), max_items)?;
        if include_subfolders && is_dir {
            let walker = WalkDir::new(&pb)
                .min_depth(1)
                .follow_links(false)
                .sort_by(|a, b| a.file_name().to_string_lossy().to_lowercase().cmp(&b.file_name().to_string_lossy().to_lowercase()));
            for entry in walker.into_iter().filter_map(|e| e.ok()) {
                add_path(&mut out, &mut seen, entry.into_path(), max_items)?;
            }
        }
    }
    Ok(out)
}

pub fn preview_blocking(paths: &[String], rules: &RenameRules, include_subfolders: bool) -> Result<PreviewResult, String> {
    let compiled = compile(rules)?;
    let expanded = expand_paths(paths, include_subfolders, MAX_ITEMS)?;
    let total = expanded.len();
    let items: Vec<ItemInfo> = expanded
        .into_iter()
        .map(|pb| {
            let md = fs::metadata(&pb).ok();
            ItemInfo {
                is_dir: md.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                modified: md
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs()),
                path: pb,
            }
        })
        .collect();
    let names = compute_all(&compiled, &items);

    let mut pairs = Vec::new();
    let mut meta = Vec::new(); // (item index, old name)
    for (i, (it, (old, new))) in items.iter().zip(&names).enumerate() {
        if old.is_empty() || old == new {
            continue;
        }
        pairs.push(Pair { path: it.path.to_string_lossy().to_string(), new_name: new.clone() });
        meta.push((i, old.clone()));
    }

    if compiled.on_collision == CollisionPolicy::Number {
        let dirs: Vec<bool> = meta.iter().map(|(i, _)| items[*i].is_dir).collect();
        resolve_duplicates(&mut pairs, &dirs);
        // A name that ended up as the item's own current name (the 2nd of "IMG (2).jpg" -> "IMG (2).jpg") is no change
        let keep: Vec<bool> = pairs.iter().zip(&meta).map(|(p, (_, old))| &p.new_name != old).collect();
        let mut k = keep.iter();
        pairs.retain(|_| *k.next().unwrap());
        let mut k = keep.iter();
        meta.retain(|_| *k.next().unwrap());
    }

    let skip: Vec<Option<String>> = if compiled.on_collision == CollisionPolicy::Skip {
        find_skips(&pairs)
    } else {
        vec![None; pairs.len()]
    };

    // Problems are checked only for the items that will really be renamed
    let active: Vec<usize> = (0..pairs.len()).filter(|&i| skip[i].is_none()).collect();
    let active_pairs: Vec<Pair> = active.iter().map(|&i| pairs[i].clone()).collect();
    let mut error_of: Vec<Option<String>> = vec![None; pairs.len()];
    for (k, e) in validate_pairs(&active_pairs).into_iter().enumerate() {
        error_of[active[k]] = e;
    }

    let rows: Vec<PreviewRow> = pairs
        .into_iter()
        .zip(meta)
        .zip(skip.into_iter().zip(error_of))
        .map(|((pair, (i, old)), (skipped, error))| PreviewRow {
            folder: Path::new(&pair.path).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
            path: pair.path,
            old_name: old,
            new_name: pair.new_name,
            is_dir: items[i].is_dir,
            error,
            skipped,
        })
        .collect();

    let skipped = rows.iter().filter(|r| r.skipped.is_some()).count();
    let changed = rows.len() - skipped;
    let problems = rows.iter().filter(|r| r.error.is_some()).count();
    Ok(PreviewResult { total, changed, skipped, unchanged: total - changed - skipped, problems, rows })
}

// ---------- apply ----------

/// One single rename, as executed. A batch's operations are the undo journal.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct Op {
    pub from: String,
    pub to: String,
}

fn temp_path(dir: &Path, counter: &mut u64) -> PathBuf {
    loop {
        *counter += 1;
        let p = dir.join(format!(".boonsh-tmp-{}-{}", std::process::id(), counter));
        if !exists_any(&p) {
            return p;
        }
    }
}

/// Order the renames so each one is safe when it runs. Call only after `validate_pairs` reported no problems.
/// - Deeper items first, so a folder and its contents can be renamed in the same batch.
/// - A rename whose target name is still used by another item waits for that item to move away.
/// - A cycle (a->b, b->a) goes through a temporary name.
pub fn plan_ops(pairs: &[Pair]) -> Vec<Op> {
    let n = pairs.len();
    let srcs: Vec<PathBuf> = pairs.iter().map(|p| PathBuf::from(&p.path)).collect();
    let dsts: Vec<PathBuf> = pairs.iter().map(target_path).collect();
    let src_index: HashMap<String, usize> = srcs.iter().enumerate().map(|(i, p)| (lower_path(p), i)).collect();
    // dep[i] = the item that currently occupies the name item i wants (it has to move first).
    // Targets are unique after validation, so every item has at most one dependency and one dependent.
    let dep: Vec<Option<usize>> = (0..n)
        .map(|i| src_index.get(&lower_path(&dsts[i])).copied().filter(|&j| j != i))
        .collect();

    let mut emitted = vec![false; n];
    let mut temp_counter = 0u64;
    let mut chains: Vec<(usize, Vec<Op>)> = Vec::new();
    let op = |i: usize| Op { from: srcs[i].to_string_lossy().to_string(), to: dsts[i].to_string_lossy().to_string() };

    for start in 0..n {
        if emitted[start] {
            continue;
        }
        let mut chain = vec![start];
        let mut is_cycle = false;
        let mut cur = start;
        while let Some(next) = dep[cur] {
            if emitted[next] {
                break;
            }
            if next == start {
                is_cycle = true;
                break;
            }
            chain.push(next);
            cur = next;
        }
        let mut ops = Vec::new();
        if is_cycle {
            let dir = srcs[start].parent().unwrap_or(Path::new("")).to_path_buf();
            let temp = temp_path(&dir, &mut temp_counter);
            ops.push(Op { from: srcs[start].to_string_lossy().to_string(), to: temp.to_string_lossy().to_string() });
            for &i in chain[1..].iter().rev() {
                ops.push(op(i));
            }
            ops.push(Op { from: temp.to_string_lossy().to_string(), to: dsts[start].to_string_lossy().to_string() });
        } else {
            for &i in chain.iter().rev() {
                ops.push(op(i));
            }
        }
        for &i in &chain {
            emitted[i] = true;
        }
        chains.push((srcs[start].components().count(), ops));
    }
    chains.sort_by(|a, b| b.0.cmp(&a.0)); // stable: deepest first
    chains.into_iter().flat_map(|(_, ops)| ops).collect()
}

fn rollback(done: &[Op]) -> Vec<String> {
    let mut failures = Vec::new();
    for op in done.iter().rev() {
        if let Err(e) = fs::rename(&op.to, &op.from) {
            failures.push(format!("{} ({})", op.to, e));
        }
    }
    failures
}

pub fn execute_ops(ops: &[Op]) -> Result<(), String> {
    for (k, op) in ops.iter().enumerate() {
        if let Err(e) = fs::rename(&op.from, &op.to) {
            let name = Path::new(&op.from).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let failures = rollback(&ops[..k]);
            return Err(if failures.is_empty() {
                format!("Couldn't rename \"{}\": {}. Nothing was changed: the renames done so far were undone.", name, e)
            } else {
                format!(
                    "Couldn't rename \"{}\": {}. Undoing the earlier renames also failed for: {}",
                    name,
                    e,
                    failures.join("; ")
                )
            });
        }
    }
    Ok(())
}

#[derive(Serialize, Debug)]
pub struct ApplyResult {
    pub renamed: usize,
    /// The executed operations: the undo journal.
    pub ops: Vec<Op>,
    /// Final path of each renamed item, in the order given.
    pub new_paths: Vec<String>,
}

pub fn apply_blocking(pairs: Vec<Pair>) -> Result<ApplyResult, String> {
    if pairs.is_empty() {
        return Err("Nothing to rename".to_string());
    }
    if pairs.len() > MAX_ITEMS {
        return Err(format!("Too many items ({}). Bulk rename handles up to {} at a time.", pairs.len(), MAX_ITEMS));
    }
    let errors = validate_pairs(&pairs);
    let bad: Vec<(&Pair, &String)> = pairs.iter().zip(&errors).filter_map(|(p, e)| e.as_ref().map(|e| (p, e))).collect();
    if let Some((p, e)) = bad.first() {
        return Err(format!(
            "{} item(s) can't be renamed, for example \"{}\": {}. Nothing was changed. Click Preview again to review.",
            bad.len(),
            p.new_name,
            e
        ));
    }
    let ops = plan_ops(&pairs);
    execute_ops(&ops)?;
    let new_paths = pairs.iter().map(|p| target_path(p).to_string_lossy().to_string()).collect();
    Ok(ApplyResult { renamed: pairs.len(), ops, new_paths })
}

// ---------- undo ----------

#[derive(Serialize, Debug)]
pub struct UndoFailure {
    pub from: String,
    pub to: String,
    pub error: String,
}

#[derive(Serialize, Debug)]
pub struct UndoResult {
    pub restored: usize,
    pub failed: Vec<UndoFailure>,
}

/// Replay the journal backwards. An operation that can't be undone (item moved, original name taken) is
/// reported and skipped; the rest continue.
pub fn undo_blocking(ops: Vec<Op>) -> UndoResult {
    let mut restored = 0;
    let mut failed = Vec::new();
    for op in ops.iter().rev() {
        let fail = |error: String| UndoFailure { from: op.to.clone(), to: op.from.clone(), error };
        let (current, original) = (Path::new(&op.to), Path::new(&op.from));
        if !exists_any(current) {
            failed.push(fail("Not found: it was moved, renamed or deleted since".to_string()));
            continue;
        }
        if lower_path(current) != lower_path(original) && exists_any(original) {
            failed.push(fail("The original name is in use now".to_string()));
            continue;
        }
        match fs::rename(current, original) {
            Ok(()) => restored += 1,
            Err(e) => failed.push(fail(e.to_string())),
        }
    }
    UndoResult { restored, failed }
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn bulk_rename_preview(paths: Vec<String>, rules: RenameRules, include_subfolders: Option<bool>) -> Result<PreviewResult, String> {
    tauri::async_runtime::spawn_blocking(move || preview_blocking(&paths, &rules, include_subfolders.unwrap_or(false)))
        .await
        .map_err(|e| e.to_string())?
}

/// Re-check a subset of the previewed renames (after the user unticks rows), without recomputing names.
#[tauri::command]
pub async fn bulk_rename_validate(pairs: Vec<Pair>) -> Result<Vec<Option<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || validate_pairs(&pairs))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn bulk_rename_apply(pairs: Vec<Pair>) -> Result<ApplyResult, String> {
    tauri::async_runtime::spawn_blocking(move || apply_blocking(pairs))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn bulk_rename_undo(ops: Vec<Op>) -> Result<UndoResult, String> {
    tauri::async_runtime::spawn_blocking(move || undo_blocking(ops))
        .await
        .map_err(|e| e.to_string())
}


#[cfg(test)]
mod tests {
    use super::*;

    // ---- helpers ----
    /// The tests call this with the sub-folder option off; include_subfolders has its own tests.
    fn preview_blocking(paths: &[String], rules: &RenameRules) -> Result<PreviewResult, String> {
        super::preview_blocking(paths, rules, false)
    }
    fn find_rule(find: &str, replace: &str) -> FindRule {
        FindRule { find: find.into(), replace: replace.into(), regex: false, match_case: false, all_matches: true, apply_to: "name".into() }
    }
    fn rules_of(specs: Vec<RuleSpec>) -> RenameRules {
        RenameRules { rules: specs, on_collision: CollisionPolicy::Block }
    }
    fn with_find(f: FindRule) -> RenameRules {
        rules_of(vec![RuleSpec::Find(f)])
    }
    fn case_spec(mode: &str, apply_to: &str) -> RuleSpec {
        RuleSpec::Case(CaseRule { mode: mode.into(), apply_to: apply_to.into() })
    }
    fn ir_spec(mode: &str, apply_to: &str, text: &str, insert_where: &str, remove_where: &str, count: usize, position: usize) -> RuleSpec {
        RuleSpec::InsertRemove(InsertRemoveRule {
            mode: mode.into(),
            apply_to: apply_to.into(),
            text: text.into(),
            insert_where: insert_where.into(),
            remove_where: remove_where.into(),
            count,
            position,
        })
    }
    fn ext_spec(mode: &str, text: &str, only: &str) -> RuleSpec {
        RuleSpec::Extension(ExtensionRule { mode: mode.into(), text: text.into(), only_ext: only.into() })
    }
    fn num_spec(position: &str, sep: &str, start: u64, step: u64, pad: usize) -> RuleSpec {
        RuleSpec::Numbering(NumberingRule { start, step, pad, position: position.into(), separator: sep.into(), restart_per_folder: true })
    }
    fn tpl_spec(template: &str, apply_to: &str, start: u64, step: u64) -> RuleSpec {
        RuleSpec::Template(TemplateRule { template: template.into(), apply_to: apply_to.into(), start, step, restart_per_folder: true })
    }
    fn plain_ctx() -> ItemCtx {
        ItemCtx { parent_name: "Album".into(), modified: None, now: 0 }
    }
    fn run_with(rules: &RenameRules, name: &str, is_dir: bool, ctx: &ItemCtx) -> String {
        compute_name(&compile(rules).unwrap(), name, is_dir, ctx, &mut Counters::new(), "")
    }
    /// A file called `name`; each call starts a fresh counter, so a numbering rule gives its `start` number.
    fn rename(rules: &RenameRules, name: &str) -> String {
        run_with(rules, name, false, &plain_ctx())
    }
    fn item(path: &str) -> ItemInfo {
        ItemInfo { path: PathBuf::from(path), is_dir: false, modified: None }
    }
    fn new_names(rules: &RenameRules, items: &[ItemInfo]) -> Vec<String> {
        compute_all(&compile(rules).unwrap(), items).into_iter().map(|(_, n)| n).collect()
    }
    fn tmp_dir(label: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("boonsh-bulk-{}-{}", std::process::id(), label));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn pair(dir: &Path, from: &str, to: &str) -> Pair {
        Pair { path: dir.join(from).to_string_lossy().to_string(), new_name: to.to_string() }
    }
    fn names_in(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        v.sort();
        v
    }

    // ---- Find & Replace ----
    #[test]
    fn find_replace_text_and_regex() {
        // plain text: characters are literal, and $ in the replacement is a dollar sign
        assert_eq!(rename(&with_find(find_rule("(1)", "")), "IMG (1).jpg"), "IMG .jpg");
        assert_eq!(rename(&with_find(find_rule("price", "$5")), "price list.txt"), "$5 list.txt");
        assert_eq!(rename(&with_find(find_rule("a.b", "-")), "a.b axb.txt"), "- axb.txt", "plain text: the dot is literal, so axb is untouched");
        // case-insensitive by default
        assert_eq!(rename(&with_find(find_rule("img", "Photo")), "IMG_1.jpg"), "Photo_1.jpg");
        let mut f = find_rule("img", "Photo");
        f.match_case = true;
        assert_eq!(rename(&with_find(f), "IMG_1.jpg"), "IMG_1.jpg");

        // regex with groups; ${1}_ because $1_ would be read as a group named "1_"
        let mut f = find_rule(r"^(\w+),\s*(\w+)$", "$2 $1");
        f.regex = true;
        assert_eq!(rename(&with_find(f), "Smith, John.txt"), "John Smith.txt");
        let mut f = find_rule(r"(\d{2})-(\d{2})-(\d{4})", "$3-$2-$1");
        f.regex = true;
        assert_eq!(rename(&with_find(f), "report 31-12-2026.pdf"), "report 2026-12-31.pdf");
        let mut f = find_rule(r"(\d+)", "${1}_x");
        f.regex = true;
        assert_eq!(rename(&with_find(f), "a12b.txt"), "a12_xb.txt");
        let mut f = find_rule(r"\s*\(\d+\)$", "");
        f.regex = true;
        assert_eq!(rename(&with_find(f), "IMG (3).jpg"), "IMG.jpg", "anchored to the end of the NAME, not the extension");

        // the other recipes in the dialog's Regex help
        let mut f = find_rule(r"\s+", "_");
        f.regex = true;
        assert_eq!(rename(&with_find(f), "my holiday  photo.jpg"), "my_holiday_photo.jpg");
        let mut f = find_rule("^IMG_", "");
        f.regex = true;
        assert_eq!(rename(&with_find(f), "img_0042.jpg"), "0042.jpg", "case-insensitive by default");

        // pad a single digit: 1..9 -> 01..09 (names that are not exactly one digit are left alone)
        let mut f = find_rule(r"^(\d)$", "0$1");
        f.regex = true;
        let pad = with_find(f);
        assert_eq!(rename(&pad, "7.txt"), "07.txt");
        assert_eq!(rename(&pad, "10.txt"), "10.txt");
        assert_eq!(rename(&pad, "a7.txt"), "a7.txt");

        // first match only vs all matches
        let mut f = find_rule("a", "X");
        f.all_matches = false;
        assert_eq!(rename(&with_find(f), "banana.txt"), "bXnana.txt");
        assert_eq!(rename(&with_find(find_rule("a", "X")), "banana.txt"), "bXnXnX.txt");

        // an empty Find switches the rule off, and a bad regex is an error
        assert_eq!(rename(&with_find(find_rule("", "X")), "keep.txt"), "keep.txt");
        let mut f = find_rule("(", "");
        f.regex = true;
        assert!(compile(&with_find(f)).unwrap_err().contains("invalid pattern"));
        let mut f = find_rule("(?=x)", "");
        f.regex = true;
        assert!(compile(&with_find(f)).unwrap_err().contains("look-around"));
    }

    #[test]
    fn apply_to_name_extension_or_both() {
        let mut f = find_rule("txt", "md");
        f.apply_to = "ext".into();
        assert_eq!(rename(&with_find(f.clone()), "txt notes.txt"), "txt notes.md", "extension only");
        assert_eq!(rename(&with_find(f), "txt"), "txt", "no extension: nothing to change");
        assert_eq!(rename(&with_find(find_rule("txt", "md")), "txt notes.txt"), "md notes.txt", "name only is the default");
        let mut f = find_rule("txt", "md");
        f.apply_to = "both".into();
        assert_eq!(rename(&with_find(f), "txt notes.txt"), "md notes.md");
        // folders and dot-files have no extension
        let mut f = find_rule("2", "X");
        f.apply_to = "ext".into();
        let r = with_find(f);
        assert_eq!(run_with(&r, "v1.2", true, &plain_ctx()), "v1.2");
        assert_eq!(rename(&r, ".gitignore"), ".gitignore");
        assert_eq!(rename(&with_find(find_rule("git", "x")), ".gitignore"), ".xignore");
    }

    // ---- Case ----
    #[test]
    fn case_modes() {
        let case = |mode: &str, apply_to: &str, name: &str| rename(&rules_of(vec![case_spec(mode, apply_to)]), name);
        assert_eq!(case("upper", "name", "my file.txt"), "MY FILE.txt");
        assert_eq!(case("lower", "name", "My FILE.TXT"), "my file.TXT");
        assert_eq!(case("lower", "both", "My FILE.TXT"), "my file.txt");
        assert_eq!(case("upper", "ext", "my file.txt"), "my file.TXT");
        assert_eq!(case("title", "name", "the quick_brown-fox (draft).txt"), "The Quick_Brown-Fox (Draft).txt");
        assert_eq!(case("title", "name", "don't STOP.txt"), "Don't Stop.txt");
        assert_eq!(case("sentence", "name", "hELLO wORLD 2.txt"), "Hello world 2.txt");
        assert!(compile(&rules_of(vec![case_spec("x", "name")])).is_err());
    }

    // ---- Insert / Remove ----
    #[test]
    fn insert_and_remove_text() {
        let ins = |text: &str, at: &str, pos: usize, apply: &str, name: &str| rename(&rules_of(vec![ir_spec("insert", apply, text, at, "first", 0, pos)]), name);
        assert_eq!(ins("2026_", "start", 1, "name", "photo.jpg"), "2026_photo.jpg");
        assert_eq!(ins("_final", "end", 1, "name", "photo.jpg"), "photo_final.jpg", "the end of the NAME is before the extension");
        assert_eq!(ins("-", "position", 3, "name", "photo.jpg"), "ph-oto.jpg", "before the 3rd character");
        assert_eq!(ins("-", "position", 1, "name", "photo.jpg"), "-photo.jpg");
        assert_eq!(ins("-", "position", 99, "name", "photo.jpg"), "photo-.jpg", "a position past the end appends");
        assert_eq!(ins("!", "end", 1, "both", "photo.jpg"), "photo.jpg!");
        assert_eq!(ins("x", "start", 1, "ext", "photo.jpg"), "photo.xjpg");
        assert_eq!(ins("x", "start", 1, "ext", "photo"), "photo", "no extension: nothing to change");
        assert_eq!(ins("é", "position", 4, "name", "cafe.txt"), "cafée.txt", "counts characters, not bytes");
        assert_eq!(ins("", "start", 1, "name", "photo.jpg"), "photo.jpg", "empty text: the rule does nothing");

        let rem = |at: &str, count: usize, pos: usize, name: &str| rename(&rules_of(vec![ir_spec("remove", "name", "", "start", at, count, pos)]), name);
        assert_eq!(rem("first", 4, 1, "IMG_001.jpg"), "001.jpg");
        assert_eq!(rem("last", 2, 1, "photo12.jpg"), "photo.jpg");
        assert_eq!(rem("position", 3, 2, "abcdef.txt"), "aef.txt", "3 characters from the 2nd");
        assert_eq!(rem("first", 99, 1, "abc.txt"), ".txt", "more than the name has: the whole name goes");
        assert_eq!(rem("last", 1, 1, "café.txt"), "caf.txt", "counts characters, not bytes");
        assert_eq!(rem("position", 2, 99, "abc.txt"), "abc.txt", "a position past the end removes nothing");
        assert_eq!(rem("first", 0, 1, "abc.txt"), "abc.txt", "count 0: the rule does nothing");
        assert!(compile(&rules_of(vec![ir_spec("swap", "name", "x", "start", "first", 1, 1)])).is_err());
        assert!(compile(&rules_of(vec![ir_spec("insert", "name", "x", "middle", "first", 1, 1)])).is_err());
    }

    // ---- Numbering ----
    #[test]
    fn numbering_modes_and_order() {
        let one = |position: &str, sep: &str, start: u64, step: u64, pad: usize| rename(&rules_of(vec![num_spec(position, sep, start, step, pad)]), "photo.jpg");
        assert_eq!(one("prefix", "_", 7, 1, 3), "007_photo.jpg");
        assert_eq!(one("suffix", " - ", 15, 5, 0), "photo - 15.jpg");
        assert_eq!(one("replace", "", 3, 1, 2), "03.jpg");
        assert!(compile(&rules_of(vec![num_spec("prefix", "", 1, 1, 13)])).is_err(), "more than 12 digits");

        // step 0: every item gets the same number
        let two = vec![item("C:\\a\\a.txt"), item("C:\\a\\b.txt")];
        assert_eq!(new_names(&rules_of(vec![num_spec("suffix", "-", 3, 0, 2)]), &two), ["a-03.txt", "b-03.txt"]);
        // a fixed 0 in front of every name turns 1..9 into 01..09
        let digits: Vec<ItemInfo> = (1..=9).map(|n| item(&format!("C:\\a\\{}.txt", n))).collect();
        assert_eq!(
            new_names(&rules_of(vec![num_spec("prefix", "", 0, 0, 1)]), &digits),
            ["01.txt", "02.txt", "03.txt", "04.txt", "05.txt", "06.txt", "07.txt", "08.txt", "09.txt"]
        );
        // with step 1 (what the dialog used to turn a typed 0 into) the numbers grow: 01, 12, 23...
        assert_eq!(
            new_names(&rules_of(vec![num_spec("prefix", "", 0, 1, 1)]), &digits)[..3],
            ["01.txt", "12.txt", "23.txt"]
        );

        // the sequence follows the given order; with restart_per_folder each folder starts again
        let items = vec![item("C:\\a\\x.txt"), item("C:\\a\\y.txt"), item("C:\\b\\z.txt")];
        assert_eq!(new_names(&rules_of(vec![num_spec("prefix", "-", 1, 1, 2)]), &items), ["01-x.txt", "02-y.txt", "01-z.txt"]);
        let mut n = NumberingRule { start: 1, step: 1, pad: 2, position: "prefix".into(), separator: "-".into(), restart_per_folder: false };
        assert_eq!(new_names(&rules_of(vec![RuleSpec::Numbering(n.clone())]), &items), ["01-x.txt", "02-y.txt", "03-z.txt"]);
        n.start = 10;
        n.step = 10;
        assert_eq!(new_names(&rules_of(vec![RuleSpec::Numbering(n)]), &items), ["10-x.txt", "20-y.txt", "30-z.txt"]);
    }

    // ---- Extension ----
    #[test]
    fn extension_rule() {
        let ext = |mode: &str, text: &str, only: &str, name: &str| rename(&rules_of(vec![ext_spec(mode, text, only)]), name);
        assert_eq!(ext("set", "jpg", "", "a.jpeg"), "a.jpg");
        assert_eq!(ext("set", ".md", "", "a.txt"), "a.md", "a leading dot is ignored");
        assert_eq!(ext("set", "txt", "", "readme"), "readme.txt", "a file without one gets it");
        assert_eq!(ext("set", "jpg", "jpeg,jpe", "a.jpeg"), "a.jpg");
        assert_eq!(ext("set", "jpg", "jpeg,jpe", "b.JPE"), "b.jpg", "the filter ignores case");
        assert_eq!(ext("set", "jpg", ".jpeg", "c.jpeg"), "c.jpg", "the filter may have dots");
        assert_eq!(ext("set", "jpg", "jpeg", "d.png"), "d.png", "other extensions are left alone");
        assert_eq!(ext("set", "jpg", "jpeg", "noext"), "noext");
        assert_eq!(ext("lower", "", "", "A.JPG"), "A.jpg");
        assert_eq!(ext("upper", "", "", "a.jpg"), "a.JPG");
        assert_eq!(ext("remove", "", "", "a.tar.gz"), "a.tar");
        assert_eq!(ext("remove", "", "", "noext"), "noext");
        assert_eq!(ext("remove", "", "", ".gitignore"), ".gitignore", "a dot-file has no extension");
        // folders are never touched, and an empty new extension turns the rule off
        assert_eq!(run_with(&rules_of(vec![ext_spec("set", "x", "")]), "v1.2", true, &plain_ctx()), "v1.2");
        assert_eq!(rename(&rules_of(vec![ext_spec("set", "  ", "")]), "a.txt"), "a.txt");
        assert!(compile(&rules_of(vec![ext_spec("rename", "x", "")])).is_err());
    }

    // ---- Template ----
    #[test]
    fn template_tokens() {
        // 2026-07-06 12:00 UTC (noon, so the local date is the same in every time zone); "today" is 2027-01-02
        let at = |y, m, d| (localtime::days_from_civil(y, m, d) * 86_400 + 12 * 3600) as u64;
        let ctx = ItemCtx { parent_name: "Album".into(), modified: Some(at(2026, 7, 6)), now: at(2027, 1, 2) };
        let one = |t: &str, apply: &str, name: &str, is_dir: bool| run_with(&rules_of(vec![tpl_spec(t, apply, 1, 1)]), name, is_dir, &ctx);

        // "name": the result is the new name part, the extension is kept
        assert_eq!(one("{date}_{name}", "name", "photo.jpg", false), "2026-07-06_photo.jpg");
        assert_eq!(one("{parent} - {name}", "name", "photo.jpg", false), "Album - photo.jpg");
        assert_eq!(one("{name}_{ext}", "name", "photo.jpg", false), "photo_jpg.jpg");
        assert_eq!(one("{name}-{n:3}", "name", "photo.jpg", false), "photo-001.jpg");
        assert_eq!(one("{n}", "name", "photo.jpg", false), "1.jpg");
        // "both": the result is the whole name, so write the extension yourself
        assert_eq!(one("{name}.{ext}", "both", "photo.jpg", false), "photo.jpg");
        assert_eq!(one("{date:yyyyMMdd}-{name}.{ext}", "both", "photo.jpg", false), "20260706-photo.jpg");
        assert_eq!(one("{date:yy-MM-dd}", "name", "a.txt", false), "26-07-06.txt");
        assert_eq!(one("{today:yyyy}_{name}", "name", "a.txt", false), "2027_a.txt");
        assert_eq!(one("{today}", "name", "a.txt", false), "2027-01-02.txt");
        // folders have no extension
        assert_eq!(one("{parent}_{name}", "name", "Trip", true), "Album_Trip");
        assert_eq!(one("{name}", "name", "v1.2", true), "v1.2");
        // literal braces are written twice
        assert_eq!(one("{{x}}{name}", "name", "a.txt", false), "{x}a.txt");
        // an item without a modified date
        let unknown = ItemCtx { parent_name: "Album".into(), modified: None, now: 0 };
        assert_eq!(run_with(&rules_of(vec![tpl_spec("{date}_{name}", "name", 1, 1)]), "a.txt", false, &unknown), "unknown_a.txt");
        // an empty template does nothing
        assert_eq!(one("", "name", "keep.txt", false), "keep.txt");
        assert_eq!(one("   ", "name", "keep.txt", false), "keep.txt");
        // mistakes are reported, with the list of tokens
        for (bad, why) in [
            ("{foo}", "unknown token"),
            ("{name", "no matching }"),
            ("name}", "no matching {"),
            ("{n:x}", "digits"),
            ("{n:13}", "digits"),
            ("{name:3}", "takes nothing"),
        ] {
            let err = compile(&rules_of(vec![tpl_spec(bad, "name", 1, 1)])).unwrap_err();
            assert!(err.contains(why), "{} -> {}", bad, err);
        }
        assert!(compile(&rules_of(vec![tpl_spec("{foo}", "name", 1, 1)])).unwrap_err().contains("{name} {ext} {parent}"));
        // step 0 is allowed here too: {n} stays the same for every item
        let two = vec![item("C:\\a\\x.txt"), item("C:\\a\\y.txt")];
        assert_eq!(new_names(&rules_of(vec![tpl_spec("{name}~{n}", "name", 7, 0)]), &two), ["x~7.txt", "y~7.txt"]);
        assert!(compile(&rules_of(vec![tpl_spec("{n}", "ext", 1, 1)])).is_err(), "a template builds the name, not just the extension");
    }

    #[test]
    fn template_counter_follows_item_order_and_folders() {
        let items = vec![item("C:\\a\\x.txt"), item("C:\\a\\y.txt"), item("C:\\b\\z.txt")];
        let r = |restart: bool| {
            rules_of(vec![RuleSpec::Template(TemplateRule { template: "{n:2}_{name}".into(), apply_to: "name".into(), start: 5, step: 5, restart_per_folder: restart })])
        };
        assert_eq!(new_names(&r(true), &items), ["05_x.txt", "10_y.txt", "05_z.txt"]);
        assert_eq!(new_names(&r(false), &items), ["05_x.txt", "10_y.txt", "15_z.txt"]);
        // a template without {n} does not use up numbers
        let plain = rules_of(vec![tpl_spec("{parent}", "name", 1, 1)]);
        assert_eq!(new_names(&plain, &items), ["a.txt", "a.txt", "b.txt"]);
    }

    // ---- The stack: order matters, rules can repeat ----
    #[test]
    fn rule_stack_order_and_repeats() {
        // the same two rules in the two orders give different names
        let find_then_upper = rules_of(vec![RuleSpec::Find(find_rule("abc", "x")), case_spec("upper", "name")]);
        let upper_then_find = rules_of(vec![case_spec("upper", "name"), RuleSpec::Find(find_rule("abc", "x"))]);
        assert_eq!(rename(&find_then_upper, "abc.txt"), "X.txt");
        assert_eq!(rename(&upper_then_find, "abc.txt"), "x.txt", "the find (ignoring case) sees ABC");

        // the same kind of rule twice
        let twice = rules_of(vec![RuleSpec::Find(find_rule("-", "_")), RuleSpec::Find(find_rule("_", " "))]);
        assert_eq!(rename(&twice, "a-b-c.txt"), "a b c.txt");

        // each numbering rule counts on its own
        let items = vec![item("C:\\a\\x.txt"), item("C:\\a\\y.txt")];
        let two = rules_of(vec![num_spec("prefix", "-", 1, 1, 2), num_spec("suffix", "-", 100, 1, 0)]);
        assert_eq!(new_names(&two, &items), ["01-x-100.txt", "02-y-101.txt"]);
        // numbering and a template counter are independent too
        let mixed = rules_of(vec![num_spec("prefix", "-", 1, 1, 0), tpl_spec("{name}~{n}", "name", 50, 1)]);
        assert_eq!(new_names(&mixed, &items), ["1-x~50.txt", "2-y~51.txt"]);

        // all kinds together, in a chosen order
        let all = rules_of(vec![
            RuleSpec::Find(find_rule("img", "trip")),
            case_spec("title", "name"),
            ir_spec("insert", "name", "_x", "end", "first", 0, 1),
            num_spec("suffix", "-", 4, 1, 2),
            ext_spec("set", "jpg", "jpeg"),
            tpl_spec("{name}!", "name", 1, 1),
        ]);
        assert_eq!(rename(&all, "IMG.jpeg"), "Trip_x-04!.jpg");
        assert_eq!(rename(&all, "IMG.png"), "Trip_x-04!.png", "the extension filter skipped it");

        // too many rules are refused
        let many = rules_of((0..31).map(|_| case_spec("lower", "name")).collect());
        assert!(compile(&many).unwrap_err().contains("Too many rules"));
        // an empty list does nothing
        assert_eq!(rename(&rules_of(vec![]), "same.txt"), "same.txt");
    }

    #[test]
    fn rules_wire_format_matches_the_dialog() {
        // exactly the shape src/bulkRename.ts sends
        let json = r#"{"rules":[
          {"kind":"find","find":"a","replace":"b","regex":false,"match_case":false,"all_matches":true,"apply_to":"name"},
          {"kind":"case","mode":"upper","apply_to":"name"},
          {"kind":"insert_remove","mode":"insert","apply_to":"name","text":"x","insert_where":"start","remove_where":"first","count":1,"position":1},
          {"kind":"numbering","start":1,"step":1,"pad":2,"position":"suffix","separator":"_","restart_per_folder":true},
          {"kind":"extension","mode":"lower","text":"","only_ext":""},
          {"kind":"template","template":"{name}","apply_to":"name","start":1,"step":1,"restart_per_folder":true}
        ],"on_collision":"number"}"#;
        let r: RenameRules = serde_json::from_str(json).unwrap();
        assert_eq!(r.rules.len(), 6);
        assert_eq!(r.on_collision, CollisionPolicy::Number);
        assert_eq!(compile(&r).unwrap().rules.len(), 6);
        // missing fields fall back to "no rules, no auto numbering"
        let empty: RenameRules = serde_json::from_str("{}").unwrap();
        assert!(empty.rules.is_empty() && empty.on_collision == CollisionPolicy::Skip, "the default is to skip colliding items");
        assert!(serde_json::from_str::<RenameRules>(r#"{"on_collision":"explode"}"#).is_err());
        // an unknown kind is an error, not silently ignored
        assert!(serde_json::from_str::<RenameRules>(r#"{"rules":[{"kind":"spin"}]}"#).is_err());
    }

    // ---- checks ----
    #[test]
    fn name_checks() {
        for (name, bad) in [
            ("ok name.txt", false),
            ("", true),
            ("a<b.txt", true),
            ("a:b.txt", true),
            ("a/b.txt", true),
            ("a|b", true),
            ("trailing.", true),
            ("trailing ", true),
            ("CON", true),
            ("con.txt", true),
            ("Nul.tar.gz", true),
            ("COM1.log", true),
            ("LPT9", true),
            ("COM0", false),
            ("COMM", false),
            ("console.txt", false),
        ] {
            assert_eq!(check_name(name).is_some(), bad, "{:?}", name);
        }
        assert!(check_name(&"x".repeat(256)).is_some());
        assert!(check_name(&"x".repeat(255)).is_none());
    }

    #[test]
    fn preview_lists_only_changed_names_and_flags_problems() {
        let d = tmp_dir("preview");
        for f in ["IMG (1).jpg", "IMG (2).jpg", "notes.txt", "a.txt", "b.txt", "1.txt", "2.txt"] {
            fs::write(d.join(f), "x").unwrap();
        }
        let paths = |names: &[&str]| names.iter().map(|n| d.join(n).to_string_lossy().to_string()).collect::<Vec<_>>();

        // unchanged names are counted but not listed
        let mut f = find_rule(r"\s*\(\d+\)", "");
        f.regex = true;
        let p = preview_blocking(&paths(&["IMG (1).jpg", "notes.txt"]), &with_find(f.clone())).unwrap();
        assert_eq!((p.total, p.changed, p.unchanged, p.problems), (2, 1, 1, 0));
        assert_eq!(p.rows.len(), 1);
        assert_eq!((p.rows[0].old_name.as_str(), p.rows[0].new_name.as_str()), ("IMG (1).jpg", "IMG.jpg"));

        // two items getting the same new name are both flagged
        let p = preview_blocking(&paths(&["IMG (1).jpg", "IMG (2).jpg"]), &with_find(f)).unwrap();
        assert_eq!((p.changed, p.problems), (2, 2));
        assert!(p.rows.iter().all(|r| r.error.as_deref() == Some("Another item gets the same new name")));

        // a name taken by an existing item that is not being renamed (b.txt has no "a", so it stays)
        let p = preview_blocking(&paths(&["a.txt", "b.txt"]), &with_find(find_rule("a", "b"))).unwrap();
        assert_eq!((p.changed, p.unchanged), (1, 1));
        assert_eq!(p.rows[0].error.as_deref(), Some("A file or folder with this name already exists"));

        // a name that another item in the batch is moving away from is fine: 1.txt -> 2.txt, 2.txt -> 3.txt
        let numbering = rules_of(vec![num_spec("replace", "", 2, 1, 0)]);
        let p = preview_blocking(&paths(&["1.txt", "2.txt"]), &numbering).unwrap();
        assert_eq!((p.changed, p.problems), (2, 0), "{:?}", p.rows);

        // nothing matches
        let p = preview_blocking(&paths(&["notes.txt"]), &with_find(find_rule("zzz", "y"))).unwrap();
        assert_eq!((p.changed, p.unchanged, p.rows.len()), (0, 1, 0));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn template_uses_the_real_modified_date_and_folder_name() {
        let d = tmp_dir("tplreal").join("Holiday 2026");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("a.jpg"), "x").unwrap();
        let ts = (localtime::days_from_civil(2025, 3, 9) * 86_400 + 12 * 3600) as u64;
        let f = fs::File::options().write(true).open(d.join("a.jpg")).unwrap();
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(ts)).unwrap();
        drop(f);
        let r = rules_of(vec![tpl_spec("{parent}_{date:yyyyMMdd}_{name}", "name", 1, 1)]);
        let p = preview_blocking(&[d.join("a.jpg").to_string_lossy().to_string()], &r).unwrap();
        assert_eq!(p.rows[0].new_name, "Holiday 2026_20250309_a.jpg");
        assert_eq!(p.problems, 0);
        fs::remove_dir_all(d.parent().unwrap()).unwrap();
    }

    // ---- "add (2), (3) to names that would collide" ----
    #[test]
    fn auto_number_duplicates() {
        let d = tmp_dir("autonum");
        for (f, c) in [("IMG (1).jpg", "1"), ("IMG (2).jpg", "2"), ("IMG (3).jpg", "3"), ("notes.txt", "n")] {
            fs::write(d.join(f), c).unwrap();
        }
        let paths = |names: &[&str]| names.iter().map(|n| d.join(n).to_string_lossy().to_string()).collect::<Vec<_>>();
        let mut f = find_rule(r"\s*\(\d+\)$", "");
        f.regex = true;
        let batch = paths(&["IMG (1).jpg", "IMG (2).jpg", "IMG (3).jpg"]);

        // off: all three are flagged
        let p = preview_blocking(&batch, &with_find(f.clone())).unwrap();
        assert_eq!((p.changed, p.problems), (3, 3));

        // on: the first keeps IMG.jpg; the 2nd and 3rd would be "IMG (2).jpg" and "IMG (3).jpg", which are
        // their own names already, so they are not changes at all
        let mut on = with_find(f.clone());
        on.on_collision = CollisionPolicy::Number;
        let p = preview_blocking(&batch, &on).unwrap();
        assert_eq!((p.total, p.changed, p.unchanged, p.problems), (3, 1, 2, 0), "{:?}", p.rows);
        assert_eq!((p.rows[0].old_name.as_str(), p.rows[0].new_name.as_str()), ("IMG (1).jpg", "IMG.jpg"));

        // IMG.jpg already exists (not part of the batch, and with different letter case): numbers start at (2)
        fs::write(d.join("img.JPG"), "orig").unwrap();
        let p = preview_blocking(&batch, &on).unwrap();
        let moves: Vec<(&str, &str)> = p.rows.iter().map(|r| (r.old_name.as_str(), r.new_name.as_str())).collect();
        assert_eq!(moves, [("IMG (1).jpg", "IMG (2).jpg"), ("IMG (2).jpg", "IMG (3).jpg"), ("IMG (3).jpg", "IMG (4).jpg")]);
        assert_eq!(p.problems, 0, "a chain is fine");
        // ...and the chain really can be applied, without touching the file that was already there
        let pairs: Vec<Pair> = p.rows.iter().map(|r| Pair { path: r.path.clone(), new_name: r.new_name.clone() }).collect();
        apply_blocking(pairs).unwrap();
        assert_eq!(fs::read_to_string(d.join("img.JPG")).unwrap(), "orig");
        assert_eq!(fs::read_to_string(d.join("IMG (2).jpg")).unwrap(), "1");
        assert_eq!(fs::read_to_string(d.join("IMG (3).jpg")).unwrap(), "2");
        assert_eq!(fs::read_to_string(d.join("IMG (4).jpg")).unwrap(), "3");

        // other problems are still reported: auto numbering only fixes collisions
        let mut bad = with_find(find_rule("notes", "a:b"));
        bad.on_collision = CollisionPolicy::Number;
        let p = preview_blocking(&paths(&["notes.txt"]), &bad).unwrap();
        assert_eq!(p.problems, 1);
        assert!(p.rows[0].error.as_deref().unwrap().contains("doesn't allow"));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn auto_number_duplicates_across_folders_and_with_extensions() {
        let d = tmp_dir("autonum2");
        fs::create_dir_all(d.join("one")).unwrap();
        fs::create_dir_all(d.join("two")).unwrap();
        for f in ["one/a.txt", "one/b.txt", "two/a.txt", "two/b.txt", "one/c.tar.gz", "one/d.tar.gz"] {
            fs::write(d.join(f), "x").unwrap();
        }
        let paths = |names: &[&str]| names.iter().map(|n| d.join(n).to_string_lossy().to_string()).collect::<Vec<_>>();
        let mut r = rules_of(vec![tpl_spec("same", "name", 1, 1)]); // every file in every folder becomes "same.<ext>"
        r.on_collision = CollisionPolicy::Number;
        let p = preview_blocking(&paths(&["one/a.txt", "one/b.txt", "two/a.txt", "two/b.txt", "one/c.tar.gz", "one/d.tar.gz"]), &r).unwrap();
        let moves: Vec<String> = p.rows.iter().map(|r| format!("{}->{}", r.old_name, r.new_name)).collect();
        // each folder is counted on its own, and the (last) extension stays at the end: "c.tar" is the name part of c.tar.gz
        assert_eq!(moves, ["a.txt->same.txt", "b.txt->same (2).txt", "a.txt->same.txt", "b.txt->same (2).txt", "c.tar.gz->same.gz", "d.tar.gz->same (2).gz"]);
        assert_eq!(p.problems, 0);
        fs::remove_dir_all(&d).unwrap();
    }

    // ---- "skip" policy (the default): an item whose new name is already taken is left out ----
    #[test]
    fn find_skips_logic() {
        let d = tmp_dir("skips");
        for f in ["a.txt", "b.txt", "c.txt"] {
            fs::write(d.join(f), "x").unwrap();
        }
        // a -> b and b -> c, but c.txt (not in the batch) exists: b is skipped, so b.txt stays,
        // and then a can't take its name either
        let s = find_skips(&[pair(&d, "a.txt", "b.txt"), pair(&d, "b.txt", "c.txt")]);
        assert!(s[0].is_some() && s[1].is_some(), "{:?}", s);
        assert!(s[1].as_deref().unwrap().contains("already exists"));
        // a swap is fine, and so is a chain
        assert_eq!(find_skips(&[pair(&d, "a.txt", "b.txt"), pair(&d, "b.txt", "a.txt")]), vec![None, None]);
        assert_eq!(find_skips(&[pair(&d, "a.txt", "b.txt"), pair(&d, "b.txt", "x.txt")]), vec![None, None]);
        // two items want the same new name (letter case ignored): the first keeps it
        let s = find_skips(&[pair(&d, "a.txt", "z.txt"), pair(&d, "b.txt", "Z.TXT")]);
        assert_eq!(s[0], None);
        assert_eq!(s[1].as_deref(), Some("Skipped: another item in this batch gets this name first"));
        // a change of letter case of the item itself is not a collision
        assert_eq!(find_skips(&[pair(&d, "a.txt", "A.txt")]), vec![None]);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn skip_policy_leaves_duplicates_out_and_renames_the_rest() {
        let d = tmp_dir("skippolicy");
        for f in ["IMG (1).jpg", "IMG (2).jpg", "IMG (3).jpg", "other (1).txt", "notes.txt"] {
            fs::write(d.join(f), f).unwrap();
        }
        let paths = |names: &[&str]| names.iter().map(|n| d.join(n).to_string_lossy().to_string()).collect::<Vec<_>>();
        let mut f = find_rule(r"\s*\(\d+\)$", "");
        f.regex = true;
        let mut r = with_find(f);
        assert_eq!(r.on_collision, CollisionPolicy::Block, "the test helper uses Block; Skip is chosen below");
        r.on_collision = CollisionPolicy::Skip;
        let batch = paths(&["IMG (1).jpg", "IMG (2).jpg", "IMG (3).jpg", "other (1).txt"]);

        // all three IMG files want IMG.jpg: the first keeps it, the other two are skipped, not a problem
        let p = preview_blocking(&batch, &r).unwrap();
        assert_eq!((p.total, p.changed, p.skipped, p.unchanged, p.problems), (4, 2, 2, 0, 0), "{:?}", p.rows);
        let status: Vec<(&str, bool)> = p.rows.iter().map(|x| (x.old_name.as_str(), x.skipped.is_some())).collect();
        assert_eq!(status, [("IMG (1).jpg", false), ("IMG (2).jpg", true), ("IMG (3).jpg", true), ("other (1).txt", false)]);
        assert!(p.rows[1].skipped.as_deref().unwrap().contains("another item in this batch"));
        assert!(p.rows[1].error.is_none(), "a skipped row is not a problem");
        // renaming exactly the rows that are not skipped works, and leaves the skipped files alone
        let pairs: Vec<Pair> = p.rows.iter().filter(|x| x.skipped.is_none()).map(|x| Pair { path: x.path.clone(), new_name: x.new_name.clone() }).collect();
        apply_blocking(pairs).unwrap();
        assert_eq!(names_in(&d), ["IMG (2).jpg", "IMG (3).jpg", "IMG.jpg", "notes.txt", "other.txt"]);
        assert_eq!(fs::read_to_string(d.join("IMG.jpg")).unwrap(), "IMG (1).jpg");

        // a file called IMG.jpg already there: all of them are skipped
        let d2 = tmp_dir("skippolicy2");
        for f in ["IMG (1).jpg", "IMG (2).jpg", "IMG.jpg"] {
            fs::write(d2.join(f), "x").unwrap();
        }
        let batch2: Vec<String> = ["IMG (1).jpg", "IMG (2).jpg"].iter().map(|n| d2.join(n).to_string_lossy().to_string()).collect();
        let p = preview_blocking(&batch2, &r).unwrap();
        assert_eq!((p.changed, p.skipped, p.problems), (0, 2, 0));
        assert!(p.rows.iter().all(|x| x.skipped.as_deref().unwrap().contains("already exists")));
        // the other two policies treat the same situation differently
        let mut block = r.clone();
        block.on_collision = CollisionPolicy::Block;
        let p = preview_blocking(&batch2, &block).unwrap();
        assert_eq!((p.changed, p.skipped, p.problems), (2, 0, 2), "Block: problems, nothing skipped");
        let mut number = r.clone();
        number.on_collision = CollisionPolicy::Number;
        let p = preview_blocking(&batch2, &number).unwrap();
        assert_eq!((p.skipped, p.problems), (0, 0), "Number: IMG (2).jpg and IMG (3).jpg");
        fs::remove_dir_all(&d).unwrap();
        fs::remove_dir_all(&d2).unwrap();
    }

    // ---- include sub-folders ----
    #[test]
    fn expand_paths_includes_folder_contents_when_asked() {
        let d = tmp_dir("expand");
        fs::create_dir_all(d.join("top/sub/deep")).unwrap();
        fs::create_dir_all(d.join("top/Zeta")).unwrap();
        for f in ["top/b.txt", "top/A.txt", "top/sub/c.txt", "top/sub/deep/d.txt", "other.txt"] {
            fs::write(d.join(f), "x").unwrap();
        }
        let sel = |names: &[&str]| names.iter().map(|n| d.join(n).to_string_lossy().to_string()).collect::<Vec<_>>();
        let rel = |v: Vec<PathBuf>| v.iter().map(|p| p.strip_prefix(&d).unwrap().to_string_lossy().replace('\\', "/")).collect::<Vec<_>>();

        // off: only what is selected
        assert_eq!(rel(expand_paths(&sel(&["top", "other.txt"]), false, 100).unwrap()), ["top", "other.txt"]);
        // on: a selected folder is followed by everything inside it, at any depth, sorted by name
        assert_eq!(
            rel(expand_paths(&sel(&["top", "other.txt"]), true, 100).unwrap()),
            ["top", "top/A.txt", "top/b.txt", "top/sub", "top/sub/c.txt", "top/sub/deep", "top/sub/deep/d.txt", "top/Zeta", "other.txt"]
        );
        // an item that is selected and also inside a selected folder appears once, at its first place
        assert_eq!(
            rel(expand_paths(&sel(&["top/b.txt", "top"]), true, 100).unwrap()),
            ["top/b.txt", "top", "top/A.txt", "top/sub", "top/sub/c.txt", "top/sub/deep", "top/sub/deep/d.txt", "top/Zeta"]
        );
        // selected files have nothing to expand
        assert_eq!(rel(expand_paths(&sel(&["other.txt"]), true, 100).unwrap()), ["other.txt"]);
        // too many items is an error that names the way out
        let err = expand_paths(&sel(&["top"]), true, 3).unwrap_err();
        assert!(err.contains("Too many items") && err.contains("Include sub-folders"), "{}", err);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn preview_with_subfolders_on_and_off() {
        let d = tmp_dir("subs");
        fs::create_dir_all(d.join("top/sub")).unwrap();
        for f in ["top/A.TXT", "top/sub/B.TXT", "top/sub/keep.txt", "loose.TXT"] {
            fs::write(d.join(f), "x").unwrap();
        }
        let sel: Vec<String> = ["top", "loose.TXT"].iter().map(|n| d.join(n).to_string_lossy().to_string()).collect();
        let r = rules_of(vec![ext_spec("lower", "", "")]); // .TXT -> .txt; folders are not touched

        let off = super::preview_blocking(&sel, &r, false).unwrap();
        assert_eq!((off.total, off.changed), (2, 1), "only the selected loose.TXT");

        let on = super::preview_blocking(&sel, &r, true).unwrap();
        assert_eq!((on.total, on.changed, on.unchanged), (6, 3, 3), "top, A.TXT, sub, B.TXT, keep.txt, loose.TXT");
        let changed: Vec<&str> = on.rows.iter().map(|x| x.old_name.as_str()).collect();
        assert_eq!(changed, ["A.TXT", "B.TXT", "loose.TXT"]);
        // the files in the sub-folders get their own folder shown
        assert!(on.rows[1].folder.ends_with("sub"));
        // and the whole batch can be applied
        let pairs: Vec<Pair> = on.rows.iter().map(|x| Pair { path: x.path.clone(), new_name: x.new_name.clone() }).collect();
        apply_blocking(pairs).unwrap();
        assert!(d.join("top/A.txt").exists() && d.join("top/sub/B.txt").exists() && d.join("loose.txt").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    // ---- real files ----
    #[test]
    fn case_only_rename_works_directly() {
        let d = tmp_dir("caseonly");
        fs::write(d.join("Photo.JPG"), "x").unwrap();
        let pairs = vec![pair(&d, "Photo.JPG", "photo.jpg")];
        assert_eq!(validate_pairs(&pairs), vec![None]);
        let ops = plan_ops(&pairs);
        assert_eq!(ops.len(), 1, "no temporary name needed");
        apply_blocking(pairs).unwrap();
        assert_eq!(names_in(&d), ["photo.jpg"]);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn swaps_and_chains_use_a_safe_order_and_undo_restores() {
        let d = tmp_dir("swap");
        for (f, c) in [("a.txt", "A"), ("b.txt", "B"), ("c.txt", "C")] {
            fs::write(d.join(f), c).unwrap();
        }
        // swap a <-> b
        let swap = vec![pair(&d, "a.txt", "b.txt"), pair(&d, "b.txt", "a.txt")];
        assert_eq!(validate_pairs(&swap), vec![None, None]);
        let res = apply_blocking(swap).unwrap();
        assert_eq!(res.ops.len(), 3, "a swap goes through one temporary name");
        assert_eq!(fs::read_to_string(d.join("a.txt")).unwrap(), "B");
        assert_eq!(fs::read_to_string(d.join("b.txt")).unwrap(), "A");
        assert_eq!(names_in(&d), ["a.txt", "b.txt", "c.txt"], "no temporary file is left behind");
        let undo = undo_blocking(res.ops);
        assert!(undo.failed.is_empty(), "{:?}", undo.failed);
        assert_eq!(fs::read_to_string(d.join("a.txt")).unwrap(), "A");
        assert_eq!(fs::read_to_string(d.join("b.txt")).unwrap(), "B");

        // chain a -> b, b -> c, c -> d (listed in the worst order)
        let chain = vec![pair(&d, "a.txt", "b.txt"), pair(&d, "b.txt", "c.txt"), pair(&d, "c.txt", "d.txt")];
        assert_eq!(validate_pairs(&chain), vec![None, None, None]);
        let res = apply_blocking(chain).unwrap();
        assert_eq!(res.ops.len(), 3, "a chain needs no temporary name");
        assert_eq!(names_in(&d), ["b.txt", "c.txt", "d.txt"]);
        assert_eq!(fs::read_to_string(d.join("d.txt")).unwrap(), "C");
        assert_eq!(fs::read_to_string(d.join("c.txt")).unwrap(), "B");
        assert_eq!(fs::read_to_string(d.join("b.txt")).unwrap(), "A");
        assert!(undo_blocking(res.ops).failed.is_empty());
        assert_eq!(names_in(&d), ["a.txt", "b.txt", "c.txt"]);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn folder_and_its_contents_in_one_batch() {
        let d = tmp_dir("nested");
        fs::create_dir_all(d.join("Parent/child")).unwrap();
        fs::write(d.join("Parent/child/f.txt"), "x").unwrap();
        // parent and child (given by their ORIGINAL paths) are both renamed
        let pairs = vec![
            pair(&d, "Parent", "Parent2"),
            Pair { path: d.join("Parent").join("child").to_string_lossy().to_string(), new_name: "child2".into() },
        ];
        assert_eq!(validate_pairs(&pairs), vec![None, None]);
        let res = apply_blocking(pairs).unwrap();
        assert!(res.ops[0].from.ends_with("child"), "the child is renamed before its parent: {:?}", res.ops);
        assert!(d.join("Parent2/child2/f.txt").exists());
        let undo = undo_blocking(res.ops);
        assert!(undo.failed.is_empty(), "{:?}", undo.failed);
        assert!(d.join("Parent/child/f.txt").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn apply_refuses_changed_situations_and_changes_nothing() {
        let d = tmp_dir("refuse");
        fs::write(d.join("a.txt"), "x").unwrap();
        fs::write(d.join("taken.txt"), "y").unwrap();
        // the name got taken after the preview
        let err = apply_blocking(vec![pair(&d, "a.txt", "taken.txt")]).unwrap_err();
        assert!(err.contains("already exists") && err.contains("Nothing was changed"), "{}", err);
        // the file disappeared after the preview
        let err = apply_blocking(vec![pair(&d, "gone.txt", "z.txt")]).unwrap_err();
        assert!(err.contains("No longer exists"), "{}", err);
        assert_eq!(names_in(&d), ["a.txt", "taken.txt"]);
        fs::remove_dir_all(&d).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_failure_in_the_middle_rolls_everything_back() {
        use std::os::windows::fs::OpenOptionsExt;
        let d = tmp_dir("rollback");
        for f in ["a.txt", "b.txt", "c.txt"] {
            fs::write(d.join(f), f).unwrap();
        }
        // hold c.txt open without sharing, so renaming it fails
        let _lock = fs::OpenOptions::new().read(true).share_mode(0).open(d.join("c.txt")).unwrap();
        let err = apply_blocking(vec![pair(&d, "a.txt", "x.txt"), pair(&d, "b.txt", "y.txt"), pair(&d, "c.txt", "z.txt")]).unwrap_err();
        assert!(err.contains("Nothing was changed"), "{}", err);
        assert_eq!(names_in(&d), ["a.txt", "b.txt", "c.txt"], "a and b were put back");
        drop(_lock);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn undo_reports_what_it_cannot_restore() {
        let d = tmp_dir("undofail");
        fs::write(d.join("a.txt"), "x").unwrap();
        let res = apply_blocking(vec![pair(&d, "a.txt", "b.txt")]).unwrap();
        fs::write(d.join("a.txt"), "someone else's file").unwrap(); // original name taken again
        let undo = undo_blocking(res.ops.clone());
        assert_eq!(undo.restored, 0);
        assert_eq!(undo.failed.len(), 1);
        assert!(undo.failed[0].error.contains("in use"));
        assert_eq!(names_in(&d), ["a.txt", "b.txt"], "nothing was overwritten");
        fs::remove_dir_all(&d).unwrap();
    }
}
