//! The desktop on Windows (docs/computer-protocol.md §29): the apps from the
//! top-level windows the taskbar shows, a window's tree from UI Automation
//! in the grammar's words, and the invisible tier's actions through UIA
//! patterns (Invoke, Toggle, SelectionItem, ExpandCollapse, Value,
//! RangeValue, Scroll, Text), with `WM_SETTEXT` for a text control that has
//! no Value pattern. No pointer, key or focus change: that is milestone 43's.
//!
//! Every thread that calls in joins the COM multithreaded apartment once;
//! the one `IUIAutomation` and every element handle are free-threaded there.

#![allow(non_upper_case_globals)]

use std::cell::Cell;
use std::collections::HashMap;
use std::ffi::c_void;
use std::time::Instant;

use windows::core::{Interface, BOOL, BSTR, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, SAFEARRAY};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Ole::{SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    SendMessageTimeoutW, GWL_EXSTYLE, GW_OWNER, SMTO_ABORTIFHUNG, WM_GETTEXT, WM_GETTEXTLENGTH, WM_SETTEXT, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

use crate::desktop::{fail, Acted, Desktop};
use crate::generated::contract::walk as limits;
use crate::text::{RawNode, RawWindow};
use crate::wire::*;

/// An element between reads. UIA's MTA objects are free-threaded.
#[derive(Clone)]
pub struct Elem(IUIAutomationElement);
unsafe impl Send for Elem {}
unsafe impl Sync for Elem {}

struct Uia {
    automation: IUIAutomation,
    request: IUIAutomationCacheRequest,
    view: IUIAutomationCondition,
}
unsafe impl Send for Uia {}
unsafe impl Sync for Uia {}

pub struct WindowsDesktop {
    uia: Uia,
    parent: Option<HANDLE>,
}
unsafe impl Send for WindowsDesktop {}
unsafe impl Sync for WindowsDesktop {}

thread_local! {
    static COM: Cell<bool> = const { Cell::new(false) };
}

/// Joins this thread to the multithreaded apartment, once.
fn com() {
    COM.with(|c| {
        if !c.get() {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            c.set(true);
        }
    });
}

fn err(kind: ComputerErrorKind, what: &str, e: windows::core::Error) -> ComputerError {
    fail(kind, format!("{what}: {}", e.message()))
}

const PROPS: &[UIA_PROPERTY_ID] = &[
    UIA_ControlTypePropertyId,
    UIA_NamePropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_IsEnabledPropertyId,
    UIA_HasKeyboardFocusPropertyId,
    UIA_IsOffscreenPropertyId,
    UIA_IsPasswordPropertyId,
    UIA_ClassNamePropertyId,
    UIA_IsRequiredForFormPropertyId,
    UIA_RuntimeIdPropertyId,
    UIA_NativeWindowHandlePropertyId,
    UIA_LocalizedControlTypePropertyId,
    UIA_FrameworkIdPropertyId,
    // a pattern's Cached* values come only from its own property ids in the request
    UIA_ValueValuePropertyId,
    UIA_ValueIsReadOnlyPropertyId,
    UIA_ToggleToggleStatePropertyId,
    UIA_ExpandCollapseExpandCollapseStatePropertyId,
    UIA_SelectionItemIsSelectedPropertyId,
    UIA_RangeValueValuePropertyId,
    UIA_WindowIsModalPropertyId,
];

const PATTERNS: &[UIA_PATTERN_ID] = &[
    UIA_ValuePatternId,
    UIA_InvokePatternId,
    UIA_TogglePatternId,
    UIA_SelectionItemPatternId,
    UIA_ExpandCollapsePatternId,
    UIA_RangeValuePatternId,
    UIA_TextPatternId,
    UIA_WindowPatternId,
];

impl WindowsDesktop {
    pub fn new() -> windows::core::Result<Self> {
        com();
        unsafe {
            let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let request = automation.CreateCacheRequest()?;
            for p in PROPS {
                request.AddProperty(*p)?;
            }
            for p in PATTERNS {
                request.AddPattern(*p)?;
            }
            let view = automation.ControlViewCondition()?;
            Ok(WindowsDesktop { uia: Uia { automation, request, view }, parent: parent_handle() })
        }
    }
}

// ── windows and apps ────────────────────────────────────────────────────

struct Win {
    hwnd: HWND,
    pid: u32,
    title: String,
    frame: Rect,
    minimized: bool,
    /// on another virtual desktop
    other_desktop: bool,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn window_text(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn window_frame(hwnd: HWND) -> Rect {
    let mut r = RECT::default();
    let ok = unsafe { DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut _ as *mut c_void, std::mem::size_of::<RECT>() as u32) }.is_ok();
    if !ok {
        let _ = unsafe { GetWindowRect(hwnd, &mut r) };
    }
    Rect { x: r.left as f64, y: r.top as f64, w: (r.right - r.left) as f64, h: (r.bottom - r.top) as f64 }
}

fn cloaked(hwnd: HWND) -> u32 {
    let mut c = 0u32;
    let _ = unsafe { DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut c as *mut _ as *mut c_void, 4) };
    c
}

/// The windows the taskbar and Alt-Tab show, top of the z-order first.
fn top_windows() -> Vec<Win> {
    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
        list.push(hwnd);
        BOOL(1)
    }
    let mut all: Vec<HWND> = Vec::new();
    let _ = unsafe { EnumWindows(Some(each), LPARAM(&mut all as *mut _ as isize)) };
    let mut out = Vec::new();
    for hwnd in all {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                continue;
            }
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let owned = GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid());
            if ex & WS_EX_TOOLWINDOW.0 != 0 || (owned && ex & WS_EX_APPWINDOW.0 == 0) {
                continue;
            }
            let class = class_name(hwnd);
            if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Windows.UI.Core.CoreWindow") {
                continue;
            }
            let title = window_text(hwnd);
            if title.is_empty() {
                continue;
            }
            // cloaked by the shell: another virtual desktop; by the app: a suspended store app, never shown
            let c = cloaked(hwnd);
            if c != 0 && c != 2 {
                continue;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            // a store app's frame belongs to ApplicationFrameHost; its CoreWindow child to the app
            if class == "ApplicationFrameWindow" {
                if let Ok(core) = FindWindowExW(Some(hwnd), None, PCWSTR(wide("Windows.UI.Core.CoreWindow").as_ptr()), PCWSTR::null()) {
                    GetWindowThreadProcessId(core, Some(&mut pid));
                }
            }
            out.push(Win { hwnd, pid, title, frame: window_frame(hwnd), minimized: IsIconic(hwnd).as_bool(), other_desktop: c == 2 });
        }
    }
    out
}

