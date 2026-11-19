//! Input, capture, the clipboard and launching on Windows
//! (docs/computer-protocol.md §29.4, §29.6). The message tiers (`process`,
//! `front`) post window messages to the control under the point or with the
//! keyboard focus; the `session` tier sends real input with `SendInput`.
//! Every event the service sends carries `INPUT_TAG`, so the low-level
//! hooks tell the person's input from its own. A window's pixels come from
//! `PrintWindow` with full content (a covered window draws whole), encoded by
//! WIC.

#![allow(non_upper_case_globals)]

use std::ffi::c_void;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, ScreenToClient, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::Com::StructuredStorage::{IPropertyBag2, PROPBAG2};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, STREAM_SEEK_CUR};
use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, UOI_NAME};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId, GetProcessId};
use windows::Win32::System::Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_R4};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows::Win32::UI::WindowsAndMessaging::*;

use super::windows::com;
use crate::capture::Image;
use crate::desktop::{fail, Button, Clip, Event, KeyPhase, PersonInput};
use crate::input::{vk, Combo, Key, Mods, INPUT_TAG};
use crate::wire::{ComputerError, ComputerErrorKind, ErrorReason, ShotFormat, Tier};

fn hwnd(id: i64) -> HWND {
    HWND(id as *mut c_void)
}

fn lparam_xy(x: i32, y: i32) -> LPARAM {
    LPARAM(((y as u16 as u32) << 16 | x as u16 as u32) as isize)
}

// ── the front ───────────────────────────────────────────────────────────

/// The window in front (its top-level) and its pid.
pub fn front() -> Option<(i64, i64)> {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_invalid() {
            return None;
        }
        let top = GetAncestor(fg, GA_ROOT);
        let top = if top.is_invalid() { fg } else { top };
        let mut pid = 0u32;
        GetWindowThreadProcessId(top, Some(&mut pid));
        Some((pid as i64, top.0 as i64))
    }
}

