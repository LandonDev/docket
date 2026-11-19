//! A walked window as observation text (docs/computer-protocol.md §4, §29.3):
//! which elements are kept, their indices from the session's book, the
//! element lines, the header, the budget and the thin rule. Platform-free:
//! the Windows reader hands in a `RawNode` tree already in the grammar's
//! words (role, states, action words), and `parseObservation` in
//! observation.ts reads back every text this writes.

use crate::book::AppBook;
use crate::generated::contract::{budget, grammar, text as limits};
use crate::wire::{CoordinateSpace, Rect};

/// One element as the reader saw it, in the grammar's words.
#[derive(Debug, Clone, Default)]
pub struct RawNode<H> {
    pub handle: H,
    /// what makes it the same element across reads (UI Automation's RuntimeId)
    pub key: Vec<i32>,
    /// a word of ROLE_WORDS, or a control type split into lower-case words
    pub role: String,
    pub name: Option<String>,
    pub value: Option<String>,
    /// state words, any order; printed in STATE_WORDS' order
    pub states: Vec<&'static str>,
    pub caret: Option<i64>,
    pub selection: Option<(i64, i64)>,
    /// action words beyond the role's defaults
    pub actions: Vec<&'static str>,
    /// screen pixels
    pub frame: Option<Rect>,
    pub children: Vec<RawNode<H>>,
}

/// What the reader read of one window.
#[derive(Debug, Clone)]
pub struct RawWindow<H> {
    pub pid: i64,
    pub app_name: String,
    pub bundle_id: Option<String>,
    pub window_id: i64,
    pub title: String,
    pub frame: Rect,
    /// the app's other windows: title and whether minimized
    pub others: Vec<(String, bool)>,
    pub root: RawNode<H>,
    /// the walk stopped at its node or time cap
    pub partial: bool,
    pub read_ms: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct TextOptions {
    pub budget_bytes: usize,
    pub geometry: bool,
    /// a subtree read (`element: i`): values uncut up to the budget
    pub whole_values: bool,
}

impl Default for TextOptions {
    fn default() -> Self {
        TextOptions { budget_bytes: budget::DEFAULT_BYTES as usize, geometry: false, whole_values: false }
    }
}

/// The text and what the observation's stats need.
#[derive(Debug, Clone, PartialEq)]
pub struct Rendered {
    pub text: String,
    pub elements: i64,
    pub lines: i64,
    pub omitted: i64,
    pub thin: bool,
    pub focused: Option<i64>,
    /// every index this read gave or kept, shown or cut
    pub seen: Vec<i64>,
}

/// The coordinate space of a window `w`×`h` pixels: a screenshot's long edge
/// and pixel count capped as the Mac's are (protocol.ts SHOT), so M43's
/// captures and these frames agree.
pub fn space_of(w: f64, h: f64) -> CoordinateSpace {
    let (w, h) = (w.max(1.0), h.max(1.0));
    let edge = 1280.0 / w.max(h);
    let pixels = (3_750_000.0 / (w * h)).sqrt();
    let scale = 1f64.min(edge).min(pixels);
    CoordinateSpace { width: (w * scale).round() as i64, height: (h * scale).round() as i64, scale }
}

/// A string as JSON.stringify writes it (serde_json escapes the same set, with lower-case hex).
pub fn quote(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// At most 100 scalars, then `…`.
pub fn cut_name(s: &str) -> String {
    let max = limits::NAME_MAX_CHARS as usize;
    let n = s.chars().count();
    if n > max { s.chars().take(max).collect::<String>() + "…" } else { s.to_string() }
}

/// At most 160 scalars, then `…(+<n> chars)`.
pub fn cut_value(s: &str) -> String {
    let max = limits::VALUE_MAX_CHARS as usize;
    let n = s.chars().count();
    if n > max { format!("{}…(+{} chars)", s.chars().take(max).collect::<String>(), n - max) } else { s.to_string() }
}

fn role_defaults(role: &str) -> &'static [&'static str] {
    grammar::ROLE_DEFAULTS.iter().find(|(r, _)| *r == role).map(|(_, d)| *d).unwrap_or(&[])
}

fn has_role_default(role: &str) -> bool {
    !role_defaults(role).is_empty() || grammar::TYPING_ROLES.contains(&role)
}

fn is_structural(role: &str) -> bool {
    grammar::STRUCTURAL_ROLES.contains(&role)
}

/// Layout roles that are never a line when unnamed: their children rise (§4.3).
fn is_layout(role: &str) -> bool {
    matches!(role, "group" | "split" | "pane" | "custom" | "scroll bar" | "thumb" | "title bar" | "separator")
}

/// The names a text child may not repeat: its parent's name and value, and its sibling controls' names (an input's label).
fn with_siblings<'a, H>(mut texts: Vec<&'a str>, children: &'a [RawNode<H>]) -> Vec<&'a str> {
    texts.extend(children.iter().filter(|c| c.role != "text").filter_map(|c| c.name.as_deref()).filter(|n| !n.is_empty()));
    texts
}

/// One kept element, before its line is written.
struct Kept {
    index: i64,
    line: String,
    /// the bytes of name and value, for the thin rule
    text_bytes: usize,
    actionable: bool,
    focused: bool,
    /// the element's kept descendants
    inside: usize,
    /// kept parent in `out`
    parent: Option<usize>,
}

struct Walk<'a, H> {
    book: &'a mut AppBook<H>,
    opts: TextOptions,
    origin: (f64, f64),
    scale: f64,
    out: Vec<Kept>,
    used: std::collections::HashSet<i64>,
}

