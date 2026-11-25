import Foundation
import Synchronization
#if canImport(Darwin)
import Darwin
#endif

/// A cold launch's marks, each in milliseconds from the process start
/// (docs/IOS-DESIGN.md "The Work perf proof"). The app keeps this launch's
/// in `LaunchClock`; Settings → Diagnostics shows them, and the `work-perf`
/// proof's `launch-home` run writes them to its report.
public struct LaunchMarks: Sendable, Equatable, Codable {
    public enum Mark: Sendable, CaseIterable {
        /// The root view's first frame is on screen.
        case firstFrame
        /// Home's first row is on screen, from the cache or the host.
        case firstRow
        /// Home's first row from the cache is on screen.
        case cachedRow
        /// That row takes a touch: the window's hit test at its middle lands in its list cell.
        case rowHit
    }

    public var firstFrameMs: Double?
    public var firstRowMs: Double?
    public var cachedRowMs: Double?
    public var rowHitMs: Double?
    /// The socket's requests begun before the first frame; nil where they are not counted (Release).
    public var requestsBeforeFirstFrame: Int?

    public init() {}

    public func ms(_ mark: Mark) -> Double? {
        switch mark {
        case .firstFrame: firstFrameMs
        case .firstRow: firstRowMs
        case .cachedRow: cachedRowMs
        case .rowHit: rowHitMs
        }
    }

    /// Records `mark` at `ms` the first time only; false when it was already there.
    /// The first frame also takes the socket's request count of that moment.
    public mutating func record(_ mark: Mark, ms: Double, requests: Int?) -> Bool {
        guard self.ms(mark) == nil else { return false }
        switch mark {
        case .firstFrame:
            firstFrameMs = ms
            requestsBeforeFirstFrame = requests
        case .firstRow: firstRowMs = ms
        case .cachedRow: cachedRowMs = ms
        case .rowHit: rowHitMs = ms
        }
        return true
    }
}

/// This process's start, from the kernel: the mark `launch.processStart`
/// is the system's to make, not the app's.
public enum ProcessStart {
    /// When the kernel started this process; nil where `sysctl` cannot say (Linux).
    public static let date: Date? = read()

    /// Milliseconds from `start` to `now`, to a tenth.
    public static func ms(from start: Date, to now: Date) -> Double {
        (now.timeIntervalSince(start) * 10_000).rounded() / 10
    }

    /// The CPU time this process has used on every thread so far, in milliseconds.
    public static func cpuMs() -> Double {
        var usage = rusage()
        #if canImport(Darwin)
        let who = RUSAGE_SELF
        #else
        let who = __rusage_who_t(RUSAGE_SELF.rawValue)
        #endif
        guard getrusage(who, &usage) == 0 else { return 0 }
        let user = Double(usage.ru_utime.tv_sec) * 1_000 + Double(usage.ru_utime.tv_usec) / 1_000
        let system = Double(usage.ru_stime.tv_sec) * 1_000 + Double(usage.ru_stime.tv_usec) / 1_000
        return ((user + system) * 10).rounded() / 10
    }

    private static func read() -> Date? {
        #if canImport(Darwin)
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&name, u_int(name.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let start = info.kp_proc.p_un.__p_starttime
        return Date(timeIntervalSince1970: Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000)
        #else
        return nil
        #endif
    }
}

/// This launch's marks, kept once each and signposted under `launch`.
@MainActor
public enum LaunchClock {
    public private(set) static var marks = LaunchMarks()
    /// The sockets' start waits here (`EnvironmentClient.start`): open unless the app holds it for its first frame.
    public private(set) static var sockets = FirstFrameGate()

    /// The app's cold launch: no socket starts before the first frame is on screen (`network-before-frame`), nor
    /// later than `atMost`, so a launch that never draws (a background launch) still connects.
    public static func holdSockets(atMost: Duration = FirstFrameGate.cap) {
        guard sockets.isOpen, marks.firstFrameMs == nil else { return }
        let gate = FirstFrameGate(open: false)
        sockets = gate
        Task { @MainActor in
            try? await Task.sleep(for: atMost)
            gate.pass()
        }
    }

    /// Marks `mark` now, the first time it is asked.
    public static func mark(_ mark: LaunchMarks.Mark, now: Date = Date()) {
        if mark == .firstFrame { sockets.pass() }
        guard marks.ms(mark) == nil, let start = ProcessStart.date,
              marks.record(mark, ms: ProcessStart.ms(from: start, to: now), requests: SocketRequests.count) else { return }
        switch mark {
        case .firstFrame: Signposts.launch.event("firstFrame")
        case .cachedRow: Signposts.launch.event("cachedRow")
        case .firstRow, .rowHit: break
        }
    }
}

/// What a socket's start waits for on a cold launch: the first frame on screen. Once passed it stays open, and
/// every wait after returns at once.
@MainActor
public final class FirstFrameGate {
    /// The longest a held start waits when no frame comes.
    public static let cap: Duration = .seconds(3)
    public private(set) var isOpen: Bool
    private var waiting: [CheckedContinuation<Void, Never>] = []

    public init(open: Bool = true) {
        isOpen = open
    }

    /// The first frame is on screen (or the cap ran out): every start waiting goes now.
    public func pass() {
        guard !isOpen else { return }
        isOpen = true
        let held = waiting
        waiting = []
        for start in held { start.resume() }
    }

    /// Returns once the gate is open.
    public func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { waiting.append($0) }
    }
}

/// The socket's requests begun so far: each ticket minted, each socket
/// opened, each call. The `work-perf` proof reads it at the first frame,
/// where it must be 0. Kept in DEBUG builds and the Measure build alone; a
/// Release build counts nothing and reads nil.
public enum SocketRequests {
    #if DEBUG
    private static let begun = Atomic<Int>(0)
    #endif

    /// One more request began.
    @inline(__always)
    public static func began() {
        #if DEBUG
        begun.add(1, ordering: .relaxed)
        #endif
    }

    /// The count, or nil where it is not kept.
    public static var count: Int? {
        #if DEBUG
        begun.load(ordering: .relaxed)
        #else
        nil
        #endif
    }
}

/// Home's rows across a cold launch, by row id: each row's state makes,
/// appearances and disappearances, and the row's data when its state was
/// made. A row whose state is made again while it is on screen lost its
/// identity in place. When its data had not changed, the fresh list made
/// it again for nothing (`remadeSame`, the proof's gate); when it had, the
/// row is one that changed (`remadeChanged`, reported).
public struct LaunchRowLedger: Sendable, Equatable {
    struct Row: Sendable, Equatable {
        var made = 0
        var appears = 0
        var disappears = 0
        var data = 0
    }

    private var rows: [String: Row] = [:]
    public private(set) var remadeSame: [String] = []
    public private(set) var remadeChanged: [String] = []

    public init() {}

    /// Every state made, first makes and makes again together.
    public var made: Int { rows.values.reduce(0) { $0 + $1.made } }

    public mutating func made(_ key: String, data: Int) {
        var row = rows[key, default: Row()]
        row.made += 1
        if row.made > 1, row.appears > row.disappears {
            if row.data == data { remadeSame.append(key) } else { remadeChanged.append(key) }
        }
        row.data = data
        rows[key] = row
    }

    public mutating func appeared(_ key: String) { rows[key, default: Row()].appears += 1 }

    public mutating func disappeared(_ key: String) { rows[key, default: Row()].disappears += 1 }
}
