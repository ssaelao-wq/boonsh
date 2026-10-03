//! Search-box query language. Terms are separated by spaces and ALL must match (AND):
//!
//!   report                 name contains "report" (also wildcards: *.md, rep*t)
//!   "my file"              quoted = one term with spaces
//!   filename:<regex>       name matches a regular expression (case-insensitive)
//!   filesize:0-1M          size range, inclusive (B, K, M, G, T; 1K = 1024 bytes; decimals ok)
//!   filesize:1G+           at least; also  filesize:-10K  (at most), >1M, <100K, and exact  filesize:0
//!   type:folder size:>20G  with type:folder, size filters use each folder's total size (all files inside,
//!                          any depth). Without type:folder, size filters match files only.
//!   filetype:exe           extension; comma = OR (jpg,png); also folder, file, image, video, audio, doc, archive, code
//!   filedate:2026          modified (local time) in a year / year-month / exact day: 2026-07, 2026-07-06
//!   filedate:-07-06        any year, July 6;  -07- any July;  --06 any year/month, day 6
//!   filedate:2026-01..2026-03   range (either side may be empty);  today, yesterday, 7d (last 7 days)
//!   path:legal             the full path (folders above the item + its name) contains the text
//!   path:a,b  path:a, b    comma = OR (spaces around the comma are fine)
//!   path:a +b              + directly in front of a word = AND (x+y, x+ y, x + y are NOT and-operators)
//!   path:a, b +c           AND binds tighter than OR, ties go left to right: a OR (b AND c).
//!                          Parentheses group: path:(a, b) +c  or  path:a +(b, c)
//!   path:'legal'           quotes (' or ") = this exact text as whole folder/file names, not part of one.
//!                          Names with spaces need quotes. Text in quotes is literal; put * outside the
//!                          quotes: path:'my client'*  (starts with)   path:*'client'  (ends with)
//!   path:'client-xyz\invoices'  one text: those two names directly after each other, anywhere in the path
//!   input:.\client\ +.\docs, d:\work   where to search (default: the current folder). Folders or files.
//!                          Same operators as path: a comma is OR, " +" is AND, parentheses group. For places
//!                          AND means by file name: only names found on both sides are kept, with every copy
//!                          (the same name, not the same file). Relative paths start at the current folder;
//!                          names with spaces need quotes; input:{NAME} uses a Global Var (ignored, with a
//!                          notice, while it has no value).
//!   !term                  negate any term, e.g.  !filetype:tmp  or  !backup
//!
//!   input:.\client\ +.\docs, d:\work   where to search (default: the current folder). Folders or files.
//!                          A comma adds another place to the same group (OR). " +" starts another group (AND):
//!                          only file names found in every group are kept (the same name, not the same file).
//!                          Relative paths start at the current folder; names with spaces need quotes;
//!                          input:{NAME} uses a Global Var (ignored, with a notice, while it has no value).
//!
//! Short aliases: name:, size:, type:, ext:, date:. A filter with an empty value is ignored (still typing).
//! Lists may have spaces around their commas: "path:a, b", "type:jpg , png".

use crate::localtime;
use regex_lite::{Regex, RegexBuilder};

pub struct Query {
    terms: Vec<(bool, Filter)>, // (negated, filter)
    needs_date: bool,
    inputs: Option<Expr<InputSpec>>, // where to search (AND = same file names); None = the current folder
}

/// A `path:` / `input:` expression: AND binds tighter than OR, equal operators go left to right,
/// and parentheses group.
#[derive(Debug, Clone, PartialEq)]
pub enum Expr<T> {
    Leaf(T),
    And(Vec<Expr<T>>),
    Or(Vec<Expr<T>>),
}

/// One `input:` place: a path as typed (maybe relative), or a Global Var name like `{INPUT01}`.
#[derive(Debug, PartialEq)]
pub enum InputSpec {
    Path(String),
    Var(String), // UPPERCASE name without braces
}

enum Filter {
    Name(String),
    NameRegex(Regex),
    Size(u64, u64), // inclusive byte range, files only
    Type(Vec<TypeRule>),
    Date(DateRule),
    Path(Expr<PathNeedle>),
}

enum PathNeedle {
    /// Unquoted, no `*`: the path contains this text anywhere.
    Contains(String),
    /// Unquoted with `*`: the path contains text fitting this pattern (the `*` may cross folders).
    Pattern(Vec<Pat>),
    /// Quoted: whole folder/file names. One entry per `\`-separated name; `*` outside the quotes is a wildcard
    /// inside that name, so `'my client'*` also fits `my client 2026`.
    Names(Vec<Vec<Pat>>),
}

#[derive(Clone, PartialEq)]
enum Pat {
    Lit(char), // lowercase
    Star,
}

impl<T> Expr<T> {
    fn eval(&self, leaf: &dyn Fn(&T) -> bool) -> bool {
        match self {
            Expr::Leaf(t) => leaf(t),
            Expr::And(v) => v.iter().all(|e| e.eval(leaf)),
            Expr::Or(v) => v.iter().any(|e| e.eval(leaf)),
        }
    }
}

impl PathNeedle {
    fn matches(&self, hay: &str, segments: &[&str]) -> bool {
        match self {
            PathNeedle::Contains(t) => hay.contains(t.as_str()),
            PathNeedle::Pattern(p) => {
                let mut full = vec![Pat::Star];
                full.extend(p.iter().cloned());
                full.push(Pat::Star);
                glob_match(&full, hay)
            }
            PathNeedle::Names(names) => segments
                .windows(names.len())
                .any(|w| w.iter().zip(names).all(|(seg, pat)| glob_match(pat, seg))),
        }
    }
}

