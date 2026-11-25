import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Today's rules the fixtures do not reach: the store's keeping, the hosts it reads through, the routes a row opens,
/// the Work list's line and the words at their edges (TodayParityTests holds the rest to the desktop).
struct TodayModelTests {
    static let cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago")!
        c.locale = Locale(identifier: "en_US")
        return c
    }()
    static func at(_ day: Int, _ hour: Int, _ minute: Int = 0, month: Int = 11) -> Double {
        TodayModel.ms(cal.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour, minute: minute))!)
    }
    static func plain(_ s: String?) -> String? { s?.replacingOccurrences(of: "\u{202F}", with: " ") }
    static let mac = TodayWorkspace(environmentId: "mac", workspaceId: "mac-purdue", sector: "purdue", name: "Purdue", open: true)
    static let box = TodayWorkspace(environmentId: "box", workspaceId: "box-purdue", sector: "purdue", name: "Purdue Esports", open: false)
    static let ref = TodayWorkspace(environmentId: "box", workspaceId: "box-ref", sector: "ref", name: "Refereeing", open: false)

    static func row(_ key: String, _ section: String = "held", title: String = "T") -> TodayRow { TodayRow(key: key, section: section, sector: "purdue", title: title) }

    @Test func `a day across the clock change is one day`() {
        let day = TodayModel.dayBounds(Self.at(1, 12), calendar: Self.cal)
        #expect(day.to - day.from == 25 * 3_600_000)
        #expect(TodayModel.dayAfter(day.from, 1, calendar: Self.cal) == day.to)
    }

    @Test func `jobs are the Work workspaces with a sector on hosts with Work on`() {
        let catalog: [TodayModel.CatalogRow] = [
            .init(id: "a", environmentId: "mac", name: "A", kind: "work", sector: "purdue"),
            .init(id: "b", environmentId: "mac", name: "B", kind: "code", sector: "purdue"),
            .init(id: "c", environmentId: "box", name: "C", kind: "work", sector: "ref"),
            .init(id: "d", environmentId: "pc", name: "D", kind: "work", sector: "ref"),
            .init(id: "e", environmentId: "mac", name: "E", kind: "work", sector: nil),
        ]
        let jobs = TodayModel.jobsOf(catalog, workHosts: ["mac", "box"], openHosts: ["mac"])
        #expect(jobs.map(\.workspaceId) == ["a", "c"])
        #expect(jobs.map(\.open) == [true, false])
        #expect(TodayModel.offlineHosts(jobs) == ["box"])
    }

    @Test func `a sector's row opens on the Work home, else an open host, else the first`() {
        #expect(TodayModel.workspaceFor("purdue", [Self.mac, Self.box], home: "box")?.environmentId == "box")
        #expect(TodayModel.workspaceFor("purdue", [Self.box, Self.mac], home: nil)?.environmentId == "mac")
        #expect(TodayModel.workspaceFor("purdue", [Self.box], home: nil)?.environmentId == "box")
        #expect(TodayModel.workspaceFor("life", [Self.box], home: nil) == nil)
    }

    @Test func `LifeOS is read through the home, then each open host, skipping one found wanting`() {
        var open = Self.box
        open.open = true
        let hosts = TodayModel.lifeosHosts([Self.mac, open], home: "box")
        #expect(hosts == ["box", "mac"])
        #expect(TodayModel.pickHost(hosts, wanting: ["box"]) == "mac")
        #expect(TodayModel.pickHost(hosts, wanting: ["box", "mac"]) == "box")
        #expect(TodayModel.lifeosHosts([Self.box], home: "box") == [])
    }

    @Test func `a sector the session lacks is read on another open host, or said no one can`() {
        var refOpen = Self.ref
        refOpen.open = true
        let jobs = [Self.mac, refOpen]
        #expect(TodayModel.lackingOf(.all, jobs, host: "mac").isEmpty)
        #expect(TodayModel.lackingOf(.sectors(["purdue"]), jobs, host: "mac").map(\.sector) == ["ref"])
        #expect(TodayModel.uncoveredOf(.sectors(["purdue"]), jobs, host: "mac").isEmpty)
        #expect(TodayModel.uncoveredOf(.sectors(["purdue"]), [Self.mac, Self.ref], host: "mac") == ["ref"])
        #expect(TodayModel.uncoveredOf(nil, jobs, host: "mac").isEmpty)
    }

    @Test func `a source reading again with no rows keeps the rows it had, and only then`() {
        let had = TodayAnswer(rows: [Self.row("a")], note: "line")
        let again = TodayModel.kept(had: had, answer: TodayAnswer(loading: true))
        #expect(again.kept && again.answer.rows?.map(\.key) == ["a"] && again.answer.note == "line" && again.answer.loading)
        let partial = TodayModel.kept(had: had, answer: TodayAnswer(rows: [], loading: true))
        #expect(!partial.kept && partial.answer.rows == [])
        #expect(!TodayModel.kept(had: nil, answer: TodayAnswer(loading: true)).kept)
    }

    @Test func `a key his act took off is kept off only while a source still gives it`() {
        let gone = TodayModel.stillGiven(["a", "b"], [TodayAnswer(rows: [Self.row("a")]), TodayAnswer()])
        #expect(gone == ["a"])
    }

    @Test func `a source that threw says so in its section, or under Also with what is missing`() {
        #expect(TodayModel.broken("due", ownSection: true).failed.first?.said == "Today could not show this")
        #expect(TodayModel.broken("clashes", ownSection: false).failed.first?.said == "Today could not show clashes")
        #expect(TodayModel.broken("unknown", ownSection: false).failed.first?.said == "Today could not show everything")
    }

    @Test func `a fold line's key names its section`() {
        let key = TodayModel.foldKey(.more, "a:b")
        #expect(key == "fold:more:a:b")
        #expect(TodayModel.foldOf(key)?.section == "a:b")
        #expect(TodayModel.foldOf("task:1") == nil)
    }

    @Test func `a row his act took off leaves before its source drops it`() {
        let fed = [TodayFed(source: "held", section: TodaySources.held, answer: TodayAnswer(rows: [Self.row("a"), Self.row("b")]))]
        let merged = TodayModel.merge(fed, gone: ["a"])
        #expect(merged.first?.rows.map(\.key) == ["b"])
    }

    @Test func `kept rows of a job that is gone are left out, a fresh answer's are not`() {
        var stale = Self.row("x", "due")
        stale.workspace = TodayPlace(environmentId: "pc", workspaceId: "old")
        let page = { (kept: Bool) in
            TodayModel.page([TodayFed(source: "due", section: TodaySources.due, answer: TodayAnswer(rows: [stale]), kept: kept)], jobs: [Self.mac], lifeos: .ok)
        }
        guard case .day(_, _, let keys) = page(false), case .clear = page(true) else { Issue.record("pages"); return }
        #expect(keys == ["x"])
    }

    @Test func `a row opens where the phone has a place, and is no button where it has none`() {
        let place = TodayPlace(environmentId: "mac", workspaceId: "w")
        #expect(TodayTarget.held(environmentId: "mac", ref: .host(.init(id: "h"))).route == .outboxItem(environmentId: "mac", ref: "host:h"))
        // A meeting, and its prep mark, open the meeting's page.
        #expect(TodayTarget.event(place, eventId: "e").route == .prep(environmentId: "mac", workspaceId: "w", eventId: "e"))
        #expect(TodayTarget.prep(place, eventId: "e").route == .prep(environmentId: "mac", workspaceId: "w", eventId: "e"))
        #expect(TodayTarget.task(place, sector: "purdue", taskId: "t").route == .workView(environmentId: "mac", workspaceId: "w", view: "tasks"))
        #expect(TodayTarget.mail(place, threadId: "m").route == .workView(environmentId: "mac", workspaceId: "w", view: "mail"))
        #expect(TodayTarget.form(place, formId: "f", tenant: "t").route == .workView(environmentId: "mac", workspaceId: "w", view: "forms"))
        #expect(TodayTarget.chat(place, chatId: "c").route == .chat(environmentId: "mac", workspaceId: "w", chatId: "c"))
        #expect(TodayTarget.money(place).route == .workView(environmentId: "mac", workspaceId: "w", view: "money"))
        #expect(TodayTarget.review(week: 0).route == .place(.review))
    }

    @Test func `the tick of a Due row completes its task by sector`() {
        let jobs = TodayJobs([Self.mac])
        let rows = TodaySources.dueRows([.init(id: "t", title: "Book", sector: "purdue", dueAt: Self.at(24, 15))], now: Self.at(24, 9), jobs: jobs, calendar: Self.cal)
        #expect(rows.first.flatMap(TodaySources.tick) == .done(sector: "purdue", taskId: "t"))
        #expect(rows.first?.lead == .tick(label: "Mark Book done"))
        #expect(TodaySources.tick(Self.row("held:x")) == nil)
    }

    @Test func `the Work list's line names the next meeting and never the Outbox's count`() {
        var meeting = Self.row("event:a", "meetings", title: "Budget sync")
        meeting.when = "2:00 PM"
        var over = Self.row("event:z", "meetings", title: "Standup")
        over.past = true
        over.when = "9:00 AM"
        var allDay = Self.row("event:d", "meetings", title: "Tournament")
        allDay.when = "All day"
        let held = TodayFed(source: "held", section: TodaySources.held, answer: TodayAnswer(rows: (1...7).map { Self.row("held:\($0)") }))
        let fed = [held, TodayFed(source: "meetings", section: TodaySources.meetings, answer: TodayAnswer(rows: [over, allDay, meeting]))]
        let page = TodayModel.page(fed, jobs: [Self.mac], lifeos: .ok, folds: .init(earlier: ["meetings"]))
        #expect(TodayModel.workListLine(page, now: 0, calendar: Self.cal) == "Budget sync at 2:00 PM")
        var now = meeting
        now.whenLine = "Now"
        let running = TodayModel.page([TodayFed(source: "meetings", section: TodaySources.meetings, answer: TodayAnswer(rows: [now]))], jobs: [Self.mac], lifeos: .ok)
        #expect(TodayModel.workListLine(running, now: 0, calendar: Self.cal) == "Budget sync now")
        // Held rows alone: the Outbox's row says them, so the line says nothing.
        let onlyHeld = TodayModel.page([held], jobs: [Self.mac], lifeos: .ok)
        #expect(TodayModel.workListLine(onlyHeld, now: 0, calendar: Self.cal) == nil)
        #expect(TodayModel.workListLine(.clear(line: nil), now: 0, calendar: Self.cal) == nil)
        #expect(TodayModel.workListLine(.noJobs, now: 0, calendar: Self.cal) == nil)
        let quiet = TodayModel.page([TodayFed(source: "held", section: TodaySources.held, answer: TodayAnswer(rows: [], loading: true))], jobs: [Self.mac], lifeos: .ok)
        #expect(TodayModel.workListLine(quiet, now: 0, calendar: Self.cal) == nil)
    }

    @Test func `with no meeting ahead the Work list's line says what is due`() {
        func line(_ rows: [TodayRow], meetings: [TodayRow] = []) -> String? {
            let fed = [
                TodayFed(source: "meetings", section: TodaySources.meetings, answer: TodayAnswer(rows: meetings)),
                TodayFed(source: "due", section: TodaySources.due, answer: TodayAnswer(rows: rows)),
            ]
            return TodayModel.workListLine(TodayModel.page(fed, jobs: [Self.mac], lifeos: .ok), now: 0, calendar: Self.cal)
        }
        var book = Self.row("task:b", "due", title: "Book the ballroom")
        book.when = "3:00 PM"
        #expect(line([book]) == "Book the ballroom due at 3:00 PM")
        var pinned = Self.row("task:p", "due", title: "Call Dana")
        pinned.when = nil
        #expect(line([pinned]) == "Call Dana due today")
        var late = Self.row("task:l", "due", title: "File the report")
        late.when = "Yesterday"
        late.late = true
        #expect(line([late]) == "File the report, late")
        #expect(line([late, book, pinned]) == "3 due, 1 late")
        #expect(line([book, pinned]) == "2 due")
        // A meeting over and one all day say nothing; the due rows speak.
        var over = Self.row("event:z", "meetings", title: "Standup")
        over.past = true
        over.when = "9:00 AM"
        #expect(line([book], meetings: [over]) == "Book the ballroom due at 3:00 PM")
        // A meeting still ahead wins.
        var sync = Self.row("event:a", "meetings", title: "Budget sync")
        sync.when = "2:00 PM"
        #expect(line([book], meetings: [sync]) == "Budget sync at 2:00 PM")
    }

    @Test func `a row keeps its value while it shows the same, whatever its press holds`() {
        var a = Self.row("a")
        a.open = .money(TodayPlace(environmentId: "mac", workspaceId: "w"))
        var b = a
        b.open = .money(TodayPlace(environmentId: "box", workspaceId: "w"))
        let kept = TodayModel.keepRows([a], [b])
        #expect(kept.same && kept.rows == [a])
        var c = a
        c.title = "Other"
        #expect(!TodayModel.keepRows([a], [c]).same)
    }

    @Test func `the words at their edges`() {
        let c = Self.cal
        #expect(TodayWords.money(123_456_789) == "$1,234,567.89")
        #expect(TodayWords.money(-300) == "-$3.00")
        #expect(TodayWords.money(5) == "$0.05")
        #expect(TodayWords.waitedFor(Self.at(10, 9), today: Self.at(24, 0), c) == "2 weeks")
        #expect(TodayWords.waitedFor(Self.at(24, 9), today: Self.at(24, 0), c) == "1 day")
        #expect(TodayWords.since("2026-11-24", today: "2026-11-24") == "Today")
        #expect(TodayWords.since("2026-11-23", today: "2026-11-24") == "1 day")
        #expect(TodayWords.since(nil, today: "2026-11-24") == nil)
        #expect(Self.plain(TodayWords.chatTime(Self.at(3, 9, month: 1), now: Self.at(24, 9), c)) == "Jan 3")
        #expect(TodayWords.chatTime(Self.at(3, 9, month: 1) - 365 * 86_400_000, now: Self.at(24, 9), c) == "Jan 3, 2025")
        #expect(Self.plain(TodayWords.heldWhen(Self.at(10, 9), now: Self.at(24, 9), c)) == "Nov 10")
        #expect(Self.plain(TodayWords.dayTime(Self.at(25, 9), now: Self.at(24, 9), c)) == "Nov 25, 9:00 AM")
        #expect(TodayWords.due(Self.at(25, 9), now: Self.at(24, 9), c) == "Tomorrow")
        #expect(TodayWords.due(Self.at(27, 9), now: Self.at(24, 9), c) == "Fri")
        #expect(TodayWords.waitingWho([]) == "No one")
        #expect(TodayWords.sectorName("ref") == "Ref" && TodayWords.sectorName("new") == "new")
    }

    @Test func `the second 1:30 AM where the clocks go back is said so`() {
        // Nov 1 2026, 1:30 AM CST, an hour after 1:30 AM CDT.
        let second = TodayModel.ms(Self.cal.date(from: DateComponents(timeZone: TimeZone(identifier: "America/Chicago"), year: 2026, month: 11, day: 1, hour: 1, minute: 30))!) + 3_600_000
        #expect(TodayWords.isSecond(second, Self.cal))
        #expect(!TodayWords.isSecond(second - 3_600_000, Self.cal))
        #expect(TodayWords.timeNear(second, on: second, Self.cal) == "second 1:30 AM")
    }

    @Test func `a review is this week's, last week's, or a week's`() {
        let c = Self.cal
        let monday = TodayWords.weekOf(Self.at(25, 15), c).from
        #expect(monday == Self.at(23, 0))
        #expect(TodayWords.readyTitle(monday, now: Self.at(24, 0), c) == "This week's review is ready")
        #expect(TodayWords.readyTitle(Self.at(16, 0), now: Self.at(24, 0), c) == "Last week's review is ready")
        #expect(TodayWords.readyTitle(Self.at(9, 0), now: Self.at(24, 0), c) == "A week's review is ready")
        #expect(TodayWords.weekWords(Self.at(16, 0), c) == "Week of Nov 16")
    }

    // MARK: - fix round 2

    @Test func `a LifeOS that is connecting is one line in its sections' place, and the page is never clear`() {
        let jobs = [TodayWorkspace(environmentId: "mac", workspaceId: "w", sector: "purdue", name: "Purdue", open: true)]
        let fed = [TodayFed(source: "meetings", section: TodaySources.meetings, answer: TodayAnswer(loading: true)),
                   TodayFed(source: "held", section: TodaySources.held, answer: TodayAnswer(rows: []))]
        guard case .day(let blocks, _, _) = TodayModel.page(fed, jobs: jobs, lifeos: .connecting) else { Issue.record("clear"); return }
        #expect(blocks.filter { $0 == .connecting }.count == 1)
        #expect(!blocks.contains { if case .section(let s) = $0 { s.id == "meetings" } else { false } })
    }

    @Test func `a read waiting on another host's LifeOS is one line for the page, with no press`() {
        let jobs = TodayJobs([TodayWorkspace(environmentId: "mac", workspaceId: "w", sector: "ref", name: "Refereeing", open: true)])
        let read = TodaySources.LifeosRead(lost: [TodaySources.Lost(environmentId: "mac", sector: "ref", error: "", waits: true)])
        let meetings = TodaySources.lifeosAnswer(read, rows: [], sessionDown: false, host: "box", what: "meetings", jobs: jobs)
        let tasks = TodaySources.lifeosAnswer(read, rows: [], sessionDown: false, host: "box", what: "tasks", jobs: jobs)
        let fed = [TodayFed(source: "meetings", section: TodaySources.meetings, answer: meetings), TodayFed(source: "due", section: TodaySources.due, answer: tasks)]
        guard case .day(let blocks, _, _) = TodayModel.page(fed, jobs: jobs.jobs, lifeos: .ok) else { Issue.record("clear"); return }
        guard case .lost(let line)? = blocks.first else { Issue.record("no line"); return }
        #expect(line.waits && line.retry == nil && line.said == "Refereeing's meetings and tasks left out")
    }

    @Test func `the Work list's line counts every late row, folded or not`() {
        var rows: [TodayRow] = []
        for i in 0..<12 {
            var row = Self.row("task:\(i)", "due")
            row.late = i < 10
            row.when = "Nov 1"
            rows.append(row)
        }
        let section = TodayModel.fold(TodayModel.MergedSection(def: TodaySources.due, rows: rows))
        let page = TodayModel.Page.day(blocks: [.section(section)], offline: [], keys: [])
        #expect(TodayModel.workListLine(page, now: Self.at(24, 9), calendar: Self.cal) == "12 due, 10 late")
    }
}
