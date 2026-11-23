//! Compact Claude bar. Keep the forms, roles and fitting order in sync with render/layout/bar-fields.ts.
use crate::{
    config::{Display, Policy},
    json::{self, Value},
    quota::WINDOWS,
    state::{self, Workers},
};

const RESET: &str = "\x1b[0m";
#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Plain,
    Dim,
    Value,
    Name,
    Project,
    Branch,
    Ok,
    Warn,
    Bad,
    Info,
    Usage,
    High,
    Count,
    Lead,
    Alert,
}
use Role::*;
struct Piece {
    text: String,
    role: Role,
    meter: bool,
}
type Form = Vec<Piece>;
fn piece(text: impl Into<String>, role: Role) -> Piece {
    Piece {
        text: text.into(),
        role,
        meter: false,
    }
}
fn cells(percent: f64, role: Role) -> Form {
    let filled = ((percent / 100.) * 10.).round() as usize;
    let mut form = vec![
        piece("█".repeat(filled), role),
        piece("░".repeat(10 - filled), Dim),
        piece(" ", Plain),
    ];
    for p in &mut form {
        p.meter = true;
    }
    form
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Model,
    Context,
    Project,
    Quota,
    Tps,
    Notice,
    Loaded,
}
struct Segment {
    field: Field,
    forms: Vec<Form>,
    ink: (u8, u8),
    mark: Option<u8>,
    at: usize,
}
impl Segment {
    fn new(field: Field, ink: (u8, u8), forms: Vec<Form>) -> Self {
        Self {
            field,
            ink,
            forms,
            mark: None,
            at: 0,
        }
    }
    fn parts(&self, capsules: bool) -> impl Iterator<Item = &Piece> {
        self.forms
            .get(self.at)
            .into_iter()
            .flatten()
            .filter(move |p| !capsules || !p.meter)
    }
    fn size(&self, capsules: bool) -> usize {
        self.parts(capsules).map(|p| visual_width(&p.text)).sum()
    }
    fn alive(&self, capsules: bool) -> bool {
        self.parts(capsules).any(|p| !p.text.is_empty())
    }
}
struct Window {
    label: &'static str,
    percent: f64,
    reset: String,
}

pub fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' |
        '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn safe(v: &Value, limit: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in v.str().unwrap_or_default().chars() {
        units += c.len_utf16();
        if units > limit {
            if c.len_utf16() == 2 && units == limit + 1 {
                out.push('\u{fffd}');
            }
            break;
        }
        match c {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\0'..='\u{1f}' | '\u{7f}'..='\u{9f}' => out.push_str(&format!("\\x{:02x}", c as u32)),
            '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' => {
                out.push_str(&format!("\\u{:04x}", c as u32))
            }
            _ => out.push(c),
        }
    }
    out.trim_matches(js_whitespace).to_owned()
}
fn width_of(c: char) -> usize {
    match c as u32 {
        0x0300..=0x036f | 0x200b..=0x200f | 0x20d0..=0x20f0 | 0xfe00..=0xfe0f | 0xfeff => 0,
        0x1100..=0x115f
        | 0x26a1
        | 0x2e80..=0x303e
        | 0x3041..=0x33ff
        | 0x3400..=0x4dbf
        | 0x4e00..=0x9fff
        | 0xa000..=0xa4cf
        | 0xa960..=0xa97f
        | 0xac00..=0xd7a3
        | 0xf900..=0xfaff
        | 0xfe10..=0xfe19
        | 0xfe30..=0xfe6f
        | 0xff00..=0xff60
        | 0xffe0..=0xffe6
        | 0x1f300..=0x1f64f
        | 0x1f900..=0x1f9ff
        | 0x20000..=0x2fffd
        | 0x30000..=0x3fffd => 2,
        _ => 1,
    }
}
fn tokens(mut s: &str) -> impl Iterator<Item = (&str, usize)> {
    std::iter::from_fn(move || {
        let head = s.chars().next()?;
        let (bytes, width) = if s.starts_with("\x1b[") {
            (s[2..].find('m')? + 3, 0)
        } else {
            (head.len_utf8(), width_of(head))
        };
        let (part, rest) = s.split_at(bytes);
        s = rest;
        Some((part, width))
    })
}
fn visual_width(s: &str) -> usize {
    tokens(s).map(|(_, n)| n).sum()
}
fn truncate(s: &str, width: usize) -> String {
    if visual_width(s) <= width {
        return s.into();
    }
    let limit = width.saturating_sub(1);
    let (mut used, mut end, mut ansi) = (0, 0, false);
    for (token, size) in tokens(s) {
        if used >= limit || used + size > limit {
            break;
        }
        ansi |= token.starts_with('\x1b');
        end += token.len();
        used += size;
    }
    format!("{}…{}", &s[..end], if ansi { RESET } else { "" })
}
pub fn unavailable(width: usize) -> String {
    truncate("HUD unavailable", width)
}

