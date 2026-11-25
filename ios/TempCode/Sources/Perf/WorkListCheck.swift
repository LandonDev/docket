import Observation
import SwiftUI
import TempCodeClient
import UIKit

/// The list check (docs/IOS-DESIGN.md "The Work perf proof"): a 1,000-row fixture list in the Files place's own frame
/// and row (`WorkPlaceScreen`, `FilesRowLabel`), its words made once off the main actor. After the rows settle it
/// scrolls the list down and up once to warm it, then again measured at 3,000 pt/s, then holds still for a few
/// seconds while whatever the hosts push for other places arrives. It counts what the app owns: rows built before
/// the finger moved, the most alive at once, any built twice, any built while still, and the app's own scrolls
/// under the finger (`PerfCounters.offsetWrites`). Frame times are reported. Settings → Diagnostics runs it on the
/// phone; the `work-perf` runs `list-idle` and `list-busy` run it in the simulator (`WorkPerfRun`).
@MainActor @Observable
final class WorkListCheck {
    private(set) var rows: [WorkListRow] = []
    private(set) var report: WorkListReport?
    private(set) var running = false
    @ObservationIgnored var ledger = ListCheckLedger()
    /// The proof's `list-busy`: the test server plays other places' traffic through the still seconds.
    @ObservationIgnored var busy = false

    var ids: [String] { rows.map(\.id) }

    func run() async {
        guard !running else { return }
        running = true
        defer { running = false }
        report = nil
        ledger = ListCheckLedger()
        let now = Date()
        rows = await Task.detached(priority: .userInitiated) { WorkListRow.fixture(now: now) }.value
        report = await measure()
    }

    private func measure() async -> WorkListReport {
        var report = WorkListReport()
        report.rows = rows.count
        report.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        report.thermal = Self.word(ProcessInfo.processInfo.thermalState)
        guard let list = await findList() else {
            report.note = "the list did not load"
            return report
        }
        // The first rows settle: what is built now is the first paint.
        await PerfRunner.sleep(1)
        report.firstPaintMade = ledger.made
        // Warm: every row has been on screen once before the measured pass.
        await drive(list) { _ in }
        ledger.resetPeak()
        let offsets = PerfCounters.value(.offsetWrites)
        let recorder = FrameRecorder()
        recorder.start(sourceRows: rows.count, items: rows.count, scrollView: list, driver: .perf)
        var window = 0
        var foreign = 0
        var travel = 0.0
        await drive(list) { step in
            window = max(window, list.indexPathsForVisibleItems.count)
            if step.foreign { foreign += 1 }
            travel += abs(step.moved)
        }
        let frames = recorder.finish()
        report.offsetWrites = PerfCounters.value(.offsetWrites) - offsets
        report.window = window
        report.peakAlive = ledger.peakAlive
        report.foreignMoves = foreign
        report.travelPt = travel.rounded()
        report.maxFramesPerSecond = frames.maxFramesPerSecond
        report.frames = frames.intervals.count
        report.late = frames.late
        report.frameP95Ms = PerfDist(frames.intervals).p95
        report.frameWorstMs = PerfDist(frames.intervals).worst
        report.hitchMsPerS = frames.seconds > 0 ? PerfDist.round(frames.hitchMs / frames.seconds) : 0
        report.mainP95Ms = PerfDist(frames.cpu).p95
        // Still: the list stands while other places' pushes arrive. A row built now was thrown away by one of them.
        if busy { await PerfRunner.control("/load", ["seconds": Int(WorkListCheckRules.stillSeconds) + 4]) }
        let made = ledger.made
        let pushes = Self.pushes()
        await PerfRunner.sleep(WorkListCheckRules.stillSeconds)
        report.stillSeconds = WorkListCheckRules.stillSeconds
        report.stillMade = ledger.made - made
        report.stillPushes = Self.pushes() - pushes
        report.madeAgain = ledger.madeAgain.count
        report.madeAgainKeys = Array(ledger.madeAgain.prefix(20))
        if Task.isCancelled { report.note = "it was stopped" }
        return report
    }

