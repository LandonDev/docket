//! What the service needs of a desktop (docs/computer-protocol.md §29.2):
//! the apps and their windows, a window's tree in the grammar's words, the
//! invisible tier's actions on one element, and (§29.4) input at the event
//! tiers, window capture, the clipboard and launching. `platform::windows`
//! is the real one over UI Automation and Win32; the tests drive the
//! service over a fake, which implements only what a test needs: every
//! input, capture and clipboard primitive defaults to "not on this desktop".

use std::time::{Duration, Instant};

use crate::capture::Image;
use crate::input::{Combo, Mods};
use crate::text::{RawNode, RawWindow};
use crate::wire::{AppInfo, ComputerAction, ComputerError, ComputerErrorKind, DisplayInfo, InputVia, Rect, ShotFormat, Tier, WindowRef};

/// What an action did, as far as the desktop can tell.
#[derive(Debug, Clone, Default)]
pub struct Acted {
    /// the typing route that ran, for `type`
    pub via: Option<InputVia>,
    /// the element's value read back after a write, when it has one
    pub value: Option<String>,
}

pub trait Desktop: Send + Sync + 'static {
    /// An element as the platform holds it between reads.
    type Handle: Clone + Send + 'static;

    /// `{ version, arch }` for `initialize`.
    fn os(&self) -> (String, String);
    fn displays(&self) -> Vec<DisplayInfo>;
    /// Regular apps (those with a window the taskbar shows), the active one first, then by name.
    fn apps(&self, windows: bool) -> Result<Vec<AppInfo>, ComputerError>;
    /// The window of `pid` that `window` names (none: its main window) as a tree; `from` reads that element's subtree instead.
    fn read(&self, pid: i64, window: Option<&WindowRef>, from: Option<&Self::Handle>, deadline: Instant) -> Result<RawWindow<Self::Handle>, ComputerError>;
    /// One `ax`-tier action on an element (left_click, set_value, perform, select_text, type into an empty field).
    fn act(&self, pid: i64, element: &Self::Handle, action: &ComputerAction) -> Result<Acted, ComputerError>;
    /// Whether the process that started this one is still running.
    fn parent_alive(&self) -> bool {
        true
    }

    // ── input (§29.4) ───────────────────────────────────────────────────

    /// The window of `pid` that `window` names (none: its main window), for input and capture.
    fn window(&self, _pid: i64, _window: Option<&WindowRef>) -> Result<Win, ComputerError> {
        Err(not_here("windows"))
    }
    /// An element's frame on the screen, in pixels.
    fn frame_of(&self, _element: &Self::Handle) -> Option<Rect> {
        None
    }
    /// Gives an element the keyboard focus (the session tier: it may bring its window forward).
    fn focus(&self, _element: &Self::Handle) -> Result<(), ComputerError> {
        Err(not_here("focus"))
    }
    /// Posts one event at an event tier. `process` and `front` post window messages to the window
    /// (`element`'s own control for keys, when it has one); `session` sends real input.
    fn post(&self, _win: &Win, _element: Option<&Self::Handle>, _tier: Tier, _event: &Event) -> Result<(), ComputerError> {
        Err(not_here("input"))
    }
    /// The window in front and its app's pid.
    fn front(&self) -> Option<(i64, i64)> {
        None
    }
    /// Brings a window forward (restoring it if minimized); false when Windows refused.
    fn raise(&self, _window_id: i64) -> bool {
        false
    }
    /// The real pointer, in screen pixels.
    fn pointer(&self) -> (f64, f64) {
        (0.0, 0.0)
    }
    fn set_pointer(&self, _at: (f64, f64)) {}
    /// The screen is locked or another desktop (the secure desktop, the sign-in screen) has the input.
    fn locked(&self) -> bool {
        false
    }
    /// Calls `f` for every key and pointer event the person makes (never the service's own), from a thread of the desktop's.
    fn watch_person(&self, _f: Box<dyn Fn(PersonInput) + Send + Sync>) {}

    // ── capture (§6) ────────────────────────────────────────────────────

    /// The window's pixels, its frame's size, whether covered or not.
    fn grab(&self, _window_id: i64) -> Result<Image, ComputerError> {
        Err(ComputerError { kind: ComputerErrorKind::CaptureFailed, message: "this desktop captures nothing".into(), ..Default::default() })
    }
    fn encode(&self, _img: &Image, _format: ShotFormat, _quality: f32) -> Result<Vec<u8>, ComputerError> {
        Err(ComputerError { kind: ComputerErrorKind::CaptureFailed, message: "this desktop encodes nothing".into(), ..Default::default() })
    }
    /// Whether the window still exists.
    fn alive(&self, _window_id: i64) -> bool {
        false
    }

    // ── live video (§30) ────────────────────────────────────────────────

    /// Starts a capture of the window at the display's own rate, at least `fps`. Called on the window's capture thread.
    fn video_capture(&self, _window_id: i64, _fps: usize) -> Result<Box<dyn crate::video::WindowCapture>, ComputerError> {
        Err(not_here("video"))
    }
    /// An encoder for one stream. Called on the stream's thread.
    fn video_encoder(&self, _spec: &crate::video::EncoderSpec) -> Result<Box<dyn crate::video::VideoEncoder>, ComputerError> {
        Err(not_here("video"))
    }

    // ── the clipboard (§5.3) ────────────────────────────────────────────

    /// The clipboard's change count (Windows' sequence number).
    fn clip_seq(&self) -> i64 {
        0
    }
    /// Every format the clipboard holds, or `clipboard_busy` when one cannot be saved.
    fn clip_save(&self) -> Result<Clip, ComputerError> {
        Err(not_here("clipboard"))
    }
    /// Puts plain text, and HTML in the `HTML Format` when given.
    fn clip_put(&self, _text: &str, _html: Option<&str>) -> Result<(), ComputerError> {
        Err(not_here("clipboard"))
    }
    fn clip_restore(&self, _clip: &Clip) -> Result<(), ComputerError> {
        Err(not_here("clipboard"))
    }
    /// The clipboard's text (CF_UNICODETEXT), whole; None when it holds no text (§29.8).
    fn clip_text(&self) -> Result<Option<String>, ComputerError> {
        Err(not_here("clipboard"))
    }
    /// Empties the clipboard (§29.8, `clipboard.write { text: null }`).
    fn clip_empty(&self) -> Result<(), ComputerError> {
        Err(not_here("clipboard"))
    }

    // ── launching (§23) ─────────────────────────────────────────────────

    /// Starts an app by its exe name or path, with `args`, without bringing it forward; its pid.
    fn launch(&self, _exe: &str, _args: &[String]) -> Result<i64, ComputerError> {
        Err(not_here("launching"))
    }
}

