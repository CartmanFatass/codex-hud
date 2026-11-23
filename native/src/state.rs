//! Read the existing TypeScript file protocols. None of these readers refreshes stale evidence.
use crate::{
    json::{self, Value},
    sha256,
};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}
pub fn hud_env(key: &str) -> Option<String> {
    env(key).or_else(|| env(&format!("CODEX_{key}")))
}
pub fn home() -> Option<PathBuf> {
    let path = env("HUD_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| Some(PathBuf::from(env("HOME").filter(|v| !v.is_empty())?).join(".hud")))?;
    path.is_absolute().then_some(path)
}
pub fn claude_home() -> Option<PathBuf> {
    env("CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| Some(PathBuf::from(env("HOME")?).join(".claude")))
}
pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}
fn bad() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "unsupported statusline state")
}
pub fn no_links(path: &Path) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(bad());
    }
    for component in path.ancestors() {
        match fs::symlink_metadata(component) {
            Ok(m) if m.file_type().is_symlink() => return Err(bad()),
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
fn regular(path: &Path, no_follow: bool) -> io::Result<(File, Metadata)> {
    // Linux O_NONBLOCK plus optional O_NOFOLLOW; do not hang on a FIFO even during a replacement.
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(0o4000 | if no_follow { 0o400000 } else { 0 })
        .open(path)?;
    let m = file.metadata()?;
    if !m.is_file() {
        return Err(bad());
    }
    Ok((file, m))
}
fn bytes(path: &Path, limit: usize, private: bool, no_follow: bool) -> io::Result<Vec<u8>> {
    if no_follow {
        no_links(path)?;
    }
    let (file, m) = regular(path, no_follow)?;
    if m.len() > limit as u64 {
        return Err(bad());
    }
    if private && (m.mode() & 0o077 != 0 || m.nlink() != 1 || Some(m.uid()) != own_uid()) {
        return Err(bad());
    }
    let mut out = Vec::with_capacity(m.len() as usize);
    file.take(limit as u64 + 1).read_to_end(&mut out)?;
    if out.len() > limit {
        return Err(bad());
    }
    Ok(out)
}
fn own_uid() -> Option<u32> {
    let text = fs::read_to_string("/proc/self/status").ok()?;
    text.lines()
        .find_map(|l| l.strip_prefix("Uid:"))?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}
pub fn read(path: &Path, limit: usize, private: bool, no_follow: bool) -> Option<Option<Value>> {
    match bytes(path, limit, private, no_follow) {
        Ok(data) => Some(Some(json::parse(&data).ok()?)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Some(None),
        Err(_) => None,
    }
}
pub fn cache_path(home: &Path, kind: &str, key: &str) -> PathBuf {
    home.join("display/statusline")
        .join(format!("{kind}-{}.json", sha256::hex(key.as_bytes())))
}
pub fn cache(home: &Path, kind: &str, key: &str) -> Option<Value> {
    let path = cache_path(home, kind, key);
    // A large or cold cache is uncommon. Keep the one-shot process bounded and let TS handle it.
    let v = read(&path, 131_072, true, true)??;
    (v.get("version").num() == Some(1.)).then_some(v)
}
pub fn write(path: &Path, data: &str) -> io::Result<()> {
    use std::{
        io::Write,
        os::unix::fs::{DirBuilderExt, PermissionsExt},
    };
    no_links(path)?;
    fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(path.parent().ok_or_else(bad)?)?;
    no_links(path)?;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = path.with_extension(format!("json.{}.{unique}.tmp", std::process::id()));
    let mut fd = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    let result = fd
        .set_permissions(fs::Permissions::from_mode(0o600))
        .and_then(|()| fd.write_all(data.as_bytes()))
        .and_then(|()| fs::rename(&temp, path));
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub fn mtime(m: &Metadata) -> f64 {
    millis(m.mtime(), m.mtime_nsec())
}
fn millis(sec: i64, ns: i64) -> f64 {
    sec as f64 * 1000. + ns as f64 / 1_000_000.
}
fn matches_stamp(path: &Path, stamp: &str) -> bool {
    let Ok(m) = fs::metadata(path) else {
        return stamp == "-";
    };
    let mut parts = stamp.split(':');
    let mut integer = || parts.next()?.parse::<u64>().ok();
    if integer() != Some(m.dev()) || integer() != Some(m.ino()) || integer() != Some(m.len()) {
        return false;
    }
    let mut decimal = || parts.next()?.parse::<f64>().ok();
    decimal() == Some(mtime(&m))
        && decimal() == Some(millis(m.ctime(), m.ctime_nsec()))
        && parts.next().is_none()
}
fn fresh_stamps(v: &Value) -> Option<()> {
    let stamps = v.obj()?;
    if stamps.len() > 80 {
        return None;
    }
    for (path, sig) in stamps {
        if !matches_stamp(Path::new(path), sig.str()?) {
            return None;
        }
    }
    Some(())
}
pub fn git(home: &Path, cwd: Option<&str>, now: f64) -> Option<Value> {
    let Some(cwd) = cwd.filter(|p| !p.is_empty()) else {
        return Some(Value::Null);
    };
    let path = Path::new(cwd);
    if let Some(v) = cache(home, "git", cwd) {
        let age = now - v.get("at").num()?;
        if (0. ..2000.).contains(&age) && fresh_stamps(v.get("stamps")).is_some() {
            let value = v.field("value")?;
            if value != &Value::Null {
                value.get("branch").str()?;
                value.get("dirty").bool()?;
                value.get("ahead").count()?;
                value.get("behind").count()?;
            }
            return Some(value.clone());
        }
        return None;
    }
    // Fail closed for uncertain Git discovery (symlinks, bare repos, a missing working directory).
    // A cold repo always goes to TS, the only path that runs Git under its safe config.
    no_links(path).ok()?;
    if !path.is_dir() || path.ancestors().count() > 64 {
        return None;
    }
    for parent in path.ancestors() {
        for probe in [".git", "HEAD"] {
            match fs::symlink_metadata(parent.join(probe)) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                _ => return None,
            }
        }
    }
    Some(Value::Null)
}

pub fn config_count(home: &Path, cwd: Option<&str>) -> Option<u64> {
    let user = env("HOME").unwrap_or_default();
    let claude = claude_home()?;
    let key = format!(
        "[{},{},{}]",
        json::quoted(&user),
        json::quoted(claude.to_str()?),
        cwd.map(json::quoted).unwrap_or_else(|| "null".into())
    );
    let v = cache(home, "config", &key)?;
    fresh_stamps(v.get("stamps"))?;
    v.get("counts").get("mcpCount").count()
}

pub struct Transcript {
    pub value: Value,
    pub identity: String,
}
pub fn transcript(home: &Path, path: Option<&str>) -> Option<Transcript> {
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        return Some(Transcript {
            value: Value::Null,
            identity: String::new(),
        });
    };
    let file = Path::new(path);
    no_links(file).ok()?;
    let (_, m) = regular(file, true).ok()?;
    // First observation, rewrites, appends and backfill are owned by the TS reducer.
    let identity = format!("{}:{}", m.dev(), m.ino());
    let birth = m.created().ok()?.duration_since(UNIX_EPOCH).ok()?;
    let birth = millis(birth.as_secs() as i64, birth.subsec_nanos() as i64);
    let v = cache(home, "transcript", path)?;
    let (disk_id, disk_birth) = v.get("identity").str()?.rsplit_once(':')?;
    if disk_id != identity
        || disk_birth.parse().ok() != Some(birth)
        || v.get("mtime").num() != Some(mtime(&m))
        || v.get("size").count() != Some(m.len())
        || v.get("offset").count() != Some(m.len())
        || v.get("backfill").count() != Some(0)
    {
        return None;
    }
    v.get("speed").obj()?;
    for key in ["results", "agents", "todos", "tasks", "skills"] {
        v.get(key).list()?;
    }
    v.get("ultracode").bool()?;
    Some(Transcript { value: v, identity })
}

#[derive(Default)]
pub struct Workers {
    pub counts: [u64; 7],
    pub asking: u64,
}
pub const ROLES: [&str; 7] = [
    "imp",
    "frontend-imp",
    "general",
    "oracle",
    "reviewer",
    "other",
    "sonic",
];
fn workers(v: &Value) -> Option<Workers> {
    let running = v.get("running").count()?;
    let asking = v.get("asking").count()?;
    if asking > running {
        return None;
    }
    let roles = v.get("roles").obj()?;
    if roles.len() > 33 {
        return None;
    }
    let mut result = Workers::default();
    for (role, c) in roles {
        if role.is_empty() {
            return None;
        }
        let n = c.get("running").count()?;
        let waiting = c.get("asking").count()?;
        if waiting > n {
            return None;
        }
        let role = role
            .trim_matches(crate::render::js_whitespace)
            .to_lowercase();
        result.counts[ROLES.iter().position(|r| *r == role).unwrap_or(5)] += n;
        result.asking += waiting;
    }
    (running == result.counts.iter().sum() && asking == result.asking).then_some(result)
}
fn pane_id(pane: &str) -> bool {
    !pane.is_empty()
        && !pane
            .chars()
            .any(|c| matches!(c, '\0'..='\u{1f}' | '\u{7f}'..='\u{9f}'))
}
pub fn work(home: &Path, now: f64) -> Option<Workers> {
    let snapshot = read(
        &home.join("display/work-summary.v1.json"),
        65_536,
        true,
        true,
    )??;
    let pid = snapshot
        .get("pid")
        .count()
        .filter(|n| (1..=i32::MAX as u64).contains(n))?;
    let at = snapshot.get("observed_at").num()?;
    let producer = snapshot.get("producer").str()?;
    let watching = snapshot.get("watching").bool()?;
    if snapshot.get("version").num() != Some(1.)
        || snapshot.get("complete").bool() != Some(true)
        || snapshot.get("generation").count()? == 0
        || !(at > 0. && at <= now + 5_000.)
    {
        return None;
    }
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let mut fields = stat.rsplit_once(") ")?.1.split_whitespace();
    if matches!(fields.next()?, "Z" | "X" | "x") {
        return None;
    }
    let start = fields.nth(18)?;
    match snapshot.field("pid_start")? {
        Value::Null => {}
        Value::Str(s) if s == start => {}
        _ => return None,
    }
    match producer {
        "hud-watch" => {
            let raw = bytes(&home.join("watch.pid"), 64, false, true).ok()?;
            if std::str::from_utf8(&raw).ok()?.trim().parse::<u64>().ok()? != pid
                || (!watching && now - at > 5_000.)
            {
                return None;
            }
        }
        "hud-mcp" if now - at <= 5_000. => {}
        _ => return None,
    }
    workers(snapshot.get("global"))?;
    let panes = snapshot.get("panes").obj()?;
    if panes.len() > 128 {
        return None;
    }
    let pane = env("HERDR_PANE_ID");
    if pane.as_deref().is_some_and(|p| !pane_id(p)) {
        return None;
    }
    let mut found = Workers::default();
    for (id, scope) in panes {
        if !pane_id(id) {
            return None;
        }
        let counts = workers(scope)?;
        if pane.as_ref() == Some(id) {
            found = counts;
        }
    }
    // A Claude bar is pane-local, including when it has no pane.
    (found.counts.iter().sum::<u64>() <= 4096).then_some(found)
}
