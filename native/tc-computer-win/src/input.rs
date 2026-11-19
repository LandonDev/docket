//! Input as the Windows service plans it (docs/computer-protocol.md §5, §29.4):
//! key combos as virtual keys, the modifiers a pointer step holds, text cut
//! into key chunks, the session's coordinate space, and which tier can
//! express a step. Platform-free; `platform::windows` posts what this plans.

use crate::wire::{ComputerAction, ComputerActionName, CoordinateSpace, Rect, Tier};

/// The value every event the service posts carries (`dwExtraInfo`), "tccp", so
/// the person watch tells its own input from the person's (§5.2).
pub const INPUT_TAG: usize = 0x7463_6370;

/// Unicode key events carry at most this many UTF-16 units each (§5.3).
pub const CHUNK_UNITS: usize = 20;
/// Text longer than this goes in by paste, never by keys (§5.3).
pub const KEYS_MAX_UNITS: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mods {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    /// the Windows key
    pub win: bool,
}

impl Mods {
    pub fn none(&self) -> bool {
        !(self.shift || self.ctrl || self.alt || self.win)
    }
    /// The virtual keys held, in the order they go down.
    pub fn vks(&self) -> Vec<u16> {
        let mut v = Vec::new();
        if self.ctrl {
            v.push(vk::CONTROL);
        }
        if self.alt {
            v.push(vk::MENU);
        }
        if self.shift {
            v.push(vk::SHIFT);
        }
        if self.win {
            v.push(vk::LWIN);
        }
        v
    }
}

/// Windows' virtual key codes (winuser.h) the names map to.
pub mod vk {
    pub const BACK: u16 = 0x08;
    pub const TAB: u16 = 0x09;
    pub const RETURN: u16 = 0x0D;
    pub const SHIFT: u16 = 0x10;
    pub const CONTROL: u16 = 0x11;
    pub const MENU: u16 = 0x12;
    pub const ESCAPE: u16 = 0x1B;
    pub const SPACE: u16 = 0x20;
    pub const PRIOR: u16 = 0x21;
    pub const NEXT: u16 = 0x22;
    pub const END: u16 = 0x23;
    pub const HOME: u16 = 0x24;
    pub const LEFT: u16 = 0x25;
    pub const UP: u16 = 0x26;
    pub const RIGHT: u16 = 0x27;
    pub const DOWN: u16 = 0x28;
    pub const DELETE: u16 = 0x2E;
    pub const LWIN: u16 = 0x5B;
    pub const F1: u16 = 0x70;
    pub const OEM_1: u16 = 0xBA; // ;
    pub const OEM_PLUS: u16 = 0xBB; // =
    pub const OEM_COMMA: u16 = 0xBC;
    pub const OEM_MINUS: u16 = 0xBD;
    pub const OEM_PERIOD: u16 = 0xBE;
    pub const OEM_2: u16 = 0xBF; // /
    pub const OEM_3: u16 = 0xC0; // `
    pub const OEM_4: u16 = 0xDB; // [
    pub const OEM_5: u16 = 0xDC; // \
    pub const OEM_6: u16 = 0xDD; // ]
    pub const OEM_7: u16 = 0xDE; // '
}

/// A key: a virtual key, or a character the keyboard layout maps (`VkKeyScanW`) at the platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Vk(u16),
    Char(char),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Combo {
    pub mods: Mods,
    pub key: Key,
}

fn modifier(word: &str, m: &mut Mods) -> bool {
    match word.to_ascii_lowercase().as_str() {
        "shift" | "shift_l" | "shift_r" => m.shift = true,
        "ctrl" | "control" | "control_l" | "control_r" => m.ctrl = true,
        "alt" | "opt" | "option" | "alt_l" | "alt_r" => m.alt = true,
        "super" | "cmd" | "command" | "win" | "super_l" | "super_r" | "meta_l" | "meta_r" => m.win = true,
        _ => return false,
    }
    true
}

