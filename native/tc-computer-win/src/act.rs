//! The event tiers of the Windows service (docs/computer-protocol.md §5.2,
//! §5.3, §29.4): pointer and key steps at `process` (window messages),
//! `front` (the same, with the window held forward for the step) and
//! `session` (real input, under the machine-wide session lock, stopped by
//! the person's own input); typing by keys or by paste under the clipboard
//! lock; screenshots and zoom (§6); and the agent cursor.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::capture::{self, geometry, write_shot, Image};
use crate::clip;
use crate::desktop::{fail, Button, Desktop, Event, KeyPhase, Win};
use crate::generated::contract::{locks as lock_limits, service as limits};
use crate::input::{self, in_space, parse_combo, parse_mods, pieces, to_screen, to_space, Mods, Piece};
use crate::locks::{guard, lock_file, machine_lock_path, user_temp};
use crate::service::{Held, Service};
use crate::wire::*;

/// One part of a step: an event to post, or a hold the person or a cancel cuts short.
enum Part {
    Post(Event),
    Hold(Duration),
}

/// The event that lets go of a press: a button's up, a key's up.
fn release_of(e: &Event) -> Option<Event> {
    match e {
        Event::Button { at, button, down: true, mods } => Some(Event::Button { at: *at, button: *button, down: false, mods: *mods }),
        Event::Key { combo, phase: KeyPhase::Down } => Some(Event::Key { combo: *combo, phase: KeyPhase::Up }),
        _ => None,
    }
}

/// What one event step did, beyond its tier.
#[derive(Default)]
pub(crate) struct EventDone {
    pub via: Option<InputVia>,
    pub clipboard: Option<ClipboardOutcome>,
    pub session: Option<SessionChange>,
    /// the agent cursor after the step, in the session's space
    pub cursor: Option<(i64, i64)>,
    /// a click-class step's point, for the streams' click mark
    pub click: Option<(i64, i64)>,
}

fn needs(tier: Tier, why: &str) -> ComputerError {
    ComputerError { needed: Some(tier), ..fail(ComputerErrorKind::NeedsTier, why) }
}


impl<D: Desktop> Service<D> {
    /// The session's space for a window: its last screenshot's, else a default screenshot's.
    pub(crate) fn space(&self, session: &str, win: &Win) -> CoordinateSpace {
        guard(&self.state).spaces.get(&(session.to_string(), win.id)).cloned().unwrap_or_else(|| geometry(win.frame.w, win.frame.h, None))
    }

    /// A step's point: an element's centre, a coordinate in the session's space, or the agent cursor.
    /// Returns the screen point and the space point.
    fn point(&self, session: &str, pid: i64, win: &Win, space: &CoordinateSpace, element: Option<i64>, coordinate: Option<&Point>) -> Result<Option<((f64, f64), (i64, i64))>, ComputerError> {
        if let Some(i) = element {
            let h = self.element(session, pid, i)?;
            let f = self.desktop.frame_of(&h).filter(|f| f.w > 0.0 && f.h > 0.0).ok_or_else(|| ComputerError { element: Some(i), ..fail(ComputerErrorKind::ActionUnsupported, format!("[{i}] has no place on the screen")) })?;
            // the centre, clipped to the window
            let x = (f.x + f.w / 2.0).clamp(win.frame.x, win.frame.x + win.frame.w - 1.0);
            let y = (f.y + f.h / 2.0).clamp(win.frame.y, win.frame.y + win.frame.h - 1.0);
            return Ok(Some(((x, y), to_space(&win.frame, space, (x, y)))));
        }
        if let Some(c) = coordinate {
            let p = (c.first().copied().unwrap_or(-1), c.get(1).copied().unwrap_or(-1));
            if !in_space(space, p) {
                return Err(ComputerError { coordinate: Some(c.clone()), space: Some(space.clone()), ..fail(ComputerErrorKind::OutOfBounds, format!("({}, {}) is outside the window's {}×{}", p.0, p.1, space.width, space.height)) });
            }
            return Ok(Some((to_screen(&win.frame, space, p), p)));
        }
        let cursor = guard(&self.state).cursors.get(&(session.to_string(), pid)).filter(|(w, _)| *w == win.id).map(|(_, p)| *p);
        Ok(cursor.map(|p| (to_screen(&win.frame, space, p), p)))
    }