fn fg(n: u8) -> String {
    format!("\x1b[38;5;{n}m")
}
fn bg(n: u8) -> String {
    format!("\x1b[48;5;{n}m")
}
fn sgr(code: &str, s: &str) -> String {
    format!("\x1b[{code}m{s}{RESET}")
}
fn rgb(hex: u32) -> String {
    format!("{};{};{}", hex >> 16, hex >> 8 & 255, hex & 255)
}
/// The bar's role inks are the `palette.ts` roles, not part of the fact-building code.
fn paint(role: Role, s: &str, theme: &str, mark: Option<u8>) -> String {
    if theme == "none" || role == Plain {
        return s.into();
    }
    match role {
        Lead => return mark.map_or_else(|| s.into(), |n| format!("{}{s}{RESET}", fg(n))),
        Count => return sgr("1", s),
        Usage => return sgr("94", s),
        High => return sgr("95", s),
        _ => {}
    }
    let (palette, bold, badge) = match theme {
        "titanium" => (
            [
                0x9ca3b0, 0xe8ecf4, 0xd4c090, 0xe8ecf4, 0xd06fed, 0x00ff88, 0xffb347, 0xff4757,
                0x00b4ff,
            ],
            true,
            0x0f0f11,
        ),
        "mocha" => (
            [
                0x9399b2, 0xcdd6f4, 0xcba6f7, 0xb4befe, 0xf5c2e7, 0xa6e3a1, 0xf9e2af, 0xf38ba8,
                0x89dceb,
            ],
            false,
            0x11111b,
        ),
        "latte" => (
            [
                0x6c6f85, 0x4c4f69, 0x8839ef, 0x7287fd, 0xea76cb, 0x40a02b, 0xdf8e1d, 0xd20f39,
                0x04a5e5,
            ],
            false,
            0xeff1f5,
        ),
        "arctic" => (
            [
                0xaab5c9, 0xd8dee9, 0xcda7c6, 0xd8dee9, 0x81a1c1, 0xa3be8c, 0xebcb8b, 0xee9aa2,
                0x8fbcbb,
            ],
            true,
            0x2a303b,
        ),
        "ember" => (
            [
                0xb8a892, 0xebdbb2, 0xe19baf, 0xebdbb2, 0xd8bc8c, 0x9ccb5d, 0xfabd2f, 0xff7e6e,
                0x7acbc0,
            ],
            true,
            0x1d2021,
        ),
        "contrast" => (
            [
                0xbdc1c9, 0xffffff, 0xd7a8ff, 0xffffff, 0xff8ad8, 0x5cff8a, 0xffd633, 0xff7b7b,
                0x4de8f5,
            ],
            true,
            0x050505,
        ),
        "paper" => (
            [
                0x594e3c, 0x3b342b, 0x5b3590, 0x3b342b, 0x8a3f7a, 0x25591a, 0x7a4600, 0xa21f18,
                0x08566a,
            ],
            true,
            0xffffff,
        ),
        _ => {
            return sgr(
                match role {
                    Dim => "2",
                    Value => "39",
                    Name => "96",
                    Project => "1",
                    Branch => "35",
                    Ok => "32",
                    Warn => "33",
                    Bad => "31",
                    Info => "36",
                    Alert => "1;7;31",
                    _ => unreachable!(),
                },
                s,
            )
        }
    };
    if role == Alert {
        return sgr(
            &format!("1;48;2;{};38;2;{}", rgb(palette[7]), rgb(badge)),
            s,
        );
    }
    let color = palette[role as usize - 1];
    sgr(
        &format!(
            "{}38;2;{}",
            if bold && role == Project { "1;" } else { "" },
            rgb(color)
        ),
        s,
    )
}