/// A named key or a single character (observation.ts `KEY_NAMES`, X11 keysym names).
fn key_of(word: &str) -> Option<Key> {
    let mut chars = word.chars();
    if let (Some(c), None) = (chars.next(), chars.clone().next()) {
        return Some(match c {
            'a'..='z' => Key::Vk(c.to_ascii_uppercase() as u16),
            'A'..='Z' | '0'..='9' => Key::Vk(c as u16),
            ' ' => Key::Vk(vk::SPACE),
            _ => Key::Char(c),
        });
    }
    let lower = word.to_ascii_lowercase();
    if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()).filter(|n| (1..=20).contains(n)) {
        return Some(Key::Vk(vk::F1 + n - 1));
    }
    let v = match lower.as_str() {
        "return" | "enter" | "kp_enter" => vk::RETURN,
        "tab" => vk::TAB,
        "escape" | "esc" => vk::ESCAPE,
        "backspace" => vk::BACK,
        "delete" | "del" => vk::DELETE,
        "space" | "spacebar" => vk::SPACE,
        "up" | "arrowup" => vk::UP,
        "down" | "arrowdown" => vk::DOWN,
        "left" | "arrowleft" => vk::LEFT,
        "right" | "arrowright" => vk::RIGHT,
        "home" => vk::HOME,
        "end" => vk::END,
        "page_up" | "pageup" | "prior" => vk::PRIOR,
        "page_down" | "pagedown" | "next" => vk::NEXT,
        "minus" => vk::OEM_MINUS,
        // `plus` is the shifted `=` on a US layout: the layout maps the character
        "plus" => return Some(Key::Char('+')),
        "equal" => vk::OEM_PLUS,
        "comma" => vk::OEM_COMMA,
        "period" => vk::OEM_PERIOD,
        "slash" => vk::OEM_2,
        "backslash" => vk::OEM_5,
        "semicolon" => vk::OEM_1,
        "apostrophe" => vk::OEM_7,
        "grave" => vk::OEM_3,
        "bracketleft" => vk::OEM_4,
        "bracketright" => vk::OEM_6,
        "shift" | "shift_l" | "shift_r" => vk::SHIFT,
        "ctrl" | "control" | "control_l" | "control_r" => vk::CONTROL,
        "alt" | "opt" | "option" | "alt_l" | "alt_r" => vk::MENU,
        "super" | "cmd" | "command" | "win" | "super_l" | "super_r" | "meta_l" | "meta_r" => vk::LWIN,
        _ => return None,
    };
    Some(Key::Vk(v))
}

/// `ctrl+s`, `super+shift+t`, `alt+Tab`, `Return`, `ctrl++` (observation.ts `parseKeyCombo`).
pub fn parse_combo(text: &str) -> Result<Combo, String> {
    if text.is_empty() {
        return Err("a key is needed".into());
    }
    if text == "+" {
        return Ok(Combo { mods: Mods::default(), key: Key::Char('+') });
    }
    let (rest, plus) = match text.strip_suffix("++") {
        Some(r) => (r, true),
        None => (text, false),
    };
    let mut parts: Vec<&str> = if rest.is_empty() { vec![] } else { rest.split('+').collect() };
    if parts.iter().any(|p| p.is_empty()) {
        return Err(format!("{text:?} has an empty part"));
    }
    let key = if plus {
        Key::Char('+')
    } else {
        let last = parts.pop().ok_or_else(|| format!("{text:?} names no key"))?;
        key_of(last).ok_or_else(|| format!("{last:?} is not a key"))?
    };
    let mut mods = Mods::default();
    for p in parts {
        if !modifier(p, &mut mods) {
            return Err(format!("{p:?} in {text:?} is not a modifier"));
        }
    }
    Ok(Combo { mods, key })
}

/// The modifiers a click, drag or scroll holds: `shift`, `ctrl+alt`.
pub fn parse_mods(text: Option<&str>) -> Result<Mods, String> {
    let mut m = Mods::default();
    let Some(text) = text.filter(|t| !t.is_empty()) else { return Ok(m) };
    for p in text.split('+') {
        if !modifier(p, &mut m) {
            return Err(format!("{p:?} in {text:?} is not a modifier"));
        }
    }
    Ok(m)
}

/// One piece of typed text: a run of characters sent as Unicode keys, or a real key (a line break is Return, a tab Tab).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece {
    Text(String),
    Key(u16),
}

/// Whether `c` joins the character before it (a combining mark, a joiner, a variation selector, a skin tone).
fn joins(c: char) -> bool {
    matches!(c as u32, 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE00..=0xFE0F | 0xFE20..=0xFE2F | 0x200C | 0x200D | 0x1F3FB..=0x1F3FF | 0xE0020..=0xE007F)
}