fn exe_path(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut n = buf.len() as u32;
        let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut n);
        let _ = CloseHandle(h);
        r.ok()?;
        Some(String::from_utf16_lossy(&buf[..n as usize]))
    }
}

/// The exe's FileDescription ("Microsoft Edge", "Windows Explorer"), else its file name without `.exe`.
fn display_name(path: &str) -> String {
    let stem = path.rsplit('\\').next().unwrap_or(path).trim_end_matches(".exe").trim_end_matches(".EXE").to_string();
    let read = || -> Option<String> {
        unsafe {
            let wpath = wide(path);
            let size = GetFileVersionInfoSizeW(PCWSTR(wpath.as_ptr()), None);
            if size == 0 {
                return None;
            }
            let mut block = vec![0u8; size as usize];
            GetFileVersionInfoW(PCWSTR(wpath.as_ptr()), None, size, block.as_mut_ptr() as *mut c_void).ok()?;
            let mut ptr: *mut c_void = std::ptr::null_mut();
            let mut len = 0u32;
            if !VerQueryValueW(block.as_ptr() as *const c_void, PCWSTR(wide("\\VarFileInfo\\Translation").as_ptr()), &mut ptr, &mut len).as_bool() || len < 4 {
                return None;
            }
            let pair = *(ptr as *const [u16; 2]);
            let key = format!("\\StringFileInfo\\{:04x}{:04x}\\FileDescription", pair[0], pair[1]);
            if !VerQueryValueW(block.as_ptr() as *const c_void, PCWSTR(wide(&key).as_ptr()), &mut ptr, &mut len).as_bool() || len == 0 {
                return None;
            }
            let s = std::slice::from_raw_parts(ptr as *const u16, len as usize);
            let text = String::from_utf16_lossy(s).trim_end_matches('\0').trim().to_string();
            Some(text.trim_end_matches(".exe").trim_end_matches(".EXE").to_string()).filter(|t| !t.is_empty())
        }
    };
    read().unwrap_or(stem)
}

