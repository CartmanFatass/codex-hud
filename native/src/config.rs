use crate::{render::js_whitespace, state};
use std::path::{Path, PathBuf};

pub const FIELDS: [&str; 7] = [
    "model", "context", "project", "quota", "tps", "notice", "loaded",
];
pub struct Policy {
    pub margin: usize,
    pub git: bool,
    pub dirty: bool,
    pub sync: bool,
    pub effort: bool,
    pub agents: bool,
    pub skills: bool,
    pub config_counts: bool,
}
impl Policy {
    pub fn load(home: &Path) -> Option<Self> {
        use crate::json::Value;
        let root =
            state::read(&home.join("config.json"), 131_072, false, true)?.unwrap_or(Value::Null);
        let v = root.get("statusline");
        if v.field("forward").is_some() {
            return None;
        }
        if v.field("lineLayout")
            .is_some_and(|l| l.str() != Some("compact"))
            || v.field("showSeparators")
                .is_some_and(|v| v.bool().is_none())
        {
            return None;
        }
        let d = v.get("display");
        let g = v.get("gitStatus");
        for (obj, keys) in [
            (
                d,
                &[
                    "showTools",
                    "showAgents",
                    "showTodos",
                    "showDuration",
                    "showConfigCounts",
                    "showSkills",
                    "showEffortLevel",
                ][..],
            ),
            (
                g,
                &["enabled", "showDirty", "showAheadBehind", "showFileStats"][..],
            ),
        ] {
            if keys
                .iter()
                .any(|k| obj.field(k).is_some_and(|v| v.bool().is_none()))
            {
                return None;
            }
        }
        if d.get("showTools").bool() == Some(true) || g.get("showFileStats").bool() == Some(true) {
            return None;
        }
        let margin = match v.get("widthMargin") {
            Value::Null => 4,
            value => value.count().filter(|n| *n <= 100)? as usize,
        };
        Some(Self {
            margin,
            git: g.get("enabled").bool() != Some(false),
            dirty: g.get("showDirty").bool() != Some(false),
            sync: g.get("showAheadBehind").bool() == Some(true),
            effort: d.get("showEffortLevel").bool() == Some(true),
            agents: d.get("showAgents").bool() == Some(true),
            skills: d.get("showSkills").bool() == Some(true),
            config_counts: d.get("showConfigCounts").bool() == Some(true),
        })
    }
    pub fn width(&self, args: &[String]) -> Option<usize> {
        fn digits(s: &str) -> bool {
            !s.is_empty() && !s.starts_with('0') && s.bytes().all(|b| b.is_ascii_digit())
        }
        match args {
            [] => {
                let cols = state::env("COLUMNS")
                    .filter(|s| digits(s))
                    .map(|s| s.parse::<usize>().unwrap_or(usize::MAX))
                    .unwrap_or(120);
                Some(cols.saturating_sub(self.margin).clamp(1, 500))
            }
            [flag, n] if flag == "--width" && digits(n) => {
                n.parse::<usize>().ok().filter(|n| *n <= 500)
            }
            _ => None,
        }
    }
}

pub struct Display {
    pub theme: String,
    pub capsules: bool,
    pub ascii: bool,
    pub nerd: bool,
    pub fields: [bool; 7],
}
impl Display {
    pub fn icon_index(&self) -> usize {
        usize::from(self.ascii) + 2 * usize::from(self.nerd)
    }
    pub fn load(home: &Path, now: f64) -> Option<Self> {
        let word = |key| {
            state::hud_env(key)
                .unwrap_or_default()
                .trim_matches(js_whitespace)
                .to_lowercase()
        };
        let mut theme = word("HUD_THEME");
        if state::env("NO_COLOR").is_some_and(|s| !s.is_empty()) {
            theme = "none".into();
        }
        let mut style = word("HUD_BAR_STYLE");
        let mut icons = word("HUD_ICONS");
        let named = state::hud_env("HUD_BAR_FIELDS").unwrap_or_default();
        let mut fields = FIELDS.map(|field| {
            named
                .split(|c| c == ',' || js_whitespace(c))
                .any(|s| s == field)
        });
        if !fields.contains(&true) {
            fields.fill(true);
        }
        let file = state::hud_env("HUD_SETTINGS_PATH")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("hud-settings.json"));
        if let Some(v) = state::read(&file, 65_536, false, false)? {
            if v.get("advisorShadow").bool() == Some(true) {
                let rules_enabled = v.get("advisorRulesFile").str().is_some_and(|p| {
                    Path::new(p).is_absolute() && !p.contains('\0') && p.encode_utf16().count() <= 4096
                });
                // TypeScript owns the advisor notice presentation, but only a live notice needs it.
                if state::has_live_advisor_notice(home, now, rules_enabled) {
                    return None;
                }
            }
            style = v.get("barStyle").str().unwrap_or_default().into();
            if let Some(set) = v
                .get("icons")
                .str()
                .filter(|s| ["nerd", "unicode", "text"].contains(s))
            {
                icons = set.into();
            }
            if v.get("theme").str() == Some("none") {
                theme = "none".into();
            }
            fields = match v.get("barFields").list() {
                Some(items)
                    if items
                        .iter()
                        .all(|v| v.str().is_some_and(|s| FIELDS.contains(&s))) =>
                {
                    FIELDS.map(|field| items.iter().any(|v| v.str() == Some(field)))
                }
                _ => [true; 7],
            };
        }
        // Retired and unknown styles use line, as in the TypeScript settings reader.
        Some(Self {
            capsules: theme != "none" && style == "p10k",
            theme,
            ascii: icons == "text",
            nerd: !matches!(icons.as_str(), "text" | "unicode" | "emoji"),
            fields,
        })
    }
}