/// Brings a window forward, restoring it if minimized. A process in the background may not take the front
/// (the foreground lock): joining the front thread's input lifts it, and a tap of Alt, sent as the service's
/// own input, makes it the last to have had input when that is not enough.
pub fn raise(id: i64) -> bool {
    let h = hwnd(id);
    unsafe {
        if !IsWindow(Some(h)).as_bool() {
            return false;
        }
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        for attempt in 0..2 {
            if GetForegroundWindow() == h {
                return true;
            }
            let fg = GetForegroundWindow();
            let theirs = if fg.is_invalid() { 0 } else { GetWindowThreadProcessId(fg, None) };
            let mine = GetCurrentThreadId();
            let joined = theirs != 0 && theirs != mine && AttachThreadInput(mine, theirs, true).as_bool();
            if attempt == 1 {
                send(&[key_input(vk::MENU, false), key_input(vk::MENU, true)]);
            }
            let _ = BringWindowToTop(h);
            let _ = SetForegroundWindow(h);
            if joined {
                let _ = AttachThreadInput(mine, theirs, false);
            }
            let until = Instant::now() + Duration::from_millis(300);
            while Instant::now() < until {
                if GetForegroundWindow() == h {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
        GetForegroundWindow() == h
    }
}

pub fn pointer() -> (f64, f64) {
    let mut p = POINT::default();
    let _ = unsafe { GetCursorPos(&mut p) };
    (p.x as f64, p.y as f64)
}

pub fn set_pointer(at: (f64, f64)) {
    let _ = unsafe { SetCursorPos(at.0.round() as i32, at.1.round() as i32) };
}

/// The input desktop is not the person's own (the lock screen, a UAC prompt on the secure desktop), or cannot be read.
pub fn locked() -> bool {
    unsafe {
        let Ok(desk) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) else { return true };
        let mut name = [0u16; 64];
        let mut needed = 0u32;
        let ok = GetUserObjectInformationW(HANDLE(desk.0), UOI_NAME, Some(name.as_mut_ptr() as *mut c_void), (name.len() * 2) as u32, Some(&mut needed)).is_ok();
        let _ = CloseDesktop(desk);
        let n = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        !ok || !String::from_utf16_lossy(&name[..n]).eq_ignore_ascii_case("Default")
    }
}

pub fn alive(id: i64) -> bool {
    unsafe { IsWindow(Some(hwnd(id))).as_bool() }
}

// ── the message tiers ───────────────────────────────────────────────────

/// The deepest visible, enabled control of `top` under a screen point, and the point in its client area.
fn control_at(top: HWND, at: (f64, f64)) -> (HWND, POINT) {
    let screen = POINT { x: at.0.floor() as i32, y: at.1.floor() as i32 };
    let mut h = top;
    unsafe {
        loop {
            let mut p = screen;
            let _ = ScreenToClient(h, &mut p);
            let c = ChildWindowFromPointEx(h, p, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT);
            if c.is_invalid() || c == h {
                return (h, p);
            }
            h = c;
        }
    }
}

/// The control keys go to at the message tiers: the element's own control when it has one, else the window's
/// thread's focus when it lies in the window, else the window.
pub fn key_target(top: i64, own: Option<HWND>) -> HWND {
    let top = hwnd(top);
    unsafe {
        if let Some(h) = own.filter(|h| !h.is_invalid() && (*h == top || IsChild(top, *h).as_bool())) {
            return h;
        }
        let thread = GetWindowThreadProcessId(top, None);
        let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        if GetGUIThreadInfo(thread, &mut info).is_ok() && !info.hwndFocus.is_invalid() && (info.hwndFocus == top || IsChild(top, info.hwndFocus).as_bool()) {
            return info.hwndFocus;
        }
    }
    top
}

fn wparam_mods(m: &Mods, buttons: usize) -> WPARAM {
    WPARAM(buttons | if m.shift { 0x0004 } else { 0 } | if m.ctrl { 0x0008 } else { 0 })
}

fn post(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> Result<(), ComputerError> {
    unsafe { PostMessageW(Some(h), msg, w, l) }.map_err(|e| fail(ComputerErrorKind::ActionUnsupported, format!("the window took no message: {}", e.message())))
}

const MK_LBUTTON: usize = 0x0001;
const MK_RBUTTON: usize = 0x0002;
const MK_MBUTTON: usize = 0x0010;

fn button_msgs(b: Button) -> (u32, u32, u32, usize) {
    match b {
        Button::Left => (WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK, MK_LBUTTON),
        Button::Right => (WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK, MK_RBUTTON),
        Button::Middle => (WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDBLCLK, MK_MBUTTON),
    }
}

fn key_lparam(vk: u16, up: bool) -> LPARAM {
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as isize;
    let ext = if extended(vk) { 1 << 24 } else { 0 };
    let up_bits: isize = if up { (1 << 30) | (1 << 31) } else { 0 };
    LPARAM(1 | (scan << 16) | ext | up_bits)
}

/// An event as window messages: the pointer's to the control under its point, keys and text to `keys`.
pub fn post_messages(top: i64, keys: HWND, e: &Event) -> Result<(), ComputerError> {
    let top = hwnd(top);
    match e {
        Event::Move { at } => {
            let (c, p) = control_at(top, *at);
            post(c, WM_MOUSEMOVE, WPARAM(0), lparam_xy(p.x, p.y))
        }
        Event::Button { at, button, down, mods } => {
            let (c, p) = control_at(top, *at);
            let (dn, upm, _, mk) = button_msgs(*button);
            if *down {
                post(c, WM_MOUSEMOVE, wparam_mods(mods, 0), lparam_xy(p.x, p.y))?;
                post(c, dn, wparam_mods(mods, mk), lparam_xy(p.x, p.y))
            } else {
                post(c, WM_MOUSEMOVE, wparam_mods(mods, mk), lparam_xy(p.x, p.y))?;
                post(c, upm, wparam_mods(mods, 0), lparam_xy(p.x, p.y))
            }
        }
        Event::Click { at, button, count, hold, mods } => {
            let (c, p) = control_at(top, *at);
            let (dn, upm, dbl, mk) = button_msgs(*button);
            let xy = lparam_xy(p.x, p.y);
            post(c, WM_MOUSEMOVE, wparam_mods(mods, 0), xy)?;
            for i in 0..*count {
                // the second press of a pair is the double click, as Windows itself sends it
                post(c, if i % 2 == 1 { dbl } else { dn }, wparam_mods(mods, mk), xy)?;
                if i + 1 == *count && !hold.is_zero() {
                    std::thread::sleep(*hold);
                }
                post(c, upm, wparam_mods(mods, 0), xy)?;
            }
            Ok(())
        }
        Event::Wheel { at, dx, dy, mods } => {
            let (c, _) = control_at(top, *at);
            let screen = lparam_xy(at.0.floor() as i32, at.1.floor() as i32);
            let one = |msg: u32, delta: i32| post(c, msg, WPARAM(((delta as i16 as u16 as usize) << 16) | wparam_mods(mods, 0).0), screen);
            for _ in 0..dy.unsigned_abs() {
                one(WM_MOUSEWHEEL, if *dy > 0 { -120 } else { 120 })?;
            }
            for _ in 0..dx.unsigned_abs() {
                one(WM_MOUSEHWHEEL, if *dx > 0 { 120 } else { -120 })?;
            }
            Ok(())
        }
        Event::Key { combo, phase } => {
            if !combo.mods.none() {
                return Err(fail(ComputerErrorKind::ActionUnsupported, "a posted key carries no modifier"));
            }
            match combo.key {
                Key::Char(ch) => {
                    let mut buf = [0u16; 2];
                    for u in ch.encode_utf16(&mut buf).iter() {
                        post(keys, WM_CHAR, WPARAM(*u as usize), LPARAM(1))?;
                    }
                    Ok(())
                }
                Key::Vk(v) => {
                    if *phase != KeyPhase::Up {
                        post(keys, WM_KEYDOWN, WPARAM(v as usize), key_lparam(v, false))?;
                    }
                    if *phase != KeyPhase::Down {
                        post(keys, WM_KEYUP, WPARAM(v as usize), key_lparam(v, true))?;
                    }
                    Ok(())
                }
            }
        }
        Event::Text(t) => {
            for u in t.encode_utf16() {
                post(keys, WM_CHAR, WPARAM(u as usize), LPARAM(1))?;
            }
            Ok(())
        }
        Event::Paste => {
            let mut r = 0usize;
            unsafe { SendMessageTimeoutW(keys, WM_PASTE, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 2000, Some(&mut r)) };
            Ok(())
        }
    }
}

// ── the session tier ────────────────────────────────────────────────────

fn extended(v: u16) -> bool {
    matches!(v, 0x21..=0x28 | 0x2D | 0x2E | 0x5B | 0x5C | 0x5D | 0x6F | 0x90 | 0xA3 | 0xA5)
}

fn key_input(v: u16, up: bool) -> INPUT {
    let mut flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
    if extended(v) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(v), wScan: unsafe { MapVirtualKeyW(v as u32, MAPVK_VK_TO_VSC) } as u16, dwFlags: flags, time: 0, dwExtraInfo: INPUT_TAG } } }
}

