import SwiftUI
import TempCodeClient
import UIKit

/// A cold launch's marks (`LaunchClock`), made from effects and never from a
/// body: the root's first frame and the first rows of Home or Today. In every
/// build, for Settings → Diagnostics and the `launch` signposts; the
/// `work-perf` proof's runs (`WorkPerfRun`, DEBUG and Measure builds) read them.
enum LaunchFrames {
    /// The root view appeared: its first frame is committed at the end of this
    /// turn of the run loop and shown at the next display tick, where it is marked.
    static func rootAppeared() {
        guard LaunchClock.marks.firstFrameMs == nil else { return }
        DisplayTicks.run { _ in
            LaunchClock.mark(.firstFrame)
            return true
        }
    }

    /// A Home or Today row appeared; `cached` when what it shows came from the cache.
    static func rowAppeared(cached: Bool) {
        LaunchClock.mark(.firstRow)
        if cached { LaunchClock.mark(.cachedRow) }
    }
}

/// A callback on each display tick until it answers true (CADisplayLink
/// holds its target until then). It gets the seconds since the first tick.
final class DisplayTicks: NSObject {
    private let each: (Double) -> Bool
    private var link: CADisplayLink?
    private var first: CFTimeInterval?

    private init(_ each: @escaping (Double) -> Bool) {
        self.each = each
    }

    static func run(_ each: @escaping (Double) -> Bool) {
        let ticks = DisplayTicks(each)
        let link = CADisplayLink(target: ticks, selector: #selector(tick(_:)))
        ticks.link = link
        link.add(to: .main, forMode: .common)
    }

    @objc private func tick(_ link: CADisplayLink) {
        let first = self.first ?? link.timestamp
        self.first = first
        if each(link.timestamp - first) {
            link.invalidate()
            self.link = nil
        }
    }
}

extension View {
    /// Home's row: marks the launch's first row and first cached row on
    /// screen. In a `work-perf` run it also counts the row's state makes and
    /// finds when the first cached row takes a touch (`LaunchRowProbe`).
    func launchRow(_ entry: HomeSections.Entry) -> some View {
        modifier(LaunchRowMark(entry: entry))
    }

    /// Today's row: the same marks, for the `launch-today` and `rest-today` runs. A row is cached while its
    /// source has not answered on this launch (`TodayStore.isFresh`).
    func launchTodayRow(_ row: TodayRow) -> some View {
        modifier(LaunchTodayMark(row: row))
    }
}

private struct LaunchTodayMark: ViewModifier {
    let row: TodayRow

    func body(content: Content) -> some View {
        #if DEBUG
        if WorkPerfRun.countsToday {
            content.modifier(LaunchRowProbe(key: row.key, data: Self.facts(row), cached: { [row] in !TodayFeed.store.isFresh(row) }))
        } else {
            content.onAppear { LaunchFrames.rowAppeared(cached: !TodayFeed.store.isFresh(row)) }
        }
        #else
        content.onAppear { LaunchFrames.rowAppeared(cached: !TodayFeed.store.isFresh(row)) }
        #endif
    }

    /// What the row shows, less its verbs: a kept row (no verbs) and its fresh twin are the same data.
    static func facts(_ row: TodayRow) -> Int {
        var shown = row
        shown.acts = []
        return shown.hashValue
    }
}

private struct LaunchRowMark: ViewModifier {
    @Environment(AppModel.self) private var model
    let entry: HomeSections.Entry

    func body(content: Content) -> some View {
        #if DEBUG
        if WorkPerfRun.active, !WorkPerfRun.countsToday {
            content.modifier(LaunchRowProbe(key: entry.id, data: entry.hashValue, cached: cached))
        } else {
            content.onAppear { LaunchFrames.rowAppeared(cached: cached()) }
        }
        #else
        content.onAppear { LaunchFrames.rowAppeared(cached: cached()) }
        #endif
    }

    /// Read when the row appears, never in a body: the row's host still shows its cached list.
    private func cached() -> Bool {
        entry.environmentIds.contains { model.registry.client($0)?.shellSource == .cache }
    }
}

#if DEBUG
/// The `work-perf` proof's runs (docs/IOS-DESIGN.md "The Work perf proof"),
/// asked for by `TC_TEST_WORK_PERF=<run>` with `TC_TEST_WORK_PERF_SPLIT`:
/// `fill` waits for what a measured launch waits for (`WorkPerfWait`: every
/// host that can list, and Today's fresh page when it lands on Today) and
/// writes `<run>.filled.json` once the cache holds it; `empty` drops the
/// caches (the threads' and Work's) before they open; `cached` and
/// `restored` launch over the caches as they are. Each measured launch adds its
/// split to `Documents/work-perf/<run>.json` (`WorkPerfFile`).
@MainActor
enum WorkPerfRun {
    private static let env = ProcessInfo.processInfo.environment
    static let run = env["TC_TEST_WORK_PERF"].flatMap { $0.isEmpty ? nil : $0 }
    static let split = env["TC_TEST_WORK_PERF_SPLIT"].flatMap { $0.isEmpty ? nil : $0 } ?? "cached"
    static var active: Bool { run != nil }
    /// The run counts Today's rows (`launch-today`, `rest-today`), not Home's.
    static var countsToday: Bool { run?.hasSuffix("-today") == true }
    static var ledger = LaunchRowLedger()
    private static var watching = false

