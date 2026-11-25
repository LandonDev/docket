import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The phone's digest (Work/Digest/DigestModel.swift), held to the desktop's
/// `work/digest/store.ts` and `notice.ts`.
@Suite struct DigestModelTests {
    /// 2026-11-23 15:00 in New York.
    private let now = Date(timeIntervalSince1970: 1_795_464_000)
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        return calendar
    }()
    private let locale = Locale(identifier: "en_US")

    private func ms(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Double {
        calendar.date(from: DateComponents(year: 2026, month: 11, day: day, hour: hour, minute: minute))!.timeIntervalSince1970 * 1000
    }

    private func row(_ id: String, key: String? = nil, sector: String? = "purdue", title: String = "Budget review", at: Double, day: String? = nil, toldAt: Double? = nil, by: Double? = nil, open: TellOpen? = nil) -> TellRow {
        TellRow(id: id, host: "h", kind: "prep.soon", group: .meetings, workspaceId: sector == nil ? nil : "w_\(sector!)", sector: sector, title: title, open: open, by: by, key: key, at: at, how: toldAt != nil ? .now : day != nil ? .digest : .waiting, day: day, toldAt: toldAt)
    }

    /// ICU writes a narrow no-break space before AM and PM; the words compare as he reads them.
    private func plain(_ text: String) -> String { text.replacingOccurrences(of: "\u{202F}", with: " ") }

    // MARK: - merge

    @Test func `one key on two hosts is one row, and a row with no key is its own on each host`() {
        let merged = DigestModel.mergeRows([
            (environmentId: "env_mac", rows: [row("a1", key: "clash:1", at: ms(23, 9)), row("a2", at: ms(23, 10))]),
            (environmentId: "env_box", rows: [row("b1", key: "clash:1", at: ms(23, 9, 5)), row("a2", at: ms(23, 10))])
        ])
        #expect(merged.count == 3)
        #expect(merged.filter { $0.row.key == "clash:1" }.count == 1)
        // the newest of the two wins when neither was told at once
        #expect(merged.first { $0.row.key == "clash:1" }?.environmentId == "env_box")
        // newest first
        #expect(merged.map(\.row.at) == merged.map(\.row.at).sorted(by: >))
    }

    @Test func `the one told at once wins over a newer one that waited`() {
        let merged = DigestModel.mergeRows([
            (environmentId: "env_mac", rows: [row("a1", key: "held:1", at: ms(23, 9), toldAt: ms(23, 9))]),
            (environmentId: "env_box", rows: [row("b1", key: "held:1", at: ms(23, 11))])
        ])
        #expect(merged.count == 1)
        #expect(merged[0].environmentId == "env_mac")
        #expect(merged[0].row.toldAt != nil)
    }

    @Test func `hosts' days of one date are one day, seen once any host's is`() {
        let days = DigestModel.mergeDays([
            (environmentId: "env_mac", days: [DigestDay(day: "2026-11-23", madeAt: ms(23, 8, 1), seenAt: nil, count: 2), DigestDay(day: "2026-11-22", madeAt: ms(22, 8), seenAt: nil, count: 1)]),
            (environmentId: "env_box", days: [DigestDay(day: "2026-11-23", madeAt: ms(23, 8), seenAt: ms(23, 9), count: 3)])
        ])
        #expect(days.map(\.day) == ["2026-11-23", "2026-11-22"])
        #expect(days[0].hosts == ["env_mac", "env_box"])
        #expect(days[0].madeAt == ms(23, 8))
        #expect(days[0].seenAt == ms(23, 9))
        #expect(days[1].seenAt == nil)
    }

    @Test func `opening the screen marks every unseen day seen on every host that holds it`() {
        let days = DigestModel.mergeDays([
            (environmentId: "env_mac", days: [DigestDay(day: "2026-11-23", madeAt: 1, seenAt: nil, count: 2), DigestDay(day: "2026-11-21", madeAt: 1, seenAt: nil, count: 1)]),
            (environmentId: "env_box", days: [DigestDay(day: "2026-11-23", madeAt: 1, seenAt: nil, count: 1), DigestDay(day: "2026-11-22", madeAt: 1, seenAt: 5, count: 1)])
        ])
        let calls = DigestModel.seenCalls(days).map { "\($0.environmentId) \($0.day)" }
        #expect(calls == ["env_mac 2026-11-23", "env_box 2026-11-23", "env_mac 2026-11-21"])
        // and a day already seen anywhere is not sent again
        #expect(!calls.contains { $0.hasSuffix("2026-11-22") })
    }

    // MARK: - the ledger and the push

    @Test func `the push tells, replaces, takes away and makes a day`() {
        var ledger = DigestModel.Ledger(days: [], rows: [row("r1", at: 1), row("r2", at: 2)])
        let replaced = ledger.apply(WorkDigestPush(row: row("r1", title: "Budget review moved", at: 3)))
        #expect(!replaced)
        #expect(ledger.rows.map(\.id) == ["r1", "r2"])
        #expect(ledger.rows[0].title == "Budget review moved")
        ledger.apply(WorkDigestPush(gone: "r2"))
        #expect(ledger.rows.map(\.id) == ["r1"])
        // a day made: read again, the host stamped its rows
        let made = ledger.apply(WorkDigestPush(day: DigestDay(day: "2026-11-23", madeAt: 1, seenAt: nil, count: 1)))
        #expect(made)
        // the same day seen elsewhere replaces it, and needs no read
        let seenElsewhere = ledger.apply(WorkDigestPush(day: DigestDay(day: "2026-11-23", madeAt: 1, seenAt: 9, count: 1)))
        #expect(!seenElsewhere)
        #expect(ledger.days.count == 1)
        #expect(ledger.days[0].seenAt == 9)
        let settings = DigestSettings(at: "07:30", zone: "America/New_York", levels: ["held": .now], nextAt: 1)
        ledger.apply(WorkDigestPush(settings: settings))
        #expect(ledger.settings == settings)
        ledger.days = [DigestDay(day: "2026-11-24", madeAt: 1, seenAt: nil, count: 1)]
        ledger.seen("2026-11-24", at: 42)
        #expect(ledger.days[0].seenAt == 42)
    }

    @Test func `a host that did not answer is named, and one still reading holds the list`() {
        let screen = DigestModel.screen([
            DigestModel.HostInput(environmentId: "env_box", name: "The box", ledger: DigestModel.Ledger(rows: [row("r1", at: 1)]), error: nil),
            DigestModel.HostInput(environmentId: "env_mac", name: "The Mac", ledger: nil, error: "timed out")
        ])
        #expect(screen.entries.count == 1)
        #expect(screen.silent == ["The Mac"])
        #expect(!screen.reading)
        #expect(DigestModel.silentLine("The Mac") == "The Mac did not answer")
        #expect(DigestModel.screen([DigestModel.HostInput(environmentId: "env_box", name: "The box", ledger: nil, error: nil)]).reading)
    }

    // MARK: - the list

    @Test func `sections run newest first: since the digest, today at its time, yesterday, then dates`() {
        let entries = DigestModel.mergeRows([(environmentId: "env_box", rows: [
            row("w1", sector: "ref", at: ms(23, 12)),
            row("w2", sector: nil, title: "Unsorted captures", at: ms(23, 13)),
            row("w3", sector: "cosmic", at: ms(23, 11)),
            row("t1", sector: "purdue", at: ms(23, 7), day: "2026-11-23"),
            row("y1", sector: "hypixel", at: ms(22, 7), day: "2026-11-22"),
            row("o1", sector: "unify", at: ms(16, 7), day: "2026-11-16")
        ])])
        let days = [DigestModel.Day(day: "2026-11-23", madeAt: ms(23, 8), seenAt: nil, hosts: ["env_box"])]
        let sections = DigestModel.sections(entries, days: days, now: now, calendar: calendar, locale: locale)
        #expect(sections.map { plain($0.title) } == ["Since the digest", "Today, 8:00 AM", "Yesterday", "Mon, Nov 16"])
        // by job, then newest; a row about no one job last
        #expect(sections[0].entries.map(\.row.id) == ["w3", "w1", "w2"])
    }

    @Test func `a section's rows of one job are newest first`() {
        let entries = DigestModel.mergeRows([(environmentId: "env_box", rows: [row("a", at: ms(23, 9)), row("b", at: ms(23, 10))])])
        #expect(DigestModel.sections(entries, days: [], now: now, calendar: calendar, locale: locale)[0].entries.map(\.row.id) == ["b", "a"])
    }

    private func when(_ row: TellRow) -> String { plain(DigestModel.when(row, now: now, calendar: calendar, locale: locale)) }

    @Test func `a told time names its day only when it is not the day of the row's heading`() {
        let under = { (row: TellRow, day: String) in self.plain(DigestModel.when(row, now: self.now, day: day, calendar: self.calendar, locale: self.locale)) }
        // under "Yesterday" (Sun Nov 22): told that morning, and told the evening before
        #expect(under(row("r", at: ms(22, 7, 1), day: "2026-11-22"), "2026-11-22") == "7:01 AM")
        #expect(under(row("r", at: ms(21, 21, 14), day: "2026-11-22"), "2026-11-22") == "Sat 9:14 PM")
        // under "Today, 8:00 AM": told yesterday afternoon
        #expect(under(row("r", at: ms(22, 16, 20), day: "2026-11-23"), "2026-11-23") == "Sun 4:20 PM")
        // each section carries the day its heading names; "Since the digest" is today's
        let entries = DigestModel.mergeRows([(environmentId: "env_box", rows: [row("s", at: ms(23, 12)), row("y", at: ms(22, 7), day: "2026-11-22")])])
        let sections = DigestModel.sections(entries, days: [], now: now, calendar: calendar, locale: locale)
        #expect(sections.map(\.day) == ["2026-11-23", "2026-11-22"])
    }

    @Test func `a row with a clock reads by its clock, else the time it was told, each naming a day that is not today`() {
        #expect(when(row("r", at: ms(23, 9, 5))) == "9:05 AM")
        #expect(when(row("r", at: ms(23, 9), by: ms(23, 14))) == "by 2:00 PM")
        // a held invite with a clock on Thursday
        #expect(when(row("r", title: "Held: Invite Dana Reyes to Spring LAN walkthrough", at: ms(23, 9), by: ms(26, 14))) == "by Nov 26, 2:00 PM")
        // told yesterday, and told before the week
        #expect(when(row("r", at: ms(22, 16, 20))) == "Sun 4:20 PM")
        #expect(when(row("r", at: ms(9, 7))) == "Nov 9, 7:00 AM")
    }

    @Test func `a row whose words carry its clock never says it twice: it ends with when it was told`() {
        #expect(when(row("r", title: "Budget review starts at 2:00 PM", at: ms(23, 13, 50), by: ms(23, 14))) == "1:50 PM")
        var detailed = row("r", title: "Prep is ready for Budget review", at: ms(23, 8), by: ms(23, 14))
        detailed = TellRow(id: detailed.id, host: detailed.host, kind: detailed.kind, group: detailed.group, workspaceId: detailed.workspaceId, sector: detailed.sector, title: detailed.title, detail: "2:00 PM, with Dana Reyes", by: detailed.by, at: detailed.at, how: detailed.how, day: nil, toldAt: nil)
        #expect(when(detailed) == "8:00 AM")
        // the host's words with a narrow no-break space still say the clock
        #expect(when(row("r", title: "Budget review starts at 2:00\u{202F}PM", at: ms(22, 13, 50), by: ms(23, 14))) == "Sun 1:50 PM")
    }

    @Test func `a clock that had come when the row was told is no deadline: it ends with when it was told`() {
        // a send that failed, told at once: its clock is the failure itself
        #expect(when(row("r", title: "Not sent: Send to Rivera Dental", at: ms(23, 5, 17), by: ms(23, 5, 17))) == "5:17 AM")
        // a clock already past when it was told
        #expect(when(row("r", at: ms(23, 9), by: ms(23, 8, 30))) == "9:00 AM")
        // one minute ahead is still ahead
        #expect(when(row("r", at: ms(23, 13, 59), by: ms(23, 14))) == "by 2:00 PM")
    }

    @Test func `nothing at all says since when`() {
        #expect(DigestModel.emptyLine(now: now, calendar: calendar, locale: locale) == "Nothing Since Oct 24")
    }

    @Test func `a row is spoken with its job first, which the dot says to the eye alone`() {
        #expect(DigestModel.spoken(row("r", sector: "cosmic", title: "Morning summary", at: ms(23, 9)), when: "9:00 AM") == "Cosmic, Morning summary, 9:00 AM")
        #expect(DigestModel.spoken(row("r", sector: nil, title: "4 captures to sort", at: ms(23, 9)), when: "9:00 AM") == "4 captures to sort, 9:00 AM")
    }

    @Test func `an answer for an earlier edit is not the latest once another began`() {
        var gate = EditGate()
        let first = gate.begin()
        #expect(gate.isLatest(first))
        let second = gate.begin()
        #expect(!gate.isLatest(first))
        #expect(gate.isLatest(second))
    }

    // MARK: - where a press goes

    @Test func `a row opens its thread, held item or view on its host, and nothing the phone has no screen for`() {
        #expect(DigestModel.route(TellOpen(thread: "s1"), environmentId: "e") == .thread(environmentId: "e", sessionId: "s1", seq: nil))
        #expect(DigestModel.route(TellOpen(thread: "s1", held: .host(.init(id: "h1"))), environmentId: "e") == .outboxItem(environmentId: "e", ref: "host:h1"))
        #expect(DigestModel.route(TellOpen(view: "agenda", workspaceId: "w1", at: "ev1"), environmentId: "e") == .workView(environmentId: "e", workspaceId: "w1", view: "agenda"))
        #expect(DigestModel.route(TellOpen(view: "clashes", workspaceId: "w1"), environmentId: "e") == nil)
        #expect(DigestModel.route(TellOpen(place: "review"), environmentId: "e") == .place(.review))
        #expect(DigestModel.reviewWeek(TellOpen(at: "1700000000000", place: "review")) == 1_700_000_000_000)
        #expect(DigestModel.reviewWeek(TellOpen(view: "agenda", workspaceId: "w1", at: "ev1")) == nil)
        // Connections is a place of the Work tab since M5b: a lapse's tell opens it.
        #expect(DigestModel.route(TellOpen(settings: "connections"), environmentId: "e") == .place(.connections))
        #expect(DigestModel.route(nil, environmentId: "e") == nil)
        // A place of the Work tab and Settings → Work are the phone's own: no host is needed.
        #expect(DigestModel.route(TellOpen(place: "outbox"), environmentId: "") == .place(.outbox))
        #expect(DigestModel.route(TellOpen(settings: "work"), environmentId: "") == .workSettings)
        #expect(DigestModel.route(TellOpen(view: "outbox", workspaceId: "w1"), environmentId: "e") == .place(.outbox))
        #expect(DigestModel.route(TellOpen(view: "files", workspaceId: "w1"), environmentId: "e") == .workView(environmentId: "e", workspaceId: "w1", view: "files"))
        #expect(DigestModel.route(TellOpen(thread: "s1"), environmentId: "") == nil)
    }

    @Test func `a clash's tell opens the clash by its key, whatever its open names`() {
        // clashes/watch.ts tells `clash:<id>` with the Agenda of a job as its open.
        #expect(DigestModel.route(TellOpen(view: "agenda", workspaceId: "w1", at: "ev2"), environmentId: "e", key: "clash:ev1-ev2") == .clash(environmentId: "e", clashId: "ev1-ev2"))
        #expect(DigestModel.route(nil, environmentId: "e", key: "clash:ev1-ev2") == .clash(environmentId: "e", clashId: "ev1-ev2"))
        // With no host the clash cannot be read.
        #expect(DigestModel.route(nil, environmentId: "", key: "clash:ev1-ev2") == nil)
        #expect(DigestModel.route(TellOpen(view: "agenda", workspaceId: "w1", at: "ev2"), environmentId: "e", key: "prep:1") == .workView(environmentId: "e", workspaceId: "w1", view: "agenda"))
    }

    // MARK: - Settings → Work → Digest

    @Test func `Mail, Tasks and Agenda for every job open as places; one not built does not`() {
        #expect(DigestModel.route(TellOpen(place: "tasks"), environmentId: "") == .place(.tasks))
        #expect(DigestModel.route(TellOpen(at: "ev1", place: "agenda"), environmentId: "e") == .place(.agenda))
        #expect(DigestModel.route(TellOpen(place: "mail"), environmentId: "e") == .place(.mail))
        #expect(DigestModel.route(TellOpen(place: "connections"), environmentId: "e") == .place(.connections))
        #expect(DigestModel.route(TellOpen(place: "nowhere"), environmentId: "e") == nil)
    }

    /// Each `open` a host's `ctx.tell` passes today (src/main/server/work), and where the phone takes it: its
    /// screen, or nil, which opens the Digest.
    @Test func `every open the hosts send opens its screen or the Digest`() {
        let view = { (name: String) in Route.workView(environmentId: "e", workspaceId: "w1", view: name) }
        let sent: [(TellOpen, Route?)] = [
            // outbox/requests.ts, digest/gate.ts
            (TellOpen(thread: "s1"), .thread(environmentId: "e", sessionId: "s1", seq: nil)),
            // outbox/tells.ts: an earned grant's offer names the held item it came from
            (TellOpen(held: .host(.init(id: "h1"))), .outboxItem(environmentId: "e", ref: "host:h1")),
            // digest/sources/scheduled.ts, waiting.ts
            (TellOpen(view: "mail", workspaceId: "w1"), view("mail")),
            // digest/sources/capture.ts
            (TellOpen(view: "tasks", workspaceId: "w1"), view("tasks")),
            // clashes/watch.ts: the Agenda of the job whose week holds the clash
            (TellOpen(view: "agenda", workspaceId: "w1", at: "ev1"), view("agenda")),
            // msforms/tell.ts
            (TellOpen(view: "forms", workspaceId: "w1", at: "f1"), view("forms")),
            // messages/tell.ts: the conversation that waits on him, over Messages
            (TellOpen(view: "messages", workspaceId: "w1", at: "c1"), .chat(environmentId: "e", workspaceId: "w1", chatId: "c1")),
            (TellOpen(view: "messages", workspaceId: "w1"), .place(.messages)),
            // digest/sources/prep.ts: the meeting's page
            (TellOpen(view: "prep", workspaceId: "w1", at: "ev1"), .prep(environmentId: "e", workspaceId: "w1", eventId: "ev1")),
            // money/inbox.ts: the job's Money page
            (TellOpen(view: "money", workspaceId: "w1"), view("money")),
            // digest/sources/guests.ts: no screen on the phone yet
            (TellOpen(view: "docs", workspaceId: "w1", at: "k1"), nil),
            // review/friday.ts: Review, at the week it names (`ReviewDesk.weekNamed`)
            (TellOpen(at: "1700000000000", place: "review"), .place(.review)),
            // digest/sources/winvm.ts, lapses.ts
            (TellOpen(settings: "work"), .workSettings),
            (TellOpen(settings: "connections"), .place(.connections)),
            // routines' plays: the job's Plays (M5b)
            (TellOpen(view: "plays", workspaceId: "w1"), view("plays"))
        ]
        for (open, route) in sent {
            #expect(DigestModel.route(open, environmentId: "e") == route, "\(open)")
        }
    }

    @Test func `every group starts at when it can't wait, in his words`() {
        // the desktop's SETTING_GROUPS, in its order
        #expect(DigestModel.settingsGroups.map(DigestModel.groupName) == ["Held items", "Routine results", "Messages and mail", "Meetings"])
        #expect(DigestModel.levels.map(DigestModel.levelName) == ["In the digest", "When it can’t wait", "Right away"])
        let settings = DigestSettings(at: "08:00", zone: "UTC", levels: ["held": .now], nextAt: 0)
        #expect(DigestModel.level(settings, .held) == .now)
        #expect(DigestModel.level(settings, .results) == .clock)
        #expect(DigestModel.level(settings, .meetings) == .clock)
        #expect(DigestModel.level(nil, .people) == .clock)
    }

    @Test func `the time goes through the picker as the wire's wall time`() {
        let picked = DigestModel.atDate("07:45", now: now, calendar: calendar)
        #expect(calendar.dateComponents([.hour, .minute], from: picked) == DateComponents(hour: 7, minute: 45))
        #expect(DigestModel.atString(picked, calendar: calendar) == "07:45")
        #expect(DigestModel.atString(DigestModel.atDate("23:05", now: now, calendar: calendar), calendar: calendar) == "23:05")
    }

    // MARK: - the kept days (Work/Digest/DigestKept.swift)

    private func ledger(days: [String], rows: [TellRow]) -> DigestModel.Ledger {
        DigestModel.Ledger(days: days.map { DigestDay(day: $0, madeAt: 1, seenAt: nil, count: 1) }, rows: rows, settings: nil)
    }

    @Test func `a host away draws what the phone kept, and its days are marked seen only once it answers`() {
        let kept = ledger(days: ["2026-11-23"], rows: [row("r1", at: ms(23, 8), day: "2026-11-23")])
        let screen = DigestModel.screen([
            .init(environmentId: "env_mac", name: "Mac", ledger: nil, error: "Not connected", kept: kept),
            .init(environmentId: "env_box", name: "The box", ledger: ledger(days: ["2026-11-23"], rows: []), error: nil),
        ])
        #expect(screen.entries.map(\.row.id) == ["r1"])
        #expect(DigestModel.sections(screen.entries, days: screen.days, now: now, calendar: calendar, locale: locale).map(\.id) == ["2026-11-23"])
        #expect(screen.silent == ["Mac"])
        // Read-only: the kept host's day is not marked seen from the disk; the live one's is.
        #expect(DigestModel.seenCalls(screen.days, live: ["env_box"]).map(\.environmentId) == ["env_box"])
        // Its answer wins over what was kept.
        let answered = DigestModel.screen([.init(environmentId: "env_mac", name: "Mac", ledger: ledger(days: [], rows: []), error: nil, kept: kept)])
        #expect(answered.entries.isEmpty)
    }

    @Test func `what is kept: the newest days with their rows, no live rows, no settings`() {
        let days = (1...20).map { String(format: "2026-11-%02d", $0) }
        let rows = [row("old", at: 1, day: "2026-11-01"), row("new", at: 2, day: "2026-11-20"), row("live", at: 3)]
        let full = DigestModel.Ledger(days: days.map { DigestDay(day: $0, madeAt: 1, seenAt: nil, count: 1) }, rows: rows, settings: DigestSettings(at: "08:00", zone: "America/Chicago", levels: [:], nextAt: 0))
        let kept = WorkCache.digest(full)
        #expect(kept.days.count == WorkCache.digestDaysKept)
        #expect(kept.days.first?.day == "2026-11-20")
        #expect(kept.rows.map(\.id) == ["new"])
        #expect(kept.settings == nil)
    }

    @MainActor @Test func `kept days are read under the host's key, written when they change, and go with Work off`() {
        let cache = DigestBookCache()
        let key = WorkCache.Key(host: "env_mac", account: "k1", keyGeneration: 1, scope: .digest)
        let one = DigestKept(cache: cache, key: key)
        #expect(one.ledger == nil)
        let read = ledger(days: ["2026-11-23"], rows: [row("r1", at: 1, day: "2026-11-23")])
        one.keep(read)
        one.keep(read)
        #expect(cache.writes == 1)
        // A cold launch reads them back; a replaced key reads none.
        #expect(DigestKept(cache: cache, key: key).ledger == WorkCache.digest(read))
        #expect(DigestKept(cache: cache, key: WorkCache.Key(host: "env_mac", account: "k2", keyGeneration: 2, scope: .digest)).ledger == nil)
        one.drop()
        #expect(one.ledger == nil)
        #expect(DigestKept(cache: cache, key: key).ledger == nil)
    }
}