fn unicode_input(u: u16, up: bool) -> INPUT {
    let flags = KEYEVENTF_UNICODE | if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
    INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: u, dwFlags: flags, time: 0, dwExtraInfo: INPUT_TAG } } }
}

fn mouse_input(flags: MOUSE_EVENT_FLAGS, data: i32, at: Option<(f64, f64)>) -> INPUT {
    let (mut dx, mut dy, mut f) = (0, 0, flags);
    if let Some((x, y)) = at {
        // absolute over the whole virtual desktop, 0..65535
        let (vx, vy, vw, vh) = unsafe { (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN)) };
        dx = (((x - vx as f64) * 65535.0) / (vw.max(2) - 1) as f64).round() as i32;
        dy = (((y - vy as f64) * 65535.0) / (vh.max(2) - 1) as f64).round() as i32;
        f |= MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    }
    INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: f, time: 0, dwExtraInfo: INPUT_TAG } } }
}

fn send(inputs: &[INPUT]) -> bool {
    inputs.is_empty() || unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) } as usize == inputs.len()
}

fn send_or_fail(inputs: &[INPUT]) -> Result<(), ComputerError> {
    if send(inputs) {
        Ok(())
    } else {
        // SendInput is refused into a window of higher integrity (an elevated app) and on the secure desktop
        Err(ComputerError { reason: Some(ErrorReason::Secure), ..fail(ComputerErrorKind::SessionUnavailable, "Windows refused the input (an administrator's window or the secure desktop)") })
    }
}