    /// The `empty` split: the cache and its sidecars go before the cache opens.
    static func dropCacheIfAsked(_ path: URL) {
        guard active, split == "empty" else { return }
        for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path.path + suffix) }
    }

    static func begin(_ registry: ClientRegistry) {
        guard let run else { return }
        sampleMemory()
        Task {
            if split == "fill" { await fill(run, registry) } else if run.hasPrefix("list-") { await list(run) } else { await measure(run, registry) }
        }
    }

    /// The app's footprint every half second for the whole launch, written with the split (`WorkPerfMemory`); the
    /// `editor` run reads it against its ceilings, and the proof script samples the WebKit processes beside it.
    private static var memory = WorkPerfMemory()
    private static let loadsAtLaunch = HostedWebPool.loads

    private static func sampleMemory() {
        Task {
            while !Task.isCancelled {
                if let bytes = AppMemory.footprint() { memory.add(bytes: bytes) }
                memory.webLoads = HostedWebPool.loads - loadsAtLaunch
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
    }

    /// `list-idle` and `list-busy`: after the first frame, the list check's fixture over the app in a window of its
    /// own (the Files place's frame and row, `WorkListCheck`), measured, then written as the `list` split.
    private static func list(_ run: String) async {
        await wait(seconds: 20) { LaunchClock.marks.firstFrameMs != nil }
        let check = WorkListCheck()
        check.busy = run == "list-busy"
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first, let router = PushDelegate.handler?.router else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: NavigationStack { WorkListFixture(check: check) }
            .environment(ShellNavigator(tab: .work))
            .environment(router))
        window.makeKeyAndVisible()
        listWindow = window
        await wait(seconds: 150) { check.report != nil }
        var report = WorkPerfReport(split: "list", counted: SocketRequests.count != nil, marks: LaunchClock.marks, ledger: ledger)
        report.list = check.report ?? { var missing = WorkListReport(); missing.note = "the list check never finished"; return missing }()
        report.note = report.list?.note
        report.memory = memory
        report.cpuMs = ProcessStart.cpuMs()
        if let data = WorkPerfFile.setting(report, run: run, over: nil).encoded() { write(data, "\(run).json") }
    }

    /// Held while the list check runs: a window nothing else retains goes away.
    private static var listWindow: UIWindow?

    /// The launch's own route (`TC_TEST_ROUTE`): a `fill` launch waits for Today only when it lands there.
    private static let route = env["TC_TEST_ROUTE"].flatMap { $0.isEmpty ? nil : $0 }

    private static func wait(seconds: Double, until done: () -> Bool) async {
        var waited = 0.0
        while !done(), waited < seconds {
            try? await Task.sleep(for: .milliseconds(100))
            waited += 0.1
        }
    }

    /// What the run still waits for before it measures (`WorkPerfWait`): every host that can list, its list from the
    /// host; and for a launch onto Today, Today's fresh page too. Nil once it may measure.
    private static func missing(_ registry: ClientRegistry) -> String? {
        let hosts = registry.ordered.map { client in
            WorkPerfWait.Host(name: client.environment.name, relay: client.relayState, listed: client.shellSource == .changes || client.shellSource == .list)
        }
        let today = WorkPerfWait.waitsForToday(run: run ?? "", split: split, route: route)
            ? WorkPerfWait.Today(page: TodayFeed.store.page != nil, cached: TodayFeed.store.cached)
            : nil
        return WorkPerfWait.missing(hosts: hosts, today: today)
    }

    private static func fill(_ run: String, _ registry: ClientRegistry) async {
        await wait(seconds: 60) { missing(registry) == nil }
        // The cache writer's last batch lands after the list.
        try? await Task.sleep(for: .seconds(3))
        // The proof prints a fill that never had what it waited for: its note says what.
        let note = missing(registry)
        let fields: [String: Any] = note.map { ["live": false, "note": $0] } ?? ["live": true]
        if let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) { write(data, "\(run).filled.json") }
    }

    private static func measure(_ run: String, _ registry: ClientRegistry) async {
        let began = Date()
        await wait(seconds: 20) { LaunchClock.marks.firstFrameMs != nil }
        await wait(seconds: 30) { missing(registry) == nil }
        // The fresh list lands as a diff: what it makes again is made within these seconds.
        try? await Task.sleep(for: .seconds(3))
        let rest = split == "rest" ? await rested() : nil
        // `editor`: the document opens over the reader route and its page draws; the memory figures cover all of it.
        if run == "editor" { try? await Task.sleep(for: .seconds(20)) }
        await wait(seconds: 5) { LaunchClock.marks.cachedRowMs == nil || LaunchClock.marks.rowHitMs != nil }
        var report = WorkPerfReport(split: split, counted: SocketRequests.count != nil, marks: LaunchClock.marks, ledger: ledger)
        report.rest = rest
        if report.marks.firstFrameMs == nil {
            report.note = "the first frame never came"
        } else if let missing = missing(registry) {
            report.note = missing
        }
        report.cpuMs = ProcessStart.cpuMs()
        report.memory = memory
        report.seconds = (Date().timeIntervalSince(began) * 10).rounded() / 10
        let name = "\(run).json"
        let file = WorkPerfFile.setting(report, run: run, over: directory.flatMap { try? Data(contentsOf: $0.appending(path: name)) })
        if let data = file.encoded() { write(data, name) }
    }

    /// `rest-today`: Today on screen and nothing arriving for ten seconds. The main thread's CPU over them, and
    /// what Today keeps alive against what it needs: its repeating tasks (one, the minute's words) and its own
    /// LifeOS queries; any host read in the seconds is a poll.
    private static func rested() async -> WorkPerfRest {
        let seconds = 10.0
        let reads = TodayFeed.store.readsMade
        let cpu = MainThreadCPU.ms()
        try? await Task.sleep(for: .seconds(seconds))
        return WorkPerfRest(
            seconds: seconds, mainCpuMs: ((MainThreadCPU.ms() - cpu) * 10).rounded() / 10,
            ticks: TickLedger.names, ticksAllowed: 1,
            queries: TodayLife.queriesAlive, queriesAllowed: TodayLife.queriesNeeded,
            reads: TodayFeed.store.readsMade - reads
        )
    }

    /// The first cached row's frame, watched on each display tick (5 s at most)
    /// until the window's hit test at its middle lands in its list cell.
    static func watchHit(_ frame: @escaping () -> CGRect) {
        guard !watching, LaunchClock.marks.rowHitMs == nil else { return }
        watching = true
        DisplayTicks.run { elapsed in
            if hits(frame()) {
                LaunchClock.mark(.rowHit)
                return true
            }
            return elapsed > 5
        }
    }

    private static func hits(_ frame: CGRect) -> Bool {
        let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow)
        guard frame.width > 0, frame.height > 0, let window, window.isUserInteractionEnabled else { return false }
        var view = window.hitTest(CGPoint(x: frame.midX, y: frame.midY), with: nil)
        while let shown = view {
            if shown is UICollectionViewCell { return true }
            view = shown.superview
        }
        return false
    }

    private static var directory: URL? {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return nil }
        let directory = documents.appending(path: "work-perf")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private static func write(_ data: Data, _ name: String) {
        guard let directory else { return }
        try? data.write(to: directory.appending(path: name), options: .atomic)
    }
}

