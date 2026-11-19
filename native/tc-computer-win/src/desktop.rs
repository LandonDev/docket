//! What the service needs of a desktop (docs/computer-protocol.md §29.2):
//! the apps and their windows, a window's tree in the grammar's words, and
//! the invisible tier's actions on one element. `platform::windows` is the
//! real one over UI Automation; the tests drive the service over a fake.

use std::time::Instant;

use crate::text::{RawNode, RawWindow};
use crate::wire::{AppInfo, ComputerAction, ComputerError, ComputerErrorKind, DisplayInfo, InputVia, WindowRef};

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