fn parent_handle() -> Option<HANDLE> {
    unsafe {
        let me = std::process::id();
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut parent = None;
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                if e.th32ProcessID == me {
                    parent = Some(e.th32ParentProcessID);
                    break;
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        OpenProcess(PROCESS_SYNCHRONIZE, false, parent?).ok()
    }
}

struct AppRow {
    pid: u32,
    exe: String,
    name: String,
    windows: Vec<Win>,
}

fn app_rows() -> Vec<AppRow> {
    let mut by_pid: HashMap<u32, AppRow> = HashMap::new();
    let mut order = Vec::new();
    for w in top_windows() {
        if w.pid == std::process::id() {
            continue;
        }
        let row = by_pid.entry(w.pid).or_insert_with(|| {
            order.push(w.pid);
            let path = exe_path(w.pid).unwrap_or_default();
            let exe = path.rsplit('\\').next().unwrap_or("").to_lowercase();
            AppRow { pid: w.pid, name: if path.is_empty() { format!("pid {}", w.pid) } else { display_name(&path) }, exe, windows: Vec::new() }
        });
        row.windows.push(w);
    }
    order.into_iter().filter_map(|p| by_pid.remove(&p)).collect()
}

// ── the tree ────────────────────────────────────────────────────────────

fn b(r: windows::core::Result<BOOL>) -> bool {
    r.map(|v| v.as_bool()).unwrap_or(false)
}

fn s(r: windows::core::Result<BSTR>) -> Option<String> {
    r.ok().map(|v| v.to_string()).filter(|v| !v.is_empty())
}

fn runtime_id(e: &IUIAutomationElement) -> Vec<i32> {
    unsafe {
        let Ok(sa) = e.GetRuntimeId() else { return vec![] };
        if sa.is_null() {
            return vec![];
        }
        let mut out = Vec::new();
        if let (Ok(lo), Ok(hi)) = (SafeArrayGetLBound(sa as *const SAFEARRAY, 1), SafeArrayGetUBound(sa as *const SAFEARRAY, 1)) {
            for i in lo..=hi {
                let mut v = 0i32;
                if SafeArrayGetElement(sa as *const SAFEARRAY, &i, &mut v as *mut _ as *mut c_void).is_ok() {
                    out.push(v);
                }
            }
        }
        let _ = SafeArrayDestroy(sa as *const SAFEARRAY);
        out
    }
}

/// UI Automation's control type as a word of the grammar (§29.3).
fn role_of(ct: UIA_CONTROLTYPE_ID, framework: &str, password: bool, editable: bool, top: bool, modal: bool) -> &'static str {
    match ct {
        UIA_ButtonControlTypeId => "button",
        UIA_SplitButtonControlTypeId => "menu button",
        UIA_CheckBoxControlTypeId => "checkbox",
        UIA_RadioButtonControlTypeId => "radio",
        UIA_ComboBoxControlTypeId => {
            if editable {
                "combo box"
            } else {
                "pop up"
            }
        }
        UIA_EditControlTypeId => {
            if password {
                "password"
            } else {
                "input"
            }
        }
        UIA_DocumentControlTypeId => {
            if framework == "Chrome" {
                "web area"
            } else {
                "text area"
            }
        }
        UIA_HyperlinkControlTypeId => "link",
        UIA_ImageControlTypeId => "image",
        UIA_ListControlTypeId => "list",
        UIA_ListItemControlTypeId | UIA_DataItemControlTypeId | UIA_TreeItemControlTypeId => "row",
        UIA_TreeControlTypeId => "outline",
        UIA_DataGridControlTypeId | UIA_TableControlTypeId => "table",
        UIA_HeaderControlTypeId => "group",
        UIA_HeaderItemControlTypeId => "column",
        UIA_MenuControlTypeId => "menu",
        UIA_MenuBarControlTypeId => "menu bar",
        UIA_MenuItemControlTypeId => "menu item",
        UIA_ProgressBarControlTypeId => "progress",
        UIA_SliderControlTypeId => "slider",
        UIA_SpinnerControlTypeId => "stepper",
        UIA_TabControlTypeId => "tabs",
        UIA_TabItemControlTypeId => "tab",
        UIA_TextControlTypeId => "text",
        UIA_ToolBarControlTypeId | UIA_AppBarControlTypeId => "toolbar",
        UIA_WindowControlTypeId => {
            if top {
                "window"
            } else if modal {
                "dialog"
            } else {
                "group"
            }
        }
        UIA_CalendarControlTypeId => "date",
        UIA_StatusBarControlTypeId => "status bar",
        UIA_ToolTipControlTypeId => "tool tip",
        UIA_ScrollBarControlTypeId => "scroll bar",
        UIA_ThumbControlTypeId => "thumb",
        UIA_TitleBarControlTypeId => "title bar",
        UIA_SeparatorControlTypeId => "separator",
        UIA_PaneControlTypeId => "pane",
        UIA_CustomControlTypeId => "custom",
        _ => "group",
    }
}

struct Walker<'a> {
    uia: &'a Uia,
    /// the RuntimeId of the element with the system's focus
    focus: Option<Vec<i32>>,
    deadline: Instant,
    nodes: usize,
    partial: bool,
}