impl<H: Clone> Walk<'_, H> {
    fn visit(&mut self, node: &RawNode<H>, depth: usize, parent: Option<usize>, parent_text: &[&str]) {
        let named = node.name.as_deref().is_some_and(|n| !n.is_empty());
        let valued = node.value.as_deref().is_some_and(|v| !v.is_empty());
        let focused = node.states.contains(&"focused");
        let listed: Vec<&str> = {
            let defaults = role_defaults(&node.role);
            let mut seen = Vec::new();
            for a in &node.actions {
                if !defaults.contains(a) && !seen.contains(a) {
                    seen.push(*a);
                }
            }
            seen
        };
        // a text that repeats its parent's name or value is the parent's label
        let echo = node.role == "text" && node.name.as_deref().is_some_and(|n| parent_text.contains(&n));
        let keep = !echo
            && if is_layout(&node.role) {
                named || focused
            } else {
                named || valued || !listed.is_empty() || has_role_default(&node.role) || is_structural(&node.role) || !node.states.is_empty()
            };
        if !keep {
            let texts = with_siblings(parent_text.to_vec(), &node.children);
            for c in &node.children {
                self.visit(c, depth, parent, &texts);
            }
            return;
        }
        let mut index = self.book.index_of(&node.key, node.handle.clone());
        if !self.used.insert(index) {
            index = self.book.fresh(node.handle.clone());
            self.used.insert(index);
        }
        let line = self.line(node, index, depth.min(limits::MAX_DEPTH as usize), &listed);
        let text_bytes = node.name.as_deref().map_or(0, str::len) + node.value.as_deref().map_or(0, str::len);
        let me = self.out.len();
        self.out.push(Kept {
            index,
            line,
            text_bytes,
            actionable: has_role_default(&node.role),
            focused,
            inside: 0,
            parent,
        });
        let mut texts: Vec<&str> = Vec::new();
        if let Some(n) = node.name.as_deref() {
            texts.push(n);
        }
        if let Some(v) = node.value.as_deref() {
            texts.push(v);
        }
        let texts = with_siblings(texts, &node.children);
        for c in &node.children {
            self.visit(c, depth + 1, Some(me), &texts);
        }
        let inside = self.out.len() - me - 1;
        self.out[me].inside = inside;
    }

    fn line(&self, node: &RawNode<H>, index: i64, depth: usize, listed: &[&str]) -> String {
        let mut s = format!("{}[{}] {}", " ".repeat(depth * limits::INDENT_SPACES as usize), index, node.role);
        let name = node.name.as_deref().filter(|n| !n.is_empty());
        if let Some(n) = name {
            s += &format!(" {}", quote(&cut_name(n)));
        }
        let value = node.value.as_deref().filter(|v| !v.is_empty() && Some(*v) != name && node.role != "password");
        if let Some(v) = value {
            let v = if self.opts.whole_values { v.to_string() } else { cut_value(v) };
            s += &format!(" = {}", quote(&v));
        }
        for w in grammar::STATE_WORDS {
            if node.states.contains(w) {
                s += &format!(" {w}");
            }
        }
        if let Some(c) = node.caret {
            s += &format!(" caret {c}");
        } else if let Some((a, b)) = node.selection {
            s += &format!(" selection {a}..{b}");
        }
        if !listed.is_empty() {
            s += &format!(" actions: {}", listed.join(", "));
        }
        if self.opts.geometry {
            if let Some(f) = &node.frame {
                let x = ((f.x - self.origin.0) * self.scale).round() as i64;
                let y = ((f.y - self.origin.1) * self.scale).round() as i64;
                let w = (f.w * self.scale).round().max(0.0) as i64;
                let h = (f.h * self.scale).round().max(0.0) as i64;
                s += &format!(" @{x},{y} {w}×{h}");
            }
        }
        s
    }
}