fn button_flags(b: Button) -> (MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS) {
    match b {
        Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }
}

fn mods_inputs(m: &Mods, up: bool) -> Vec<INPUT> {
    let mut v: Vec<INPUT> = m.vks().into_iter().map(|k| key_input(k, up)).collect();
    if up {
        v.reverse();
    }
    v
}

/// A key and the modifiers its character needs on this keyboard layout.
fn resolve_key(c: &Combo) -> (Option<u16>, Mods, Option<char>) {
    match c.key {
        Key::Vk(v) => (Some(v), c.mods, None),
        Key::Char(ch) => {
            let scan = if (ch as u32) <= 0xFFFF { unsafe { VkKeyScanW(ch as u16) } } else { -1 };
            if scan == -1 {
                return (None, c.mods, Some(ch));
            }
            let (v, shifts) = ((scan & 0xFF) as u16, (scan >> 8) & 0xFF);
            let m = Mods { shift: c.mods.shift || shifts & 1 != 0, ctrl: c.mods.ctrl || shifts & 2 != 0, alt: c.mods.alt || shifts & 4 != 0, win: c.mods.win };
            (Some(v), m, None)
        }
    }
}

/// An event as real input: the pointer moves, keys go to whatever has the focus (the caller raised the window).
pub fn send_event(e: &Event) -> Result<(), ComputerError> {
    match e {
        Event::Move { at } => send_or_fail(&[mouse_input(MOUSE_EVENT_FLAGS(0), 0, Some(*at))]),
        Event::Button { at, button, down, mods } => {
            let (dn, up) = button_flags(*button);
            let mut v = vec![mouse_input(MOUSE_EVENT_FLAGS(0), 0, Some(*at))];
            if *down {
                v.extend(mods_inputs(mods, false));
                v.push(mouse_input(dn, 0, None));
            } else {
                v.push(mouse_input(up, 0, None));
                v.extend(mods_inputs(mods, true));
            }
            send_or_fail(&v)
        }
        Event::Click { at, button, count, hold, mods } => {
            let (dn, up) = button_flags(*button);
            let mut v = vec![mouse_input(MOUSE_EVENT_FLAGS(0), 0, Some(*at))];
            v.extend(mods_inputs(mods, false));
            send_or_fail(&v)?;
            for i in 0..*count {
                send_or_fail(&[mouse_input(dn, 0, None)])?;
                if i + 1 == *count && !hold.is_zero() {
                    std::thread::sleep(*hold);
                }
                send_or_fail(&[mouse_input(up, 0, None)])?;
            }
            send_or_fail(&mods_inputs(mods, true))
        }
        Event::Wheel { at, dx, dy, mods } => {
            let mut v = vec![mouse_input(MOUSE_EVENT_FLAGS(0), 0, Some(*at))];
            v.extend(mods_inputs(mods, false));
            for _ in 0..dy.unsigned_abs() {
                v.push(mouse_input(MOUSEEVENTF_WHEEL, if *dy > 0 { -120 } else { 120 }, None));
            }
            for _ in 0..dx.unsigned_abs() {
                v.push(mouse_input(MOUSEEVENTF_HWHEEL, if *dx > 0 { 120 } else { -120 }, None));
            }
            v.extend(mods_inputs(mods, true));
            send_or_fail(&v)
        }
        Event::Key { combo, phase } => {
            let (v, mods, ch) = resolve_key(combo);
            let mut out = Vec::new();
            if *phase != KeyPhase::Up {
                out.extend(mods_inputs(&mods, false));
            }
            match (v, ch) {
                (Some(v), _) => {
                    if *phase != KeyPhase::Up {
                        out.push(key_input(v, false));
                    }
                    if *phase != KeyPhase::Down {
                        out.push(key_input(v, true));
                    }
                }
                (None, Some(ch)) => {
                    let mut buf = [0u16; 2];
                    for u in ch.encode_utf16(&mut buf).iter() {
                        if *phase != KeyPhase::Up {
                            out.push(unicode_input(*u, false));
                        }
                        if *phase != KeyPhase::Down {
                            out.push(unicode_input(*u, true));
                        }
                    }
                }
                _ => {}
            }
            if *phase != KeyPhase::Down {
                out.extend(mods_inputs(&mods, true));
            }
            send_or_fail(&out)
        }
        Event::Text(t) => {
            let v: Vec<INPUT> = t.encode_utf16().flat_map(|u| [unicode_input(u, false), unicode_input(u, true)]).collect();
            send_or_fail(&v)
        }
        Event::Paste => send_or_fail(&[key_input(vk::CONTROL, false), key_input(b'V' as u16, false), key_input(b'V' as u16, true), key_input(vk::CONTROL, true)]),
    }
}