impl Walker<'_> {
    /// One element from its cached properties, and its children (one UIA call per parent).
    fn node(&mut self, e: &IUIAutomationElement, top: bool) -> Option<RawNode<Elem>> {
        self.nodes += 1;
        unsafe {
            let ct = e.CachedControlType().unwrap_or(UIA_CustomControlTypeId);
            let framework = s(e.CachedFrameworkId()).unwrap_or_default();
            // a scroll bar is never a line, nor anything in it (§4.3): the scroll area's own actions scroll
            if matches!(ct, UIA_ScrollBarControlTypeId | UIA_ThumbControlTypeId) {
                return None;
            }
            let offscreen = b(e.CachedIsOffscreen());
            if offscreen && !top {
                return None;
            }
            let value_p = e.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).ok();
            let read_only = value_p.as_ref().is_some_and(|v| b(v.CachedIsReadOnly()));
            let window_p = e.GetCachedPatternAs::<IUIAutomationWindowPattern>(UIA_WindowPatternId).ok();
            let modal = window_p.as_ref().is_some_and(|w| b(w.CachedIsModal()));
            let password = b(e.CachedIsPassword());
            let role = role_of(ct, &framework, password, value_p.is_some() && !read_only, top, modal);
            let mut n = RawNode {
                handle: Elem(e.clone()),
                key: runtime_id(e),
                role: role.to_string(),
                name: s(e.CachedName()),
                value: None,
                states: Vec::new(),
                caret: None,
                selection: None,
                actions: Vec::new(),
                frame: None,
                children: Vec::new(),
            };
            let r = e.CachedBoundingRectangle().unwrap_or_default();
            let zero = r.right <= r.left || r.bottom <= r.top;
            if !zero {
                n.frame = Some(Rect { x: r.left as f64, y: r.top as f64, w: (r.right - r.left) as f64, h: (r.bottom - r.top) as f64 });
            }

            // value
            let container = matches!(role, "window" | "dialog" | "group" | "pane" | "custom" | "web area" | "list" | "outline" | "table" | "tabs" | "toolbar" | "menu" | "menu bar");
            if !password && !container {
                if let Some(v) = &value_p {
                    n.value = s(v.CachedValue());
                }
                if n.value.is_none() {
                    if let Ok(rv) = e.GetCachedPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId) {
                        if let Ok(x) = rv.CachedValue() {
                            n.value = Some(if x.fract() == 0.0 { format!("{}", x as i64) } else { format!("{x}") });
                        }
                    }
                }
            }
            let text_p = e.GetCachedPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId).ok();
            if n.value.is_none() && role == "text area" {
                if let Some(t) = &text_p {
                    n.value = t.DocumentRange().and_then(|r| r.GetText(2000)).ok().map(|v| v.to_string());
                }
            }

            // states
            // the one element with the system's focus: XAML islands each say HasKeyboardFocus
            let focused = !n.key.is_empty() && self.focus.as_deref() == Some(n.key.as_slice());
            if focused {
                n.states.push("focused");
            }
            if !b(e.CachedIsEnabled()) {
                n.states.push("disabled");
            }
            if b(e.CachedIsRequiredForForm()) {
                n.states.push("required");
            }
            if read_only && matches!(role, "input" | "text area" | "combo box" | "date") {
                n.states.push("read-only");
            }
            if modal {
                n.states.push("modal");
            }
            let selection_p = e.GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId).ok();
            let selected = selection_p.as_ref().is_some_and(|p| b(p.CachedIsSelected()));
            let toggle_p = e.GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId).ok();
            match role {
                "checkbox" | "switch" | "radio" => {
                    let state = if let Some(t) = &toggle_p {
                        match t.CachedToggleState() {
                            Ok(ToggleState_On) => "checked",
                            Ok(ToggleState_Indeterminate) => "mixed",
                            _ => "unchecked",
                        }
                    } else if selected {
                        "checked"
                    } else {
                        "unchecked"
                    };
                    n.states.push(state);
                }
                _ => {
                    if selected {
                        n.states.push("selected");
                    }
                }
            }
            let expand_p = e.GetCachedPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId).ok();
            if let Some(x) = &expand_p {
                match x.CachedExpandCollapseState() {
                    Ok(ExpandCollapseState_Expanded) => n.states.push("expanded"),
                    Ok(ExpandCollapseState_Collapsed) if matches!(role, "row" | "cell" | "disclosure") => n.states.push("collapsed"),
                    _ => {}
                }
            }

            // caret or selection in the focused text element; a background window has no focus, so
            // there a text area's selection alone shows (select_text's evidence)
            if focused || role == "text area" || role == "input" {
                if let Some(t) = &text_p {
                    if let Some((a, z)) = selection_of(t) {
                        if a != z {
                            n.selection = Some((a, z));
                        } else if focused {
                            n.caret = Some(a);
                        }
                    }
                }
            }

            // action words beyond the role's defaults
            let invoke = e.GetCachedPattern(UIA_InvokePatternId).is_ok();
            if invoke && !matches!(role, "button" | "link" | "menu item" | "checkbox" | "switch" | "radio" | "tab" | "pop up" | "menu button" | "row" | "cell" | "disclosure") {
                n.actions.push("press");
            }
            if toggle_p.is_some() && !matches!(role, "checkbox" | "switch" | "radio") {
                n.actions.push("toggle");
            }
            if let Some(x) = &expand_p {
                if !matches!(role, "row" | "disclosure" | "pop up" | "menu button" | "combo box") {
                    match x.CachedExpandCollapseState() {
                        Ok(ExpandCollapseState_Expanded) => n.actions.push("collapse"),
                        Ok(ExpandCollapseState_LeafNode) => {}
                        _ => n.actions.push("expand"),
                    }
                }
            }

            // children, unless a cap is reached
            if self.nodes >= limits::MAX_NODES as usize || Instant::now() >= self.deadline {
                self.partial = true;
                return Some(n);
            }
            if let Ok(kids) = e.FindAllBuildCache(TreeScope_Children, &self.uia.view, &self.uia.request) {
                let len = kids.Length().unwrap_or(0);
                for i in 0..len {
                    if self.nodes >= limits::MAX_NODES as usize || Instant::now() >= self.deadline {
                        self.partial = true;
                        break;
                    }
                    if let Ok(k) = kids.GetElement(i) {
                        if let Some(child) = self.node(&k, false) {
                            // a zero-size element is no line, but its children are (§4.3)
                            if child.frame.is_none() && !child.states.contains(&"focused") && child.role != "window" {
                                n.children.extend(child.children);
                            } else {
                                n.children.push(child);
                            }
                        }
                    }
                }
            }
            Some(n)
        }
    }
}