    /// One pointer or key step at the first allowed event tier that can express it.
    pub(crate) fn event_step(&self, session: &str, pid: i64, window: Option<&WindowRef>, a: &ComputerAction, tiers: &[Tier], paste_quiet_ms: Option<i64>, cancel: &AtomicBool) -> Result<(Tier, EventDone), ComputerError> {
        use ComputerActionName::*;
        let key = (session.to_string(), pid);
        let held = guard(&self.state).held.get(&key).cloned();
        let mut tier = input::event_tier(tiers, a).ok_or_else(|| needs(input::needed_tier(a), &format!("{} needs a tier this call does not allow", a.action.as_str())))?;
        if input::is_pointer(a.action) {
            if let Some(h) = &held {
                if !tiers.contains(&h.tier) {
                    return Err(needs(h.tier, "the button is held at another tier"));
                }
                tier = h.tier;
            }
        }
        let win = self.desktop.window(pid, window)?;
        if win.minimized {
            return Err(fail(ComputerErrorKind::WindowMinimized, "the window is minimized"));
        }
        let space = self.space(session, &win);
        let element = a.element.map(|i| self.element(session, pid, i)).transpose()?;
        let mods = if input::is_pointer(a.action) { parse_mods(a.text.as_deref()).map_err(|e| fail(ComputerErrorKind::ActionUnsupported, e))? } else { Mods::default() };
        let at = self.point(session, pid, &win, &space, a.element, a.coordinate.as_ref())?;
        let need_at = || at.ok_or_else(|| fail(ComputerErrorKind::ActionUnsupported, "no point yet: name an element or a coordinate"));
        let mut done = EventDone::default();
        let mut events: Vec<Part> = Vec::new();
        let button = match a.action {
            RightClick => Button::Right,
            MiddleClick => Button::Middle,
            _ => Button::Left,
        };
        match a.action {
            LeftClick | RightClick | MiddleClick | DoubleClick | TripleClick => {
                let (s, p) = need_at()?;
                let count = match a.action {
                    DoubleClick => 2,
                    TripleClick => 3,
                    _ => 1,
                };
                let hold = Duration::from_secs_f64(a.duration.unwrap_or(0.0).clamp(0.0, 10.0));
                if hold.is_zero() {
                    events.push(Part::Post(Event::Click { at: s, button, count, hold, mods }));
                } else {
                    // the last press held as a wait the person or a cancel can cut short, its release always sent
                    if count > 1 {
                        events.push(Part::Post(Event::Click { at: s, button, count: count - 1, hold: Duration::ZERO, mods }));
                    }
                    events.push(Part::Post(Event::Button { at: s, button, down: true, mods }));
                    events.push(Part::Hold(hold));
                    events.push(Part::Post(Event::Button { at: s, button, down: false, mods }));
                }
                done.cursor = Some(p);
                done.click = Some(p);
            }
            MouseMove => {
                let (s, p) = need_at()?;
                events.push(Part::Post(Event::Move { at: s }));
                done.cursor = Some(p);
            }
            LeftClickDrag => {
                let start = if a.start_element.is_some() || a.start_coordinate.is_some() {
                    self.point(session, pid, &win, &space, a.start_element, a.start_coordinate.as_ref())?
                } else {
                    None
                };
                let ((s0, _), (s1, p1)) = (start.ok_or_else(|| fail(ComputerErrorKind::ActionUnsupported, "a drag needs its start"))?, need_at()?);
                events.push(Part::Post(Event::Move { at: s0 }));
                events.push(Part::Post(Event::Button { at: s0, button: Button::Left, down: true, mods }));
                // the drag in ten moves, so an app that tracks the pointer sees it travel
                for k in 1..=10 {
                    let t = k as f64 / 10.0;
                    events.push(Part::Post(Event::Move { at: (s0.0 + (s1.0 - s0.0) * t, s0.1 + (s1.1 - s0.1) * t) }));
                }
                events.push(Part::Post(Event::Button { at: s1, button: Button::Left, down: false, mods }));
                done.cursor = Some(p1);
            }
            LeftMouseDown | LeftMouseUp => {
                let (s, p) = need_at()?;
                let down = a.action == LeftMouseDown;
                if down && held.is_some() {
                    return Err(fail(ComputerErrorKind::ActionUnsupported, "the button is already down; left_mouse_up first"));
                }
                events.push(Part::Post(Event::Button { at: s, button: Button::Left, down, mods }));
                done.cursor = Some(p);
                if down {
                    done.click = Some(p);
                }
            }
            Scroll => {
                let (s, p) = match at {
                    Some(x) => x,
                    None => {
                        let c = (space.width / 2, space.height / 2);
                        (to_screen(&win.frame, &space, c), c)
                    }
                };
                let n = a.scroll_amount.unwrap_or(1).clamp(1, 50) as i32;
                let (dx, dy) = match a.scroll_direction {
                    Some(ScrollDirection::Up) => (0, -n),
                    Some(ScrollDirection::Left) => (-n, 0),
                    Some(ScrollDirection::Right) => (n, 0),
                    _ => (0, n),
                };
                events.push(Part::Post(Event::Wheel { at: s, dx, dy, mods }));
                done.cursor = Some(p);
            }
            Key | HoldKey => {
                let combo = parse_combo(a.text.as_deref().unwrap_or("")).map_err(|e| fail(ComputerErrorKind::ActionUnsupported, e))?;
                if a.action == Key {
                    for _ in 0..a.repeat.unwrap_or(1).clamp(1, 100) {
                        events.push(Part::Post(Event::Key { combo, phase: KeyPhase::Tap }));
                    }
                } else {
                    events.push(Part::Post(Event::Key { combo, phase: KeyPhase::Down }));
                    events.push(Part::Hold(Duration::from_secs_f64(a.duration.unwrap_or(0.0).clamp(0.0, 300.0))));
                    events.push(Part::Post(Event::Key { combo, phase: KeyPhase::Up }));
                }
            }
            Type => {
                let text = a.text.clone().unwrap_or_default();
                let keys = (text.encode_utf16().count() <= input::KEYS_MAX_UNITS).then(|| pieces(&text)).flatten();
                match keys {
                    // real input takes the text whole: the platform sends it as Unicode packets and a Return per line
                    // break, in small calls in order (input::text_records), so nothing it types can overtake the rest
                    Some(_) if tier == Tier::Session => {
                        done.via = Some(InputVia::Keys);
                        events.push(Part::Post(Event::Text(text.clone())));
                    }
                    Some(ps) => {
                        done.via = Some(InputVia::Keys);
                        events.extend(ps.into_iter().map(|p| {
                            Part::Post(match p {
                                Piece::Text(t) => Event::Text(t),
                                Piece::Key(vk) => Event::Key { combo: input::Combo { mods: Mods::default(), key: input::Key::Vk(vk) }, phase: KeyPhase::Tap },
                            })
                        }));
                    }
                    None => return self.paste_step(session, &win, element.as_ref(), tier, &text, None, paste_quiet_ms),
                }
            }
            Paste => {
                let text = a.text.clone().unwrap_or_default();
                let html = match a.format {
                    Some(PasteFormat::Markdown) => Some(clip::markdown_html(&text)),
                    Some(PasteFormat::Html) => Some(text.clone()),
                    _ => None,
                };
                let plain = if a.format == Some(PasteFormat::Html) { clip::html_text(&text) } else { text };
                return self.paste_step(session, &win, element.as_ref(), tier, &plain, html.as_deref(), paste_quiet_ms);
            }
            _ => return Err(fail(ComputerErrorKind::ActionUnsupported, format!("{} is not an input step", a.action.as_str()))),
        }
        let element = element.as_ref();
        let typing = input::is_keys(a.action);
        let person = |tier: Tier| -> Result<(), ComputerError> {
            if tier == Tier::Session && self.person.interrupted.load(Ordering::SeqCst) {
                return Err(ComputerError { by: Some(InterruptedBy::Person), ..fail(ComputerErrorKind::Interrupted, "the person used the PC") });
            }
            Ok(())
        };
        let run = |tier: Tier| -> Result<(), ComputerError> {
            // what the step pressed and has not let go: on any failure it is let go, in reverse order
            let mut pressed: Vec<Event> = Vec::new();
            let mut go = || -> Result<(), ComputerError> {
                if typing && tier == Tier::Session {
                    if let Some(h) = element {
                        self.desktop.focus(h)?;
                    }
                }
                for part in &events {
                    person(tier)?;
                    if cancel.load(Ordering::SeqCst) {
                        return Err(fail(ComputerErrorKind::Cancelled, "cancelled"));
                    }
                    match part {
                        Part::Post(e) => {
                            self.desktop.post(&win, element, tier, e)?;
                            match e {
                                Event::Button { down: true, .. } | Event::Key { phase: KeyPhase::Down, .. } => pressed.push(e.clone()),
                                Event::Button { button, down: false, .. } => pressed.retain(|p| !matches!(p, Event::Button { button: b, .. } if b == button)),
                                Event::Key { combo, phase: KeyPhase::Up } => pressed.retain(|p| !matches!(p, Event::Key { combo: c, .. } if c == combo)),
                                _ => {}
                            }
                        }
                        // held for its duration, cut short when the call is cancelled or the person acts
                        Part::Hold(d) => {
                            let until = Instant::now() + *d;
                            while Instant::now() < until && !cancel.load(Ordering::SeqCst) && person(tier).is_ok() {
                                std::thread::sleep(Duration::from_millis(10).min(until.saturating_duration_since(Instant::now())));
                            }
                        }
                    }
                }
                person(tier)
            };
            let r = go();
            if r.is_err() {
                for e in pressed.iter().rev().filter_map(release_of) {
                    let _ = self.desktop.post(&win, element, tier, &e);
                }
            }
            r
        };
        done.session = self.at_tier(session, &win, tier, &run)?;
        // the held button: kept per session × app until its up, released after 30 s
        match a.action {
            LeftMouseDown => {
                // a session-tier button keeps the PC: the machine's session lock until its up (§5.1)
                let lock = (tier == Tier::Session).then(|| lock_file(&machine_lock_path(&user_temp(), "session"), Duration::from_millis(lock_limits::CLIPBOARD_WAIT_MS as u64)).ok().flatten().map(std::sync::Arc::new)).flatten();
                guard(&self.state).held.insert(key, Held { tier, window: win.id, at: done.cursor.unwrap_or((0, 0)), mods, since: Instant::now(), _lock: lock });
            }
            LeftMouseUp => {
                guard(&self.state).held.remove(&key);
            }
            _ => {}
        }
        if let Some(p) = done.cursor {
            guard(&self.state).cursors.insert((session.to_string(), pid), (win.id, p));
        }
        if let Some(p) = done.click {
            self.click_mark(session, &win, &space, p);
        }
        Ok((tier, done))
    }