/// Lets go of what a session step may have left down: the three buttons and the modifiers.
pub fn release_all() {
    let mut v = vec![mouse_input(MOUSEEVENTF_LEFTUP, 0, None)];
    v.extend([vk::SHIFT, vk::CONTROL, vk::MENU, vk::LWIN].iter().filter(|k| unsafe { GetAsyncKeyState(**k as i32) } as u16 & 0x8000 != 0).map(|k| key_input(*k, true)));
    send(&v);
}

pub fn tier_post(top: i64, own: Option<HWND>, tier: Tier, e: &Event) -> Result<(), ComputerError> {
    match tier {
        Tier::Session => send_event(e),
        _ => post_messages(top, key_target(top, own), e),
    }
}

// ── the person watch ────────────────────────────────────────────────────

static PERSON: OnceLock<Mutex<Sender<PersonInput>>> = OnceLock::new();

fn tell(p: PersonInput) {
    if let Some(tx) = PERSON.get() {
        if let Ok(tx) = tx.lock() {
            let _ = tx.send(p);
        }
    }
}

unsafe extern "system" fn keyboard_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let k = unsafe { &*(l.0 as *const KBDLLHOOKSTRUCT) };
        let down = matches!(w.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
        if k.dwExtraInfo != INPUT_TAG && down {
            tell(if k.vkCode == vk::ESCAPE as u32 { PersonInput::Escape } else { PersonInput::Key });
        }
    }
    unsafe { CallNextHookEx(None, code, w, l) }
}

unsafe extern "system" fn mouse_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let m = unsafe { &*(l.0 as *const MSLLHOOKSTRUCT) };
        if m.dwExtraInfo != INPUT_TAG {
            tell(PersonInput::Pointer);
        }
    }
    unsafe { CallNextHookEx(None, code, w, l) }
}

