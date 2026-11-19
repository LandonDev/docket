//! The methods of docs/computer-protocol.md §3 as the Windows service serves
//! them (§29): initialize and the lifecycle, apps, sessions, `state.get`
//! (every `auto` read answers `full`, as the box's service does, §28.3),
//! and `action.run` / `action.batch` at the `ax` tier. Pointer, key and
//! capture verbs answer `action_unsupported` until milestone 43 brings the
//! input and capture tiers; the methods with nothing to do on Windows
//! (`escape.watch`, `input.probe`, `input.restoreSession`, the stream) answer
//! as the box's service does.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use crate::book::Sessions;
use crate::desktop::{fail, Desktop};
use crate::generated::contract::{budget, rpc_error, service as limits, walk, COMPUTER_PROTOCOL};
use crate::locks::{guard, lock_file, AppSlots, FileLock};
use crate::server::{write_frame, RpcError};
use crate::text::{brief_of, render, space_of, RawWindow, TextOptions};
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
    desktop: D,
    epoch: String,
    started_at: i64,
    version: String,
    state: Mutex<State<D::Handle>>,
    /// one initialize at a time, held while it waits for the data dir; never the state lock (§1)
    init: Mutex<()>,
    slots: AppSlots,
}

struct State<H> {
    initialized: Option<(String, InitializeResult)>,
    _service_lock: Option<FileLock>,
    sessions: Sessions<H>,
}