    /// Runs `f` at `tier`: as it is at `process`; with the window forward and the person's front window put back
    /// after at `front`; under the session lock, with the window forward and the person watched, at `session`.
    pub(crate) fn at_tier(&self, session: &str, win: &Win, tier: Tier, f: &dyn Fn(Tier) -> Result<(), ComputerError>) -> Result<Option<SessionChange>, ComputerError> {
        match tier {
            Tier::Process => f(tier).map(|_| None),
            Tier::Front => {
                // the front is one at a time: never in the middle of another step's front or session hold, here or in another service
                let _front = guard(&self.front_lock);
                let _lock = lock_file(&machine_lock_path(&user_temp(), "session"), Duration::from_millis(lock_limits::CLIPBOARD_WAIT_MS as u64))
                    .ok()
                    .flatten()
                    .ok_or_else(|| ComputerError { reason: Some(ErrorReason::InUse), ..fail(ComputerErrorKind::SessionUnavailable, "another session has the PC") })?;
                let before = self.desktop.front();
                if !self.desktop.raise(win.id) {
                    return Err(ComputerError { reason: Some(ErrorReason::ActivationRefused), ..fail(ComputerErrorKind::SessionUnavailable, "Windows did not let the window come forward") });
                }
                let r = f(tier);
                // the posts are queued: give the app a moment to take them while it is in front
                std::thread::sleep(Duration::from_millis(150));
                if let Some((_, hwnd)) = before.filter(|(_, h)| *h != win.id) {
                    self.desktop.raise(hwnd);
                }
                r.map(|_| None)
            }
            _ => self.session_hold(session, win, f).map(Some),
        }
    }