/// A `@StateObject` is built once per identity, so its init is the row's state made.
private final class LaunchRowLife: ObservableObject {
    var frame = CGRect.zero

    init(key: String, data: Int) {
        WorkPerfRun.ledger.made(key, data: data)
    }
}

/// A Home or Today row in a `work-perf` run: its state makes, appearances and frame.
private struct LaunchRowProbe: ViewModifier {
    let key: String
    let cached: () -> Bool
    @StateObject private var life: LaunchRowLife

    init(key: String, data: Int, cached: @escaping () -> Bool) {
        self.key = key
        self.cached = cached
        _life = StateObject(wrappedValue: LaunchRowLife(key: key, data: data))
    }

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { life.frame = $0 }
            .onAppear {
                WorkPerfRun.ledger.appeared(key)
                let fromCache = cached()
                LaunchFrames.rowAppeared(cached: fromCache)
                if fromCache { WorkPerfRun.watchHit { [life] in life.frame } }
            }
            .onDisappear { WorkPerfRun.ledger.disappeared(key) }
    }
}

/// The main thread's CPU time, user and system, in milliseconds (Mach's thread info for the thread it runs on).
@MainActor
enum MainThreadCPU {
    static func ms() -> Double {
        var info = thread_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<integer_t>.size)
        let thread = mach_thread_self()
        defer { mach_port_deallocate(mach_task_self_, thread) }
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { thread_info(thread, thread_flavor_t(THREAD_BASIC_INFO), $0, &count) }
        }
        guard result == KERN_SUCCESS else { return 0 }
        let user = Double(info.user_time.seconds) * 1000 + Double(info.user_time.microseconds) / 1000
        let system = Double(info.system_time.seconds) * 1000 + Double(info.system_time.microseconds) / 1000
        return user + system
    }
}
#endif