/// The selection of a text pattern as UTF-16 offsets into its document (text up to 200,000 units).
fn selection_of(t: &IUIAutomationTextPattern) -> Option<(i64, i64)> {
    unsafe {
        let sel = t.GetSelection().ok()?;
        if sel.Length().ok()? < 1 {
            return None;
        }
        let range = sel.GetElement(0).ok()?;
        let doc = t.DocumentRange().ok()?;
        let offset = |endpoint: TextPatternRangeEndpoint| -> Option<i64> {
            let head = doc.Clone().ok()?;
            head.MoveEndpointByRange(TextPatternRangeEndpoint_End, &range, endpoint).ok()?;
            let text = head.GetText(200_000).ok()?;
            Some(text.to_string().encode_utf16().count() as i64)
        };
        Some((offset(TextPatternRangeEndpoint_Start)?, offset(TextPatternRangeEndpoint_End)?))
    }
}

impl WindowsDesktop {
    fn windows_of(&self, pid: i64) -> Vec<Win> {
        top_windows().into_iter().filter(|w| w.pid as i64 == pid).collect()
    }

    /// §2.1: by id, else the title exactly, then as a substring; else the app's main window (front-most, not minimized first).
    fn resolve_window(&self, pid: i64, r: Option<&WindowRef>) -> Result<(Win, Vec<Win>), ComputerError> {
        let mut wins = self.windows_of(pid);
        if wins.is_empty() {
            return Err(fail(ComputerErrorKind::WindowNotFound, "the app has no window"));
        }
        let pick = match r {
            Some(WindowRef { id: Some(id), .. }) => wins.iter().position(|w| w.hwnd.0 as i64 == *id),
            Some(WindowRef { title: Some(t), .. }) => wins.iter().position(|w| w.title == *t).or_else(|| wins.iter().position(|w| w.title.contains(t.as_str()))),
            _ => wins.iter().position(|w| !w.minimized).or(Some(0)),
        };
        let Some(i) = pick else {
            return Err(ComputerError { candidates: Some(wins.iter().map(|w| w.title.clone()).collect()), ..fail(ComputerErrorKind::WindowNotFound, "no window of the app matches") });
        };
        let win = wins.remove(i);
        Ok((win, wins))
    }
}

impl Desktop for WindowsDesktop {
    type Handle = Elem;

    fn os(&self) -> (String, String) {
        use windows::Wdk::System::SystemServices::RtlGetVersion;
        use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
        let mut v = OSVERSIONINFOW { dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32, ..Default::default() };
        let _ = unsafe { RtlGetVersion(&mut v) };
        (format!("Windows {}.{}.{}", v.dwMajorVersion, v.dwMinorVersion, v.dwBuildNumber), std::env::consts::ARCH.to_string())
    }