/// `Pat::Star` matches any run of characters (including none); a literal must match exactly.
fn glob_match(p: &[Pat], text: &str) -> bool {
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti, mut star, mut mark) = (0, 0, None::<usize>, 0);
    while ti < t.len() {
        if pi < p.len() && p[pi] == Pat::Star {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if pi < p.len() && p[pi] == Pat::Lit(t[ti]) {
            pi += 1;
            ti += 1;
        } else if let Some(sp) = star {
            pi = sp + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == Pat::Star {
        pi += 1;
    }
    pi == p.len()
}

enum TypeRule {
    Ext(String),
    Folder,
    File,
}

enum DateRule {
    Pattern { y: Option<i32>, m: Option<u32>, d: Option<u32> },
    Range { from: Option<(i32, u32, u32)>, to: Option<(i32, u32, u32)> },
}

/// The facts about one directory entry that filters look at.
pub struct Candidate<'a> {
    pub name: &'a str,
    /// Full path of the entry (its name included), as shown by Windows.
    pub path: &'a str,
    pub ext: &'a str, // lowercase, without dot
    pub is_dir: bool,
    pub size: u64,
    /// Folder total when computed (see `Query::wants_folder_sizes`); None = folder size unknown.
    pub folder_size: Option<u64>,
    pub modified_ts: u64,
}

impl Query {
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty() && self.inputs.is_none()
    }

    /// True when some term filters by name, size, path ...; `input:` alone is not a filter.
    pub fn has_terms(&self) -> bool {
        !self.terms.is_empty()
    }

    pub fn inputs(&self) -> Option<&Expr<InputSpec>> {
        self.inputs.as_ref()
    }

    /// `type:folder` + a size filter: folders are sized by the total of everything inside them.
    /// Only then do we pay for scanning whole folder trees; otherwise size filters match files only.
    pub fn wants_folder_sizes(&self) -> bool {
        let has_size = self.terms.iter().any(|(_, f)| matches!(f, Filter::Size(..)));
        let asks_folders = self.terms.iter().any(|(neg, f)| {
            !neg && matches!(f, Filter::Type(rules) if rules.iter().any(|r| matches!(r, TypeRule::Folder)))
        });
        has_size && asks_folders
    }

    pub fn matches(&self, c: &Candidate) -> bool {
        let date = if self.needs_date && c.modified_ts > 0 {
            Some(localtime::from_unix(c.modified_ts).ymd())
        } else {
            None
        };
        self.terms.iter().all(|(neg, f)| f.matches(c, date) != *neg)
    }
}

impl Filter {
    fn matches(&self, c: &Candidate, date: Option<(i32, u32, u32)>) -> bool {
        match self {
            Filter::Name(term) => crate::fs_ops::matches_search_query(c.name, term),
            Filter::NameRegex(re) => re.is_match(c.name),
            Filter::Path(expr) => {
                let hay = c.path.replace('/', "\\").to_lowercase();
                let segments: Vec<&str> = hay.split('\\').collect();
                expr.eval(&|n: &PathNeedle| n.matches(&hay, &segments))
            }
            Filter::Size(lo, hi) => {
                let size = if c.is_dir { c.folder_size } else { Some(c.size) };
                size.map_or(false, |s| s >= *lo && s <= *hi)
            }
            Filter::Type(rules) => rules.iter().any(|r| match r {
                TypeRule::Ext(e) => !c.is_dir && c.ext == e,
                TypeRule::Folder => c.is_dir,
                TypeRule::File => !c.is_dir,
            }),
            Filter::Date(rule) => match (rule, date) {
                (_, None) => false,
                (DateRule::Pattern { y, m, d }, Some((fy, fm, fd))) => {
                    y.map_or(true, |y| y == fy) && m.map_or(true, |m| m == fm) && d.map_or(true, |d| d == fd)
                }
                (DateRule::Range { from, to }, Some(fd)) => {
                    from.map_or(true, |f| fd >= f) && to.map_or(true, |t| fd <= t)
                }
            },
        }
    }
}

pub fn parse(input: &str) -> Result<Query, String> {
    let mut terms = Vec::new();
    let mut inputs: Option<Expr<InputSpec>> = None;
    let mut it = tokenize(input).into_iter().peekable();
    while let Some(raw) = it.next() {
        let (neg, mut token) = match raw.strip_prefix('!') {
            Some(rest) if !rest.is_empty() => (true, rest.to_string()),
            _ => (false, raw),
        };
        if token.starts_with('"') {
            token = token.replace('"', ""); // "filename:^my report": quotes around the whole term
        }
        if token == "+" {
            continue; // a lone + : still typing
        }
        let Some(colon) = token.find(':') else {
            terms.push((neg, Filter::Name(unquote(&token))));
            continue;
        };
        let key = token[..colon].to_lowercase();
        let is_path = key == "path" || key == "input"; // both take "+word" clauses and comma lists
        if is_path || matches!(key.as_str(), "filetype" | "type" | "ext") {
            // A list continues across spaces around its commas; path:/input: also take " +word" (AND) and
            // anything inside an open ( ... ).
            while let Some(next) = it.peek() {
                let open = is_path && scan_expr(&token[colon + 1..]).map_or(0, |r| r.1) > 0;
                if token.ends_with(',') || next.starts_with(',') || open {
                    if is_path {
                        token.push(' ');
                    }
                    token.push_str(&it.next().unwrap());
                } else if is_path && next == "+" {
                    it.next(); // lone + : still typing
                } else if is_path && next.starts_with('+') {
                    token.push(' ');
                    token.push_str(&it.next().unwrap());
                } else {
                    break;
                }
            }
        }
        let raw_value = token[colon + 1..].trim();
        let value = unquote(raw_value);
        let filter = match key.as_str() {
            "filename" | "name" | "filesize" | "size" | "filetype" | "type" | "ext" | "filedate" | "date" | "path" | "input"
                if value.is_empty() =>
            {
                continue; // still typing the value
            }
            "filename" | "name" => Filter::NameRegex(
                RegexBuilder::new(&value)
                    .case_insensitive(true)
                    .build()
                    .map_err(|e| format!("filename: invalid pattern \"{}\": {}", value, first_line(&e.to_string())))?,
            ),
            "filesize" | "size" => {
                let (lo, hi) = parse_size_range(&value)?;
                Filter::Size(lo, hi)
            }
            "filetype" | "type" | "ext" => Filter::Type(parse_types(&value)?),
            "filedate" | "date" => Filter::Date(parse_date(&value)?),
            "input" => {
                if neg {
                    return Err("input: tells where to search, so it can't be excluded with !".to_string());
                }
                if let Some(e) = parse_expr(raw_value, "input", &parse_input_item)? {
                    // another input: term is ANDed with the earlier ones, like several path: terms
                    inputs = Some(match inputs.take() {
                        None => e,
                        Some(prev) => Expr::And(vec![prev, e]),
                    });
                }
                continue;
            }
            "path" => {
                match parse_expr(raw_value, "path", &parse_needle)? {
                    Some(e) => Filter::Path(e),
                    None => continue, // only commas / plus signs so far
                }
            }
            _ => {
                return Err(format!(
                    "Unknown filter \"{}:\". Use filename:, filesize:, filetype:, filedate:, path: or input:",
                    &token[..colon]
                ))
            }
        };
        terms.push((neg, filter));
    }
    let needs_date = terms.iter().any(|(_, f)| matches!(f, Filter::Date(_)));
    Ok(Query { terms, needs_date, inputs })
}