pub fn without_tag(s: &str) -> &str {
    let Some(end) = s.strip_suffix(']') else {
        return s;
    };
    end.rsplit(']')
        .next()
        .and_then(|tail| tail.find('[').map(|i| &end[..end.len() - tail.len() + i]))
        .unwrap_or(s)
}
fn short_model(s: &str) -> String {
    let name = without_tag(s);
    let mut slug = name.rsplit('/').next().unwrap_or(name);
    let lower = slug.to_ascii_lowercase();
    if lower.starts_with("anthropic.") {
        slug = &slug[10..];
    } else if lower
        .as_bytes()
        .get(..3)
        .is_some_and(|b| b[0].is_ascii_lowercase() && b[1].is_ascii_lowercase() && b[2] == b'.')
        && lower.get(3..).is_some_and(|s| s.starts_with("anthropic."))
    {
        slug = &slug[13..];
    }
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    if let Some((head, tail)) = slug.rsplit_once("-v") {
        if tail
            .split_once(':')
            .is_some_and(|(a, b)| digits(a) && digits(b))
        {
            slug = head;
        }
    }
    if let Some((head, tag)) = slug.rsplit_once('-') {
        if (4..=8).contains(&tag.len()) && digits(tag) {
            slug = head;
        }
    }
    while let Some((word, rest)) = slug.split_once('-') {
        if ![
            "claude",
            "gpt",
            "zai",
            "glm",
            "gemini",
            "deepseek",
            "openai",
            "anthropic",
            "mistral",
        ]
        .iter()
        .any(|w| word.eq_ignore_ascii_case(w))
        {
            break;
        }
        slug = rest;
    }
    if slug.is_empty() {
        return s.into();
    }
    let mut out = String::new();
    // The match consumes the second run of digits, as JS's global regexp does.
    let mut chars = slug.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(c);
        if c.is_ascii_digit() && chars.peek() == Some(&'-') {
            let mut scan = chars.clone();
            scan.next();
            let digits: String = scan.by_ref().take_while(char::is_ascii_digit).collect();
            let mut tail = chars.clone();
            tail.next();
            for _ in 0..digits.len() {
                tail.next();
            }
            if !digits.is_empty() && matches!(tail.peek(), None | Some('-')) {
                out.push('.');
                out.push_str(&digits);
                chars = tail;
            }
        }
    }
    out
}
fn provider(id: &str, ascii: bool) -> Option<(&'static str, Option<u8>)> {
    let id = id.to_lowercase();
    let has = |tokens: &[&str]| tokens.iter().any(|t| id.contains(t));
    let (glyph, text, color) = if has(&["gpt", "o1-", "o3-", "o4-"])
        || ["o1", "o3", "o4"].iter().any(|t| id.ends_with(t))
    {
        ("◎", "OAI", Some(79))
    } else if has(&["claude", "sonnet", "haiku", "opus", "fable"]) {
        ("✻", "Ant", Some(173))
    } else if has(&["deepseek"]) {
        ("≋", "DS", Some(69))
    } else if has(&["glm"]) {
        ("ℤ", "GLM", None)
    } else if has(&["gemini"]) {
        ("▲", "Gem", Some(111))
    } else if has(&["grok"]) {
        ("⊘", "xAI", Some(245))
    } else {
        return None;
    };
    Some((if ascii { text } else { glyph }, color))
}
fn model(input: &Value, t: &Value, policy: &Policy, ascii: bool) -> Segment {
    let m = input.get("model");
    let id = safe(m.get("id"), 512);
    let mut name = if id.is_empty() {
        safe(m.get("display_name"), 512)
    } else {
        short_model(&id)
    };
    if name.is_empty() {
        name = "Unknown".into();
    }
    let vendor = provider(if id.is_empty() { &name } else { &id }, ascii);
    let mut full = vec![];
    let mut short = vec![];
    for form in [&mut full, &mut short] {
        if let Some((glyph, _)) = vendor {
            form.push(piece(format!("{glyph} "), Lead));
        }
        form.push(piece(&name, Name));
    }
    if policy.effort {
        let effort = input.get("effort");
        let effort = safe(
            if effort.str().is_some() {
                effort
            } else {
                effort.get("level")
            },
            64,
        )
        .to_lowercase();
        if !effort.is_empty() {
            let effort = if t.get("ultracode").bool() == Some(true) {
                format!("ultracode({effort})")
            } else {
                effort
            };
            full.extend([piece(" ", Plain), piece(effort, Dim)]);
        }
    }
    let mut seg = Segment::new(Field::Model, (7, 232), vec![full, short]);
    seg.mark = vendor.and_then(|(_, c)| c);
    seg
}
fn fixed_tenth(n: f64) -> String {
    // JS toFixed chooses the greater neighbour for an exact half, not ties-to-even.
    if n % 0.5 == 0.25 {
        format!("{:.1}", (n * 10.).ceil() / 10.)
    } else if n >= 1e21 {
        json::number(n)
    } else {
        format!("{n:.1}")
    }
}
fn token_count(v: f64) -> String {
    let (n, unit) = if v >= 1e6 {
        (v / 1e6, "M")
    } else if v >= 1e3 {
        (v / 1e3, "K")
    } else {
        return json::number(v);
    };
    let text = fixed_tenth(n);
    format!("{}{unit}", text.strip_suffix(".0").unwrap_or(&text))
}
fn nonnegative(v: &Value) -> f64 {
    v.num().filter(|v| v.is_finite() && *v >= 0.).unwrap_or(0.)
}
fn percent(v: &Value) -> Option<f64> {
    v.num()
        .filter(|v| v.is_finite())
        .map(|p| p.clamp(0., 100.).round())
}
fn context(c: &Value, compact: f64) -> Segment {
    let size = nonnegative(c.get("context_window_size"));
    let p = c.get("used_percentage");
    let u = c.get("current_usage");
    let mut p = if p.num().is_some_and(|p| p > 0. && p.is_finite()) {
        percent(p).unwrap()
    } else if size > 0. {
        let ratio = (nonnegative(u.get("input_tokens"))
            + nonnegative(u.get("cache_creation_input_tokens"))
            + nonnegative(u.get("cache_read_input_tokens")))
            / size;
        ((ratio + 0.225 * ((ratio - 0.05) / 0.45).clamp(0., 1.)) * 100.)
            .round()
            .min(100.)
    } else {
        0.
    };
    let size = if compact > 0. && compact < size {
        p = (p * size / compact).round().min(100.);
        compact
    } else {
        size
    };
    let (role, bg) = if p >= 85. {
        (Bad, 204)
    } else if p >= 70. {
        (Warn, 179)
    } else {
        (Ok, 116)
    };
    let shown = format!("{}%", p as u32);
    let numbers = || {
        let mut parts = vec![piece(&shown, role)];
        if size > 0. {
            parts.push(piece(format!("/{}", token_count(size)), Dim));
        }
        parts
    };
    let mut full = cells(p, role);
    full.extend(numbers());
    Segment::new(
        Field::Context,
        (bg, 235),
        vec![full, numbers(), vec![piece(shown, role)]],
    )
}
fn project(input: &Value, git: &Value, policy: &Policy) -> Option<Segment> {
    let cwd = safe(input.get("cwd"), 512);
    let name = cwd
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or(if cwd.starts_with('/') { "/" } else { "" });
    if name.is_empty() {
        return None;
    }
    let branch = safe(git.get("branch"), 512);
    let dirty = policy.dirty && git.get("dirty").bool() == Some(true);
    let marker = if dirty { "*" } else { "" };
    let sync = if policy.sync {
        [("ahead", "↑"), ("behind", "↓")]
            .into_iter()
            .filter_map(|(key, arrow)| {
                let n = git.get(key).count()?;
                (n > 0).then(|| format!("{arrow}{n}"))
            })
            .collect::<String>()
    } else {
        String::new()
    };
    let name = || vec![piece(name, Project)];
    let with_branch = |marks: &str| {
        let mut out = name();
        if !branch.is_empty() {
            out.extend([piece(" ", Plain), piece(format!("{branch}{marks}"), Branch)]);
        }
        out
    };
    Some(Segment::new(
        Field::Project,
        (if dirty { 179 } else { 110 }, 235),
        vec![
            with_branch(&format!("{marker}{sync}")),
            with_branch(marker),
            name(),
        ],
    ))
}
fn span(minutes: f64) -> String {
    let d = (minutes / 1440.).floor();
    let h = (minutes / 60.).floor() % 24.;
    let m = minutes % 60.;
    if d > 0. {
        format!(
            "{}d{}",
            json::number(d),
            if h != 0. {
                format!("{h}h")
            } else {
                String::new()
            }
        )
    } else if h > 0. {
        format!(
            "{h}h{}",
            if m != 0. {
                format!("{m}m")
            } else {
                String::new()
            }
        )
    } else {
        format!("{m}m")
    }
}
fn quota(input: &Value, now: f64) -> Option<Segment> {
    let id = safe(input.get("model").get("id"), 512);
    if state::env("CLAUDE_CODE_USE_BEDROCK").as_deref() == Some("1")
        || id.to_lowercase().contains("anthropic.claude-")
    {
        return None;
    }
    let mut lead: Option<Window> = None;
    for (key, label) in WINDOWS {
        let w = input.get("rate_limits").get(key);
        let Some(percent) = percent(w.get("used_percentage")) else {
            continue;
        };
        if lead.as_ref().is_some_and(|w| w.percent >= percent) {
            continue;
        }
        let ends = nonnegative(w.get("resets_at")) * 1000.;
        let reset = if ends > now {
            format!(" ({})", span(((ends - now) / 60000.).ceil()))
        } else {
            String::new()
        };
        lead = Some(Window {
            label,
            percent,
            reset,
        });
    }
    let Window {
        label,
        percent,
        reset,
    } = lead?;
    let (role, ink) = if percent >= 90. {
        (Bad, 204)
    } else if percent >= 75. {
        (High, 179)
    } else {
        (Usage, 152)
    };
    let form = |meter, with_reset| {
        let mut f = vec![piece(label, Dim), piece(" ", Plain)];
        if meter {
            f.extend(cells(percent, role));
        }
        f.push(piece(format!("{}%", percent as u32), role));
        if with_reset && !reset.is_empty() {
            f.push(piece(&reset, ValueRole));
        }
        f
    };
    Some(Segment::new(
        Field::Quota,
        (ink, 235),
        vec![form(true, true), form(false, true), form(false, false)],
    ))
}
fn roster(workers: Workers, display: &Display) -> Option<Segment> {
    // The same table as `ROLE_GLYPHS` in src/render/model-glyphs.ts; the Nerd glyphs are Font Awesome's, in the BMP.
    let glyphs = if display.ascii {
        ["I", "F", "G", "O", "R", ".", "*"]
    } else if display.nerd {
        [
            "\u{F0AD}", "\u{F1FC}", "\u{F013}", "\u{F0EB}", "\u{F002}", "•", "\u{F0E7}",
        ]
    } else {
        ["⚒", "✎", "✦", "◈", "⚖", "•", "⚡"]
    };
    let mut form = vec![];
    for (i, n) in workers.counts.into_iter().enumerate() {
        if n == 0 {
            continue;
        }
        if !form.is_empty() {
            form.push(piece("  ", Plain));
        }
        form.push(piece(glyphs[i], if i == 6 { Warn } else { Info }));
        form.push(piece(n.to_string(), Count));
    }
    if form.is_empty() {
        return None;
    }
    if workers.asking > 0 {
        let pad = !display.capsules && display.theme != "none";
        form.extend([
            piece("  ", Plain),
            piece(
                if pad {
                    format!(" !{} ", workers.asking)
                } else {
                    format!("!{}", workers.asking)
                },
                if pad { Alert } else { Warn },
            ),
        ]);
    }
    Some(Segment::new(Field::Notice, (110, 235), vec![form]))
}

