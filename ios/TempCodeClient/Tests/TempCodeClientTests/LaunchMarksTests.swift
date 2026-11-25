import Foundation
import Testing
@testable import TempCodeClient

@Suite struct LaunchMarksTests {
    @Test func `a mark is kept the first time only`() {
        var marks = LaunchMarks()
        let first = marks.record(.cachedRow, ms: 310, requests: nil)
        let again = marks.record(.cachedRow, ms: 900, requests: nil)
        #expect(first && !again)
        #expect(marks.cachedRowMs == 310)
        #expect(marks.firstFrameMs == nil)
    }

    @Test func `the first frame takes the request count of its moment`() {
        var marks = LaunchMarks()
        let first = marks.record(.firstFrame, ms: 240.5, requests: 0)
        let again = marks.record(.firstFrame, ms: 300, requests: 4)
        #expect(first && !again)
        #expect(marks.requestsBeforeFirstFrame == 0)
        #expect(marks.ms(.firstFrame) == 240.5)
        let hit = marks.record(.rowHit, ms: 330, requests: 7)
        #expect(hit)
        #expect(marks.requestsBeforeFirstFrame == 0)
    }

    @Test func `milliseconds from the start are kept to a tenth`() {
        let start = Date(timeIntervalSince1970: 1_000)
        #expect(ProcessStart.ms(from: start, to: start.addingTimeInterval(0.123456)) == 123.5)
        #expect(ProcessStart.ms(from: start, to: start) == 0)
    }

    @Test func `the process has used some CPU`() {
        #expect(ProcessStart.cpuMs() > 0)
    }

    @Test func `a debug build counts the socket's requests`() {
        #if DEBUG
        let before = SocketRequests.count ?? -1
        SocketRequests.began()
        SocketRequests.began()
        #expect((SocketRequests.count ?? -1) >= before + 2)
        #else
        SocketRequests.began()
        #expect(SocketRequests.count == nil)
        #endif
    }
}

@Suite struct LaunchRowLedgerTests {
    @Test func `rows that keep their state count nothing`() {
        var ledger = LaunchRowLedger()
        for key in ["a", "b"] {
            ledger.made(key, data: 1)
            ledger.appeared(key)
        }
        #expect(ledger.made == 2)
        #expect(ledger.remadeSame.isEmpty && ledger.remadeChanged.isEmpty)
    }

    @Test func `a row made again on screen with the same data is counted`() {
        var ledger = LaunchRowLedger()
        ledger.made("a", data: 7)
        ledger.appeared("a")
        // The fresh list lands and the row loses its identity: the new state comes before the old one goes.
        ledger.made("a", data: 7)
        ledger.disappeared("a")
        ledger.appeared("a")
        #expect(ledger.remadeSame == ["a"])
        #expect(ledger.remadeChanged.isEmpty)
    }

    @Test func `a row whose data changed is reported apart`() {
        var ledger = LaunchRowLedger()
        ledger.made("a", data: 7)
        ledger.appeared("a")
        ledger.made("a", data: 8)
        #expect(ledger.remadeSame.isEmpty)
        #expect(ledger.remadeChanged == ["a"])
    }

    @Test func `a row that scrolled off and came back is not counted`() {
        var ledger = LaunchRowLedger()
        ledger.made("a", data: 7)
        ledger.appeared("a")
        ledger.disappeared("a")
        ledger.made("a", data: 7)
        ledger.appeared("a")
        #expect(ledger.remadeSame.isEmpty && ledger.remadeChanged.isEmpty)
        #expect(ledger.made == 2)
    }
}

@Suite struct WorkPerfReportTests {
    private func report(_ split: String) -> WorkPerfReport {
        var marks = LaunchMarks()
        _ = marks.record(.firstFrame, ms: 200, requests: 0)
        var ledger = LaunchRowLedger()
        ledger.made("a", data: 1)
        ledger.appeared("a")
        ledger.made("a", data: 1)
        return WorkPerfReport(split: split, counted: true, marks: marks, ledger: ledger)
    }

    @Test func `a report carries the ledger's counts`() {
        let made = report("cached")
        #expect(made.rowsMade == 2)
        #expect(made.rowsRemade == 1)
        #expect(made.remade == ["a"])
    }

    @Test func `each launch adds its split to the run's file`() throws {
        let first = WorkPerfFile.setting(report("empty"), run: "launch-home", over: nil)
        let second = WorkPerfFile.setting(report("cached"), run: "launch-home", over: first.encoded())
        #expect(Set(second.splits.keys) == ["empty", "cached"])
        // Another run's file, or nothing readable, starts over.
        let other = WorkPerfFile.setting(report("cached"), run: "launch-today", over: second.encoded())
        #expect(Set(other.splits.keys) == ["cached"])
        #expect(WorkPerfFile.setting(report("cached"), run: "launch-home", over: Data("{".utf8)).splits.count == 1)
    }

    @Test func `the file has the keys the checker reads`() throws {
        let data = try #require(WorkPerfFile.setting(report("cached"), run: "launch-home", over: nil).encoded())
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let split = try #require((json["splits"] as? [String: Any])?["cached"] as? [String: Any])
        for key in ["split", "counted", "marks", "rowsMade", "rowsRemade", "rowsRemadeChanged", "remade", "cpuMs", "seconds"] {
            #expect(split[key] != nil, "\(key)")
        }
        let marks = try #require(split["marks"] as? [String: Any])
        #expect(marks["firstFrameMs"] as? Double == 200)
        #expect(marks["requestsBeforeFirstFrame"] as? Int == 0)
    }