/// A quote opens at the start of a piece (or after `: , + * \ /`), so an apostrophe inside a word is just a letter.
/// Double quotes open anywhere.
fn opens_quote(ch: char, prev: Option<char>) -> bool {
    ch == '"' || (ch == '\'' && prev.map_or(true, |p| matches!(p, ':' | ',' | '+' | '*' | '\\' | '/') || p.is_whitespace()))
}

/// Split on whitespace; quotes (" or ') group a value with spaces. The quotes are kept in the token.
fn tokenize(input: &str) -> Vec<String> {
    split_unquoted(input, |c| c.is_whitespace())
}

fn split_unquoted(input: &str, is_sep: impl Fn(char) -> bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for ch in input.chars() {
        if let Some(q) = quote {
            cur.push(ch);
            if ch == q {
                quote = None;
            }
        } else if is_sep(ch) {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        } else {
            if opens_quote(ch, cur.chars().last()) {
                quote = Some(ch);
            }
            cur.push(ch);
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Remove the quotes around a value: every " (as before), or a pair of ' wrapping the whole value.
fn unquote(s: &str) -> String {
    let s = s.replace('"', "");
    match s.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')) {
        Some(inner) if s.len() >= 2 => inner.to_string(),
        _ => s,
    }
}

#[derive(Debug, PartialEq)]
enum Tok {
    Item(String), // raw text, quotes still in
    Or,
    And,
    Open,
    Close,
}

/// Cut a `path:` / `input:` value into items and operators. Returns the tokens and how many ( are still open.
/// `+` is AND only when it starts a word (after a space, `,` or `(`) and a word follows it; `(` opens a group
/// only at the start of a word; `)` closes only while a group is open.
fn scan_expr(value: &str) -> Result<(Vec<Tok>, i32), String> {
    let chars: Vec<char> = value.chars().collect();
    let mut toks = Vec::new();
    let mut depth = 0i32;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        let prev = if i == 0 { None } else { Some(chars[i - 1]) };
        let word_start = prev.map_or(true, |p| p.is_whitespace() || matches!(p, ',' | '(' | '+'));
        if ch.is_whitespace() {
            i += 1;
        } else if ch == ',' {
            toks.push(Tok::Or);
            i += 1;
        } else if ch == '(' && word_start {
            toks.push(Tok::Open);
            depth += 1;
            i += 1;
        } else if ch == ')' && depth > 0 {
            toks.push(Tok::Close);
            depth -= 1;
            i += 1;
        } else if ch == '+' && prev.map_or(true, |p| p.is_whitespace() || matches!(p, ',' | '(')) {
            // a + that starts a word: AND when a word follows, otherwise (a lone +) it is still being typed
            let next = chars.get(i + 1);
            if next.map_or(false, |n| !n.is_whitespace() && *n != ',' && *n != ')') {
                toks.push(Tok::And);
            }
            i += 1;
        } else {
            let start = i;
            let mut quote: Option<char> = None;
            while i < chars.len() {
                let c = chars[i];
                if let Some(q) = quote {
                    if c == q {
                        quote = None;
                    }
                } else if c.is_whitespace() || c == ',' || (c == ')' && depth > 0) {
                    break;
                } else if opens_quote(c, if i == 0 { None } else { Some(chars[i - 1]) }) {
                    quote = Some(c);
                }
                i += 1;
            }
            if quote.is_some() {
                return Err(format!("a closing quote is missing in {}", chars[start..].iter().collect::<String>()));
            }
            toks.push(Tok::Item(chars[start..i].iter().collect()));
        }
    }
    Ok((toks, depth))
}

/// Parse `a, b +c`, `(a, b) +c` ... into an expression. `what` ("path" / "input") names the filter in errors.
/// Empty alternatives (`a,,b`, a trailing comma or +) are ignored so a half-typed query does not error.
fn parse_expr<T>(
    value: &str,
    what: &str,
    leaf: &dyn Fn(&str) -> Result<Option<T>, String>,
) -> Result<Option<Expr<T>>, String> {
    let (toks, depth) = scan_expr(value).map_err(|e| format!("{}: {}", what, e))?;
    if depth > 0 {
        return Err(format!("{}: a closing ) is missing", what));
    }
    let mut pos = 0;
    parse_or(&toks, &mut pos, what, leaf)
}

fn parse_or<T>(
    toks: &[Tok],
    pos: &mut usize,
    what: &str,
    leaf: &dyn Fn(&str) -> Result<Option<T>, String>,
) -> Result<Option<Expr<T>>, String> {
    let mut parts = Vec::new();
    loop {
        while matches!(toks.get(*pos), Some(Tok::Or)) {
            *pos += 1;
        }
        if matches!(toks.get(*pos), None | Some(Tok::Close)) {
            break;
        }
        if let Some(e) = parse_and(toks, pos, what, leaf)? {
            parts.push(e);
        }
        match toks.get(*pos) {
            None | Some(Tok::Close) => break,
            Some(Tok::Or) => {}
            Some(_) => {
                return Err(format!(
                    "{}: put a comma (OR) or + in front of the next word (AND) between words; names with spaces need quotes",
                    what
                ))
            }
        }
    }
    Ok(match parts.len() {
        0 => None,
        1 => parts.pop(),
        _ => Some(Expr::Or(parts)),
    })
}

fn parse_and<T>(
    toks: &[Tok],
    pos: &mut usize,
    what: &str,
    leaf: &dyn Fn(&str) -> Result<Option<T>, String>,
) -> Result<Option<Expr<T>>, String> {
    let mut parts = Vec::new();
    loop {
        while matches!(toks.get(*pos), Some(Tok::And)) {
            *pos += 1;
        }
        match toks.get(*pos) {
            Some(Tok::Item(text)) => {
                *pos += 1;
                if let Some(l) = leaf(text)? {
                    parts.push(Expr::Leaf(l));
                }
            }
            Some(Tok::Open) => {
                *pos += 1;
                let inner = parse_or(toks, pos, what, leaf)?;
                if !matches!(toks.get(*pos), Some(Tok::Close)) {
                    return Err(format!("{}: a closing ) is missing", what));
                }
                *pos += 1;
                if let Some(e) = inner {
                    parts.push(e);
                }
            }
            _ => break,
        }
        if !matches!(toks.get(*pos), Some(Tok::And)) {
            break;
        }
    }
    Ok(match parts.len() {
        0 => None,
        1 => parts.pop(),
        _ => Some(Expr::And(parts)),
    })
}

/// One `input:` place: a path (quotes removed), or `{NAME}` for a Global Var.
fn parse_input_item(item: &str) -> Result<Option<InputSpec>, String> {
    let mut text = String::new();
    let mut quote: Option<char> = None;
    let mut prev: Option<char> = None;
    for ch in item.trim().chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => text.push(ch),
            None if opens_quote(ch, prev) => quote = Some(ch),
            None => text.push(ch),
        }
        prev = Some(ch);
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(None);
    }
    let var = text
        .strip_prefix('{')
        .and_then(|r| r.strip_suffix('}'))
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    Ok(Some(match var {
        Some(name) => InputSpec::Var(name.to_uppercase()),
        None => InputSpec::Path(text),
    }))
}