    fn displays(&self) -> Vec<DisplayInfo> {
        unsafe extern "system" fn each(m: HMONITOR, _: HDC, _: *mut RECT, lparam: LPARAM) -> BOOL {
            let list = unsafe { &mut *(lparam.0 as *mut Vec<RECT>) };
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if unsafe { GetMonitorInfoW(m, &mut info) }.as_bool() {
                list.push(info.rcMonitor);
            }
            BOOL(1)
        }
        let mut rects: Vec<RECT> = Vec::new();
        let _ = unsafe { EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut rects as *mut _ as isize)) };
        // frames are physical pixels (the process is per-monitor DPI aware): a pixel is a point here
        rects
            .iter()
            .enumerate()
            .map(|(i, r)| DisplayInfo { id: i as i64 + 1, frame: Rect { x: r.left as f64, y: r.top as f64, w: (r.right - r.left) as f64, h: (r.bottom - r.top) as f64 }, scale: 1.0 })
            .collect()
    }

    fn apps(&self, with_windows: bool) -> Result<Vec<AppInfo>, ComputerError> {
        let front = unsafe { GetForegroundWindow() };
        let mut front_pid = 0u32;
        unsafe { GetWindowThreadProcessId(front, Some(&mut front_pid)) };
        let mut apps: Vec<AppInfo> = app_rows()
            .into_iter()
            .map(|row| {
                let windows = with_windows.then(|| {
                    let main = row.windows.iter().position(|w| !w.minimized).unwrap_or(0);
                    row.windows
                        .iter()
                        .enumerate()
                        .map(|(i, w)| WindowInfo {
                            id: w.hwnd.0 as i64,
                            title: w.title.clone(),
                            frame: w.frame.clone(),
                            main: i == main,
                            focused: w.hwnd == front,
                            minimized: w.minimized,
                            on_screen: !w.minimized && !w.other_desktop,
                            space: if w.other_desktop { WindowSpace::Other } else { WindowSpace::Current },
                            ..Default::default()
                        })
                        .collect()
                });
                AppInfo { pid: row.pid as i64, bundle_id: Some(row.exe).filter(|e| !e.is_empty()), name: row.name, active: row.pid == front_pid, hidden: false, windows }
            })
            .collect();
        apps.sort_by(|a, b| b.active.cmp(&a.active).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(apps)
    }

    fn read(&self, pid: i64, window: Option<&WindowRef>, from: Option<&Elem>, deadline: Instant) -> Result<RawWindow<Elem>, ComputerError> {
        com();
        let started = Instant::now();
        let (win, others) = self.resolve_window(pid, window)?;
        let path = exe_path(pid as u32).unwrap_or_default();
        let focus = unsafe { self.uia.automation.GetFocusedElement() }.ok().map(|f| runtime_id(&f)).filter(|k| !k.is_empty());
        let mut walker = Walker { uia: &self.uia, focus, deadline, nodes: 0, partial: false };
        let root = unsafe {
            match from {
                Some(Elem(e)) => {
                    let fresh = e.BuildUpdatedCache(&self.uia.request).map_err(|_| fail(ComputerErrorKind::StaleElement, "the element is gone"))?;
                    walker.node(&fresh, true)
                }
                None => {
                    let e = self.uia.automation.ElementFromHandleBuildCache(win.hwnd, &self.uia.request).map_err(|e| err(ComputerErrorKind::Timeout, "the window did not answer", e))?;
                    walker.node(&e, true)
                }
            }
        }
        .ok_or_else(|| fail(ComputerErrorKind::WindowNotFound, "the window is not on screen"))?;
        Ok(RawWindow {
            pid,
            app_name: if path.is_empty() { format!("pid {pid}") } else { display_name(&path) },
            bundle_id: path.rsplit('\\').next().map(str::to_lowercase).filter(|e| !e.is_empty()),
            window_id: win.hwnd.0 as i64,
            title: win.title.clone(),
            frame: win.frame.clone(),
            others: others.iter().map(|w| (w.title.clone(), w.minimized)).collect(),
            root,
            partial: walker.partial,
            read_ms: started.elapsed().as_millis() as i64,
        })
    }

    fn act(&self, _pid: i64, element: &Elem, a: &ComputerAction) -> Result<Acted, ComputerError> {
        com();
        let e = &element.0;
        let unsupported = |what: &str| fail(ComputerErrorKind::ActionUnsupported, what.to_string());
        unsafe {
            match a.action {
                ComputerActionName::LeftClick => press(e).map(|_| Acted::default()),
                ComputerActionName::Perform => {
                    let name = a.name.as_deref().unwrap_or("");
                    match name {
                        "press" => press(e).map(|_| Acted::default()),
                        "toggle" => pattern::<IUIAutomationTogglePattern>(e, UIA_TogglePatternId, name)?.Toggle().map(|_| Acted::default()).map_err(|x| err(ComputerErrorKind::ActionUnsupported, name, x)),
                        "expand" | "collapse" => {
                            let p = pattern::<IUIAutomationExpandCollapsePattern>(e, UIA_ExpandCollapsePatternId, name)?;
                            if name == "expand" { p.Expand() } else { p.Collapse() }.map(|_| Acted::default()).map_err(|x| err(ComputerErrorKind::ActionUnsupported, name, x))
                        }
                        "increment" | "decrement" => {
                            let p = pattern::<IUIAutomationRangeValuePattern>(e, UIA_RangeValuePatternId, name)?;
                            let step = p.CurrentSmallChange().ok().filter(|s| *s > 0.0).unwrap_or(1.0);
                            let now = p.CurrentValue().unwrap_or(0.0);
                            p.SetValue(if name == "increment" { now + step } else { now - step }).map(|_| Acted::default()).map_err(|x| err(ComputerErrorKind::ActionUnsupported, name, x))
                        }
                        "scroll up" | "scroll down" | "scroll left" | "scroll right" => {
                            let p = pattern::<IUIAutomationScrollPattern>(e, UIA_ScrollPatternId, name)?;
                            let (h, v) = match name {
                                "scroll up" => (ScrollAmount_NoAmount, ScrollAmount_LargeDecrement),
                                "scroll down" => (ScrollAmount_NoAmount, ScrollAmount_LargeIncrement),
                                "scroll left" => (ScrollAmount_LargeDecrement, ScrollAmount_NoAmount),
                                _ => (ScrollAmount_LargeIncrement, ScrollAmount_NoAmount),
                            };
                            p.Scroll(h, v).map(|_| Acted::default()).map_err(|x| err(ComputerErrorKind::ActionUnsupported, name, x))
                        }
                        "select" => pattern::<IUIAutomationSelectionItemPattern>(e, UIA_SelectionItemPatternId, name)?.Select().map(|_| Acted::default()).map_err(|x| err(ComputerErrorKind::ActionUnsupported, name, x)),
                        _ => Err(ComputerError {
                            available: Some(vec!["press".into(), "toggle".into(), "expand".into(), "collapse".into(), "increment".into(), "decrement".into(), "scroll up".into(), "scroll down".into(), "select".into()]),
                            ..unsupported(&format!("perform {name:?} is not an action this element takes on Windows"))
                        }),
                    }
                }
                ComputerActionName::SetValue => set_value(e, a.value.as_deref().unwrap_or("")),
                ComputerActionName::Type => {
                    let text = a.text.as_deref().unwrap_or("");
                    let now = current_text(e).unwrap_or_default();
                    if !now.is_empty() {
                        return Err(unsupported("typing into a field that already holds text needs key input, which Windows does not have yet (milestone 43); use set_value with the whole text"));
                    }
                    set_value(e, text).map(|mut r| {
                        r.via = Some(InputVia::AxValue);
                        r
                    })
                }
                ComputerActionName::SelectText => select_text(e, a),
                _ => Err(unsupported("not an ax action")),
            }
        }
    }

    fn parent_alive(&self) -> bool {
        match self.parent {
            Some(h) => unsafe { WaitForSingleObject(h, 0) }.0 != 0,
            None => true,
        }
    }
}