    @Test func `the rest run's quiet seconds carry the counts and the allowances the checker reads`() throws {
        var rested = report("rest")
        rested.rest = WorkPerfRest(seconds: 10, mainCpuMs: 42, ticks: ["today.minute"], ticksAllowed: 1, queries: ["auth:caller {}", "mailWaits:list {}"], queriesAllowed: 3, reads: 0)
        let data = try #require(WorkPerfFile.setting(rested, run: "rest-today", over: nil).encoded())
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let rest = try #require(((json["splits"] as? [String: Any])?["rest"] as? [String: Any])?["rest"] as? [String: Any])
        #expect(rest["ticks"] as? Int == 1)
        #expect(rest["ticksAllowed"] as? Int == 1)
        #expect(rest["queries"] as? Int == 2)
        #expect(rest["queriesAllowed"] as? Int == 3)
        #expect(rest["reads"] as? Int == 0)
        #expect(rest["mainCpuMs"] as? Double == 42)
        #expect((rest["tickNames"] as? [String]) == ["today.minute"])
        // Every other run carries none.
        #expect(report("cached").rest == nil)
    }
}

@Suite struct SignpostsTests {
    @Test func `events and intervals are safe to call anywhere`() {
        Signposts.launch.event("firstFrame")
        let mark = Signposts.file.begin("first")
        mark.end()
        Signposts.list.begin("firstRows").end()
        Signposts.press.event("answer")
        #expect(Signposts.subsystem == "dev.landon.tempcode")
    }
}

@MainActor @Suite struct FirstFrameGateTests {
    @Test func `an open gate lets a start through at once`() async {
        let gate = FirstFrameGate()
        #expect(gate.isOpen)
        await gate.wait()
    }

    @Test func `a held start goes once the first frame passes the gate, and only then`() async {
        let gate = FirstFrameGate(open: false)
        var started = false
        let start = Task { @MainActor in
            await gate.wait()
            started = true
        }
        for _ in 0..<5 { await Task.yield() }
        #expect(!started)
        gate.pass()
        await start.value
        #expect(started && gate.isOpen)
        gate.pass()
        await gate.wait()
    }

    @Test func `every start held is let go together`() async {
        let gate = FirstFrameGate(open: false)
        var count = 0
        let starts = (0..<3).map { _ in Task { @MainActor in await gate.wait(); count += 1 } }
        for _ in 0..<5 { await Task.yield() }
        #expect(count == 0)
        gate.pass()
        for start in starts { await start.value }
        #expect(count == 3)
    }

    @Test func `the cap is three seconds`() {
        #expect(FirstFrameGate.cap == .seconds(3))
    }
}

@Suite struct WorkPerfWaitTests {
    @Test func `an asleep or unreachable relayed host is not waited on`() {
        let hosts = [
            WorkPerfWait.Host(name: "Local test server", listed: true),
            WorkPerfWait.Host(name: "Studio Mac", relay: .available, listed: true),
            WorkPerfWait.Host(name: "Studio Mac (locked)", relay: .locked, listed: true),
            WorkPerfWait.Host(name: "Studio Mac (asleep)", relay: .asleep, listed: false),
            WorkPerfWait.Host(name: "Studio Mac (unreachable)", relay: .unreachable, listed: false),
        ]
        #expect(WorkPerfWait.awaited(hosts).map(\.name) == ["Local test server", "Studio Mac", "Studio Mac (locked)"])
        #expect(WorkPerfWait.missing(hosts: hosts, today: nil) == nil)
    }

    @Test func `a host that can list and has not names itself in the note`() {
        let hosts = [WorkPerfWait.Host(name: "Box", listed: false), WorkPerfWait.Host(name: "Studio Mac", relay: .available, listed: false)]
        #expect(WorkPerfWait.missing(hosts: hosts, today: nil) == "the host's list never came (Box, Studio Mac)")
        #expect(WorkPerfWait.missing(hosts: [], today: nil) == "no host to list")
    }

    @Test func `a launch onto Today waits for a page with a fresh row`() {
        let hosts = [WorkPerfWait.Host(name: "Box", listed: true)]
        #expect(WorkPerfWait.missing(hosts: hosts, today: .init(page: false, cached: false)) == "Today's page never came")
        #expect(WorkPerfWait.missing(hosts: hosts, today: .init(page: true, cached: true)) == "Today's fresh page never came")
        #expect(WorkPerfWait.missing(hosts: hosts, today: .init(page: true, cached: false)) == nil)
    }

    @Test func `only a today run's launch onto Today waits for its page`() {
        #expect(WorkPerfWait.waitsForToday(run: "launch-today", split: "empty", route: nil))
        #expect(WorkPerfWait.waitsForToday(run: "launch-today", split: "cached", route: nil))
        #expect(WorkPerfWait.waitsForToday(run: "rest-today", split: "rest", route: nil))
        #expect(!WorkPerfWait.waitsForToday(run: "launch-today", split: "restored", route: nil))
        #expect(WorkPerfWait.waitsForToday(run: "launch-today", split: "fill", route: "today"))
        #expect(!WorkPerfWait.waitsForToday(run: "launch-today", split: "fill", route: "workspace"))
        #expect(!WorkPerfWait.waitsForToday(run: "launch-home", split: "cached", route: nil))
    }
}