/// Quoted text is literal. `*` outside quotes is a wildcard. Any quote makes it a whole-name match.
fn parse_needle(item: &str) -> Result<Option<PathNeedle>, String> {
    let mut pats: Vec<Pat> = Vec::new();
    let mut quote: Option<char> = None;
    let mut quoted_any = false;
    let mut prev: Option<char> = None;
    let push_lit = |pats: &mut Vec<Pat>, ch: char| {
        let ch = if ch == '/' { '\\' } else { ch };
        pats.extend(ch.to_lowercase().map(Pat::Lit));
    };
    for ch in item.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => push_lit(&mut pats, ch),
            None if opens_quote(ch, prev) => {
                quote = Some(ch);
                quoted_any = true;
            }
            None if ch == '*' => pats.push(Pat::Star),
            None => push_lit(&mut pats, ch),
        }
        prev = Some(ch);
    }
    if quote.is_some() {
        return Err(format!("path: a closing quote is missing in {}", item));
    }
    if !quoted_any {
        if pats.is_empty() {
            return Ok(None);
        }
        if pats.contains(&Pat::Star) {
            return Ok(Some(PathNeedle::Pattern(pats)));
        }
        let text: String = pats.iter().filter_map(|p| if let Pat::Lit(c) = p { Some(*c) } else { None }).collect();
        return Ok(Some(PathNeedle::Contains(text)));
    }
    while pats.first() == Some(&Pat::Lit('\\')) {
        pats.remove(0);
    }
    while pats.last() == Some(&Pat::Lit('\\')) {
        pats.pop();
    }
    if pats.is_empty() {
        return Ok(None);
    }
    let names: Vec<Vec<Pat>> = pats.split(|p| *p == Pat::Lit('\\')).map(|n| n.to_vec()).collect();
    Ok(Some(PathNeedle::Names(names)))
}

fn first_line(s: &str) -> &str {
    s.lines().find(|l| !l.trim().is_empty()).unwrap_or(s).trim()
}

// ---------- filesize ----------

fn parse_size(s: &str) -> Result<u64, String> {
    let s = s.trim();
    let split = s.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let n: f64 = num
        .parse()
        .map_err(|_| format!("filesize: \"{}\" is not a size. Examples: 500, 250K, 1.2M, 1G", s))?;
    let mult: u64 = match unit.trim().to_lowercase().as_str() {
        "" | "b" => 1,
        "k" | "kb" => 1 << 10,
        "m" | "mb" => 1 << 20,
        "g" | "gb" => 1 << 30,
        "t" | "tb" => 1 << 40,
        _ => return Err(format!("filesize: unknown unit \"{}\". Use B, K, M, G or T", unit.trim())),
    };
    Ok((n * mult as f64) as u64)
}

fn parse_size_range(v: &str) -> Result<(u64, u64), String> {
    let v = v.trim();
    let (lo, hi) = if let Some(r) = v.strip_suffix('+') {
        (parse_size(r)?, u64::MAX)
    } else if let Some(r) = v.strip_prefix(">=") {
        (parse_size(r)?, u64::MAX)
    } else if let Some(r) = v.strip_prefix('>') {
        (parse_size(r)?.saturating_add(1), u64::MAX)
    } else if let Some(r) = v.strip_prefix("<=") {
        (0, parse_size(r)?)
    } else if let Some(r) = v.strip_prefix('<') {
        (0, parse_size(r)?.saturating_sub(1))
    } else if let Some((a, b)) = v.split_once('-') {
        let lo = if a.trim().is_empty() { 0 } else { parse_size(a)? };
        let hi = if b.trim().is_empty() { u64::MAX } else { parse_size(b)? };
        (lo, hi)
    } else {
        let n = parse_size(v)?;
        (n, n)
    };
    if lo > hi {
        return Err(format!("filesize: range \"{}\" is backwards (min is larger than max)", v));
    }
    Ok((lo, hi))
}

// ---------- filetype ----------