/// The low-level keyboard and pointer hooks on a thread of their own with its message loop; `f` is called
/// on another thread, so a slow writer never holds the hooks past Windows' timeout.
pub fn watch_person(f: Box<dyn Fn(PersonInput) + Send + Sync>) {
    let (tx, rx) = channel::<PersonInput>();
    if PERSON.set(Mutex::new(tx)).is_err() {
        return;
    }
    std::thread::spawn(move || {
        while let Ok(p) = rx.recv() {
            f(p);
        }
    });
    std::thread::spawn(|| unsafe {
        let module = GetModuleHandleW(PCWSTR::null()).ok().map(|m| m.into());
        let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), module, 0);
        let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), module, 0);
        if kb.is_err() && ms.is_err() {
            eprintln!("the person watch has no hooks");
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

// ── capture ─────────────────────────────────────────────────────────────

/// The window's pixels inside its DWM frame (no invisible resize border), drawn whole when covered.
pub fn grab(id: i64, frame: (i32, i32, i32, i32)) -> Result<Image, ComputerError> {
    let h = hwnd(id);
    let failed = |why: &str| fail(ComputerErrorKind::CaptureFailed, why.to_string());
    unsafe {
        let mut wr = RECT::default();
        GetWindowRect(h, &mut wr).map_err(|_| failed("the window is gone"))?;
        let (w, ht) = (wr.right - wr.left, wr.bottom - wr.top);
        if w <= 0 || ht <= 0 {
            return Err(failed("the window has no size"));
        }
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -ht, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() },
            ..Default::default()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(Some(screen), &bmi, DIB_RGB_COLORS, &mut bits, None, 0);
        let result = match dib {
            Ok(dib) => {
                let old = SelectObject(mem, HGDIOBJ(dib.0));
                // PW_RENDERFULLCONTENT: DirectComposition content (Chromium, WinUI) too
                let ok = PrintWindow(h, mem, PRINT_WINDOW_FLAGS(2)).as_bool();
                let img = ok.then(|| {
                    let src = std::slice::from_raw_parts(bits as *const u8, (w * ht * 4) as usize);
                    let (fx, fy, fw, fh) = frame;
                    let (ox, oy) = ((fx - wr.left).clamp(0, w), (fy - wr.top).clamp(0, ht));
                    let (cw, ch) = (fw.min(w - ox).max(1) as usize, fh.min(ht - oy).max(1) as usize);
                    let mut out = Image::new(cw, ch);
                    for y in 0..ch {
                        let row = ((oy as usize + y) * w as usize + ox as usize) * 4;
                        for x in 0..cw {
                            let s = row + x * 4;
                            let d = (y * cw + x) * 3;
                            out.bgr[d..d + 3].copy_from_slice(&src[s..s + 3]);
                        }
                    }
                    out
                });
                SelectObject(mem, old);
                let _ = DeleteObject(HGDIOBJ(dib.0));
                img.ok_or_else(|| failed("Windows could not draw the window"))
            }
            Err(e) => Err(failed(&format!("no bitmap: {}", e.message()))),
        };
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        result
    }
}

fn quality(q: f32) -> VARIANT {
    VARIANT { Anonymous: VARIANT_0 { Anonymous: std::mem::ManuallyDrop::new(VARIANT_0_0 { vt: VT_R4, wReserved1: 0, wReserved2: 0, wReserved3: 0, Anonymous: VARIANT_0_0_0 { fltVal: q } }) } }
}

/// PNG or JPEG through WIC, 24-bit BGR.
pub fn encode(factory: &IWICImagingFactory, img: &Image, format: ShotFormat, q: f32) -> Result<Vec<u8>, ComputerError> {
    com();
    let failed = |e: windows::core::Error| fail(ComputerErrorKind::CaptureFailed, format!("encoding failed: {}", e.message()));
    unsafe {
        let mut buf = vec![0u8; img.bgr.len() + 64 * 1024];
        let stream = factory.CreateStream().map_err(failed)?;
        stream.InitializeFromMemory(&mut buf).map_err(failed)?;
        let container = if format == ShotFormat::Png { GUID_ContainerFormatPng } else { GUID_ContainerFormatJpeg };
        let enc = factory.CreateEncoder(&container, std::ptr::null()).map_err(failed)?;
        enc.Initialize(&stream, WICBitmapEncoderNoCache).map_err(failed)?;
        let mut frame: Option<IWICBitmapFrameEncode> = None;
        let mut bag: Option<IPropertyBag2> = None;
        enc.CreateNewFrame(&mut frame, &mut bag).map_err(failed)?;
        let frame = frame.ok_or_else(|| fail(ComputerErrorKind::CaptureFailed, "no frame"))?;
        if let (ShotFormat::Jpeg, Some(bag)) = (format, &bag) {
            let mut name: Vec<u16> = "ImageQuality".encode_utf16().chain([0]).collect();
            let prop = PROPBAG2 { pstrName: PWSTR(name.as_mut_ptr()), ..Default::default() };
            let _ = bag.Write(1, &prop, &quality(q.clamp(0.0, 1.0)));
        }
        frame.Initialize(bag.as_ref()).map_err(failed)?;
        frame.SetSize(img.width as u32, img.height as u32).map_err(failed)?;
        let mut fmt = GUID_WICPixelFormat24bppBGR;
        frame.SetPixelFormat(&mut fmt).map_err(failed)?;
        if fmt != GUID_WICPixelFormat24bppBGR {
            return Err(fail(ComputerErrorKind::CaptureFailed, "the encoder wants another pixel format"));
        }
        frame.WritePixels(img.height as u32, (img.width * 3) as u32, &img.bgr).map_err(failed)?;
        frame.Commit().map_err(failed)?;
        enc.Commit().map_err(failed)?;
        let mut end = 0u64;
        stream.Seek(0, STREAM_SEEK_CUR, Some(&mut end)).map_err(failed)?;
        buf.truncate(end as usize);
        Ok(buf)
    }
}

