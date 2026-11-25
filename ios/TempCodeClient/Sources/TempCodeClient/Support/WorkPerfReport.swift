import Foundation

/// The `work-perf` proof's report: one file a run, `Documents/work-perf/<run>.json`,
/// holding each split the run measured (docs/IOS-DESIGN.md "The Work perf
/// proof"). Each launch of a run writes its own split into the file
/// (`setting`); scripts/lib/ios_work_perf_check.py judges it.
public struct WorkPerfFile: Codable, Sendable, Equatable {
    public var run: String
    public var splits: [String: WorkPerfReport]

    public init(run: String, splits: [String: WorkPerfReport] = [:]) {
        self.run = run
        self.splits = splits
    }

    /// The file with `report` as its split, read from `data` when that holds this run.
    public static func setting(_ report: WorkPerfReport, run: String, over data: Data?) -> WorkPerfFile {
        var file = data.flatMap { try? JSONDecoder().decode(WorkPerfFile.self, from: $0) }.flatMap { $0.run == run ? $0 : nil }
            ?? WorkPerfFile(run: run)
        file.splits[report.split] = report
        return file
    }

    public func encoded() -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        return try? encoder.encode(self)
    }
}

/// One launch of a run, measured. Times are milliseconds from the process start.
public struct WorkPerfReport: Codable, Sendable, Equatable {
    /// How the launch began: `empty` (no cache), `cached` (the cache from the
    /// launch before), `restored` (the cache, onto the screen the last launch
    /// was on) or `locked` (the cache behind the lock; the simulator cannot make it).
    public var split: String
    /// Why the launch measured nothing, when it did not.
    public var note: String?
    /// Whether this build counts the socket's requests (DEBUG and Measure): without it the gate has nothing to read.
    public var counted: Bool
    public var marks: LaunchMarks
    /// Home's row states made in the launch, and those made again for rows whose data had not changed (the gate) or had.
    public var rowsMade = 0
    public var rowsRemade = 0
    public var rowsRemadeChanged = 0
    /// The first rows made again for nothing, by id (20 at most).
    public var remade: [String] = []
    /// The process's CPU time on every thread when the run ended (reported, never judged).
    public var cpuMs = 0.0
    /// How long the run watched after the first frame.
    public var seconds = 0.0
    /// The `rest-today` run's ten quiet seconds; nil in every other run.
    public var rest: WorkPerfRest?
    /// The `list-idle` and `list-busy` runs' list check (`WorkListReport`); nil in every other run.
    public var list: WorkListReport?
    /// The app's own memory sampled across the run (every run); the `editor` run reads it against its ceilings.
    public var memory: WorkPerfMemory?

    public init(split: String, counted: Bool, marks: LaunchMarks, ledger: LaunchRowLedger) {
        self.split = split
        self.counted = counted
        self.marks = marks
        rowsMade = ledger.made
        rowsRemade = ledger.remadeSame.count
        rowsRemadeChanged = ledger.remadeChanged.count
        remade = Array(ledger.remadeSame.prefix(20))
    }
}

/// Today on screen with nothing arriving (`rest-today`): what ran on the main thread, and what Today keeps alive
/// against what it needs (docs/IOS-DESIGN.md "The Work perf proof").
public struct WorkPerfRest: Codable, Sendable, Equatable {
    public var seconds: Double
    /// The main thread's CPU time over the quiet seconds (reported against 10 ms a second, never gated).
    public var mainCpuMs: Double
    /// Repeating tasks alive (`TickLedger`), and how many Today needs.
    public var ticks: Int
    public var ticksAllowed: Int
    public var tickNames: [String]
    /// Today's own LifeOS live queries held, and how many it needs.
    public var queries: Int
    public var queriesAllowed: Int
    public var queryNames: [String]
    /// Today's host reads made in the quiet seconds: any is a poll.
    public var reads: Int

    public init(seconds: Double, mainCpuMs: Double, ticks: [String], ticksAllowed: Int, queries: [String], queriesAllowed: Int, reads: Int) {
        self.seconds = seconds
        self.mainCpuMs = mainCpuMs
        self.ticks = ticks.count
        self.ticksAllowed = ticksAllowed
        tickNames = ticks
        self.queries = queries.count
        self.queriesAllowed = queriesAllowed
        queryNames = queries
        self.reads = reads
    }
}

/// What a measured launch of the `work-perf` proof waits for before it measures, and what its note says when that
/// never came (docs/IOS-DESIGN.md "The Work perf proof").
public enum WorkPerfWait {
    /// One host as the run sees it.
    public struct Host: Sendable, Equatable {
        public var name: String
        /// The carrier's word on a relayed host; nil on a paired one.
        public var relay: RelayState?
        /// Its list came from the host on this launch (`ShellSource.changes` or `.list`).
        public var listed: Bool

        public init(name: String, relay: RelayState? = nil, listed: Bool) {
            self.name = name
            self.relay = relay
            self.listed = listed
        }
    }

    /// Today's page as the store holds it.
    public struct Today: Sendable, Equatable {
        /// A page is built.
        public var page: Bool
        /// Every row on it is still from the disk (`TodayStore.cached`).
        public var cached: Bool

        public init(page: Bool, cached: Bool) {
            self.page = page
            self.cached = cached
        }
    }

    /// The hosts the run waits on: every paired host, and a relayed one only while its carrier says it answers
    /// (available or locked). An asleep or unreachable Mac never lists, so waiting on it never ends.
    public static func awaited(_ hosts: [Host]) -> [Host] {
        hosts.filter { $0.relay?.admitsSends ?? true }
    }

    /// Whether the launch waits for Today's fresh page: a `-today` run's launch that lands on Today. `restored`
    /// brings back a Home workspace, and a `fill` launch only lands on Today when its route is `today`.
    public static func waitsForToday(run: String, split: String, route: String?) -> Bool {
        guard run.hasSuffix("-today"), split != "restored" else { return false }
        return split != "fill" || route == "today"
    }

    /// What the launch still waits for, as its note says it; nil once it may measure.
    public static func missing(hosts: [Host], today: Today?) -> String? {
        let waited = awaited(hosts)
        if waited.isEmpty { return "no host to list" }
        let unlisted = waited.filter { !$0.listed }.map(\.name)
        if !unlisted.isEmpty { return "the host's list never came (\(unlisted.joined(separator: ", ")))" }
        guard let today else { return nil }
        if !today.page { return "Today's page never came" }
        if today.cached { return "Today's fresh page never came" }
        return nil
    }
}

/// The app's own memory over a run: its `phys_footprint` sampled every half second (docs/IOS-DESIGN.md "The Work perf
/// proof"). The WebKit processes are other processes the app cannot read; the proof script samples them by pid on
/// the Mac. Reported against the ceilings, never gated on a simulator.
public struct WorkPerfMemory: Codable, Sendable, Equatable {
    public static let appCeilingMB = 300.0
    public static let totalCeilingMB = 700.0

    public var samples = 0
    public var peakMB = 0.0
    public var lastMB = 0.0
    /// Hosted pages loaded into a web view during the run: none means no editor was up, whatever the figures say.
    public var webLoads = 0

    public init() {}

    public mutating func add(bytes: UInt64) {
        let mb = (Double(bytes) / 1_048_576 * 10).rounded() / 10
        samples += 1
        lastMB = mb
        peakMB = max(peakMB, mb)
    }
}