    fn brief(&self, front: Option<(i64, i64)>) -> Option<AppBrief> {
        let (pid, _) = front?;
        let apps = self.desktop.apps(false).ok()?;
        apps.into_iter().find(|a| a.pid == pid).map(|a| AppBrief { pid: a.pid, bundle_id: a.bundle_id, name: a.name })
    }

    /// The session tier (§5.2): refused while the screen is locked or another session holds the PC; the window
    /// forward, the step run with the person watched, and what it changed recorded for `input.restoreSession`.
    fn session_hold(&self, session: &str, win: &Win, f: &dyn Fn(Tier) -> Result<(), ComputerError>) -> Result<SessionChange, ComputerError> {
        if self.desktop.locked() {
            return Err(ComputerError { reason: Some(ErrorReason::Locked), ..fail(ComputerErrorKind::SessionUnavailable, "the screen is locked") });
        }
        let _front = guard(&self.front_lock);
        let _lock = lock_file(&machine_lock_path(&user_temp(), "session"), Duration::from_millis(lock_limits::CLIPBOARD_WAIT_MS as u64))
            .ok()
            .flatten()
            .ok_or_else(|| ComputerError { reason: Some(ErrorReason::InUse), ..fail(ComputerErrorKind::SessionUnavailable, "another session has the PC") })?;
        let front_before = self.desktop.front();
        let pointer_before = self.desktop.pointer();
        self.person.interrupted.store(false, Ordering::SeqCst);
        self.person.active.store(true, Ordering::SeqCst);
        let raised = self.desktop.raise(win.id);
        let r = if raised { f(Tier::Session) } else { Err(ComputerError { reason: Some(ErrorReason::ActivationRefused), ..fail(ComputerErrorKind::SessionUnavailable, "Windows did not let the window come forward") }) };
        self.person.active.store(false, Ordering::SeqCst);
        let pointer_after = self.desktop.pointer();
        let change = SessionChange {
            frontmost: SessionChangeFrontmost { before: self.brief(front_before), after: self.brief(self.desktop.front()) },
            pointer: SessionChangePointer { before: vec![pointer_before.0, pointer_before.1], after: vec![pointer_after.0, pointer_after.1] },
            restorable: true,
            ..Default::default()
        };
        // what the session tier took is what the first session step since the last restore found
        guard(&self.state).restore.get_or_insert((front_before.map(|(_, h)| h), pointer_before));
        match r {
            Ok(()) => Ok(change),
            Err(mut e) => {
                if e.kind == ComputerErrorKind::Interrupted {
                    self.notify("session/interrupted", json!({ "session": session, "by": "person", "at": crate::service::now_ms() }));
                }
                e.session = Some(change);
                Err(e)
            }
        }
    }