pub fn wic() -> Option<IWICImagingFactory> {
    com();
    unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }.ok()
}

// ── the clipboard ───────────────────────────────────────────────────────

pub fn clip_seq() -> i64 {
    unsafe { GetClipboardSequenceNumber() as i64 }
}

/// The clipboard opened for this thread with a message-only owner (SetClipboardData fails with no owner),
/// trying for up to 500 ms while another app holds it; closed and the owner gone on drop.
struct Opened(HWND);

impl Opened {
    fn new() -> Result<Self, ComputerError> {
        unsafe {
            let owner = CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), PCWSTR::null(), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, None, None).unwrap_or_default();
            let until = Instant::now() + Duration::from_millis(500);
            loop {
                if OpenClipboard(Some(owner)).is_ok() {
                    return Ok(Opened(owner));
                }
                if Instant::now() >= until {
                    let _ = DestroyWindow(owner);
                    return Err(fail(ComputerErrorKind::ClipboardBusy, "another app holds the clipboard open"));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

impl Drop for Opened {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
            if !self.0.is_invalid() {
                let _ = DestroyWindow(self.0);
            }
        }
    }
}

/// Formats whose data is a GDI handle, not memory: Windows makes CF_BITMAP and CF_PALETTE from a DIB itself.
const CF_BITMAP: u32 = 2;
const CF_METAFILEPICT: u32 = 3;
const CF_PALETTE: u32 = 9;
const CF_ENHMETAFILE: u32 = 14;
const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;
const CF_UNICODETEXT: u32 = 13;

pub fn clip_save() -> Result<Clip, ComputerError> {
    let _open = Opened::new()?;
    let mut formats = Vec::new();
    let mut f = 0u32;
    loop {
        f = unsafe { EnumClipboardFormats(f) };
        if f == 0 {
            break;
        }
        formats.push(f);
    }
    let has_dib = formats.iter().any(|f| *f == CF_DIB || *f == CF_DIBV5);
    let mut out = Vec::new();
    for f in formats {
        match f {
            CF_BITMAP | CF_PALETTE if has_dib => continue,
            CF_BITMAP | CF_PALETTE | CF_METAFILEPICT | CF_ENHMETAFILE | 0x80..=0x8E => {
                return Err(fail(ComputerErrorKind::ClipboardBusy, "the clipboard holds data that can't be saved"));
            }
            _ => {}
        }
        unsafe {
            let h = GetClipboardData(f).map_err(|_| fail(ComputerErrorKind::ClipboardBusy, "the clipboard holds data that can't be saved"))?;
            let g = HGLOBAL(h.0);
            let n = GlobalSize(g);
            let p = GlobalLock(g) as *const u8;
            if p.is_null() {
                return Err(fail(ComputerErrorKind::ClipboardBusy, "the clipboard holds data that can't be saved"));
            }
            out.push((f, std::slice::from_raw_parts(p, n).to_vec()));
            let _ = GlobalUnlock(g);
        }
    }
    Ok(Clip(out))
}

fn global(bytes: &[u8]) -> Result<HGLOBAL, ComputerError> {
    unsafe {
        let g = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).map_err(|_| fail(ComputerErrorKind::ClipboardBusy, "no memory for the clipboard"))?;
        let p = GlobalLock(g) as *mut u8;
        if p.is_null() {
            let _ = GlobalFree(Some(g));
            return Err(fail(ComputerErrorKind::ClipboardBusy, "no memory for the clipboard"));
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        let _ = GlobalUnlock(g);
        Ok(g)
    }
}

fn set(format: u32, bytes: &[u8]) -> Result<(), ComputerError> {
    let g = global(bytes)?;
    unsafe {
        if SetClipboardData(format, Some(HANDLE(g.0))).is_err() {
            let _ = GlobalFree(Some(g));
            return Err(fail(ComputerErrorKind::ClipboardBusy, "Windows did not take the clipboard's data"));
        }
    }
    Ok(())
}

pub fn clip_put(text: &str, html: Option<&str>) -> Result<(), ComputerError> {
    let _open = Opened::new()?;
    unsafe { EmptyClipboard() }.map_err(|_| fail(ComputerErrorKind::ClipboardBusy, "the clipboard would not empty"))?;
    let utf16: Vec<u8> = text.encode_utf16().chain([0]).flat_map(|u| u.to_le_bytes()).collect();
    set(CF_UNICODETEXT, &utf16)?;
    if let Some(h) = html {
        let id = unsafe { RegisterClipboardFormatW(w!("HTML Format")) };
        let mut bytes = crate::clip::cf_html(h);
        bytes.push(0);
        set(id, &bytes)?;
    }
    Ok(())
}

pub fn clip_restore(clip: &Clip) -> Result<(), ComputerError> {
    let _open = Opened::new()?;
    unsafe { EmptyClipboard() }.map_err(|_| fail(ComputerErrorKind::ClipboardBusy, "the clipboard would not empty"))?;
    for (f, bytes) in &clip.0 {
        set(*f, bytes)?;
    }
    Ok(())
}

// ── launching ───────────────────────────────────────────────────────────

/// A command-line argument as CommandLineToArgvW reads it back.
fn quote_arg(a: &str) -> String {
    if !a.is_empty() && !a.contains([' ', '\t', '"']) {
        return a.to_string();
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in a.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(slashes));
                out.push(c);
                slashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

/// Starts an exe by name (App Paths and PATH resolve it) or path, shown without activation; its pid.
pub fn launch(exe: &str, args: &[String]) -> Result<i64, ComputerError> {
    let file: Vec<u16> = exe.encode_utf16().chain([0]).collect();
    let params: Vec<u16> = args.iter().map(|a| quote_arg(a)).collect::<Vec<_>>().join(" ").encode_utf16().chain([0]).collect();
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI,
        lpVerb: w!("open"),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_SHOWNOACTIVATE.0,
        ..Default::default()
    };
    unsafe {
        ShellExecuteExW(&mut info).map_err(|e| fail(ComputerErrorKind::AppNotFound, format!("Windows could not start {exe}: {}", e.message())))?;
        if info.hProcess.is_invalid() {
            // handed to a running instance (a browser opening a page): no process of its own
            return Ok(0);
        }
        let pid = GetProcessId(info.hProcess) as i64;
        let _ = CloseHandle(info.hProcess);
        Ok(pid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_quote_as_windows_reads_them() {
        assert_eq!(quote_arg("plain"), "plain");
        assert_eq!(quote_arg("C:\\a b\\c.txt"), "\"C:\\a b\\c.txt\"");
        assert_eq!(quote_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(quote_arg("C:\\dir\\"), "C:\\dir\\");
        assert_eq!(quote_arg("C:\\my dir\\"), "\"C:\\my dir\\\\\"");
        assert_eq!(quote_arg(""), "\"\"");
    }
}