/// Text as key pieces (§5.3): runs of at most CHUNK_UNITS UTF-16 units, never cut inside a cluster;
/// `\r\n`, `\n` and `\r` are Return, `\t` is Tab. None when a cluster is longer than a chunk.
pub fn pieces(text: &str) -> Option<Vec<Piece>> {
    // clusters: a character and every joining one after it (a joiner also takes the next character)
    let mut clusters: Vec<String> = Vec::new();
    let mut glue = false;
    for c in text.chars() {
        match clusters.last_mut() {
            Some(last) if (glue || joins(c)) && !matches!(c, '\n' | '\r' | '\t') && !last.ends_with(['\n', '\r', '\t']) => last.push(c),
            _ => clusters.push(c.to_string()),
        }
        glue = c == '\u{200D}';
    }
    let mut out = Vec::new();
    let mut run = String::new();
    let mut units = 0;
    let mut prev_cr = false;
    for cl in clusters {
        let key = match cl.as_str() {
            "\n" if prev_cr => {
                prev_cr = false;
                continue;
            }
            "\n" | "\r" => Some(vk::RETURN),
            "\t" => Some(vk::TAB),
            _ => None,
        };
        prev_cr = cl == "\r";
        if let Some(k) = key {
            if !run.is_empty() {
                out.push(Piece::Text(std::mem::take(&mut run)));
                units = 0;
            }
            out.push(Piece::Key(k));
            continue;
        }
        let n = cl.encode_utf16().count();
        if n > CHUNK_UNITS {
            return None;
        }
        if units + n > CHUNK_UNITS {
            out.push(Piece::Text(std::mem::take(&mut run)));
            units = 0;
        }
        run.push_str(&cl);
        units += n;
    }
    if !run.is_empty() {
        out.push(Piece::Text(run));
    }
    Some(out)
}

/// A session pixel to a screen pixel, at its centre (§6): `origin + (p + 0.5) / scale`.
pub fn to_screen(frame: &Rect, space: &CoordinateSpace, p: (i64, i64)) -> (f64, f64) {
    (frame.x + (p.0 as f64 + 0.5) / space.scale, frame.y + (p.1 as f64 + 0.5) / space.scale)
}

/// A screen point back to the session pixel it lies in: `floor((s - origin) × scale)`.
pub fn to_space(frame: &Rect, space: &CoordinateSpace, s: (f64, f64)) -> (i64, i64) {
    (((s.0 - frame.x) * space.scale).floor() as i64, ((s.1 - frame.y) * space.scale).floor() as i64)
}

pub fn in_space(space: &CoordinateSpace, p: (i64, i64)) -> bool {
    p.0 >= 0 && p.1 >= 0 && p.0 < space.width && p.1 < space.height
}

/// The pointer steps.
pub fn is_pointer(a: ComputerActionName) -> bool {
    use ComputerActionName::*;
    matches!(a, LeftClick | RightClick | MiddleClick | DoubleClick | TripleClick | LeftClickDrag | MouseMove | LeftMouseDown | LeftMouseUp | Scroll)
}

/// The steps that press keys or put text in.
pub fn is_keys(a: ComputerActionName) -> bool {
    use ComputerActionName::*;
    matches!(a, Key | HoldKey | Type | Paste)
}

/// Whether an event tier on Windows can express the step (§29.4):
/// `session` takes every pointer and key step; `process` and `front` post
/// window messages, which carry no Alt or Windows key on the pointer and
/// no modifier at all on a key (an app reads its modifiers from the
/// keyboard's state, which a posted message never sets), nor a held key.
pub fn expresses(tier: Tier, a: &ComputerAction) -> bool {
    use ComputerActionName::*;
    if !(is_pointer(a.action) || is_keys(a.action)) {
        return false;
    }
    match tier {
        Tier::Session => true,
        Tier::Process | Tier::Front => match a.action {
            HoldKey => false,
            Key => parse_combo(a.text.as_deref().unwrap_or("")).is_ok_and(|c| c.mods.none()),
            Type | Paste => true,
            _ => parse_mods(a.text.as_deref()).is_ok_and(|m| !m.alt && !m.win),
        },
        _ => false,
    }
}

/// The first allowed event tier that can express the step, in the host's order.
pub fn event_tier(tiers: &[Tier], a: &ComputerAction) -> Option<Tier> {
    tiers.iter().copied().find(|t| *t != Tier::Ax && expresses(*t, a))
}

