//! The methods of docs/computer-protocol.md §3 as the Windows service serves
//! them (§29): initialize and the lifecycle, apps and launching, sessions,
//! `state.get` (every `auto` read answers `full`, as the box's service does,
//! §28.3), `action.run` / `action.batch` at the `ax` tier and the event tiers
//! (act.rs), capture and the preview stream (stream.rs), the Escape watch and
//! the clipboard's.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use crate::book::Sessions;
use crate::desktop::{fail, Desktop, PersonInput, Win};
use crate::generated::contract::{budget, escape as escape_limits, rpc_error, service as limits, walk, COMPUTER_PROTOCOL};
use crate::locks::{guard, lock_file, AppSlots, FileLock};
use crate::server::{write_frame, Out, RpcError};
use crate::stream::Stream;
use crate::text::{brief_of, render, RawWindow, TextOptions};
use crate::wire::*;

/// The verbs the `ax` tier takes on Windows (§29.4).
const AX_VERBS: &[ComputerActionName] = &[
    ComputerActionName::LeftClick,
    ComputerActionName::SetValue,
    ComputerActionName::Perform,
    ComputerActionName::SelectText,
    ComputerActionName::Type,
];

pub struct Service<D: Desktop> {
    pub(crate) desktop: D,
    epoch: String,
    version: String,
    pub(crate) state: Mutex<State<D::Handle>>,
    /// one initialize at a time, held while it waits for the data dir; never the state lock (§1)
    init: Mutex<()>,
    slots: AppSlots,
    /// the frames' writer, for notifications, once serving
    out: Mutex<Option<Out>>,
    me: OnceLock<Weak<Self>>,
    pub(crate) person: Person,
    pub(crate) clip: ClipWatch,
    pub(crate) streams: Mutex<HashMap<String, Arc<Stream>>>,
    /// one window brought forward at a time in this process: front and session steps take it, front first, then the file lock
    pub(crate) front_lock: Mutex<()>,
}

pub(crate) struct State<H> {
    initialized: Option<(String, InitializeResult)>,
    _service_lock: Option<FileLock>,
    sessions: Sessions<H>,
    /// each session × window's space: its last whole screenshot's (§6)
    pub(crate) spaces: HashMap<(String, i64), CoordinateSpace>,
    /// the agent cursor per session × app: its window and its point in the session's space
    pub(crate) cursors: HashMap<(String, i64), (i64, (i64, i64))>,
    /// a left button held down per session × app (§5.1)
    pub(crate) held: HashMap<(String, i64), Held>,
    /// each session's next shot number
    pub(crate) shot_numbers: HashMap<String, u64>,
    /// what the last session step found: the front window and the pointer, for `input.restoreSession`
    pub(crate) restore: Option<(Option<i64>, (f64, f64))>,
}

/// A left button held by `left_mouse_down`.
#[derive(Clone)]
pub(crate) struct Held {
    pub tier: Tier,
    pub window: i64,
    pub at: (i64, i64),
    /// the modifiers the down pressed with it, let go with its up
    pub mods: crate::input::Mods,
    pub since: Instant,
    /// a session-tier button keeps the machine's session lock until it is let go
    pub _lock: Option<Arc<FileLock>>,
}

/// The person watch: whether a session step runs, whether the person stopped it, and the Escape watch's lease.
#[derive(Default)]
pub(crate) struct Person {
    pub active: AtomicBool,
    pub interrupted: AtomicBool,
    pub escape_until: Mutex<Option<Instant>>,
}

/// The clipboard watch (§5.3): its sequence number polled every 250 ms, a change the service did not make is
/// the person's copy. The watch's start counts as one, as `clipboard.state` reads it.
pub(crate) struct ClipWatch {
    since: i64,
    seq: Mutex<Option<i64>>,
    ours: Mutex<HashSet<i64>>,
    foreign_at: Mutex<Option<i64>>,
    /// a paste is writing: the poll leaves the numbers it moves through alone
    pub writing: AtomicBool,
}

impl ClipWatch {
    fn new(since: i64) -> Self {
        ClipWatch { since, seq: Mutex::new(None), ours: Mutex::default(), foreign_at: Mutex::new(None), writing: AtomicBool::new(false) }
    }

    pub(crate) fn poll<D: Desktop>(&self, d: &D) {
        if self.writing.load(Ordering::SeqCst) {
            return;
        }
        let now = d.clip_seq();
        let mut last = guard(&self.seq);
        if *last != Some(now) {
            if last.is_some() && !guard(&self.ours).contains(&now) {
                *guard(&self.foreign_at) = Some(now_ms());
            }
            *last = Some(now);
        }
    }

    /// A sequence number the service's own write left.
    pub(crate) fn ours(&self, seq: i64) {
        guard(&self.ours).insert(seq);
        *guard(&self.seq) = Some(seq);
    }

    /// The person copied (or the watch started) within `ms`.
    pub(crate) fn foreign_within(&self, ms: i64) -> bool {
        let latest = guard(&self.foreign_at).unwrap_or(self.since).max(self.since);
        now_ms() - latest <= ms
    }

    fn state(&self) -> ClipboardActivity {
        ClipboardActivity { change_count: guard(&self.seq).unwrap_or(0), foreign_change_at: guard(&self.foreign_at).map(|t| t as f64), watching_since: self.since as f64 }
    }
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn decode<T: DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(params).map_err(|e| RpcError::std(rpc_error::INVALID_PARAMS, format!("invalid params: {e}")))
}

