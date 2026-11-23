mod agy;
mod config;
mod json;
mod quota;
mod render;
mod sha256;
mod state;

use config::{Display, Policy};
use json::Value;
use std::{
    io::{self, Read, Write},
    path::Path,
    process::ExitCode,
};

const LIMIT: usize = 64 * 1024;
fn supported_path(v: &Value) -> Option<&str> {
    v.str().filter(|s| s.encode_utf16().count() <= 4096)
}
fn compact_window(input: &Value) -> Option<f64> {
    let path = state::claude_home()?.join("settings.json");
    let Some(v) = state::read(&path, 131_072, false, false)? else {
        return Some(0.);
    };
    let id = input.get("model").get("id").str().unwrap_or_default();
    let own = v
        .get("modelSettings")
        .get(render::without_tag(id))
        .get("autoCompactWindow");
    let win = if own == &Value::Null {
        v.get("autoCompactWindow")
    } else {
        own
    };
    Some(if v.get("autoCompactEnabled").bool() == Some(false) {
        0.
    } else {
        win.num().filter(|n| *n > 0.).unwrap_or(0.)
    })
}

fn context(
    input: &Value,
    file: Option<&str>,
    transcript: &state::Transcript,
    home: &Path,
    now: f64,
) -> Option<(Value, Option<String>)> {
    let c = input.get("context_window");
    let Some(file) = file.filter(|p| !p.is_empty() && c.obj().is_some_and(|o| !o.is_empty()))
    else {
        return Some((c.clone(), None));
    };
    let age_at = |v: &Value| v.get("at").num().unwrap_or(f64::NAN);
    let prev = state::cache(home, "context", file).unwrap_or(Value::Null);
    let usage = c.get("current_usage");
    let total: f64 = [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .into_iter()
    .map(|k| usage.get(k).num().unwrap_or(0.))
    .sum();
    let used = c.get("used_percentage").num();
    if used == Some(0.) && total == 0. {
        if transcript
            .value
            .get("compactAt")
            .num()
            .is_some_and(|at| at > prev.get("at").num().unwrap_or(0.))
        {
            if let (Some(size), Some(tokens)) = (
                c.get("context_window_size").num().filter(|n| *n > 0.),
                transcript
                    .value
                    .get("compactPostTokens")
                    .num()
                    .filter(|n| *n != 0.),
            ) {
                let mut updated = c.obj()?.clone();
                updated.insert(
                    "used_percentage".into(),
                    Value::Num((tokens / size * 100.).round().min(100.)),
                );
                return Some((Value::Obj(updated), None));
            }
        } else if prev.get("identity").str() == Some(&transcript.identity)
            && (0. ..=300_000.).contains(&(now - age_at(&prev)))
        {
            let mut updated = prev.get("context").obj()?.clone();
            let size = c.get("context_window_size");
            if size != &Value::Null {
                updated.insert("context_window_size".into(), size.clone());
            }
            return Some((Value::Obj(updated), None));
        }
        return None; // The reference path decides how to handle a zero reading without fresh context evidence.
    } else if used.is_some_and(|p| p > 0.)
        && (prev == Value::Null || now - age_at(&prev) > 30_000. || prev.get("context") != c)
    {
        let bytes = format!(
            "{{\"version\":1,\"at\":{now},\"identity\":{},\"context\":{}}}\n",
            json::quoted(&transcript.identity),
            json::stringify(c)
        );
        return Some((c.clone(), Some(bytes)));
    }
    Some((c.clone(), None))
}
fn is_claude(v: &Value) -> bool {
    (v.field("product").is_none()
        || matches!(v.get("product").str(), Some("claude" | "claude-code")))
        && ([
            "model",
            "context_window",
            "cost",
            "rate_limits",
            "workspace",
        ]
        .into_iter()
        .any(|k| v.get(k).obj().is_some_and(|o| !o.is_empty()))
            || v.get("cwd").str().is_some()
            || v.get("transcript_path").str().is_some())
}

fn execute(args: &[String], bytes: &[u8]) -> Option<String> {
    let home = state::home()?;
    let policy = Policy::load(&home)?;
    let width = policy.width(args)?;
    let now = state::now_ms();
    let workers = state::work(&home, now)?;
    if bytes.len() > LIMIT {
        return Some(render::unavailable(width));
    }
    let mut value = match json::parse(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes)) {
        Ok(v) => v,
        Err(json::Error::Invalid) => return Some(render::unavailable(width)),
        Err(json::Error::Unsupported) => return None,
    };
    if value.get("product").str() == Some("antigravity") {
        return None;
    }
    if !is_claude(&value) {
        return Some(render::unavailable(width));
    }
    // Only a configured TS forwarder sees the original bytes; it independently suppresses email.
    if let Value::Obj(ref mut input) = value {
        input.remove("email");
    }
    let display = Display::load(&home)?;
    let file = supported_path(value.get("transcript_path"));
    let cwd = supported_path(value.get("cwd"));
    let transcript = state::transcript(&home, file)?;
    let (context, write_context) = context(&value, file, &transcript, &home, now)?;
    let git = if policy.git {
        state::git(&home, cwd, now)?
    } else {
        Value::Null
    };
    let mcp = if policy.config_counts {
        state::config_count(&home, cwd)?
    } else {
        0
    };
    let compact = compact_window(&value)?;
    let out = render::bar(
        &value,
        render::Evidence {
            context: &context,
            compact,
            git: &git,
            transcript: &transcript.value,
            workers,
            mcp,
        },
        &policy,
        &display,
        now,
        width,
    )?;
    if let (Some(file), Some(data)) = (file, write_context) {
        let _ = state::write(&state::cache_path(&home, "context", file), &data);
    }
    quota::publish(&value, &home, now);
    Some(out)
}
fn main() -> ExitCode {
    let mut args: Vec<_> = std::env::args().skip(1).collect();
    match args.as_slice() {
        // Keep the probe flag so an older binary also leaves stdin alone on a miss.
        [flag, entry, caller] if flag == "--agy-lookup-v1" => {
            let Some((mut line, fresh)) = agy::hit(Path::new(entry), caller) else {
                return ExitCode::from(75);
            };
            line.push('\n');
            let _ = io::stdout().lock().write_all(line.as_bytes());
            if fresh {
                agy::drain();
            }
            return ExitCode::SUCCESS; // A hit already took ownership of stdin.
        }
        [flag, entry, caller] if flag == "--agy-launcher-v2" => {
            return match agy::serve(Path::new(entry), caller) {
                Some(line) => frame(&line, true),
                None => ExitCode::from(75),
            };
        }
        [flag, entry, caller, stamp] if flag == "--agy-refresh-v1" => {
            if agy::refresh(Path::new(entry), caller, stamp).is_none() {
                agy::drain();
            }
            return ExitCode::SUCCESS;
        }
        _ => {}
    }
    let launcher = args.first().is_some_and(|a| a == "--launcher-v1");
    if launcher {
        args.remove(0);
    }
    let mut bytes = Vec::new();
    if io::stdin()
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return ExitCode::from(75);
    }
    let Some(line) = execute(&args, &bytes) else {
        return ExitCode::from(75);
    };
    frame(&line, launcher)
}
fn frame(line: &str, launcher: bool) -> ExitCode {
    let mut stdout = io::stdout().lock();
    let result = if launcher {
        writeln!(stdout, "hud-statusline-v1:{line}\n:end-hud-statusline-v1")
    } else {
        writeln!(stdout, "{line}")
    };
    if result.is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(75)
    }
}