/// The header line (§4.1).
pub fn header(app: &str, title: &str, space: &CoordinateSpace, focused: Option<i64>, loading: bool, thin: bool) -> String {
    let mut parts = vec![format!("app {}", quote(app)), format!("window {}", quote(title)), format!("{}×{}", space.width, space.height)];
    if let Some(f) = focused {
        parts.push(format!("focused [{f}]"));
    }
    if loading {
        parts.push(grammar::HEADER_LOADING.into());
    }
    if thin {
        parts.push(grammar::HEADER_THIN.into());
    }
    parts.join(grammar::HEADER_SEPARATOR)
}

/// The window as text. `with_shot` says whether the observation carries a
/// picture: the thin word ("see the screenshot") is printed only then.
pub fn render<H: Clone>(win: &RawWindow<H>, root: &RawNode<H>, book: &mut AppBook<H>, opts: TextOptions, with_shot: bool) -> Rendered {
    let space = space_of(win.frame.w, win.frame.h);
    let mut walk = Walk { book, opts, origin: (win.frame.x, win.frame.y), scale: space.scale, out: Vec::new(), used: Default::default() };
    walk.visit(root, 0, None, &[]);
    let kept = walk.out;

    // the thin rule: the window line and its title-bar buttons do not count
    let counted = kept.iter().skip(1).filter(|k| !k.line.trim_start().contains("] button \"close\"") && !k.line.trim_start().contains("] button \"minimize\""));
    let (actionable, text_bytes) = counted.fold((0usize, 0usize), |(a, t), k| (a + k.actionable as usize, t + k.text_bytes));
    let thin = actionable < limits::THIN_ACTIONABLE as usize && text_bytes < limits::THIN_TEXT_BYTES as usize;
    let focused = kept.iter().find(|k| k.focused).map(|k| k.index);

    let head = header(&win.app_name, &win.title, &space, focused, false, thin && with_shot);
    let others = if win.others.is_empty() {
        None
    } else {
        let list: Vec<String> = win.others.iter().map(|(t, min)| quote(t) + if *min { " minimized" } else { "" }).collect();
        Some(format!("{}{}", grammar::OTHER_WINDOWS_PREFIX, list.join(", ")))
    };

    // the budget (§4.5): lines in reading order while they fit; the focused
    // element and its ancestors always; a line only under a kept parent
    let mut on_path = vec![false; kept.len()];
    if let Some(f) = kept.iter().position(|k| k.focused) {
        let mut at = Some(f);
        while let Some(i) = at {
            on_path[i] = true;
            at = kept[i].parent;
        }
    }
    let budget = opts.budget_bytes;
    let fixed = head.len() + others.as_ref().map_or(0, |o| o.len() + 1);
    let reserve = 120; // the truncated line
    let mut used = fixed;
    let mut shown = vec![false; kept.len()];
    for (i, k) in kept.iter().enumerate() {
        let parent_shown = k.parent.is_none_or(|p| shown[p]);
        if !parent_shown {
            continue;
        }
        let cost = k.line.len() + 1;
        if on_path[i] || used + cost + reserve <= budget {
            shown[i] = true;
            used += cost;
        }
    }
    let omitted = shown.iter().filter(|s| !**s).count();
    let mut lines: Vec<&str> = Vec::new();
    lines.push(&head);
    if let Some(o) = &others {
        lines.push(o);
    }
    for (i, k) in kept.iter().enumerate() {
        if shown[i] {
            lines.push(&k.line);
        }
    }
    let truncated;
    if omitted > 0 {
        // the kept element that lost the most of its own children
        let mut lost = vec![0usize; kept.len()];
        for (i, k) in kept.iter().enumerate() {
            if !shown[i] {
                if let Some(p) = k.parent.filter(|p| shown[*p]) {
                    lost[p] += 1 + k.inside;
                }
            }
        }
        let most = (0..kept.len()).max_by_key(|i| (lost[*i], usize::MAX - i)).unwrap_or(0);
        truncated = format!("(truncated: {omitted} elements left out; observe with element: {} to see one part whole)", kept.get(most).map_or(1, |k| k.index));
        lines.push(&truncated);
    }
    let text = lines.join("\n");
    Rendered {
        lines: lines.len() as i64,
        text,
        elements: kept.iter().zip(&shown).filter(|(_, s)| **s).count() as i64,
        omitted: omitted as i64,
        thin,
        focused: kept.iter().zip(&shown).find(|(k, s)| **s && k.focused).map(|(k, _)| k.index),
        seen: kept.iter().map(|k| k.index).collect(),
    }
}