unsafe fn pattern<T: Interface>(e: &IUIAutomationElement, id: UIA_PATTERN_ID, verb: &str) -> Result<T, ComputerError> {
    unsafe { e.GetCurrentPatternAs::<T>(id) }.map_err(|_| fail(ComputerErrorKind::ActionUnsupported, format!("the element takes no {verb}")))
}

/// A click with no pointer: Invoke, else Toggle, else select the item, else expand or collapse, else the legacy default action.
unsafe fn press(e: &IUIAutomationElement) -> Result<(), ComputerError> {
    unsafe {
        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
            return p.Invoke().map_err(|x| err(ComputerErrorKind::ActionUnsupported, "invoke", x));
        }
        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
            return p.Toggle().map_err(|x| err(ComputerErrorKind::ActionUnsupported, "toggle", x));
        }
        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
            return p.Select().map_err(|x| err(ComputerErrorKind::ActionUnsupported, "select", x));
        }
        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
            let open = matches!(p.CurrentExpandCollapseState(), Ok(ExpandCollapseState_Expanded));
            return if open { p.Collapse() } else { p.Expand() }.map_err(|x| err(ComputerErrorKind::ActionUnsupported, "expand", x));
        }
        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId) {
            if p.DoDefaultAction().is_ok() {
                return Ok(());
            }
        }
        Err(fail(ComputerErrorKind::ActionUnsupported, "the element takes no click without the pointer (milestone 43 brings pointer input)"))
    }
}

/// The element's own window, when it has one (a classic Edit or RichEdit control).
unsafe fn own_hwnd(e: &IUIAutomationElement) -> Option<HWND> {
    unsafe { e.CurrentNativeWindowHandle().ok().filter(|h| !h.is_invalid()) }
}

unsafe fn current_text(e: &IUIAutomationElement) -> Option<String> {
    unsafe {
        if let Ok(v) = e.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
            return v.CurrentValue().ok().map(|s| s.to_string());
        }
        if let Ok(t) = e.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
            return t.DocumentRange().and_then(|r| r.GetText(-1)).ok().map(|s| s.to_string());
        }
        let hwnd = own_hwnd(e)?;
        let mut len = 0usize;
        SendMessageTimeoutW(hwnd, WM_GETTEXTLENGTH, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 2000, Some(&mut len));
        let mut buf = vec![0u16; len + 1];
        let mut got = 0usize;
        SendMessageTimeoutW(hwnd, WM_GETTEXT, WPARAM(buf.len()), LPARAM(buf.as_mut_ptr() as isize), SMTO_ABORTIFHUNG, 2000, Some(&mut got));
        Some(String::from_utf16_lossy(&buf[..got.min(len)]))
    }
}