    /// `input.restoreSession`: the front window and the pointer put back as the last session step found them.
    pub(crate) fn restore_session(&self) -> SessionRestore {
        let last = guard(&self.state).restore.take();
        let Some((front, pointer)) = last else {
            return SessionRestore { frontmost: RestoreOutcome::Nothing, pointer: RestoreOutcome::Nothing, held: None, person_guard: None };
        };
        let frontmost = match front {
            Some(h) if self.desktop.raise(h) => RestoreOutcome::Restored,
            // the window the person had in front is gone, or Windows would not bring it back
            Some(_) => RestoreOutcome::AppGone,
            None => RestoreOutcome::Nothing,
        };
        self.desktop.set_pointer(pointer);
        SessionRestore { frontmost, pointer: RestoreOutcome::Restored, held: None, person_guard: None }
    }

    /// `paste`, and `type` past what keys take (§5.3): under the clipboard lock, the person's copy held off,
    /// every format saved, the content written, the target's paste, its change awaited, the clipboard put back.
    #[allow(clippy::too_many_arguments)]
    fn paste_step(&self, session: &str, win: &Win, element: Option<&D::Handle>, tier: Tier, text: &str, html: Option<&str>, quiet_ms: Option<i64>) -> Result<(Tier, EventDone), ComputerError> {
        let busy = |reason: Option<ErrorReason>, why: &str| ComputerError { reason, ..fail(ComputerErrorKind::ClipboardBusy, why) };
        let _lock = lock_file(&machine_lock_path(&user_temp(), "clipboard"), Duration::from_millis(lock_limits::CLIPBOARD_WAIT_MS as u64))
            .ok()
            .flatten()
            .ok_or_else(|| busy(None, "another paste holds the clipboard"))?;
        self.clip.poll(&self.desktop);
        if let Some(q) = quiet_ms {
            if self.clip.foreign_within(q) {
                return Err(busy(Some(ErrorReason::RecentCopy), "the person copied something moments ago"));
            }
        }
        // the watch leaves the numbers the service's own writes move through alone, until it has noted the last one
        self.clip.writing.store(true, Ordering::SeqCst);
        let before = self.desktop.clip_seq();
        let saved = match self.desktop.clip_save() {
            Ok(c) => c,
            Err(e) => {
                self.clip.writing.store(false, Ordering::SeqCst);
                return Err(e);
            }
        };
        // a copy between the save and the write would be lost under the write: refused, nothing written
        if self.desktop.clip_seq() != before {
            self.clip.writing.store(false, Ordering::SeqCst);
            return Err(busy(None, "the clipboard changed while it was saved"));
        }
        let put = self.desktop.clip_put(text, html);
        let mine = put.is_ok().then(|| self.desktop.clip_seq());
        let run = |tier: Tier| -> Result<(), ComputerError> {
            if tier == Tier::Session {
                if let Some(h) = element {
                    self.desktop.focus(h)?;
                }
            }
            self.desktop.post(win, element, tier, &Event::Paste)
        };
        let r = put.and_then(|_| self.at_tier(session, win, tier, &run));
        if r.is_ok() {
            // the app reads the clipboard as it handles the paste: 500 ms, never cut short (a cancel would hand it the person's copy)
            std::thread::sleep(Duration::from_millis(500));
        }
        // put back on every exit, unless the person copied since the write
        let theirs = mine.is_some_and(|m| self.desktop.clip_seq() != m);
        let restored = if theirs { None } else { Some(self.desktop.clip_restore(&saved)) };
        self.clip.ours(self.desktop.clip_seq());
        self.clip.writing.store(false, Ordering::SeqCst);
        let session_change = r?;
        let outcome = match restored {
            None => ClipboardOutcome::KeptPersonCopy,
            Some(Ok(())) => ClipboardOutcome::Restored,
            Some(Err(_)) => return Err(busy(None, "the paste ran but the clipboard could not be put back")),
        };
        Ok((tier, EventDone { via: Some(InputVia::Paste), clipboard: Some(outcome), session: session_change, ..Default::default() }))
    }