fn encode<T: Serialize>(v: T) -> Result<Value, RpcError> {
    Ok(serde_json::to_value(v).expect("a result serializes"))
}

fn cancelled() -> ComputerError {
    fail(ComputerErrorKind::Cancelled, "cancelled")
}

impl<D: Desktop> Service<D> {
    pub fn new(desktop: D, version: impl Into<String>) -> Self {
        let epoch = format!("{:x}-{:x}", std::process::id(), now_ms());
        let started_at = now_ms();
        Service {
            desktop,
            epoch,
            version: version.into(),
            state: Mutex::new(State {
                initialized: None,
                _service_lock: None,
                sessions: Sessions::default(),
                spaces: HashMap::new(),
                cursors: HashMap::new(),
                held: HashMap::new(),
                shot_numbers: HashMap::new(),
                restore: None,
            }),
            init: Mutex::new(()),
            slots: AppSlots::default(),
            out: Mutex::new(None),
            me: OnceLock::new(),
            person: Person::default(),
            clip: ClipWatch::new(started_at),
            streams: Mutex::default(),
            front_lock: Mutex::new(()),
        }
    }

    /// A notification to the host; nothing before serving starts.
    pub(crate) fn notify(&self, method: &str, params: Value) {
        let out = guard(&self.out).clone();
        if let Some(out) = out {
            write_frame(&out, &json!({ "jsonrpc": "2.0", "method": method, "params": params }));
        }
    }

    pub(crate) fn data_dir(&self) -> Option<PathBuf> {
        guard(&self.state).initialized.as_ref().map(|(d, _)| PathBuf::from(d))
    }