/// The tier a step that no allowed tier expresses would need: the cheapest that could.
pub fn needed_tier(a: &ComputerAction) -> Tier {
    if expresses(Tier::Process, a) {
        Tier::Process
    } else {
        Tier::Session
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combos_map_names_and_characters_to_virtual_keys() {
        let c = parse_combo("ctrl+s").unwrap();
        assert!(c.mods.ctrl && !c.mods.shift);
        assert_eq!(c.key, Key::Vk(b'S' as u16));
        let c = parse_combo("super+shift+t").unwrap();
        assert!(c.mods.win && c.mods.shift);
        assert_eq!(parse_combo("Return").unwrap().key, Key::Vk(vk::RETURN));
        assert_eq!(parse_combo("page_down").unwrap().key, Key::Vk(vk::NEXT));
        assert_eq!(parse_combo("F12").unwrap().key, Key::Vk(vk::F1 + 11));
        assert_eq!(parse_combo("ctrl++").unwrap(), Combo { mods: Mods { ctrl: true, ..Default::default() }, key: Key::Char('+') });
        assert_eq!(parse_combo("+").unwrap().key, Key::Char('+'));
        assert_eq!(parse_combo("é").unwrap().key, Key::Char('é'));
        assert_eq!(parse_combo("cmd+c").unwrap().mods.win, true);
        assert!(parse_combo("ctrl+").is_err());
        assert!(parse_combo("hyper+x").is_err());
        assert!(parse_combo("F21").is_err());
    }

    #[test]
    fn text_goes_in_twenty_unit_runs_with_line_breaks_and_tabs_as_keys() {
        assert_eq!(pieces("ab\ncd\r\ne\tf").unwrap(), vec![
            Piece::Text("ab".into()),
            Piece::Key(vk::RETURN),
            Piece::Text("cd".into()),
            Piece::Key(vk::RETURN),
            Piece::Text("e".into()),
            Piece::Key(vk::TAB),
            Piece::Text("f".into()),
        ]);
        let long = "x".repeat(45);
        let p = pieces(&long).unwrap();
        assert_eq!(p.len(), 3);
        assert!(p.iter().all(|x| matches!(x, Piece::Text(t) if t.len() <= CHUNK_UNITS)));
        // a family emoji (11 units) is never cut: 19 x's, then the emoji starts the next run
        let fam = "👨\u{200D}👩\u{200D}👧";
        let p = pieces(&format!("{}{fam}", "x".repeat(19))).unwrap();
        assert_eq!(p, vec![Piece::Text("x".repeat(19)), Piece::Text(fam.into())]);
        // e + combining acute stays together
        let p = pieces(&format!("{}e\u{301}", "x".repeat(19))).unwrap();
        assert_eq!(p[1], Piece::Text("e\u{301}".into()));
        assert!(pieces(&format!("a{}", "\u{301}".repeat(25))).is_none());
    }

    #[test]
    fn a_pixel_maps_to_the_screen_at_its_centre_and_back_to_itself() {
        let frame = Rect { x: 100.0, y: 50.0, w: 2000.0, h: 1000.0 };
        let space = crate::text::space_of(frame.w, frame.h);
        assert!(space.scale < 1.0);
        for p in [(0, 0), (17, 33), (space.width - 1, space.height - 1)] {
            let s = to_screen(&frame, &space, p);
            assert_eq!(to_space(&frame, &space, s), p);
        }
        assert!(!in_space(&space, (space.width, 0)));
        assert!(!in_space(&space, (-1, 0)));
    }

    #[test]
    fn posted_messages_carry_no_key_modifier_alt_or_windows_key_and_no_held_key() {
        let act = |action, text: Option<&str>| ComputerAction { action, text: text.map(str::to_string), ..Default::default() };
        use ComputerActionName::*;
        assert!(expresses(Tier::Process, &act(Key, Some("Return"))));
        assert!(!expresses(Tier::Process, &act(Key, Some("ctrl+s"))));
        assert!(expresses(Tier::Session, &act(Key, Some("ctrl+s"))));
        assert!(!expresses(Tier::Process, &act(HoldKey, Some("shift"))));
        assert!(expresses(Tier::Process, &act(LeftClick, Some("shift"))));
        assert!(!expresses(Tier::Process, &act(LeftClick, Some("alt"))));
        assert!(expresses(Tier::Front, &act(Type, Some("hello"))));
        assert!(!expresses(Tier::Ax, &act(LeftClick, None)));
        assert!(!expresses(Tier::Session, &act(SetValue, None)));
        assert_eq!(event_tier(&[Tier::Ax, Tier::Process, Tier::Session], &act(Key, Some("ctrl+s"))), Some(Tier::Session));
        assert_eq!(event_tier(&[Tier::Ax, Tier::Process], &act(Key, Some("ctrl+s"))), None);
        assert_eq!(needed_tier(&act(Key, Some("ctrl+s"))), Tier::Session);
        assert_eq!(needed_tier(&act(Scroll, None)), Tier::Process);
    }
}