    /// Sends a click's place to each of the session's streams on the window, in the newest frame's pixels.
    fn click_mark(&self, session: &str, win: &Win, space: &CoordinateSpace, p: (i64, i64)) {
        for s in self.streams_on(session, win.id) {
            let (w, h) = s.size();
            if w == 0 || space.width == 0 {
                continue;
            }
            let at = vec![p.0 * w as i64 / space.width, p.1 * h as i64 / space.height];
            self.notify("capture/click", json!({ "stream": s.id, "at": at, "width": w, "height": h }));
        }
    }

    /// Lets go of a held button (`session.close`, `shutdown`, 30 s with no up).
    pub(crate) fn release_held(&self, session: Option<&str>, older_than: Option<Duration>) {
        self.release_where(|s, h| session.is_none_or(|x| x == s) && older_than.is_none_or(|d| h.since.elapsed() >= d));
    }

    /// Every session-tier button let go: the person acted while one was held between calls.
    pub(crate) fn release_held_session(&self) {
        self.release_where(|_, h| h.tier == Tier::Session);
    }

    fn release_where(&self, pick: impl Fn(&str, &Held) -> bool) {
        let gone: Vec<((String, i64), Held)> = {
            let mut st = guard(&self.state);
            let keys: Vec<(String, i64)> = st.held.iter().filter(|((s, _), h)| pick(s, h)).map(|(k, _)| k.clone()).collect();
            keys.into_iter().filter_map(|k| st.held.remove(&k).map(|h| (k, h))).collect()
        };
        for ((s, pid), h) in gone {
            let Ok(win) = self.desktop.window(pid, Some(&WindowRef { id: Some(h.window), title: None })) else { continue };
            let at = to_screen(&win.frame, &self.space(&s, &win), h.at);
            // at its own tier: a session-tier button is real input and only real input lets it go, with its modifiers
            let _ = self.desktop.post(&win, None, h.tier, &Event::Button { at, button: Button::Left, down: false, mods: h.mods });
        }
    }

    // ── capture ─────────────────────────────────────────────────────────