    pub fn desktop(&self) -> &D {
        &self.desktop
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    /// `apps/changed` from a poll of the app list every second: launched, terminated, activated. Also the
    /// person watch (a session step stopped, Escape while watched), the clipboard's and the held button's clocks.
    pub fn start_watch(self: &Arc<Self>, out: Out) {
        *guard(&self.out) = Some(out.clone());
        let _ = self.me.set(Arc::downgrade(self));
        let weak = Arc::downgrade(self);
        self.desktop.watch_person(Box::new(move |input| {
            let Some(me) = weak.upgrade() else { return };
            if me.person.active.load(Ordering::SeqCst) {
                me.person.interrupted.store(true, Ordering::SeqCst);
            }
            // a session-tier button held between calls is let go when the person acts (§5.1)
            if guard(&me.state).held.values().any(|h| h.tier == Tier::Session) {
                me.release_held_session();
            }
            if input == PersonInput::Escape && guard(&me.person.escape_until).is_some_and(|t| Instant::now() < t) {
                me.notify("escape/pressed", json!({ "at": now_ms() }));
            }
        }));
        let ticker = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(limits::CLIPBOARD_POLL_MS as u64));
            match ticker.upgrade() {
                Some(me) if guard(&me.state).initialized.is_some() => me.tick(),
                Some(_) => {}
                None => return,
            }
        });
        let me = self.clone();
        std::thread::spawn(move || {
            let mut known: HashMap<i64, AppInfo> = HashMap::new();
            let mut active: Option<i64> = None;
            let mut first = true;
            loop {
                std::thread::sleep(Duration::from_millis(1000));
                if guard(&me.state).initialized.is_none() {
                    continue;
                }
                let Ok(apps) = me.desktop.apps(false) else { continue };
                let now: HashMap<i64, AppInfo> = apps.iter().map(|a| (a.pid, a.clone())).collect();
                let now_active = apps.iter().find(|a| a.active).map(|a| a.pid);
                if !first {
                    let send = |a: &AppInfo, change: AppsChangedNotificationParamsChange| {
                        let params = AppsChangedNotificationParams { pid: a.pid, bundle_id: a.bundle_id.clone(), name: a.name.clone(), change };
                        write_frame(&out, &json!({ "jsonrpc": "2.0", "method": "apps/changed", "params": params }));
                    };
                    for a in apps.iter().filter(|a| !known.contains_key(&a.pid)) {
                        send(a, AppsChangedNotificationParamsChange::Launched);
                    }
                    for a in known.values().filter(|a| !now.contains_key(&a.pid)) {
                        send(a, AppsChangedNotificationParamsChange::Terminated);
                    }
                    if now_active != active {
                        if let Some(a) = now_active.and_then(|p| now.get(&p)) {
                            send(a, AppsChangedNotificationParamsChange::Activated);
                        }
                    }
                }
                first = false;
                known = now;
                active = now_active;
            }
        });
    }

    /// One request: its result, or the error to answer.
    pub fn handle(&self, method: &str, params: Value, cancel: &AtomicBool) -> Result<Value, RpcError> {
        if !crate::generated::contract::METHODS.contains(&method) {
            return Err(RpcError::std(rpc_error::METHOD_NOT_FOUND, format!("no method {method}")));
        }
        if method == "initialize" {
            return self.initialize(decode(params)?);
        }
        // params are checked before the init gate, as the box's service does
        let gate = || -> Result<(), RpcError> {
            if guard(&self.state).initialized.is_none() {
                return Err(fail(ComputerErrorKind::NotInitialized, "initialize first").into());
            }
            Ok(())
        };
        match method {
            // answered before initialize too, as the Swift service does, so a host can end one it gave up on
            "shutdown" => {
                let _: Empty = decode(params)?;
                self.release_held(None, None);
                encode(json!({}))
            }
            "permissions.get" | "permissions.request" => {
                if method == "permissions.request" {
                    let _: PermissionsRequestParams = decode(params)?;
                }
                gate()?;
                encode(Permissions { accessibility: true, screen_recording: true })
            }
            "apps.list" => {
                let p: AppsListParams = decode(params)?;
                gate()?;
                encode(AppsListResult { apps: self.desktop.apps(p.windows.unwrap_or(false))? })
            }
            "apps.launch" => {
                let p: AppsLaunchParams = decode(params)?;
                gate()?;
                self.launch(p)
            }
            "session.open" => {
                let p: SessionRef = decode(params)?;
                gate()?;
                guard(&self.state).sessions.open(&p.session);
                encode(json!({}))
            }
            "session.close" => {
                let p: SessionRef = decode(params)?;
                gate()?;
                self.release_held(Some(&p.session), None);
                let ids: Vec<String> = guard(&self.streams).values().filter(|s| s.session == p.session).map(|s| s.id.clone()).collect();
                for id in ids {
                    self.stream_stop(&id);
                }
                let mut st = guard(&self.state);
                st.sessions.close(&p.session);
                st.spaces.retain(|(s, _), _| *s != p.session);
                st.cursors.retain(|(s, _), _| *s != p.session);
                encode(json!({}))
            }
            "state.get" => {
                let p: StateGetParams = decode(params)?;
                gate()?;
                self.state_get(p, cancel)
            }
            "action.run" => {
                let p: ActionRunParams = decode(params)?;
                if p.tiers.is_empty() {
                    return Err(RpcError::std(rpc_error::INVALID_PARAMS, "invalid params: at least one tier"));
                }
                gate()?;
                let target = Target { session: p.session, app: p.app, window: p.window, launch: p.launch, epoch: p.epoch };
                let wait = p.ax_wait.or(p.wait);
                let r = self.run_steps(&target, &[p.action], &p.tiers, None, wait, p.observe.as_ref(), p.expect_focus.is_some(), p.paste_quiet_ms, cancel)?;
                encode(ActionResult { step: r.steps.into_iter().next().unwrap(), observation: r.observation, observation_error: r.observation_error, ..Default::default() })
            }
            "action.batch" => {
                let p: ActionBatchParams = decode(params)?;
                if p.actions.is_empty() || p.actions.len() > limits::BATCH_MAX_ACTIONS as usize || p.tiers.is_empty() {
                    return Err(RpcError::std(rpc_error::INVALID_PARAMS, format!("invalid params: 1 to {} actions and at least one tier", limits::BATCH_MAX_ACTIONS)));
                }
                gate()?;
                let target = Target { session: p.session, app: p.app, window: p.window, launch: p.launch, epoch: p.epoch };
                let r = self.run_steps(&target, &p.actions, &p.tiers, p.ax_step_wait.or(p.step_wait), p.ax_wait.or(p.wait), p.observe.as_ref(), p.expect_focus.is_some(), p.paste_quiet_ms, cancel)?;
                encode(r)
            }
            "capture.screenshot" => {
                let p: CaptureScreenshotParams = decode(params)?;
                gate()?;
                let target = Target { session: p.session.clone(), app: p.app.clone(), window: p.window.clone(), launch: p.launch, epoch: p.epoch.clone() };
                self.check_session(&target)?;
                let app = self.resolve(&p.app)?;
                let win = self.desktop.window(app.pid, p.window.as_ref())?;
                encode(self.shoot(&p.session, &win, p.max_edge, p.region.as_ref(), p.format, "screenshot")?)
            }
            "capture.stream.start" => {
                let p: CaptureStreamStartParams = decode(params)?;
                gate()?;
                let target = Target { session: p.session.clone(), app: p.app.clone(), window: p.window.clone(), launch: p.launch, epoch: p.epoch.clone() };
                self.check_session(&target)?;
                let me = self.me.get().and_then(Weak::upgrade).ok_or_else(|| fail(ComputerErrorKind::CaptureFailed, "the service is not serving"))?;
                encode(me.stream_start(p)?)
            }
            "capture.stream.stop" => {
                let p: CaptureStreamStopParams = decode(params)?;
                gate()?;
                self.stream_stop(&p.stream);
                encode(json!({}))
            }
            "escape.watch" => {
                let p: EscapeWatchParams = decode(params)?;
                gate()?;
                let lease = p.lease_ms.unwrap_or(escape_limits::LEASE_MS).clamp(escape_limits::MIN_LEASE_MS, escape_limits::MAX_LEASE_MS);
                *guard(&self.person.escape_until) = p.on.then(|| Instant::now() + Duration::from_millis(lease as u64));
                encode(json!({}))
            }
            "input.probe" => {
                let p: InputProbeParams = decode(params)?;
                gate()?;
                let app = self.resolve(&p.app)?;
                // posted messages reach a background window's controls whatever has the focus: nothing to probe
                encode(ProbeReport { pid: app.pid, bundle_id: app.bundle_id, key_window: KeyWindowState::None, results: vec![] })
            }
            "input.restoreSession" => {
                let _: InputRestoreSessionParams = decode(params)?;
                gate()?;
                encode(self.restore_session())
            }
            "clipboard.state" => {
                gate()?;
                self.clip.poll(&self.desktop);
                encode(self.clip.state())
            }
            _ => Err(RpcError::std(rpc_error::METHOD_NOT_FOUND, format!("no method {method}"))),
        }
    }

    fn initialize(&self, p: InitializeParams) -> Result<Value, RpcError> {
        if p.protocol != COMPUTER_PROTOCOL {
            return Err(fail(ComputerErrorKind::ProtocolMismatch, format!("this service speaks protocol {COMPUTER_PROTOCOL}")).into());
        }
        let _one = guard(&self.init);
        if let Some((dir, result)) = &guard(&self.state).initialized {
            if *dir == p.data_dir {
                return encode(result.clone());
            }
            return Err(RpcError::std(rpc_error::INVALID_REQUEST, "initialized with another dataDir"));
        }
        // one service per data dir (§16.2)
        let lock = lock_file(&PathBuf::from(&p.data_dir).join("service.lock"), Duration::from_millis(limits::SERVICE_LOCK_WAIT_MS as u64))
            .map_err(|e| fail(ComputerErrorKind::AlreadyRunning, format!("cannot lock the data dir: {e}")))?
            .ok_or_else(|| fail(ComputerErrorKind::AlreadyRunning, "another service holds this data dir"))?;
        let (version, arch) = self.desktop.os();
        let result = InitializeResult {
            protocol: COMPUTER_PROTOCOL,
            service: InitializeResultService { version: self.version.clone(), build: "win-uia".into() },
            epoch: self.epoch.clone(),
            os: InitializeResultOs { version, arch },
            permissions: Permissions { accessibility: true, screen_recording: true },
            displays: self.desktop.displays(),
            features: Some(vec![]),
        };
        let mut st = guard(&self.state);
        st.initialized = Some((p.data_dir, result.clone()));
        st._service_lock = Some(lock);
        encode(result)
    }

    /// §2.1 on Windows: the exe name (`notepad.exe`) or display name, case-insensitively; else a unique prefix of a name.
    pub(crate) fn resolve(&self, r: &AppRef) -> Result<AppInfo, ComputerError> {
        let apps = self.desktop.apps(false)?;
        if let Some(pid) = r.pid {
            return apps.into_iter().find(|a| a.pid == pid).ok_or_else(|| fail(ComputerErrorKind::AppNotFound, format!("no app with pid {pid}")));
        }
        let q = r.app.clone().unwrap_or_default().to_lowercase();
        let q_exe = if q.ends_with(".exe") { q.clone() } else { format!("{q}.exe") };
        let exact = apps.iter().find(|a| a.bundle_id.as_deref().is_some_and(|b| b.to_lowercase() == q || b.to_lowercase() == q_exe));
        if let Some(a) = exact.or_else(|| apps.iter().find(|a| a.name.to_lowercase() == q)) {
            return Ok(a.clone());
        }
        let prefixed: Vec<&AppInfo> = apps.iter().filter(|a| !q.is_empty() && a.name.to_lowercase().starts_with(&q)).collect();
        if prefixed.len() == 1 {
            return Ok(prefixed[0].clone());
        }
        let mut candidates: Vec<String> = if prefixed.is_empty() { apps.iter().map(|a| a.name.clone()).collect() } else { prefixed.iter().map(|a| a.name.clone()).collect() };
        candidates.dedup();
        candidates.truncate(5);
        Err(ComputerError { candidates: Some(candidates), ..fail(ComputerErrorKind::AppNotFound, format!("no running app matches {:?}", r.app.as_deref().unwrap_or(""))) })
    }

    /// `apps.launch` (§23 as Windows has it): a running app answers its pid (opening `open` in it when given);
    /// else its exe is started without coming forward, and an app that comes forward anyway is sent back.
    fn launch(&self, p: AppsLaunchParams) -> Result<Value, RpcError> {
        let refused = |exe: &str| p.refuse.as_ref().is_some_and(|r| r.iter().any(|x| x.eq_ignore_ascii_case(exe)));
        let open = p.open.clone().unwrap_or_default();
        if open.len() > limits::OPEN_ITEMS_MAX as usize {
            return Err(fail(ComputerErrorKind::OpenRefused, format!("at most {} items at once", limits::OPEN_ITEMS_MAX)).into());
        }
        if let Some(item) = open.iter().find(|i| runs_as_program(i)) {
            return Err(ComputerError { reason: Some(ErrorReason::Executable), ..fail(ComputerErrorKind::OpenRefused, format!("{item} is a program; open opens documents, folders and pages")) }.into());
        }
        let running = self.resolve(&AppRef { app: Some(p.app.clone()), pid: None });
        let exe = match &running {
            Ok(app) => app.bundle_id.clone().unwrap_or_default(),
            Err(_) => p.app.clone(),
        };
        // refused by the exe's own file name, however the app was named (a path included)
        let name = exe.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
        let name = if name.ends_with(".exe") { name } else { format!("{name}.exe") };
        if refused(&name) {
            return Err(fail(ComputerErrorKind::OpenRefused, format!("{exe} may not be launched")).into());
        }
        if let Ok(app) = &running {
            if open.is_empty() {
                return encode(AppsLaunchResult { pid: app.pid, launched: false, ..Default::default() });
            }
        }
        let front_before = self.desktop.front();
        let started = self.desktop.launch(&exe, &open).map_err(|e| if running.is_err() { running.clone().err().unwrap_or(e) } else { e })?;
        // the app's window, by its exe (a launcher hands its work to the app's own process), for up to 10 s
        let deadline = Instant::now() + Duration::from_millis(limits::LAUNCH_WINDOW_MS as u64);
        let known: HashSet<i64> = match &running {
            Ok(app) => self.desktop.apps(true).ok().and_then(|a| a.into_iter().find(|x| x.pid == app.pid)).and_then(|a| a.windows).unwrap_or_default().iter().map(|w| w.id).collect(),
            Err(_) => HashSet::new(),
        };
        // a new window of the app's, by its exe; for a running app that opened an item in a window it had, its front one at the end
        let mut found: Option<(i64, WindowInfo)> = None;
        let mut fallback: Option<(i64, WindowInfo)> = None;
        while found.is_none() && Instant::now() < deadline {
            if let Ok(apps) = self.desktop.apps(true) {
                let windows: Vec<(i64, WindowInfo)> = apps
                    .iter()
                    .filter(|a| a.pid == started || a.bundle_id.as_deref().is_some_and(|b| b.eq_ignore_ascii_case(&name)))
                    .flat_map(|a| a.windows.clone().unwrap_or_default().into_iter().map(move |w| (a.pid, w)))
                    .collect();
                found = windows.iter().find(|(_, w)| !known.contains(&w.id)).cloned();
                fallback = windows.iter().find(|(_, w)| w.main).or(windows.first()).cloned();
            }
            if found.is_none() {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        let found = found.or(if running.is_ok() { fallback } else { None });
        let pid = found.as_ref().map(|(pid, _)| *pid).or(running.as_ref().ok().map(|a| a.pid)).unwrap_or(started);
        // the front guard (§23.3): an app that took the front is sent back behind the person's window
        // watched for half a second: an app often takes the front a moment after its window shows
        let mut front = None;
        let watch_until = Instant::now() + Duration::from_millis(limits::FRONT_CHOICE_MS as u64);
        while front.is_none() && Instant::now() < watch_until {
            if let (Some((before_pid, before)), Some((now_pid, _))) = (front_before, self.desktop.front()) {
                if now_pid == pid && before_pid != pid {
                    let back = self.desktop.raise(before);
                    front = Some(FrontReport { raised: true, restored: Some(if back { FrontRestore::Restored } else { FrontRestore::Failed }), ms: None });
                }
            }
            if front.is_none() {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let window = found.map(|(_, w)| LaunchedWindow { id: w.id, title: w.title });
        encode(AppsLaunchResult { pid, launched: running.is_err(), front, window, others: None })
    }

    fn check_session(&self, t: &Target) -> Result<(), ComputerError> {
        if !guard(&self.state).sessions.is_open(&t.session) {
            return Err(fail(ComputerErrorKind::UnknownSession, format!("no session {}", t.session)));
        }
        Ok(())
    }

    fn check_epoch(&self, t: &Target) -> Result<(), ComputerError> {
        match &t.epoch {
            Some(e) if *e != self.epoch => Err(ComputerError {
                reason: Some(ErrorReason::ServiceRestarted),
                ..fail(ComputerErrorKind::StaleElement, "the service restarted; read the window again")
            }),
            _ => Ok(()),
        }
    }

    fn read(&self, pid: i64, window: Option<&WindowRef>, from: Option<&D::Handle>) -> Result<RawWindow<D::Handle>, ComputerError> {
        self.desktop.read(pid, window, from, Instant::now() + Duration::from_millis(walk::MAX_MS as u64))
    }

    /// The handle behind an index, or the error a call naming it answers.
    pub(crate) fn element(&self, session: &str, pid: i64, index: i64) -> Result<D::Handle, ComputerError> {
        let mut st = guard(&self.state);
        let book = st.sessions.book(session, pid).ok_or_else(|| fail(ComputerErrorKind::UnknownSession, format!("no session {session}")))?;
        book.handle(index).map_err(|gone| {
            if gone {
                ComputerError { element: Some(index), reason: Some(ErrorReason::Gone), ..fail(ComputerErrorKind::StaleElement, format!("[{index}] is gone")) }
            } else {
                ComputerError { element: Some(index), ..fail(ComputerErrorKind::NoSuchElement, format!("no element [{index}]")) }
            }
        })
    }

    /// A read rendered into an Observation, the session's book updated. With `shots`, a picture comes too:
    /// `always`, or `auto` on a thin tree (§4.5); a failed one is `shotError`.
    #[allow(clippy::too_many_arguments)]
    fn observe(&self, session: &str, raw: RawWindow<D::Handle>, subtree: bool, geometry: bool, budget_bytes: Option<i64>, waited: Option<WaitReport>, shots: Option<Shots>) -> Result<Observation, ComputerError> {
        let started = Instant::now();
        let bytes = budget_bytes.unwrap_or(budget::DEFAULT_BYTES).clamp(budget::MIN_BYTES, budget::MAX_BYTES) as usize;
        let win = Win { id: raw.window_id, pid: raw.pid, title: raw.title.clone(), frame: raw.frame.clone(), minimized: false };
        let policy = shots.as_ref().map_or(ScreenshotPolicy::Never, |s| s.policy);
        // an `always` shot first: it may set the session's space, which the text's geometry is in
        let mut shot: Option<Result<Shot, ComputerError>> = (policy == ScreenshotPolicy::Always).then(|| self.shoot(session, &win, shots.as_ref().and_then(|s| s.max_edge), None, None, "observe"));
        let space = self.space(session, &win);
        let opts = TextOptions { budget_bytes: bytes, geometry, whole_values: subtree, space: Some(space.clone()) };
        let with_shot = policy != ScreenshotPolicy::Never;
        let mut st = guard(&self.state);
        let book = st.sessions.book(session, raw.pid).ok_or_else(|| fail(ComputerErrorKind::UnknownSession, format!("no session {session}")))?;
        let r = render(&raw, &raw.root, book, opts, with_shot);
        if !subtree {
            book.keep_only(&r.seen);
            book.seq += 1;
            book.last_text = Some(r.text.clone());
        }
        let seq = book.seq;
        drop(st);
        if shot.is_none() && policy == ScreenshotPolicy::Auto && r.thin {
            shot = Some(self.shoot(session, &win, shots.as_ref().and_then(|s| s.max_edge), None, None, "observe"));
        }
        let (shot, shot_error) = match shot {
            Some(Ok(s)) => (Some(s), None),
            Some(Err(e)) => (None, Some(e)),
            None => (None, None),
        };
        // the thin word points at a picture: none came, so the header does not say it
        let mut r = r;
        if shot.is_none() && r.thin {
            let thin = format!("{}{}", crate::generated::contract::grammar::HEADER_SEPARATOR, crate::generated::contract::grammar::HEADER_THIN);
            if let Some(end) = r.text.find('\n').or(Some(r.text.len())) {
                if r.text[..end].ends_with(&thin) {
                    r.text.replace_range(end - thin.len()..end, "");
                }
            }
        }
        Ok(Observation {
            epoch: self.epoch.clone(),
            session: session.to_string(),
            app: ObservationApp { pid: raw.pid, bundle_id: raw.bundle_id.clone(), name: raw.app_name.clone() },
            window: ObservationWindow { id: raw.window_id, title: raw.title.clone(), frame: raw.frame.clone() },
            kind: if subtree { ObservationKind::Subtree } else { ObservationKind::Full },
            seq,
            base: None,
            stats: ObservationStats {
                elements: r.elements,
                lines: r.lines,
                bytes: r.text.len() as i64,
                omitted: r.omitted,
                thin: r.thin,
                partial: raw.partial,
                read_ms: raw.read_ms + started.elapsed().as_millis() as i64,
            },
            text: r.text,
            space,
            shot,
            shot_error,
            waited,
            ..Default::default()
        })
    }

    fn state_get(&self, p: StateGetParams, cancel: &AtomicBool) -> Result<Value, RpcError> {
        let target = Target { session: p.session.clone(), app: p.app.clone(), window: p.window.clone(), launch: p.launch, epoch: p.epoch.clone() };
        self.check_session(&target)?;
        if p.element.is_some() {
            self.check_epoch(&target)?;
        }
        let app = self.resolve(&p.app)?;
        let _read = self.slots.read(app.pid);
        let waited = match &p.wait {
            Some(w) => Some(self.wait(app.pid, p.window.as_ref(), w, cancel)?),
            None => None,
        };
        let from = p.element.map(|i| self.element(&p.session, app.pid, i)).transpose()?;
        let raw = self.read(app.pid, p.window.as_ref(), from.as_ref())?;
        let shots = (from.is_none()).then(|| Shots { policy: p.screenshot.unwrap_or(ScreenshotPolicy::Auto), max_edge: p.max_edge });
        let obs = self.observe(&p.session, raw, from.is_some(), p.geometry.unwrap_or(false), p.budget.map(|b| b.bytes), waited, shots)?;
        encode(obs)
    }

    /// The smart wait (§7) as this service can see it: the window's text read
    /// again until it holds still for `quietMs`, from `minMs`, at most `maxMs`.
    fn wait(&self, pid: i64, window: Option<&WindowRef>, w: &WaitOptions, cancel: &AtomicBool) -> Result<WaitReport, ComputerError> {
        let start = Instant::now();
        let sleep = |ms: i64| -> bool {
            let until = Instant::now() + Duration::from_millis(ms.max(0) as u64);
            while Instant::now() < until {
                if cancel.load(Ordering::SeqCst) {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(10).min(until - Instant::now()));
            }
            true
        };
        let report = |reason: WaitReason, settled: bool| WaitReport { waited_ms: start.elapsed().as_millis() as i64, settled, busy: false, reason, first_change_ms: None, gap_counts: None };
        if w.max_ms <= 0 {
            return Ok(report(WaitReason::Skipped, true));
        }
        if !sleep(w.min_ms) {
            return Ok(report(WaitReason::Cancelled, false));
        }
        let sig = |s: &Self| s.read(pid, window, None).map(|r| signature(&r)).unwrap_or(0);
        let mut last = sig(self);
        loop {
            let left = w.max_ms - start.elapsed().as_millis() as i64;
            if left <= 0 {
                return Ok(report(WaitReason::Max, false));
            }
            if !sleep(w.quiet_ms.min(left)) {
                return Ok(report(WaitReason::Cancelled, false));
            }
            let now = sig(self);
            if now == last {
                return Ok(report(WaitReason::Quiet, true));
            }
            last = now;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run_steps(
        &self,
        target: &Target,
        actions: &[ComputerAction],
        tiers: &[Tier],
        step_wait: Option<WaitOptions>,
        wait: Option<WaitOptions>,
        observe: Option<&ObserveOptions>,
        expect_focus: bool,
        paste_quiet_ms: Option<i64>,
        cancel: &AtomicBool,
    ) -> Result<BatchResult, RpcError> {
        self.check_session(target)?;
        // expectFocus is an element index too (§2); no step here posts a key, so it is checked for its epoch only
        let names_element = expect_focus || actions.iter().any(|a| a.element.is_some() || a.start_element.is_some());
        if names_element {
            self.check_epoch(target)?;
        }
        let app = self.resolve(&target.app)?;
        let pid = app.pid;
        let mut steps: Vec<StepResult> = Vec::new();
        let slot = self.slots.act(pid, Duration::from_millis(limits::APP_SLOT_WAIT_MS as u64));
        let mut failed = slot.is_none();
        if failed {
            steps.push(StepResult::Failed(FailedStep { index: 0, action: actions[0].action, error: fail(ComputerErrorKind::AppBusy, format!("{} is busy with another action", app.name)) }));
        }
        let before = {
            let mut st = guard(&self.state);
            st.sessions.book(&target.session, pid).and_then(|b| b.last_text.clone())
        };
        for (i, action) in actions.iter().enumerate().skip(steps.len()) {
            let index = i as i64;
            if failed {
                steps.push(StepResult::NotRun(NotRunStep { index, action: action.action, stopped: None }));
                continue;
            }
            if cancel.load(Ordering::SeqCst) {
                steps.push(StepResult::Failed(FailedStep { index, action: action.action, error: cancelled() }));
                failed = true;
                continue;
            }
            match self.step(target, pid, action, tiers, observe.and_then(|o| o.max_edge), paste_quiet_ms, cancel) {
                Ok(ok) => {
                    steps.push(StepResult::Ok(OkStep { index, ..ok }));
                    let changes_screen = !matches!(action.action, ComputerActionName::Wait | ComputerActionName::CursorPosition | ComputerActionName::Screenshot | ComputerActionName::Zoom);
                    if changes_screen && i + 1 < actions.len() {
                        if let Some(w) = &step_wait {
                            self.wait(pid, target.window.as_ref(), w, cancel)?;
                        }
                    }
                }
                Err(error) => {
                    steps.push(StepResult::Failed(FailedStep { index, action: action.action, error }));
                    failed = true;
                }
            }
        }
        let waited = match &wait {
            Some(w) if steps.iter().any(|s| matches!(s, StepResult::Ok(_))) => self.wait(pid, target.window.as_ref(), w, cancel)?,
            _ => WaitReport { reason: WaitReason::Skipped, settled: true, ..Default::default() },
        };
        drop(slot);
        let mode = observe.and_then(|o| o.mode).unwrap_or(ObserveMode::Auto);
        let (mut observation, mut observation_error) = (None, None);
        if cancel.load(Ordering::SeqCst) {
            observation_error = Some(cancelled());
        } else if mode != ObserveMode::None {
            match self.read(pid, target.window.as_ref(), None) {
                Ok(raw) => {
                    let shots = Shots { policy: observe.and_then(|o| o.screenshot).unwrap_or(ScreenshotPolicy::Auto), max_edge: observe.and_then(|o| o.max_edge) };
                    let o = self.observe(&target.session, raw, false, observe.and_then(|o| o.geometry).unwrap_or(false), observe.and_then(|o| o.budget.clone()).map(|b| b.bytes), Some(waited.clone()), Some(shots))?;
                    // a step's effect: whether the window's text moved from the last one the session got
                    for s in steps.iter_mut() {
                        if let StepResult::Ok(ok) = s {
                            if ok.effect == StepEffect::Unknown && ok.tier.is_some() {
                                if let Some(b) = &before {
                                    ok.effect = if *b != o.text { StepEffect::Changed } else { StepEffect::None };
                                }
                            }
                            if let Some(el) = ok.element.as_mut() {
                                if let Some(line) = brief_of(&o.text, el.index) {
                                    el.line = line;
                                }
                            }
                        }
                    }
                    observation = Some(o);
                }
                Err(e) => observation_error = Some(e),
            }
        }
        // a step with no closing read names its element as the session's last read printed it
        if observation.is_none() {
            for s in steps.iter_mut() {
                if let StepResult::Ok(OkStep { element: Some(el), .. }) = s {
                    el.line = before.as_deref().and_then(|t| brief_of(t, el.index)).unwrap_or_default();
                }
            }
        }
        Ok(BatchResult { steps, observation, observation_error, waited, ..Default::default() })
    }

    /// One step: at the `ax` tier when it takes the step, else at the first allowed event tier (act.rs).
    #[allow(clippy::too_many_arguments)]
    fn step(&self, target: &Target, pid: i64, a: &ComputerAction, tiers: &[Tier], max_edge: Option<i64>, paste_quiet_ms: Option<i64>, cancel: &AtomicBool) -> Result<OkStep, ComputerError> {
        let ok = |tier: Option<Tier>| OkStep { action: a.action, tier, effect: StepEffect::Unknown, ..Default::default() };
        match a.action {
            ComputerActionName::Wait => {
                let ms = (a.duration.unwrap_or(1.0) * 1000.0) as i64;
                let waited = self.wait(pid, target.window.as_ref(), &WaitOptions { min_ms: 0, quiet_ms: 300, max_ms: ms, busy_max_ms: ms }, cancel)?;
                return Ok(OkStep { waited: Some(waited), ..ok(None) });
            }
            ComputerActionName::CursorPosition => {
                let p = guard(&self.state).cursors.get(&(target.session.clone(), pid)).map(|(_, p)| *p).unwrap_or((0, 0));
                return Ok(OkStep { text: Some(format!("X={}, Y={}", p.0, p.1)), cursor: Some(vec![p.0, p.1]), ..ok(None) });
            }
            ComputerActionName::Screenshot | ComputerActionName::Zoom => {
                let win = self.desktop.window(pid, target.window.as_ref())?;
                let region = if a.action == ComputerActionName::Zoom { a.region.as_ref() } else { None };
                let shot = self.shoot(&target.session, &win, max_edge, region, None, a.action.as_str())?;
                return Ok(OkStep { effect: StepEffect::None, shot: Some(shot), ..ok(None) });
            }
            _ => {}
        }
        let ax_form = AX_VERBS.contains(&a.action) && a.element.is_some() && a.coordinate.is_none() && a.duration.is_none() && (a.action != ComputerActionName::LeftClick || a.text.is_none());
        let ax_only = matches!(a.action, ComputerActionName::SetValue | ComputerActionName::Perform | ComputerActionName::SelectText);
        let event = crate::input::event_tier(tiers, a);
        if ax_form && tiers.contains(&Tier::Ax) {
            match self.ax_step(target, pid, a, tiers) {
                // a click or typing the element takes no other way goes on to an event tier
                Err(e) if e.kind == ComputerErrorKind::ActionUnsupported && !ax_only && event.is_some() => {}
                r => return r,
            }
        } else if ax_only {
            return if tiers.contains(&Tier::Ax) { self.ax_step(target, pid, a, tiers) } else { Err(ComputerError { needed: Some(Tier::Ax), ..fail(ComputerErrorKind::NeedsTier, "this step runs only at the ax tier") }) };
        }
        let (tier, done) = self.event_step(&target.session, pid, target.window.as_ref(), a, tiers, paste_quiet_ms, cancel)?;
        let input = done.via.map(|via| OkStepInput { via, clipboard: done.clipboard, on: None });
        let element = a.element.map(|index| ElementBrief { index, line: String::new() });
        Ok(OkStep { element, input, session: done.session, cursor: done.cursor.map(|p| vec![p.0, p.1]), ..ok(Some(tier)) })
    }

    /// One step at the `ax` tier.
    fn ax_step(&self, target: &Target, pid: i64, a: &ComputerAction, tiers: &[Tier]) -> Result<OkStep, ComputerError> {
        let ok = |tier: Option<Tier>| OkStep { action: a.action, tier, effect: StepEffect::Unknown, ..Default::default() };
        if a.action == ComputerActionName::Perform && a.name.as_deref() == Some("raise") && !tiers.contains(&Tier::Session) {
            return Err(ComputerError { needed: Some(Tier::Session), ..fail(ComputerErrorKind::NeedsTier, "raise needs the session tier") });
        }
        let index = a.element.ok_or_else(|| fail(ComputerErrorKind::ActionUnsupported, "this step needs an element"))?;
        let handle = self.element(&target.session, pid, index)?;
        let acted = self.desktop.act(pid, &handle, a)?;
        if a.action == ComputerActionName::SetValue {
            if let (Some(want), Some(got)) = (&a.value, &acted.value) {
                if want != got {
                    return Err(ComputerError { value: Some(got.clone()), ..fail(ComputerErrorKind::ValueNotTaken, "the element did not take the value") });
                }
            }
        }
        let effect = if a.action == ComputerActionName::SetValue && acted.value.is_some() { StepEffect::Changed } else { StepEffect::Unknown };
        let input = acted.via.map(|via| OkStepInput { via, clipboard: None, on: None });
        Ok(OkStep { element: Some(ElementBrief { index, line: String::new() }), input, effect, ..ok(Some(Tier::Ax)) })
    }
}

/// What an observation's picture follows: the call's policy and long edge.
pub(crate) struct Shots {
    policy: ScreenshotPolicy,
    max_edge: Option<i64>,
}

/// An item `open` refuses on Windows: a program or a script, which would run rather than open.
fn runs_as_program(item: &str) -> bool {
    let lower = item.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return false;
    }
    const RUNS: &[&str] = &[".exe", ".com", ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".msi", ".msp", ".scr", ".lnk", ".url", ".hta", ".cpl", ".msc", ".reg", ".pif", ".appref-ms"];
    RUNS.iter().any(|ext| lower.ends_with(ext))
}

/// A cheap hash of a read: every node's role, name, value and states.
pub fn signature<H>(w: &RawWindow<H>) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    w.title.hash(&mut h);
    crate::desktop::walk(&w.root, &mut |n| {
        n.role.hash(&mut h);
        n.name.hash(&mut h);
        n.value.hash(&mut h);
        n.states.hash(&mut h);
        n.caret.hash(&mut h);
    });
    h.finish()
}
