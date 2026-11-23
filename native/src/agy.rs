//! The Antigravity cache stores only a TS-rendered frame, never its stdin.
use crate::{sha256, state};
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const LINE_LIMIT: usize = 16384;
const FRESH_MS: u64 = 1000;
const MAX_AGE_MS: u64 = 3000;
const SLOTS: u8 = 64;
struct Slot {
    path: PathBuf,
    key: String,
    stamp: String,
    uid: u32,
}

impl Slot {
    fn new(entry: &Path, caller: &str) -> Option<Self> {
        // Caller is PID:start_ticks from the agy ancestor, never from stdin.
        let home = state::home()?;
        let dir = home.join("display/statusline-agy-v1");
        state::no_links(&dir).ok()?;
        let meta = match fs::symlink_metadata(&dir) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(&dir)
                    .ok()?;
                fs::symlink_metadata(&dir).ok()?
            }
            Err(_) => return None,
        };
        let uid = state::own_uid()?;
        if !meta.is_dir() || meta.mode() & 0o7777 != 0o700 || meta.uid() != uid {
            return None;
        }
        let cwd = env::current_dir().ok()?;
        let mut id = caller.as_bytes().to_vec();
        id.push(0);
        id.extend_from_slice(cwd.as_os_str().as_bytes());
        id.push(0);
        let key = sha256::hex(&id);
        let index = u8::from_str_radix(&key[..2], 16).ok()? % SLOTS;

        let settings =
            env::var_os("HUD_SETTINGS_PATH").or_else(|| env::var_os("CODEX_HUD_SETTINGS_PATH"));
        let mut data = Vec::new();
        let mut field = |bytes: &[u8]| {
            data.extend_from_slice(bytes);
            data.push(0);
        };
        field(entry.as_os_str().as_bytes());
        for name in [
            "NO_COLOR",
            "COLORTERM",
            "HUD_THEME",
            "HUD_ICONS",
            "HUD_BAR_STYLE",
            "HUD_BAR_FIELDS",
            "CODEX_HUD_THEME",
            "CODEX_HUD_ICONS",
            "CODEX_HUD_BAR_STYLE",
            "CODEX_HUD_BAR_FIELDS",
            "COLUMNS",
            "HERDR_PANE_ID",
        ] {
            match env::var_os(name) {
                Some(val) => {
                    field(b"set");
                    field(val.as_bytes());
                }
                None => field(b"unset"),
            }
        }
        for path in [
            home.join("config.json"),
            settings
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("hud-settings.json")),
            entry.parent()?.parent()?.join("dist/cli/statusline.js"),
            env::current_exe().ok()?,
        ] {
            field(path.as_os_str().as_bytes());
            match fs::metadata(&path) {
                Ok(m) => field(
                    format!(
                        "{}:{}:{}:{}:{}:{}:{}:{}",
                        m.mode(),
                        m.dev(),
                        m.ino(),
                        m.size(),
                        m.mtime(),
                        m.mtime_nsec(),
                        m.ctime(),
                        m.ctime_nsec()
                    )
                    .as_bytes(),
                ),
                Err(e) if e.kind() == io::ErrorKind::NotFound => field(b"missing"),
                Err(_) => return None,
            }
        }
        Some(Self {
            path: dir.join(format!("{index:02x}")),
            key,
            stamp: sha256::hex(&data),
            uid,
        })
    }

    fn read(&self) -> Option<(String, u64)> {
        let (file, m) = state::regular(&self.path.with_extension("line"), true).ok()?;
        if m.uid() != self.uid
            || m.mode() & 0o7777 != 0o600
            || m.nlink() != 1
            || m.len() > LINE_LIMIT as u64
        {
            return None;
        }
        let mut bytes = String::new();
        file.take(LINE_LIMIT as u64 + 1)
            .read_to_string(&mut bytes)
            .ok()?;
        let (meta, raw) = bytes.split_once('\n')?;
        let mut fields = meta.split(' ');
        if fields.next()? != self.key || fields.next()? != self.stamp {
            return None;
        }
        let born = fields.next()?;
        if born.len() != 13 {
            return None;
        }
        let age = (state::now_ms() as u64).checked_sub(born.parse().ok()?)?;
        let line = raw.strip_suffix('\n')?;
        if age >= MAX_AGE_MS
            || line.is_empty()
            || raw.contains('\0')
            || bytes.len() > LINE_LIMIT
            || fields.next()? != sha256::hex(raw.as_bytes())
            || fields.next().is_some()
        {
            return None;
        }
        Some((line.to_owned(), age))
    }

    fn lock_file(&self) -> Option<File> {
        let f = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(0o400000 | 0o4000) // O_NOFOLLOW | O_NONBLOCK
            .open(self.path.with_extension("lock"))
            .ok()?;
        let m = f.metadata().ok()?;
        (m.is_file() && m.uid() == self.uid && m.mode() & 0o7777 == 0o600 && m.nlink() == 1)
            .then_some(f)
    }
    fn marker(&self) -> PathBuf {
        self.path.with_extension("refresh")
    }
    fn marked(&self) -> bool {
        fs::symlink_metadata(self.marker()).is_ok()
    }

    // Called only while holding the slot's exclusive flock. Fixed temp/marker names also bound crash debris.
    fn render(&self, entry: &Path) -> Option<String> {
        let marker = self.marker();
        let tmp = self.path.with_extension("tmp");
        let line = self.path.with_extension("line");
        let _ = fs::remove_file(&marker);
        private_file(&marker).ok()?;
        let output = Command::new("timeout")
            .args(["-k", ".2s", "2s", "node"])
            .arg(entry)
            .arg("--agy-cache-v1")
            .stdin(Stdio::inherit())
            .stderr(Stdio::null())
            .output();
        let fresh = output
            .as_ref()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| std::str::from_utf8(&o.stdout).ok())
            .map(|s| s.trim_end_matches('\n'))
            .filter(|s| !s.is_empty());
        let _ = fs::remove_file(&tmp);
        let frame = fresh.and_then(|s| s.strip_prefix("hud-statusline-v1:"));
        let stored = frame.filter(|s| !s.is_empty()).and_then(|s| {
            let raw = format!("{s}\n");
            let record = format!(
                "{} {} {} {}\n{raw}",
                self.key,
                self.stamp,
                state::now_ms() as u64,
                sha256::hex(raw.as_bytes())
            );
            if record.len() > LINE_LIMIT {
                return None;
            }
            private_file(&tmp).ok()?.write_all(record.as_bytes()).ok()?;
            fs::rename(&tmp, &line).ok()
        });
        if stored.is_none() {
            let _ = fs::remove_file(line);
        }
        let _ = fs::remove_file(tmp);
        let _ = fs::remove_file(marker);
        // Missing timeout: decline and replay through the launcher's plain agy-only TS path.
        output.as_ref().ok()?;
        Some(frame.or(fresh).unwrap_or("HUD unavailable").into())
    }
    fn prune(&self) {
        for i in 0..SLOTS {
            let path = self.path.with_file_name(format!("{i:02x}.line"));
            if fs::symlink_metadata(&path)
                .ok()
                .filter(|m| m.is_file())
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|d| d.as_secs() >= 120)
            {
                let _ = fs::remove_file(path);
            }
        }
    }
}
fn private_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