    /// A screenshot of the window, or of `region` (session space) at full resolution: written under the data dir.
    /// A whole-window shot sets the session's space for the window; a zoom never does.
    pub(crate) fn shoot(&self, session: &str, win: &Win, max_edge: Option<i64>, region: Option<&Region>, format: Option<ShotFormat>, action: &str) -> Result<Shot, ComputerError> {
        if win.minimized {
            return Err(fail(ComputerErrorKind::WindowMinimized, "the window is minimized"));
        }
        let started = Instant::now();
        let raw = self.desktop.grab(win.id)?;
        let (pic, scale, region_out) = match region {
            None => {
                let g = geometry(raw.width as f64, raw.height as f64, max_edge);
                (raw.scaled(g.width as usize, g.height as usize), g.scale, None)
            }
            Some(r) => {
                let space = self.space(session, win);
                let [x0, y0, x1, y1] = [0, 1, 2, 3].map(|i| r.get(i).copied().unwrap_or(-1));
                if x1 <= x0 || y1 <= y0 || !in_space(&space, (x0, y0)) || !in_space(&space, (x1 - 1, y1 - 1)) {
                    return Err(ComputerError { space: Some(space.clone()), ..fail(ComputerErrorKind::OutOfBounds, format!("the region {r:?} is not inside the window's {}×{}", space.width, space.height)) });
                }
                let px = |v: i64| (v as f64 / space.scale).round().max(0.0) as usize;
                let crop = raw.crop(px(x0), px(y0), px(x1), px(y1));
                let g = geometry(crop.width as f64, crop.height as f64, max_edge);
                (crop.scaled(g.width as usize, g.height as usize), g.scale, Some(r.clone()))
            }
        };
        if started.elapsed() > Duration::from_secs(5) {
            return Err(fail(ComputerErrorKind::CaptureFailed, "the capture took over 5 s"));
        }
        let (format, bytes) = self.encoded(&pic, format)?;
        let dir = capture::shot_dir(&self.data_dir().ok_or_else(|| fail(ComputerErrorKind::NotInitialized, "initialize first"))?, session);
        let n = {
            let mut st = guard(&self.state);
            let next = st.shot_numbers.get(session).copied().unwrap_or_else(|| capture::next_number(&dir));
            st.shot_numbers.insert(session.to_string(), next + 1);
            next
        };
        let path = write_shot(&dir, &capture::stem_name(n, action), format, &bytes).map_err(|e| fail(ComputerErrorKind::CaptureFailed, format!("cannot write the shot: {e}")))?;
        if region.is_none() {
            let space = CoordinateSpace { width: pic.width as i64, height: pic.height as i64, scale };
            guard(&self.state).spaces.insert((session.to_string(), win.id), space);
        }
        Ok(Shot {
            path: path.to_string_lossy().into_owned(),
            format,
            width: pic.width as i64,
            height: pic.height as i64,
            bytes: bytes.len() as i64,
            scale,
            window: ShotWindow { id: win.id, frame: win.frame.clone() },
            region: region_out,
            blank: capture::blank(&pic),
            captured_at: crate::service::now_ms(),
        })
    }

    /// A named format as named; none: JPEG, and PNG too for a flat image, kept when no larger (§6, A1).
    fn encoded(&self, pic: &Image, format: Option<ShotFormat>) -> Result<(ShotFormat, Vec<u8>), ComputerError> {
        let q = crate::generated::contract::shot::JPEG_QUALITY as f32;
        match format {
            Some(f @ (ShotFormat::Png | ShotFormat::Jpeg)) => Ok((f, self.desktop.encode(pic, f, q)?)),
            _ => {
                let jpeg = self.desktop.encode(pic, ShotFormat::Jpeg, q)?;
                if capture::try_png_too(pic) {
                    let png = self.desktop.encode(pic, ShotFormat::Png, q)?;
                    if png.len() <= jpeg.len() {
                        return Ok((ShotFormat::Png, png));
                    }
                }
                Ok((ShotFormat::Jpeg, jpeg))
            }
        }
    }

    /// The held button's 30 s and the clipboard's watch, every 250 ms from the service's watch thread.
    pub(crate) fn tick(&self) {
        self.release_held(None, Some(Duration::from_millis(limits::HELD_INPUT_RELEASE_MS as u64)));
        self.clip.poll(&self.desktop);
    }
}
