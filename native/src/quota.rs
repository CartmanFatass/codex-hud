//! Publish exactly the two Claude quota watermarks, using the existing private TS state file.
use crate::{
    json::{self, Value},
    state,
};
use std::{fs, path::Path};

pub const WINDOWS: [(&str, &str); 2] = [("five_hour", "5h"), ("seven_day", "7d")];
pub fn publish(input: &Value, home: &Path, now: f64) {
    let quota: Vec<_> = WINDOWS
        .iter()
        .filter_map(|(key, label)| {
            let limit = input.get("rate_limits").get(key);
            let percent = limit
                .get("used_percentage")
                .num()
                .filter(|p| (0. ..=100.).contains(p))?;
            let reset = limit
                .get("resets_at")
                .num()
                .filter(|s| *s > 0.)
                .and_then(|s| iso(s * 1000.));
            Some((label, if percent == 0. { 0. } else { percent }, reset))
        })
        .collect();
    if quota.is_empty() {
        return;
    }
    let path = home.join("display/state/claude-quota.json");
    if fs::symlink_metadata(&path).is_ok_and(|m| (0. ..5000.).contains(&(now - state::mtime(&m)))) {
        return;
    }
    let Some(previous) = state::read(&path, 1024, false, true) else {
        return;
    };
    if let Some(old) = previous {
        if old.field("version").is_some() {
            return;
        }
        let age = old
            .get("updatedAt")
            .str()
            .and_then(parse_timestamp)
            .map(|at| now - at);
        if age.is_some_and(|age| (0. ..5000.).contains(&age)) {
            return;
        }
        if age.is_some_and(|age| (0. ..300_000.).contains(&age))
            && old.get("quota").list().is_some_and(|items| {
                items.len() == quota.len()
                    && items
                        .iter()
                        .zip(&quota)
                        .all(|(v, (label, percent, reset))| {
                            v.get("label").str() == Some(label)
                                && v.get("percent").num() == Some(*percent)
                                && v.get("resetsAt").str() == reset.as_deref()
                                && v.obj()
                                    .is_some_and(|o| o.len() == 2 + reset.is_some() as usize)
                        })
            })
        {
            return;
        }
    }
    let Some(at) = iso(now) else {
        return;
    };
    let items: Vec<_> = quota
        .into_iter()
        .map(|(label, percent, reset)| {
            let end = reset.map_or(String::new(), |r| format!(",\"resetsAt\":\"{r}\""));
            format!(
                "{{\"label\":\"{label}\",\"percent\":{}{end}}}",
                json::number(percent)
            )
        })
        .collect();
    let _ = state::write(
        &path,
        &format!(
            "{{\"updatedAt\":\"{at}\",\"quota\":[{}]}}\n",
            items.join(",")
        ),
    );
}

// Gregorian civil date conversion, relative to 1970-01-01. Date's TimeClip truncates milliseconds.
fn iso(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    let ms = ms as i64;
    let z = ms.div_euclid(86_400_000) + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = era * 400 + yoe + (month <= 2) as i64;
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    let time = ms.rem_euclid(86_400_000);
    let (h, m, s, rem) = (
        time / 3_600_000,
        time / 60_000 % 60,
        time / 1000 % 60,
        time % 1000,
    );
    Some(format!(
        "{year}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{rem:03}Z"
    ))
}
fn parse_timestamp(date: &str) -> Option<f64> {
    // Both cache writers produce this ISO form; other timestamp formats are not part of the cache protocol.
    if date.len() != 24 || !date.is_ascii() {
        return None;
    }
    let n = |a, b| date[a..b].parse::<i64>().ok();
    let (year, month, day) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let adjusted = year - (month <= 2) as i64;
    let era = adjusted.div_euclid(400);
    let yoe = adjusted.rem_euclid(400);
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    let ms = (days * 86_400_000
        + n(11, 13)? * 3_600_000
        + n(14, 16)? * 60_000
        + n(17, 19)? * 1000
        + n(20, 23)?) as f64;
    (iso(ms)?.as_str() == date).then_some(ms)
}

#[cfg(test)]
#[test]
fn iso_round_trip() {
    for (value, text) in [
        (0., "1970-01-01T00:00:00.000Z"),
        (951782400123., "2000-02-29T00:00:00.123Z"),
        (-1., "1969-12-31T23:59:59.999Z"),
    ] {
        assert_eq!(iso(value).as_deref(), Some(text));
        assert_eq!(parse_timestamp(text), Some(value));
    }
}