fn parse_types(v: &str) -> Result<Vec<TypeRule>, String> {
    const GROUPS: &[(&str, &[&str])] = &[
        ("image", &["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tif", "tiff", "heic"]),
        ("video", &["mp4", "mkv", "avi", "mov", "wmv", "webm", "m4v", "flv"]),
        ("audio", &["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"]),
        ("doc", &["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "rtf", "odt", "csv"]),
        ("archive", &["zip", "7z", "rar", "tar", "gz", "bz2", "xz", "cab", "iso"]),
        ("code", &["rs", "js", "ts", "tsx", "jsx", "py", "ps1", "json", "toml", "yaml", "yml", "html", "css", "c", "cpp", "h", "cs", "java", "go", "sh", "bat"]),
    ];
    let mut rules = Vec::new();
    for part in v.split(',') {
        let p = part.trim().trim_start_matches('*').trim_start_matches('.').to_lowercase();
        if p.is_empty() {
            continue;
        }
        match p.as_str() {
            "folder" | "folders" | "dir" => rules.push(TypeRule::Folder),
            "file" | "files" => rules.push(TypeRule::File),
            _ => {
                let group = p.strip_suffix('s').unwrap_or(&p); // images -> image
                if let Some((_, exts)) = GROUPS.iter().find(|(g, _)| *g == p || *g == group) {
                    rules.extend(exts.iter().map(|e| TypeRule::Ext(e.to_string())));
                } else {
                    rules.push(TypeRule::Ext(p));
                }
            }
        }
    }
    if rules.is_empty() {
        return Err("filetype: give an extension like exe, or a list like jpg,png".to_string());
    }
    Ok(rules)
}

// ---------- filedate ----------

fn parse_date(v: &str) -> Result<DateRule, String> {
    let v = v.trim().to_lowercase();
    let today = localtime::today();
    let day_offset = |n: i64| {
        let (y, m, d) = today;
        localtime::civil_from_days(localtime::days_from_civil(y, m, d) - n)
    };

    match v.as_str() {
        "today" => return Ok(DateRule::Range { from: Some(today), to: Some(today) }),
        "yesterday" => {
            let y = day_offset(1);
            return Ok(DateRule::Range { from: Some(y), to: Some(y) });
        }
        _ => {}
    }
    // Relative: 7d = the last 7 days including today
    if let Some(n) = v.strip_suffix('d').and_then(|n| n.parse::<i64>().ok()) {
        if n < 1 {
            return Err("filedate: use 1d or more (e.g. 7d = last 7 days)".to_string());
        }
        return Ok(DateRule::Range { from: Some(day_offset(n - 1)), to: Some(today) });
    }
    // Range: 2026-01..2026-03 (either side optional)
    if let Some((a, b)) = v.split_once("..") {
        let from = if a.trim().is_empty() { None } else { Some(range_bound(a, false)?) };
        let to = if b.trim().is_empty() { None } else { Some(range_bound(b, true)?) };
        if let (Some(f), Some(t)) = (from, to) {
            if f > t {
                return Err(format!("filedate: range \"{}\" is backwards", v));
            }
        }
        return Ok(DateRule::Range { from, to });
    }

    let (y, m, d) = date_parts(&v)?;
    if y.is_none() && m.is_none() && d.is_none() {
        return Err(date_help(&v));
    }
    Ok(DateRule::Pattern { y, m, d })
}

/// "2026" / "2026-07" / "2026-07-06" / "-07-06" / "-07-" / "--06"  ->  (year, month, day), blanks = any
fn date_parts(v: &str) -> Result<(Option<i32>, Option<u32>, Option<u32>), String> {
    let parts: Vec<&str> = v.split('-').collect();
    if parts.len() > 3 {
        return Err(date_help(v));
    }
    let field = |i: usize, name: &str, max: u32| -> Result<Option<u32>, String> {
        match parts.get(i).map(|s| s.trim()) {
            None | Some("") => Ok(None),
            Some(s) => match s.parse::<u32>() {
                Ok(n) if (1..=max).contains(&n) && s.len() <= 2 => Ok(Some(n)),
                _ => Err(format!("filedate: \"{}\" is not a valid {} in \"{}\"", s, name, v)),
            },
        }
    };
    let year = match parts[0].trim() {
        "" => None,
        s if s.len() == 4 && s.chars().all(|c| c.is_ascii_digit()) => Some(s.parse::<i32>().unwrap()),
        _ => return Err(date_help(v)),
    };
    Ok((year, field(1, "month", 12)?, field(2, "day", 31)?))
}

/// A range side must include the year; a missing month/day means the start (or end) of that period.
fn range_bound(s: &str, is_end: bool) -> Result<(i32, u32, u32), String> {
    let (y, m, d) = date_parts(s.trim())?;
    let y = y.ok_or_else(|| format!("filedate: range side \"{}\" needs a year, e.g. 2026-01..2026-03", s.trim()))?;
    let m = m.unwrap_or(if is_end { 12 } else { 1 });
    let d = d.unwrap_or(if is_end { localtime::days_in_month(y, m) } else { 1 });
    Ok((y, m, d))
}

fn date_help(v: &str) -> String {
    format!(
        "filedate: can't read \"{}\". Examples: 2026, 2026-07, 2026-07-06, -07-06, -07-, --06, 2026-01..2026-03, 7d, today",
        v
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c<'a>(name: &'a str, ext: &'a str, is_dir: bool, size: u64, ymd: (i32, u32, u32)) -> Candidate<'a> {
        // noon UTC keeps the local date equal to ymd in any time zone within +-11h
        let ts = (localtime::days_from_civil(ymd.0, ymd.1, ymd.2) * 86_400 + 12 * 3600) as u64;
        Candidate { name, path: "", ext, is_dir, size, folder_size: None, modified_ts: ts }
    }
    fn at<'a>(path: &'a str, name: &'a str, is_dir: bool) -> Candidate<'a> {
        Candidate { name, path, ext: "", is_dir, size: 0, folder_size: None, modified_ts: 0 }
    }
    fn m(q: &str, cand: &Candidate) -> bool {
        parse(q).unwrap().matches(cand)
    }

    #[test]
    fn path_filter() {
        let a = at(r"D:\Clients\Client-XYZ\Invoices\Legal\inv-001.pdf", "inv-001.pdf", false);
        let b = at(r"D:\Clients\Client-XYZ\Invoices\other.pdf", "other.pdf", false);
        let d = at(r"D:\2026-Q4\invoices\legal", "legal", true);
        let il = at(r"D:\illegal\x.pdf", "x.pdf", false);
        assert!(m("path:legal", &a) && !m("path:legal", &b) && m("path:legal", &d)); // folder names count; case ignored
        assert!(m("path:legal", &il)); // unquoted = part of a name
        assert!(m("path:other.pdf", &b)); // the item's own name is part of the path
        assert!(m("path:client-xyz/invoices", &b)); // forward slashes are fine
        assert!(!m("!path:legal", &a) && m("!path:legal", &b));
        assert!(m("path:legal inv", &a) && m("path: ", &a) && m("path:+", &a)); // plain word still a name term; empty = ignored

        // OR: a comma, with or without spaces around it
        for q in ["path:legal,other", "path:legal, other", "path:legal ,other", "path:legal , other"] {
            assert!(m(q, &a) && m(q, &b), "{q}");
            assert!(!m(q, &at(r"D:\x\y.pdf", "y.pdf", false)), "{q}");
        }
        // AND: +word with a space in front
        assert!(m("path:client-xyz +legal", &a) && !m("path:client-xyz +legal", &b));
        assert!(m("path:client-xyz +invoices +legal", &a) && !m("path:client-xyz +invoices +legal", &b));
        assert!(m("path:legal +client-xyz", &a), "order does not matter");
        // AND binds tighter than OR; ties go left to right
        let x = at(r"D:\z\other.txt", "other.txt", false);
        assert!(m("path:legal,other +client-xyz", &d) && m("path:legal,other +client-xyz", &b)); // legal OR (other AND client-xyz)
        assert!(!m("path:legal,other +client-xyz", &x)); // other, but not client-xyz
        assert!(m("path:client-xyz +legal,other", &x) && m("path:client-xyz +legal,other", &a)); // (client-xyz AND legal) OR other
        assert!(!m("path:client-xyz +legal,other", &d)); // d has legal but not client-xyz, and no "other"
        assert!(m("path:a, b, c", &at(r"D:\c\f.txt", "f.txt", false)));
        // parentheses override that
        assert!(m("path:client-xyz +(legal,other)", &b) && !m("path:client-xyz +(legal,other)", &x));
        assert!(m("path:(legal,other) +client-xyz", &b) && !m("path:(legal,other) +client-xyz", &d) && !m("path:(legal,other) +client-xyz", &x));
        assert!(m("path:( legal , other ) +client-xyz", &b), "spaces inside parentheses are fine");
        assert!(m("path:client-xyz +(legal, other) inv", &a), "the query continues after the group");
        assert!(m("path:setup(1)", &at(r"D:\setup(1)\f.txt", "f.txt", false)), "( in the middle of a word is text");
        assert!(parse("path:(legal").is_err());

        // the four-file example in the manual (FEATURES_SPEC.md, "Combining words and places")
        let f: Vec<Candidate> = [
            r"D:\Clients\Acme\legal\a.pdf",
            r"D:\Clients\Xyz\contract\b.pdf",
            r"D:\Clients\client-xyz\contract\c.pdf",
            r"D:\Clients\client-xyz\invoices\d.pdf",
        ]
        .iter()
        .map(|p| at(p, p.rsplit('\\').next().unwrap(), false))
        .collect();
        let found = |q: &str| f.iter().enumerate().filter(|(_, c)| m(q, c)).map(|(i, _)| i + 1).collect::<Vec<_>>();
        assert_eq!(found("path:legal, contract +client-xyz"), vec![1, 3]);
        assert_eq!(found("path:(legal, contract) +client-xyz"), vec![3]);
        assert_eq!(found("path:client-xyz +legal, contract"), vec![2, 3]);
        assert!(m("!path:client-xyz +legal", &b) && !m("!path:client-xyz +legal", &a));
        // + that is not directly in front of a word is not AND
        let plus = at(r"D:\a+b\c.txt", "c.txt", false);
        assert!(m("path:a+b", &plus) && !m("path:a+b", &a)); // literal text
        assert!(!m("path:legal + client-xyz", &b)); // lone + is skipped, client-xyz is then a name term
        assert!(m("path:legal+ client-xyz", &at(r"D:\legal+\client-xyz.pdf", "client-xyz.pdf", false)));
        // quoted AND is literal text, not two conditions
        assert!(!m(r#"path:"client-xyz +legal""#, &a));
        // quotes: whole folder/file name, spaces allowed, * wildcard
        assert!(m("path:'legal'", &a) && m("path:'legal'", &d) && !m("path:'legal'", &il));
        assert!(m(r#"path:"legal""#, &a));
        assert!(m("path:'LEGAL'", &a));
        let sp = at(r"D:\My Client\Invoices\x.pdf", "x.pdf", false);
        assert!(m("path:'my client'", &sp) && m(r#"path:"my client""#, &sp) && !m("path:'my'", &sp));
        assert!(m("path:'my client' +invoices", &sp) && !m("path:'my client' +legal", &sp));
        // quoted text is literal; * goes outside the quotes
        assert!(m("path:'client-'*", &a) && m("path:*'-xyz'", &a) && m("path:'client'*'xyz'", &a) && !m("path:'xyz'", &a));
        assert!(!m("path:'client-*'", &a), "a * inside quotes is just a character");
        let mc = at(r"D:\My Client 2026\x.pdf", "x.pdf", false);
        assert!(m("path:'my client'*", &mc) && !m("path:'my client'", &mc) && m("path:*'client 2026'", &mc));
        assert!(m("path:'my client'*", &sp) && m("path:'my client'", &sp));
        assert!(m("path:cl*nt-xyz", &a) && !m("path:cl*nt-abc", &a)); // unquoted * is a wildcard too
        // 'client-xyz\invoices' is ONE text: those names directly after each other, anywhere in the path
        let q = "path:'client-xyz\\invoices'";
        assert!(m(q, &at(r"D:\client\client-xyz\invoices\a.pdf", "a.pdf", false)));
        assert!(m(q, &at(r"D:\documents\client-xyz\invoices\a.pdf", "a.pdf", false)));
        assert!(m(q, &at(r"D:\client-xyz\invoices\2026\a.pdf", "a.pdf", false)));
        assert!(!m(q, &at(r"D:\client\client-xyz\doc\invoices\a.pdf", "a.pdf", false)));
        assert!(!m(q, &at(r"D:\my-client-xyz\invoices\a.pdf", "a.pdf", false))); // starts at a name boundary
        assert!(m("path:'client-xyz/invoices'", &a) && m(r"path:'\legal\'", &a)); // / works; outer \ ignored
        assert!(m("path:'client-xyz\\inv'*", &a) && !m("path:'client-xyz\\inv'", &a));
        assert!(m("path:'x.pdf',nothing", &il)); // quoted and unquoted items mix in an OR list
        assert!(m("path:o'brien", &at(r"D:\o'brien\f.txt", "f.txt", false))); // apostrophe inside a word is a letter
        assert!(parse("path:'legal").is_err()); // missing closing quote
        // list joining also covers type:
        let t = Candidate { ext: "doc", ..at("x", "x.doc", false) };
        assert!(m("type:pdf, doc", &t) && m("type:pdf ,doc", &t));
        // quotes for other terms still work
        assert!(m(r#""my file""#, &at("x", "my file.txt", false)) && m("'my file'", &at("x", "my file.txt", false)));
    }

    #[test]
    fn input_places() {
        // shows the expression as text: (a AND b), (a OR b)
        fn show(e: &Expr<InputSpec>) -> String {
            let join = |v: &Vec<Expr<InputSpec>>, op: &str| format!("({})", v.iter().map(show).collect::<Vec<_>>().join(op));
            match e {
                Expr::Leaf(InputSpec::Path(p)) => p.clone(),
                Expr::Leaf(InputSpec::Var(n)) => format!("{{{}}}", n),
                Expr::And(v) => join(v, " AND "),
                Expr::Or(v) => join(v, " OR "),
            }
        }
        let inputs = |q: &str| parse(q).unwrap().inputs.as_ref().map(show).unwrap_or_default();
        assert_eq!(inputs(r"input:.\client\"), r".\client\");
        // the example from the manual: AND before OR
        assert_eq!(inputs(r"input:.\client\ +.\documents, d:\somboon-data\dev\"), r"((.\client\ AND .\documents) OR d:\somboon-data\dev\)");
        for q in ["input:a,b", "input:a, b", "input:a ,b", "input:a , b"] {
            assert_eq!(inputs(q), "(a OR b)", "{q}");
        }
        for q in ["input:a +b", "input:+a +b", "input:a input:b"] {
            assert_eq!(inputs(q), "(a AND b)", "{q}");
        }
        assert_eq!(inputs("input:a +b, c"), "((a AND b) OR c)");
        assert_eq!(inputs("input:a, b +c"), "(a OR (b AND c))");
        assert_eq!(inputs("input:a, b, c"), "(a OR b OR c)");
        assert_eq!(inputs("input:a +b +c, d, e +f"), "((a AND b AND c) OR d OR (e AND f))");
        // parentheses override the order
        assert_eq!(inputs("input:a +(b, c)"), "(a AND (b OR c))");
        assert_eq!(inputs("input:(a, b) +c"), "((a OR b) AND c)");
        assert_eq!(inputs("input:a +( b , c ) x.txt"), "(a AND (b OR c))");
        assert_eq!(inputs("input:((a))"), "a");
        assert_eq!(inputs(r#"input:'my client' +"d:\x y""#), r"(my client AND d:\x y)");
        assert_eq!(inputs("input:{INPUT01}, {other} x.txt"), "({INPUT01} OR {OTHER})");
        // input is not a filter: it does not hide anything by itself, and the rest of the query still parses
        let q = parse(r"input:.\x report path:legal").unwrap();
        assert_eq!(show(q.inputs.as_ref().unwrap()), r".\x");
        assert!(!q.is_empty() && parse("input:").unwrap().is_empty() && parse("input:+").unwrap().is_empty());
        assert!(!parse("input:a").unwrap().has_terms() && parse("input:a x").unwrap().has_terms());
        assert!(parse("!input:a").is_err() && parse("input:'a").is_err());
        assert!(parse("input:(a +b").is_err() && parse("input:a)").is_ok(), "an unopened ) is just text");
        assert!(parse("input:(a +").is_err(), "a group still open while typing is reported");
    }

    #[test]
    fn sizes() {
        let f = c("a.bin", "bin", false, 300 * 1024, (2026, 7, 6));
        assert!(m("filesize:250K-1.2M", &f));
        assert!(m("filesize:0-1M", &f));
        assert!(!m("filesize:800M-1G", &f));
        assert!(!m("filesize:1G+", &f));
        assert!(m("filesize:-300K", &f));
        assert!(m("size:>100K", &f));
        assert!(!m("filesize:<300K", &f));
        assert!(m("filesize:", &f)); // empty value ignored
        let empty = c("e.txt", "txt", false, 0, (2026, 7, 6));
        assert!(m("filesize:0", &empty) && !m("filesize:0", &f));
        let dir = c("folder", "", true, 0, (2026, 7, 6));
        assert!(!m("filesize:0-1G", &dir), "folders have no size");
        assert!(parse("filesize:2M-1M").is_err());
        assert!(parse("filesize:12Q").is_err());
    }

    #[test]
    fn folder_sizes() {
        assert!(parse("type:folder size:>20G").unwrap().wants_folder_sizes());
        assert!(parse("size:1G+ filetype:folder,exe").unwrap().wants_folder_sizes());
        assert!(!parse("size:>20G").unwrap().wants_folder_sizes(), "size alone = files only, no tree scan");
        assert!(!parse("type:folder").unwrap().wants_folder_sizes());
        assert!(!parse("!type:folder size:1G+").unwrap().wants_folder_sizes());

        let mut big = c("Videos", "", true, 0, (2026, 1, 1));
        big.folder_size = Some(25 << 30);
        let mut small = c("Docs", "", true, 0, (2026, 1, 1));
        small.folder_size = Some(3 << 30);
        assert!(m("type:folder size:>20G", &big) && !m("type:folder size:>20G", &small));
        assert!(m("type:folder size:1G-5G", &small));
        let file = c("movie.mkv", "mkv", false, 30 << 30, (2026, 1, 1));
        assert!(!m("type:folder size:>20G", &file), "files excluded by type:folder");
        assert!(m("type:folder,mkv size:>20G", &file), "OR list still matches files by their own size");
    }

    /// Every `filename:` sample in FEATURES_SPEC.md (section 7, "Regular expressions") is checked here.
    #[test]
    fn regex_samples() {
        const NAMES: &[&str] = &[
            "Report.pdf",
            "report_final.PDF",
            "inv-2026-001.pdf",
            "Invoice_2025.pdf",
            "IMG_0001.JPG",
            "IMG_0002.png",
            "photo.jpeg",
            "2026-07-06 notes.txt",
            "my report.txt",
            "cat.txt",
            "category.txt",
            "cat_1.txt",
            "backup.tmp",
            "setup.exe",
            "setup(1).exe",
            "README.md",
            "v1.2.3.zip",
            "café.txt",
            "Makefile",
        ];
        let run = |q: &str| -> Vec<&'static str> {
            let query = parse(q).unwrap_or_else(|e| panic!("{} should parse: {}", q, e));
            NAMES
                .iter()
                .copied()
                .filter(|n| {
                    let ext = std::path::Path::new(n).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                    query.matches(&c(n, &ext, false, 1, (2026, 7, 6)))
                })
                .collect()
        };

        assert_eq!(run("filename:^report"), ["Report.pdf", "report_final.PDF"]);
        assert_eq!(run("filename:\\.pdf$"), ["Report.pdf", "report_final.PDF", "inv-2026-001.pdf", "Invoice_2025.pdf"]);
        assert_eq!(run("filename:^inv.*\\.pdf$"), ["inv-2026-001.pdf", "Invoice_2025.pdf"]);
        assert_eq!(run("filename:^IMG_\\d{4}\\."), ["IMG_0001.JPG", "IMG_0002.png"]);
        assert_eq!(run("filename:\\.(jpg|jpeg|png)$"), ["IMG_0001.JPG", "IMG_0002.png", "photo.jpeg"]);
        assert_eq!(run("filename:^\\d{4}-\\d{2}-\\d{2}"), ["2026-07-06 notes.txt"]);
        assert_eq!(run("filename:\\bcat\\b"), ["cat.txt"], "word boundary: not category, not cat_1");
        assert_eq!(run("filename:(setup|install)"), ["setup.exe", "setup(1).exe"]);
        assert_eq!(run("filename:\\(\\d+\\)"), ["setup(1).exe"]);
        assert_eq!(run("filename:^v\\d+(\\.\\d+)+\\.zip$"), ["v1.2.3.zip"]);
        assert_eq!(run("filename:^[^.]+$"), ["Makefile"], "names without a dot");
        assert_eq!(run("filename:\\d{4}"), ["inv-2026-001.pdf", "Invoice_2025.pdf", "IMG_0001.JPG", "IMG_0002.png", "2026-07-06 notes.txt"]);
        assert_eq!(run("filename:^(?:cat|setup)"), ["cat.txt", "category.txt", "cat_1.txt", "setup.exe", "setup(1).exe"], "a colon inside the value is fine");

        // Case: insensitive by default, (?-i) switches it off
        assert_eq!(run("filename:(?-i)^Report"), ["Report.pdf"]);
        assert_eq!(run("filename:(?i)^report"), ["Report.pdf", "report_final.PDF"]);

        // Spaces in a pattern: quotes (around the value or the whole term) or \s
        assert_eq!(run("filename:\"^my report\""), ["my report.txt"]);
        assert_eq!(run("\"filename:^my report\""), ["my report.txt"]);
        assert_eq!(run("filename:^my\\sreport"), ["my report.txt"]);

        // Combining with other terms and with !
        assert_eq!(run("filename:^IMG filename:JPG$"), ["IMG_0001.JPG"], "two regex terms are ANDed");
        assert_eq!(run("!filename:^report").len(), NAMES.len() - 2);
        assert!(!run("!filename:^report").contains(&"Report.pdf"));
        assert_eq!(run("name:^v\\d"), ["v1.2.3.zip"], "name: is a short form of filename:");

        // Non-ASCII: literal text works; \w and case-insensitivity are ASCII only
        assert_eq!(run("filename:café"), ["café.txt"]);
        assert_eq!(run("filename:CAF"), ["café.txt"]);
        assert!(run("filename:CAFÉ").is_empty(), "case-insensitive matching is ASCII only");
        assert_eq!(run("filename:^\\w+\\.txt$"), ["cat.txt", "category.txt", "cat_1.txt"], "\\w is ASCII only, so café.txt is not matched");

        // Not supported by the regex engine: each gives an error instead of results
        for bad in ["filename:(?=x)", "filename:(?<!x)y", "filename:(a)\\1", "filename:\\p{L}", "filename:(", "filename:[", "filename:*abc"] {
            assert!(parse(bad).is_err(), "{} should be rejected", bad);
        }
    }

    #[test]
    fn types_and_names() {
        let exe = c("Setup.EXE", "exe", false, 10, (2026, 7, 6));
        let dir = c("tools", "", true, 0, (2026, 7, 6));
        assert!(m("filetype:exe", &exe) && m("type:.exe", &exe) && m("ext:*.exe", &exe));
        assert!(m("filetype:msi,exe", &exe) && !m("filetype:msi", &exe));
        assert!(m("filetype:folder", &dir) && !m("filetype:folder", &exe) && !m("filetype:exe", &dir));
        assert!(m("filetype:code", &c("main.rs", "rs", false, 1, (2026, 1, 1))));
        assert!(m("filetype:images", &c("p.PNG", "png", false, 1, (2026, 1, 1))));
        assert!(m("filename:^set.*\\.exe$", &exe), "regex is case-insensitive");
        assert!(!m("filename:^tool", &exe));
        assert!(m("setup", &exe) && m("set*", &exe) && m("*.exe", &exe));
        assert!(m("setup filetype:exe filesize:0-1K", &exe), "terms are ANDed");
        assert!(!m("setup filetype:msi", &exe));
        assert!(m("!filetype:tmp", &exe) && !m("!setup", &exe), "! negates");
        let spaced = c("my report.txt", "txt", false, 1, (2026, 1, 1));
        assert!(m("\"my report\"", &spaced) && !m("\"my notes\"", &spaced));
        assert!(parse("filename:(").is_err());
        assert!(parse("owner:bob").is_err());
    }

    #[test]
    fn dates() {
        let f = c("a.txt", "txt", false, 1, (2026, 7, 6));
        for q in ["filedate:2026", "filedate:2026-07", "filedate:2026-7", "filedate:2026-07-06", "filedate:-07-06", "filedate:-07-", "filedate:-07", "filedate:--06", "date:2026-06..2026-07", "filedate:2026-07-01..", "filedate:..2026"] {
            assert!(m(q, &f), "{} should match 2026-07-06", q);
        }
        for q in ["filedate:2025", "filedate:2026-08", "filedate:2026-07-05", "filedate:-08-06", "filedate:--07", "filedate:2026-01..2026-06", "filedate:2026-07-07.."] {
            assert!(!m(q, &f), "{} should not match 2026-07-06", q);
        }
        let (y, mo, d) = localtime::today();
        let now = c("n.txt", "txt", false, 1, (y, mo, d));
        assert!(m("filedate:today", &now) && m("filedate:7d", &now) && !m("filedate:yesterday", &now));
        for bad in ["filedate:26", "filedate:2026-13", "filedate:2026-07-32", "filedate:x", "filedate:2026-03..2026-01", "filedate:-07..2026"] {
            assert!(parse(bad).is_err(), "{} should be rejected", bad);
        }
        assert_eq!(localtime::civil_from_days(localtime::days_from_civil(2024, 2, 29)), (2024, 2, 29));
    }
}
