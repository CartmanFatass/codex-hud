//! Bounded JSON for the statusline's local file protocol. A valid input that cannot be represented
//! (unpaired UTF-16 surrogate, excessive nesting) is passed to Node, not treated as malformed.
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    List(Vec<Value>),
    Obj(BTreeMap<String, Value>),
}
pub static NULL: Value = Value::Null;
impl Value {
    pub fn get(&self, key: &str) -> &Self {
        self.field(key).unwrap_or(&NULL)
    }
    pub fn field(&self, key: &str) -> Option<&Self> {
        self.obj()?.get(key)
    }
    pub fn obj(&self) -> Option<&BTreeMap<String, Self>> {
        if let Self::Obj(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn list(&self) -> Option<&[Self]> {
        if let Self::List(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn str(&self) -> Option<&str> {
        if let Self::Str(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn num(&self) -> Option<f64> {
        if let Self::Num(v) = *self {
            Some(v)
        } else {
            None
        }
    }
    pub fn count(&self) -> Option<u64> {
        let n = self.num()?;
        (n >= 0. && n <= 9_007_199_254_740_991. && n.fract() == 0.).then_some(n as u64)
    }
    pub fn bool(&self) -> Option<bool> {
        if let Self::Bool(v) = *self {
            Some(v)
        } else {
            None
        }
    }
}
#[derive(Debug, PartialEq)]
pub enum Error {
    Invalid,
    Unsupported,
}
use Error::{Invalid, Unsupported};
type Result<T> = std::result::Result<T, Error>;

pub fn parse(bytes: &[u8]) -> Result<Value> {
    let text = std::str::from_utf8(bytes).map_err(|_| Invalid)?;
    let mut p = Parser(text);
    let v = p.value(0)?;
    if p.ws().is_none() {
        Ok(v)
    } else {
        Err(Invalid)
    }
}
struct Parser<'a>(&'a str);
impl Parser<'_> {
    fn ws(&mut self) -> Option<u8> {
        self.0 = self.0.trim_start_matches([' ', '\r', '\n', '\t']);
        self.0.as_bytes().first().copied()
    }
    fn eat(&mut self, s: &str) -> bool {
        if let Some(tail) = self.0.strip_prefix(s) {
            self.0 = tail;
            true
        } else {
            false
        }
    }
    fn require(&mut self, s: &str) -> Result<()> {
        if self.eat(s) {
            Ok(())
        } else {
            Err(Invalid)
        }
    }
    fn value(&mut self, depth: usize) -> Result<Value> {
        if depth > 40 {
            return Err(Unsupported);
        }
        match self.ws().ok_or(Invalid)? {
            b'n' => {
                self.require("null")?;
                Ok(Value::Null)
            }
            b't' => {
                self.require("true")?;
                Ok(Value::Bool(true))
            }
            b'f' => {
                self.require("false")?;
                Ok(Value::Bool(false))
            }
            b'"' => self.string().map(Value::Str),
            b'[' => {
                self.require("[")?;
                let mut out = Vec::new();
                if self.ws() != Some(b']') {
                    loop {
                        out.push(self.value(depth + 1)?);
                        if self.ws() == Some(b']') {
                            break;
                        }
                        self.require(",")?;
                    }
                }
                self.require("]")?;
                Ok(Value::List(out))
            }
            b'{' => {
                self.require("{")?;
                let mut out = BTreeMap::new();
                if self.ws() != Some(b'}') {
                    loop {
                        self.ws();
                        let key = self.string()?;
                        self.ws();
                        self.require(":")?;
                        out.insert(key, self.value(depth + 1)?);
                        if self.ws() == Some(b'}') {
                            break;
                        }
                        self.require(",")?;
                    }
                }
                self.require("}")?;
                Ok(Value::Obj(out))
            }
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(Invalid),
        }
    }
    fn digits(&mut self) -> Result<()> {
        let n = self.0.bytes().take_while(u8::is_ascii_digit).count();
        if n == 0 {
            return Err(Invalid);
        }
        self.0 = &self.0[n..];
        Ok(())
    }
    fn number(&mut self) -> Result<Value> {
        let start = self.0;
        self.eat("-");
        if !self.eat("0") {
            self.digits()?;
        }
        if self.eat(".") {
            self.digits()?;
        }
        if self.eat("e") || self.eat("E") {
            if !self.eat("+") {
                self.eat("-");
            }
            self.digits()?;
        }
        let n: f64 = start[..start.len() - self.0.len()]
            .parse()
            .map_err(|_| Unsupported)?;
        if !n.is_finite() {
            return Err(Unsupported);
        }
        Ok(Value::Num(n))
    }
    fn hex(&mut self) -> Result<u32> {
        let n = self
            .0
            .get(..4)
            .filter(|s| s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or(Invalid)?;
        self.0 = &self.0[4..];
        u32::from_str_radix(n, 16).map_err(|_| Invalid)
    }
    fn string(&mut self) -> Result<String> {
        self.require("\"")?;
        let mut out = String::new();
        loop {
            let end = self
                .0
                .bytes()
                .position(|b| b == b'"' || b == b'\\' || b < 0x20)
                .ok_or(Invalid)?;
            out.push_str(&self.0[..end]);
            self.0 = &self.0[end..];
            if self.eat("\"") {
                return Ok(out);
            }
            self.require("\\")?;
            let code = self
                .0
                .as_bytes()
                .first()
                .copied()
                .filter(u8::is_ascii)
                .ok_or(Invalid)?;
            self.0 = &self.0[1..];
            out.push(match code {
                b'"' | b'\\' | b'/' => code as char,
                b'b' => '\u{8}',
                b'f' => '\u{c}',
                b'n' => '\n',
                b'r' => '\r',
                b't' => '\t',
                b'u' => {
                    let mut cp = self.hex()?;
                    if (0xd800..=0xdbff).contains(&cp) {
                        if !self.eat("\\u") {
                            return Err(Unsupported);
                        }
                        let trail = self.hex()?;
                        if !(0xdc00..=0xdfff).contains(&trail) {
                            return Err(Unsupported);
                        }
                        cp = 0x10000 + ((cp - 0xd800) << 10) + trail - 0xdc00;
                    }
                    char::from_u32(cp).ok_or(Unsupported)?
                }
                _ => return Err(Invalid),
            });
        }
    }
}

pub fn number(n: f64) -> String {
    if !n.is_finite() {
        "null".into()
    } else if n == 0. {
        "0".into()
    } else if n.abs() < 1e-6 {
        format!("{n:e}")
    } else if n.abs() >= 1e21 {
        let s = format!("{n:e}");
        s.replace('e', "e+")
    } else {
        n.to_string()
    }
}
pub fn stringify(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Num(n) => number(*n),
        Value::Str(s) => quoted(s),
        Value::List(items) => format!(
            "[{}]",
            items.iter().map(stringify).collect::<Vec<_>>().join(",")
        ),
        Value::Obj(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, v)| format!("{}:{}", quoted(k), stringify(v)))
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

pub fn quoted(s: &str) -> String {
    let mut out = String::from("\"");
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\0'..='\u{1f}' => out.push_str(&format!("\\u{:04x}", ch as u32)),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}