fn identity(pid: &str) -> Option<String> {
    if pid.starts_with('0') || !pid.bytes().all(|b| b.is_ascii_digit()) || pid.is_empty() {
        return None;
    }
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (name, fields) = stat.split_once(" (")?.1.rsplit_once(") ")?;
    let birth = fields.split_ascii_whitespace().nth(19)?;
    (matches!(name, "agy" | "antigravity") && birth.bytes().all(|b| b.is_ascii_digit()))
        .then(|| format!("{pid}:{birth}"))
}

// Only a complete frame authorizes us to drain stdin (fresh) or pass it to a detached refresh (stale).
pub fn hit(entry: &Path, pid: &str) -> Option<(String, bool)> {
    let caller = identity(pid)?;
    let slot = Slot::new(entry, &caller)?;
    let (frame, age) = slot.read()?;
    if slot.marked() {
        return None;
    }
    let fresh = age < FRESH_MS;
    if !fresh
        && !Command::new("setsid")
            .arg("-f")
            .arg(env::current_exe().ok()?)
            .arg("--agy-refresh-v1")
            .arg(entry)
            .args([&caller, &slot.stamp])
            .stdin(Stdio::inherit())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()?
            .success()
    {
        return None;
    }
    Some((frame, fresh))
}

pub fn serve(entry: &Path, pid: &str) -> Option<String> {
    let slot = Slot::new(entry, &identity(pid)?)?;
    let lock = slot.lock_file()?;
    let deadline = Instant::now() + Duration::from_millis(MAX_AGE_MS);
    let cached = slot.read();
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) => {
                if let Some((frame, _)) = cached {
                    return Some(frame);
                }
                if Instant::now() >= deadline {
                    return Some("HUD unavailable".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return None,
        }
    }
    if !slot.marked() {
        if let Some((line, 0..FRESH_MS)) = slot.read() {
            return Some(line);
        }
    }
    slot.prune();
    slot.render(entry)
}

pub fn refresh(entry: &Path, caller: &str, expected_stamp: &str) -> Option<()> {
    let slot = Slot::new(entry, caller)?;
    if slot.stamp != expected_stamp {
        return None;
    }
    let lock = slot.lock_file()?;
    lock.try_lock().ok()?;
    if !slot.marked() && matches!(slot.read(), Some((_, 0..FRESH_MS))) {
        return None;
    }
    slot.render(entry)?;
    Some(())
}

// Fresh hits and losing refresh workers still own the producer's pipe. Exit after 1 s even
// without EOF; the process drops the reader thread on exit. Renders use Node's bounded reader.
pub fn drain() {
    let (done, wait) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = io::copy(
            &mut io::stdin().take((crate::LIMIT + 1) as u64),
            &mut io::sink(),
        );
        let _ = done.send(());
    });
    let _ = wait.recv_timeout(Duration::from_secs(1));
}