fn now_ms() -> i64 {
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
        Service {
            desktop,
            epoch,
            started_at: now_ms(),
            version: version.into(),
            state: Mutex::new(State { initialized: None, _service_lock: None, sessions: Sessions::default() }),
            init: Mutex::new(()),
            slots: AppSlots::default(),
        }
    }

    pub fn desktop(&self) -> &D {
        &self.desktop
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    /// `apps/changed` from a poll of the app list every second: launched, terminated, activated.
    pub fn start_watch(self: &Arc<Self>, out: Arc<Mutex<Box<dyn std::io::Write + Send>>>) {
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
                guard(&self.state).sessions.close(&p.session);
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
                let r = self.run_steps(&target, &[p.action], &p.tiers, None, wait, p.observe.as_ref(), p.expect_focus.is_some(), cancel)?;
                encode(ActionResult { step: r.steps.into_iter().next().unwrap(), observation: r.observation, observation_error: r.observation_error, ..Default::default() })
            }
            "action.batch" => {
                let p: ActionBatchParams = decode(params)?;
                if p.actions.is_empty() || p.actions.len() > limits::BATCH_MAX_ACTIONS as usize || p.tiers.is_empty() {
                    return Err(RpcError::std(rpc_error::INVALID_PARAMS, format!("invalid params: 1 to {} actions and at least one tier", limits::BATCH_MAX_ACTIONS)));
                }
                gate()?;
                let target = Target { session: p.session, app: p.app, window: p.window, launch: p.launch, epoch: p.epoch };
                let r = self.run_steps(&target, &p.actions, &p.tiers, p.ax_step_wait.or(p.step_wait), p.ax_wait.or(p.wait), p.observe.as_ref(), p.expect_focus.is_some(), cancel)?;
                encode(r)
            }
            "capture.screenshot" | "capture.stream.start" => {
                gate()?;
                Err(fail(ComputerErrorKind::CaptureFailed, "window capture on Windows is not built yet (milestone 43)").into())
            }
            "capture.stream.stop" | "escape.watch" => {
                gate()?;
                encode(json!({}))
            }
            "input.probe" => {
                let p: InputProbeParams = decode(params)?;
                gate()?;
                let app = self.resolve(&p.app)?;
                // no class runs at the process tier yet (milestone 43): nothing was tried
                encode(ProbeReport { pid: app.pid, bundle_id: app.bundle_id, key_window: KeyWindowState::None, results: vec![] })
            }
            "input.restoreSession" => {
                gate()?;
                encode(SessionRestore { frontmost: RestoreOutcome::Nothing, pointer: RestoreOutcome::Nothing, held: None, person_guard: None })
            }
            "clipboard.state" => {
                gate()?;
                encode(ClipboardActivity { change_count: 0, foreign_change_at: None, watching_since: self.started_at as f64 })
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
    fn resolve(&self, r: &AppRef) -> Result<AppInfo, ComputerError> {
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

    /// Launching is milestone 43's: a running app answers its pid, anything else `app_not_found`,
    /// so the host's resolver still falls back to a prefix of a running app's name.
    fn launch(&self, p: AppsLaunchParams) -> Result<Value, RpcError> {
        let app = self.resolve(&AppRef { app: Some(p.app.clone()), pid: None })?;
        if p.refuse.as_ref().is_some_and(|r| app.bundle_id.as_ref().is_some_and(|b| r.iter().any(|x| x.eq_ignore_ascii_case(b)))) {
            return Err(fail(ComputerErrorKind::OpenRefused, format!("{} may not be launched", app.name)).into());
        }
        if p.open.as_ref().is_some_and(|o| !o.is_empty()) {
            return Err(fail(ComputerErrorKind::OpenRefused, "opening items on Windows is not built yet (milestone 43)").into());
        }
        encode(AppsLaunchResult { pid: app.pid, launched: false, ..Default::default() })
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
    fn element(&self, session: &str, pid: i64, index: i64) -> Result<D::Handle, ComputerError> {
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

    /// A read rendered into an Observation, the session's book updated.
    fn observe(&self, session: &str, raw: RawWindow<D::Handle>, subtree: bool, geometry: bool, budget_bytes: Option<i64>, waited: Option<WaitReport>) -> Result<Observation, ComputerError> {
        let started = Instant::now();
        let bytes = budget_bytes.unwrap_or(budget::DEFAULT_BYTES).clamp(budget::MIN_BYTES, budget::MAX_BYTES) as usize;
        let mut st = guard(&self.state);
        let book = st.sessions.book(session, raw.pid).ok_or_else(|| fail(ComputerErrorKind::UnknownSession, format!("no session {session}")))?;
        let r = render(&raw, &raw.root, book, TextOptions { budget_bytes: bytes, geometry, whole_values: subtree }, false);
        if !subtree {
            book.keep_only(&r.seen);
            book.seq += 1;
            book.last_text = Some(r.text.clone());
        }
        let seq = book.seq;
        let space = space_of(raw.frame.w, raw.frame.h);
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
        let obs = self.observe(&p.session, raw, from.is_some(), p.geometry.unwrap_or(false), p.budget.map(|b| b.bytes), waited)?;
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
            match self.step(target, pid, action, tiers, cancel) {
                Ok(ok) => {
                    steps.push(StepResult::Ok(OkStep { index, ..ok }));
                    let changes_screen = !matches!(action.action, ComputerActionName::Wait | ComputerActionName::CursorPosition);
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
                    let o = self.observe(&target.session, raw, false, observe.and_then(|o| o.geometry).unwrap_or(false), observe.and_then(|o| o.budget.clone()).map(|b| b.bytes), Some(waited.clone()))?;
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

    /// One step at the `ax` tier, or the reason it cannot run here.
    fn step(&self, target: &Target, pid: i64, a: &ComputerAction, tiers: &[Tier], cancel: &AtomicBool) -> Result<OkStep, ComputerError> {
        let ok = |tier: Option<Tier>| OkStep { action: a.action, tier, effect: StepEffect::Unknown, ..Default::default() };
        match a.action {
            ComputerActionName::Wait => {
                let ms = (a.duration.unwrap_or(1.0) * 1000.0) as i64;
                let waited = self.wait(pid, target.window.as_ref(), &WaitOptions { min_ms: 0, quiet_ms: 300, max_ms: ms, busy_max_ms: ms }, cancel)?;
                return Ok(OkStep { waited: Some(waited), ..ok(None) });
            }
            ComputerActionName::CursorPosition => return Ok(OkStep { text: Some("X=0, Y=0".into()), cursor: Some(vec![0, 0]), ..ok(None) }),
            _ => {}
        }
        let ax_form = AX_VERBS.contains(&a.action) && a.element.is_some() && a.coordinate.is_none() && a.duration.is_none() && (a.action != ComputerActionName::LeftClick || a.text.is_none());
        if !ax_form {
            return Err(fail(
                ComputerErrorKind::ActionUnsupported,
                format!("{} needs pointer or key input, which Windows does not have yet (milestone 43); act on an element with set_value, perform or a click", a.action.as_str()),
            ));
        }
        if !tiers.contains(&Tier::Ax) {
            return Err(ComputerError { needed: Some(Tier::Ax), ..fail(ComputerErrorKind::NeedsTier, "this step runs only at the ax tier") });
        }
        if a.action == ComputerActionName::Perform && a.name.as_deref() == Some("raise") && !tiers.contains(&Tier::Session) {
            return Err(ComputerError { needed: Some(Tier::Session), ..fail(ComputerErrorKind::NeedsTier, "raise needs the session tier") });
        }
        let index = a.element.unwrap();
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