/// The line of one element after its indent and `[<index>] ` (ElementBrief.line).
pub fn brief_of(text: &str, index: i64) -> Option<String> {
    let tag = format!("[{index}] ");
    text.lines().find_map(|l| {
        let t = l.trim_start();
        t.strip_prefix(&tag).map(str::to_string)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(role: &str, name: Option<&str>, key: i32, children: Vec<RawNode<()>>) -> RawNode<()> {
        RawNode { role: role.into(), name: name.map(Into::into), key: vec![key], children, ..Default::default() }
    }

    fn win(root: RawNode<()>) -> RawWindow<()> {
        RawWindow {
            pid: 42,
            app_name: "Notepad".into(),
            bundle_id: Some("notepad.exe".into()),
            window_id: 7,
            title: "Untitled - Notepad".into(),
            frame: Rect { x: 100.0, y: 50.0, w: 1000.0, h: 700.0 },
            others: vec![],
            root: root.clone(),
            partial: false,
            read_ms: 3,
        }
    }

    fn notepad() -> RawNode<()> {
        let mut doc = n("text area", Some("Text editor"), 4, vec![]);
        doc.value = Some("Hello \"world\"\nline two".into());
        doc.states = vec!["focused"];
        doc.caret = Some(5);
        n(
            "window",
            Some("Untitled - Notepad"),
            1,
            vec![
                n("group", None, 2, vec![n("menu item", Some("File"), 3, vec![]), n("text", Some("File"), 9, vec![])]),
                doc,
                n("button", Some("close"), 5, vec![]),
            ],
        )
    }

    #[test]
    fn writes_the_grammar_with_indices_in_reading_order() {
        let mut book = AppBook::default();
        let w = win(notepad());
        let r = render(&w, &w.root, &mut book, TextOptions::default(), false);
        assert_eq!(
            r.text,
            "app \"Notepad\" · window \"Untitled - Notepad\" · 1000×700 · focused [3]\n\
             [1] window \"Untitled - Notepad\"\n  [2] menu item \"File\"\n  [3] text area \"Text editor\" = \"Hello \\\"world\\\"\\nline two\" focused caret 5\n  [4] button \"close\""
        );
        assert_eq!(r.focused, Some(3));
        assert_eq!(r.elements, 4);
    }

    #[test]
    fn an_element_keeps_its_index_and_a_new_one_never_reuses_a_number() {
        let mut book = AppBook::default();
        let w = win(notepad());
        render(&w, &w.root, &mut book, TextOptions::default(), false);
        let mut root = notepad();
        root.children.remove(0);
        root.children.push(n("button", Some("Save"), 77, vec![]));
        let w2 = win(root);
        let r = render(&w2, &w2.root, &mut book, TextOptions::default(), false);
        assert!(r.text.contains("[3] text area"));
        assert!(r.text.contains("[5] button \"Save\""), "{}", r.text);
    }

    #[test]
    fn two_elements_with_one_key_get_two_numbers() {
        let mut book = AppBook::default();
        let w = win(n("window", Some("W"), 1, vec![n("button", Some("A"), 7, vec![]), n("button", Some("B"), 7, vec![])]));
        let r = render(&w, &w.root, &mut book, TextOptions::default(), false);
        assert!(r.text.ends_with("[2] button \"A\"\n  [3] button \"B\""), "{}", r.text);
    }

    #[test]
    fn cuts_names_and_values_by_scalars() {
        assert_eq!(cut_name(&"é".repeat(101)), "é".repeat(100) + "…");
        assert_eq!(cut_value(&"x".repeat(170)), "x".repeat(160) + "…(+10 chars)");
        assert_eq!(quote("a\u{1}b/ü"), "\"a\\u0001b/ü\"");
    }

    #[test]
    fn thin_and_others_and_geometry() {
        let mut book = AppBook::default();
        let mut w = win(n("window", Some("W"), 1, vec![n("pane", None, 2, vec![])]));
        w.others = vec![("Second".into(), true)];
        let r = render(&w, &w.root, &mut book, TextOptions { geometry: true, ..Default::default() }, true);
        assert!(r.thin);
        assert_eq!(r.text, "app \"Notepad\" · window \"Untitled - Notepad\" · 1000×700 · thin tree, see the screenshot\nother windows: \"Second\" minimized\n[1] window \"W\"");
        let mut root = n("window", Some("W"), 1, vec![]);
        root.frame = Some(Rect { x: 110.0, y: 60.0, w: 20.0, h: 10.0 });
        let w = win(root);
        let r = render(&w, &w.root, &mut AppBook::default(), TextOptions { geometry: true, ..Default::default() }, false);
        assert!(r.text.ends_with("[1] window \"W\" @10,10 20×10"), "{}", r.text);
    }

    #[test]
    fn the_budget_keeps_the_focused_path_and_says_what_it_cut() {
        let mut items: Vec<RawNode<()>> = (0..400).map(|i| n("row", Some(&format!("row number {i}")), 100 + i, vec![])).collect();
        let mut focus = n("input", Some("Search"), 9, vec![]);
        focus.states = vec!["focused"];
        items.push(focus);
        let root = n("window", Some("W"), 1, vec![n("list", Some("Rows"), 2, items)]);
        let w = win(root);
        let r = render(&w, &w.root, &mut AppBook::default(), TextOptions { budget_bytes: 2_000, ..Default::default() }, false);
        assert!(r.text.len() <= 2_100, "{}", r.text.len());
        assert!(r.text.contains("input \"Search\" focused"));
        assert!(r.text.ends_with("elements left out; observe with element: 2 to see one part whole)"), "{}", r.text);
        assert!(r.omitted > 300);
    }

    #[test]
    fn space_caps_the_long_edge() {
        let s = space_of(2560.0, 1440.0);
        assert_eq!((s.width, s.height), (1280, 720));
        assert_eq!(space_of(800.0, 600.0).scale, 1.0);
    }
}