/// A window as input and capture see it: its id (the HWND), its frame in screen pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct Win {
    pub id: i64,
    pub pid: i64,
    pub title: String,
    pub frame: Rect,
    pub minimized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// One input event. Points are screen pixels.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Move { at: (f64, f64) },
    Button { at: (f64, f64), button: Button, down: bool, mods: Mods },
    /// `count` clicks (2: a double click), the last held `hold` before its release
    Click { at: (f64, f64), button: Button, count: u8, hold: Duration, mods: Mods },
    /// wheel clicks: `dy` down, `dx` right
    Wheel { at: (f64, f64), dx: i32, dy: i32, mods: Mods },
    Key { combo: Combo, phase: KeyPhase },
    /// Unicode characters, at most a chunk (input::CHUNK_UNITS)
    Text(String),
    /// the target's paste (WM_PASTE at the message tiers, ctrl+V at the session tier)
    Paste,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyPhase {
    Tap,
    Down,
    Up,
}

/// What the person did, as the desktop's watch saw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersonInput {
    Escape,
    Key,
    Pointer,
}

/// The clipboard as saved: each format's id and bytes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Clip(pub Vec<(u32, Vec<u8>)>);

fn not_here(what: &str) -> ComputerError {
    fail(ComputerErrorKind::ActionUnsupported, format!("{what} is not on this desktop"))
}

/// A ComputerError of `kind` with its message.
pub fn fail(kind: ComputerErrorKind, message: impl Into<String>) -> ComputerError {
    ComputerError { kind, message: message.into(), ..Default::default() }
}

/// A node's subtree, depth first, for tests and the reader's checks.
pub fn walk<H>(node: &RawNode<H>, f: &mut impl FnMut(&RawNode<H>)) {
    f(node);
    for c in &node.children {
        walk(c, f);
    }
}