/// The Value pattern's SetValue; for a text control with none (Notepad's RichEdit), `WM_SETTEXT` to its own window.
/// Never a key, the pointer or the focus. The value is read back.
unsafe fn set_value(e: &IUIAutomationElement, value: &str) -> Result<Acted, ComputerError> {
    unsafe {
        let via_value = e.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).ok().filter(|v| !b(v.CurrentIsReadOnly()));
        if let Some(v) = via_value {
            v.SetValue(&BSTR::from(value)).map_err(|x| err(ComputerErrorKind::ValueNotTaken, "set value", x))?;
        } else if let (Some(hwnd), true) = (own_hwnd(e), e.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId).is_ok()) {
            let w = wide(value);
            let mut result = 0usize;
            let r = SendMessageTimeoutW(hwnd, WM_SETTEXT, WPARAM(0), LPARAM(w.as_ptr() as isize), SMTO_ABORTIFHUNG, 2000, Some(&mut result));
            if r.0 == 0 || result == 0 {
                return Err(fail(ComputerErrorKind::ValueNotTaken, "the control did not take the text"));
            }
        } else if let Ok(rv) = e.GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId) {
            let x: f64 = value.trim().parse().map_err(|_| fail(ComputerErrorKind::ValueNotTaken, "the element takes a number"))?;
            rv.SetValue(x).map_err(|x| err(ComputerErrorKind::ValueNotTaken, "set value", x))?;
            return Ok(Acted { value: Some(value.to_string()), via: None });
        } else {
            return Err(fail(ComputerErrorKind::ActionUnsupported, "the element has no value it takes without typing"));
        }
        // the evidence, read for up to 300 ms (§5.3): Chromium updates its tree after the write.
        // RichEdit hands back \r for each line break: compare as written
        let read = || current_text(e).map(|t| if !value.contains('\r') { t.replace("\r\n", "\n").replace('\r', "\n") } else { t });
        let until = Instant::now() + std::time::Duration::from_millis(300);
        let mut back = read();
        while back.as_deref() != Some(value) && Instant::now() < until {
            std::thread::sleep(std::time::Duration::from_millis(25));
            back = read();
        }
        Ok(Acted { value: back, via: None })
    }
}

/// Selects text through the Text pattern: the first match of `text` with `prefix` before it and `suffix` after it, or `range`.
unsafe fn select_text(e: &IUIAutomationElement, a: &ComputerAction) -> Result<Acted, ComputerError> {
    unsafe {
        let t = pattern::<IUIAutomationTextPattern>(e, UIA_TextPatternId, "text selection")?;
        let doc = t.DocumentRange().map_err(|x| err(ComputerErrorKind::ActionUnsupported, "text", x))?;
        let all: Vec<u16> = doc.GetText(-1).map(|s| s.to_string()).unwrap_or_default().encode_utf16().collect();
        let (from, to) = if let Some(r) = &a.range {
            (r.first().copied().unwrap_or(0), r.get(1).copied().unwrap_or(0))
        } else {
            let want: Vec<u16> = a.text.as_deref().unwrap_or("").encode_utf16().collect();
            let pre: Vec<u16> = a.prefix.as_deref().unwrap_or("").encode_utf16().collect();
            let suf: Vec<u16> = a.suffix.as_deref().unwrap_or("").encode_utf16().collect();
            let found = (0..=all.len().saturating_sub(want.len())).find(|&i| {
                all[i..].starts_with(&want) && i >= pre.len() && all[i - pre.len()..i] == pre[..] && all[i + want.len()..].starts_with(&suf)
            });
            let Some(i) = found.filter(|_| !want.is_empty()) else {
                return Err(fail(ComputerErrorKind::TextNotFound, "the text is not in the element"));
            };
            (i as i64, (i + want.len()) as i64)
        };
        let (from, to) = match a.place {
            Some(Placement::Before) => (from, from),
            Some(Placement::After) => (to, to),
            _ => (from, to),
        };
        let r = doc.Clone().map_err(|x| err(ComputerErrorKind::ActionUnsupported, "text", x))?;
        r.MoveEndpointByRange(TextPatternRangeEndpoint_End, &doc, TextPatternRangeEndpoint_Start).ok();
        r.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, to as i32).ok();
        r.MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, from as i32).ok();
        r.Select().map_err(|x| err(ComputerErrorKind::ActionUnsupported, "select", x))?;
        Ok(Acted::default())
    }
}