// JS's `toPrecision(1)` is used only for tiny, positive transcript rates.
fn tps_number(n: f64) -> String {
    if n >= 0.05 {
        return fixed_tenth(n);
    }
    let text = format!("{n:.0e}");
    let (digits, exp) = text.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    if exp < -6 {
        return text;
    }
    format!("0.{}{digits}", "0".repeat((-1 - exp) as usize))
}

use Role::Value as ValueRole;
pub struct Evidence<'a> {
    pub context: &'a Value,
    pub compact: f64,
    pub git: &'a Value,
    pub transcript: &'a Value,
    pub workers: Workers,
    pub mcp: u64,
}
pub fn bar(
    input: &Value,
    e: Evidence,
    policy: &Policy,
    display: &Display,
    now: f64,
    width: usize,
) -> Option<String> {
    let t = e.transcript;
    let visible_notice = display.fields[5];
    // Recent detailed events use the reference renderer (locale sorting and word wrapping). Silent/expired events
    // do not prevent the compact snapshot, vitals, transcript TPS and loaded counts from taking the fast path.
    let recent = |v: &Value| v.num().is_some_and(|at| now - at < 180_000.);
    if visible_notice
        && ((policy.agents
            && t.get("agents").list().is_some_and(|a| {
                a.iter().any(|a| {
                    a.get("startPos").num().is_some_and(|p| p >= 0.)
                        && (recent(a.get("start")) || recent(a.get("end")))
                })
            }))
            || (policy.skills
                && t.get("skills")
                    .list()
                    .is_some_and(|s| s.iter().any(|s| recent(s.get("at"))))))
    {
        return None;
    }
    // Reset timestamps outside JavaScript's Date range are not part of Claude's native protocol.
    if WINDOWS.iter().any(|(key, _)| {
        input
            .get("rate_limits")
            .get(key)
            .get("resets_at")
            .num()
            .is_some_and(|n| n > 8.64e12)
    }) {
        return None;
    }
    let rate = t.get("speed").get("response").get("tps");
    if rate != &Value::Null && rate.num().is_none() {
        return None;
    }
    let mut list: Vec<_> = [
        Some(model(input, t, policy, display.ascii)),
        Some(context(e.context, e.compact)),
        project(input, e.git, policy),
        quota(input, now),
        rate.num().filter(|v| v.is_finite() && *v > 0.).map(|n| {
            Segment::new(
                Field::Tps,
                (110, 235),
                vec![vec![piece(format!("~{} t/s", tps_number(n)), ValueRole)]],
            )
        }),
        roster(e.workers, display),
        None,
    ]
    .into_iter()
    .zip(display.fields)
    .filter_map(|(seg, on)| if on { seg } else { None })
    .collect();
    if display.fields[6] {
        let skills = if policy.skills {
            t.get("skills").list().map_or(0, |s| s.len() as u64)
        } else {
            0
        };
        let loaded = || {
            let mut form = vec![];
            for (label, n) in [("MCP", e.mcp), ("skills", skills)] {
                if n == 0 {
                    continue;
                }
                if !form.is_empty() {
                    form.push(piece("  ", Plain));
                }
                form.extend([
                    piece(label, Dim),
                    piece(" ", Plain),
                    piece(n.to_string(), ValueRole),
                ]);
            }
            form
        };
        if e.mcp > 0 || skills > 0 {
            list.push(Segment::new(
                Field::Loaded,
                (250, 235),
                vec![loaded(), loaded()],
            ));
        }
    }
    Some(fit(list, display, width))
}

