//! Linux/WSL guest metrics. Keep the sample and semantics in sync with collectors/local-load.ts.
use crate::state;
use std::{io::Read, path::Path};

const SAMPLE: &str = "display/cpu-sample.v1.json";
const MAX_AGE_MS: u64 = 30_000;
const LOW_RAM_FRACTION: f64 = 0.10;

struct Counters {
    busy: u64,
    idle: u64,
}
fn counters(line: &str) -> Option<Counters> {
    let mut fields = line.split_ascii_whitespace();
    if fields.next()? != "cpu" {
        return None;
    }
    let mut ticks = [0_u64; 8];
    for tick in &mut ticks {
        *tick = decimal(fields.next()?)?;
    }
    let [user, nice, system, idle, wait, irq, softirq, steal] = ticks;
    let busy = [user, nice, system, irq, softirq, steal]
        .into_iter()
        .try_fold(0_u64, u64::checked_add)?;
    let idle = idle.checked_add(wait)?;
    (busy.checked_add(idle)? <= (1 << 53) - 1).then_some(Counters { busy, idle })
}
fn decimal(token: &str) -> Option<u64> {
    token.bytes().all(|b| b.is_ascii_digit()).then_some(())?;
    token.parse::<u64>().ok().filter(|n| *n <= (1 << 53) - 1)
}
fn proc_text(root: &Path, name: &str, limit: usize, first_line: bool) -> Option<String> {
    let (file, _) = state::regular(&root.join(name), true).ok()?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes).ok()?;
    if first_line {
        bytes.truncate(limit);
        bytes.truncate(bytes.iter().position(|&b| b == b'\n')?);
    } else if bytes.len() > limit {
        return None;
    }
    String::from_utf8(bytes).ok()
}
fn sample_cpu(file: &Path, boot: &str, current: Counters, at: u64) -> Option<u64> {
    let previous = state::read(file, 256, false, true).flatten();
    let previous = previous
        .as_ref()
        .filter(|p| p.get("boot").str() == Some(boot));
    let before = previous.and_then(|p| p.get("at").count());
    if before == Some(at) {
        return None;
    }
    let _ = state::write(
        file,
        &format!(
            "{{\"boot\":{},\"at\":{at},\"busy\":{},\"idle\":{}}}\n",
            crate::json::quoted(boot),
            current.busy,
            current.idle,
        ),
    );
    let age = at.checked_sub(before?)?;
    if age > MAX_AGE_MS {
        return None;
    }
    let previous = previous?;
    let busy = current.busy.checked_sub(previous.get("busy").count()?)?;
    let idle = current.idle.checked_sub(previous.get("idle").count()?)?;
    let total = busy + idle;
    (total > 0).then(|| (busy as f64 / total as f64 * 100.).round() as u64)
}
struct Memory {
    used: u64,
    total: u64,
}
impl Memory {
    fn text(&self) -> String {
        let gib = |kib: u64| (kib as f64 / 1048576. * 10.).round() / 10.;
        format!("{:.1}/{:.1} GiB", gib(self.used), gib(self.total))
    }
}
pub struct LocalLoad {
    scope: &'static str,
    cpu: Option<u64>,
    ram: Option<Memory>,
    swap: Option<Memory>,
}
impl LocalLoad {
    pub fn forms(&self) -> Vec<String> {
        let short = self.text(false);
        if self.swap.is_some() {
            vec![self.text(true), short]
        } else {
            vec![short]
        }
    }
    fn text(&self, show_swap: bool) -> String {
        let mut values = vec![];
        if let Some(cpu) = self.cpu {
            values.push(format!("CPU {cpu}%"));
        }
        if let Some(ram) = &self.ram {
            values.push(format!("RAM {}", ram.text()));
        }
        if let Some(swap) = self.swap.as_ref().filter(|_| show_swap) {
            values.push(format!("swap {}", swap.text()));
        }
        format!("{}: {}", self.scope, values.join(" "))
    }
}
pub fn collect(home: &Path, now: f64) -> Option<LocalLoad> {
    let root = state::env("HUD_STATUSLINE_PROC_ROOT").unwrap_or_else(|| "/proc".into());
    let root = Path::new(&root);
    if !root.is_absolute() || !cfg!(target_os = "linux") {
        return None;
    }
    let release = proc_text(root, "sys/kernel/osrelease", 256, false)?
        .trim()
        .to_ascii_lowercase();
    if release.is_empty() {
        return None;
    }
    let scope = if release.contains("microsoft")
        || release.contains("wsl")
        || state::env("WSL_INTEROP").is_some_and(|s| !s.is_empty())
    {
        "WSL"
    } else {
        "Linux"
    };
    let cpu = (|| {
        let boot = proc_text(root, "sys/kernel/random/boot_id", 64, false)?;
        let boot = boot.trim();
        if boot.is_empty() {
            return None;
        }
        let ticks = counters(&proc_text(root, "stat", 512, true)?)?;
        sample_cpu(&home.join(SAMPLE), boot, ticks, now as u64)
    })();
    let memory = proc_text(root, "meminfo", 8192, false).unwrap_or_default();
    let kib = |key: &str| {
        let mut values = memory
            .lines()
            .find_map(|line| line.strip_prefix(key))?
            .split_ascii_whitespace();
        let n = decimal(values.next()?)?;
        (values.next() == Some("kB") && values.next().is_none()).then_some(n)
    };
    let ram = (|| {
        let total = kib("MemTotal:").filter(|&x| x > 0)?;
        let available = kib("MemAvailable:")?;
        Some(Memory {
            used: total.checked_sub(available)?,
            total,
        })
    })();
    let swap = (|| {
        let ram = ram.as_ref()?;
        if (ram.total - ram.used) as f64 / ram.total as f64 >= LOW_RAM_FRACTION {
            return None;
        }
        let total = kib("SwapTotal:")?;
        let used = total.checked_sub(kib("SwapFree:")?)?;
        (used > 0).then_some(Memory { used, total })
    })();
    (cpu.is_some() || ram.is_some()).then_some(LocalLoad {
        scope,
        cpu,
        ram,
        swap,
    })
}