    /// Down to the end and back to the top at 3,000 pt/s, one display tick at a time, as the perf runs' finger does.
    private func drive(_ list: UICollectionView, each: @escaping (ListDriver.Step) -> Void) async {
        let driver = ListDriver()
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            DisplayTicks.run { elapsed in
                let step = driver.step(list, now: elapsed)
                each(step)
                if driver.done || elapsed > 90 {
                    done.resume()
                    return true
                }
                return false
            }
        }
    }

    /// The fixture's list: the collection view under the key window that holds every row (10 s at most).
    private func findList() async -> UICollectionView? {
        for _ in 0..<100 {
            let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
            if let list = windows.lazy.compactMap({ Self.list(in: $0, rows: self.rows.count) }).first { return list }
            await PerfRunner.sleep(0.1)
        }
        return nil
    }

    private static func list(in view: UIView, rows: Int) -> UICollectionView? {
        if let list = view as? UICollectionView, rows > 0, (0..<list.numberOfSections).reduce(0, { $0 + list.numberOfItems(inSection: $1) }) >= rows {
            return list
        }
        for child in view.subviews { if let found = list(in: child, rows: rows) { return found } }
        return nil
    }

    /// Writes the clients made for their readers: a session list's or a thread's, any host's.
    private static func pushes() -> Int {
        PerfCounters.value(.sessionPublishes) + PerfCounters.value(.threadPublishes)
    }

    private static func word(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown"
        }
    }
}

/// The finger for the list check: each tick it moves the list from where it is by 3,000 pt/s times the time since
/// the last tick, down to the end, then up to the top. A move it did not make between two ticks is foreign.
final class ListDriver {
    struct Step {
        var moved: Double
        var foreign: Bool
    }

    private static let velocity = 3_000.0
    private var down = true
    private var last: Double?
    private var expected: CGFloat?
    private(set) var done = false

    func step(_ list: UIScrollView, now: Double) -> Step {
        let elapsed = min(now - (last ?? now), 0.1)
        last = now
        let foreign = expected.map { abs(list.contentOffset.y - $0) > 0.5 } ?? false
        let top = -list.adjustedContentInset.top
        let bottom = max(top, list.contentSize.height + list.adjustedContentInset.bottom - list.bounds.height)
        let from = list.contentOffset.y
        let to = min(bottom, max(top, from + CGFloat(Self.velocity * elapsed) * (down ? 1 : -1)))
        if to != from { list.setContentOffset(CGPoint(x: list.contentOffset.x, y: to), animated: false) }
        expected = list.contentOffset.y
        if down, to >= bottom, elapsed > 0 { down = false }
        else if !down, to <= top { done = true }
        return Step(moved: Double(to - from), foreign: foreign)
    }
}

/// The fixture list on screen: the Files place's frame and row, a probe on each row. Its own job key keeps its top
/// row out of the real Files list's memory.
struct WorkListFixture: View {
    let check: WorkListCheck

    var body: some View {
        WorkPlaceScreen(place: .files, job: "work-checks", ids: check.ids, loading: check.rows.isEmpty, empty: PlaceEmpty(title: "No Files")) {
            ForEach(check.rows) { row in
                FilesRowLabel(symbol: row.symbol, title: row.title, fact: row.fact)
                    .listRowInsets(Layout.rowInsets)
                    .modifier(ListRowProbe(key: row.id, check: check))
            }
        }
        .task { await check.run() }
    }
}

/// A `@StateObject` is built once per row identity (its value is an autoclosure, unlike `@State`'s), so its init is
/// the row's state built.
private final class ListRowLife: ObservableObject {
    init(key: String, check: WorkListCheck) {
        check.ledger.made(key)
    }
}

private struct ListRowProbe: ViewModifier {
    let key: String
    let check: WorkListCheck
    @StateObject private var life: ListRowLife

    init(key: String, check: WorkListCheck) {
        self.key = key
        self.check = check
        _life = StateObject(wrappedValue: ListRowLife(key: key, check: check))
    }

    func body(content: Content) -> some View {
        content
            .onAppear { check.ledger.appeared(key) }
            .onDisappear { check.ledger.disappeared(key) }
    }
}

/// The app's own memory: its physical footprint, as Xcode's gauge and the system's limits count it.
enum AppMemory {
    static func footprint() -> UInt64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : nil
    }
}