fn fit(mut list: Vec<Segment>, display: &Display, width: usize) -> String {
    use Field::*;
    let cap = display.capsules;
    let arrow = usize::from(cap && !display.ascii);
    let total = |list: &[Segment]| {
        let mut len = 0;
        let mut n: usize = 0;
        for seg in list.iter().filter(|s| s.alive(cap)) {
            len += seg.size(cap);
            if cap {
                len += 2 + arrow + usize::from(n > 0 && seg.field == Loaded);
            }
            n += 1;
        }
        len + if cap { 0 } else { 3 * n.saturating_sub(1) }
    };
    let mut ladder = [
        Some(Loaded),
        Some(Loaded),
        None,
        Some(Quota),
        Some(Project),
        Some(Tps),
        Some(Model),
        Some(Context),
        Some(Project),
        Some(Quota),
        Some(Project),
        Some(Context),
    ]
    .into_iter();
    let roster = list.iter().any(|s| s.field == Notice);
    while total(&list) > width {
        match ladder.next() {
            Some(Some(id)) => {
                if let Some(s) = list
                    .iter_mut()
                    .find(|s| s.field == id && s.at < s.forms.len())
                {
                    s.at = if id == Loaded && roster {
                        s.forms.len()
                    } else {
                        s.at + 1
                    };
                }
            }
            Some(None) => {
                for s in &mut list {
                    if matches!(s.field, Context | Quota) && s.at == 0 {
                        s.at = 1;
                    }
                }
            }
            None => break,
        }
    }
    let draw = |seg: &Segment| {
        seg.parts(cap)
            .map(|p| {
                if !cap {
                    paint(p.role, &p.text, &display.theme, seg.mark)
                } else if p.role == Lead && seg.mark.is_some() {
                    format!("{}{}{}", fg(seg.mark.unwrap()), p.text, fg(seg.ink.1))
                } else {
                    p.text.clone()
                }
            })
            .collect::<String>()
    };
    let mut before = None;
    let mut out = String::new();
    for seg in list.iter().filter(|s| s.alive(cap) && s.field != Loaded) {
        if cap {
            let back = seg.ink.0 + u8::from(before == Some(seg.ink.0));
            if let Some(old) = before.filter(|_| arrow != 0) {
                out.push_str(&format!("{}{}\u{e0b0}", bg(back), fg(old)));
            }
            before = Some(back);
            out.push_str(&format!(
                "{}{} {} {RESET}",
                bg(back),
                fg(seg.ink.1),
                draw(seg)
            ));
        } else {
            if !out.is_empty() {
                out.push_str(&paint(Dim, " │ ", &display.theme, None));
            }
            out.push_str(&draw(seg));
        }
    }
    if let Some(old) = before.filter(|_| arrow != 0) {
        out.push_str(&format!("{}\u{e0b0}{RESET}", fg(old)));
    }
    if let Some(tail) = list.iter().find(|s| s.field == Loaded && s.alive(cap)) {
        let overhead = if cap { 2 + arrow } else { 0 };
        out.push_str(
            &" ".repeat(width.saturating_sub(visual_width(&out) + tail.size(cap) + overhead)),
        );
        if cap {
            if arrow != 0 {
                out.push_str(&format!("{}\u{e0b2}", fg(tail.ink.0)));
            }
            out.push_str(&format!(
                "{}{} {} {RESET}",
                bg(tail.ink.0),
                fg(tail.ink.1),
                draw(tail)
            ));
        } else {
            out.push_str(&draw(tail));
        }
    }
    if visual_width(&out) > width {
        out = truncate(&out, width) + RESET;
    }
    format!("{RESET}{out}")
}
