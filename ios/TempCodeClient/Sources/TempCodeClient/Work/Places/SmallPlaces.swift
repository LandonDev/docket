import Foundation
import TempCodeContract

// A job's small places on the phone (M5b; docs/agents/ios-client.md "A job's small places"): the rules the screens
// draw by, each held to the desktop's words where the desktop has them.

// MARK: - Plays

/// A play run from the phone (src/renderer/src/work/routines/plays/model.ts): a play that takes only a line of text, a
/// date, or nothing runs here with what he types; a play about a mail, a task, an event or a file starts from that
/// thing, which the phone's Plays list does not pick.
public enum PlayRun {
    public struct Inputs: Equatable, Sendable {
        public var text: String?
        public var date: String?

        public init(text: String? = nil, date: String? = nil) {
            self.text = text
            self.date = date
        }
    }

    public static func runsHere(_ play: PlayPhoneRow) -> Bool {
        !play.proposed && play.takes.allSatisfy { $0 == .text || $0 == .date }
    }

    public static func asksText(_ play: PlayPhoneRow) -> Bool { play.takes.contains(.text) }
    public static func asksDate(_ play: PlayPhoneRow) -> Bool { play.takes.contains(.date) }
    /// Run goes at once: nothing to ask.
    public static func asksNothing(_ play: PlayPhoneRow) -> Bool { play.takes.isEmpty }

    /// What a start hands the host, or nil while a thing it takes is missing (the host's `playInputsProblem`).
    public static func inputs(_ play: PlayPhoneRow, text: String, date: Date?, calendar: Calendar = .current) -> Inputs? {
        guard runsHere(play) else { return nil }
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var out = Inputs()
        if asksText(play) {
            guard !words.isEmpty, words.count <= 4000 else { return nil }
            out.text = words
        }
        if asksDate(play) {
            guard let date else { return nil }
            out.date = TemplateFill.day(date, calendar: calendar)
        }
        return out
    }

    private static func noun(_ take: PlayPhoneRow.Take) -> String {
        switch take {
        case .mail: "a mail"
        case .task: "a task"
        case .event: "an event"
        case .file: "a file"
        case .date: "a date"
        case .text: "a line of text"
        case .unknown(let raw): raw
        }
    }

    /// "Takes a mail", "Takes a line of text and a date"; nil for a play that takes nothing (`takesLine`).
    public static func takesLine(_ takes: [PlayPhoneRow.Take]) -> String? {
        let nouns = takes.map(noun)
        guard let last = nouns.last else { return nil }
        return "Takes " + (nouns.count > 1 ? nouns.dropLast().joined(separator: ", ") + " and " + last : last)
    }
}

// MARK: - Routines' runs

/// A routine's last runs (src/renderer/src/work/routines/model.ts `runMark`, `runWords`).
public enum RoutineRuns {
    /// How many a routine's row unfolds.
    public static let shown = 5

    public enum Mark: Equatable, Sendable { case done, working, waiting, failed }

    public static func mark(_ run: RoutineRunPhone) -> Mark {
        switch run.state {
        case .failed: .failed
        case .asked: .waiting
        case .running, .starting: .working
        default: .done
        }
    }

    /// The outcome in words: "Running", a failed run's cause alone, else its summary and what it covers.
    public static func words(_ run: RoutineRunPhone) -> String {
        switch mark(run) {
        case .working: return "Running"
        case .failed:
            let cause = run.summary.replacingOccurrences(of: #"^Failed:\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
            return cause.isEmpty ? "Did not finish" : cause
        case .done, .waiting:
            let covers = run.folded > 0 ? ", covers \(run.folded + 1)" : ""
            return (run.summary.isEmpty ? "Done" : run.summary) + covers
        }
    }

    /// When it fired: the time today, else the weekday and time.
    public static func when(_ run: RoutineRunPhone, now: Date = Date(), calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: run.firedAt / 1000)
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(date: .omitted, time: .shortened) }
        return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute())
    }

    /// Whether Run Now is offered: a routine that has not ended and is not running now.
    public static func runsNow(_ row: RoutinePhoneRow) -> Bool { !row.ended && !row.running && !row.proposed }
}

// MARK: - Templates

/// New from a template in Files (src/renderer/src/work/templates/data.ts `makeFrom`): the fields he typed, and the
/// phone's own day for Date.
public enum TemplateFill {
    /// The values for the template's own fields, each trimmed; an empty one is left out (the host leaves it as written).
    public static func fields(_ values: [String: String], of template: TemplatePhone) -> [String: String] {
        var out: [String: String] = [:]
        for name in template.fields {
            let value = (values[name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { out[name] = String(value.prefix(2000)) }
        }
        return out
    }

    /// A day as the wire keeps it, YYYY-MM-DD, on his own calendar.
    public static func day(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// What the capsule says once it is made: the file, and any field still in it as written.
    public static func madeWords(_ made: Methods.WorkTemplatesMake.Output) -> String {
        guard !made.unfilled.isEmpty else { return "Made \(made.title)" }
        let names = made.unfilled.joined(separator: ", ")
        return "Made \(made.title). \(made.unfilled.count == 1 ? "\(names) is" : "\(names) are") left to fill"
    }

    public static func glyph(_ kind: TemplatePhone.Kind) -> String {
        switch kind {
        case .sheet: "tablecells"
        case .deck: "rectangle.on.rectangle"
        default: "doc.text"
        }
    }
}

// MARK: - Forms

/// The job's Forms list on the phone: TempCode's own forms, then Microsoft's. Close is operate; Reopen starts a form
/// taking answers again, so it is drawn only for a key the host would take it from (approve on the key itself:
/// KeyMay's `.formsReopen`, `.msformsReopen`) and goes through the owner's check (`PressGates`).
public enum FormsList {
    public enum Press: Hashable, Sendable { case close, reopen }

    /// The presses a form's state offers, as the key allows.
    public static func presses(open: Bool, closed: Bool, mayClose: Bool, mayReopen: Bool) -> [Press] {
        if open { return mayClose ? [.close] : [] }
        if closed { return mayReopen ? [.reopen] : [] }
        return []
    }

    public static func presses(_ row: FormListPhoneRow, mayClose: Bool, mayReopen: Bool) -> [Press] {
        presses(open: row.state == .open, closed: row.state == .closed, mayClose: mayClose, mayReopen: mayReopen)
    }

    public static func presses(_ row: MsFormPhoneRow, mayClose: Bool, mayReopen: Bool) -> [Press] {
        presses(open: row.state == .collecting, closed: row.state == .closed, mayClose: mayClose, mayReopen: mayReopen)
    }

    /// Our form's stamp: how it stands.
    public static func stamp(_ row: FormListPhoneRow) -> String {
        switch row.state {
        case .draft: "Draft"
        case .open: "Open"
        case .closed: "Closed"
        case .unknown(let raw): raw.capitalized
        }
    }

    /// A Microsoft form's stamp: `MsForms.stamp`, with the answers he has not seen.
    public static func stamp(_ row: MsFormPhoneRow) -> String {
        let base = MsForms.stamp(row)
        guard let unseen = row.unseen, unseen > 0, row.state != .draft else { return base }
        return "\(base), \(unseen) new"
    }

    /// A Microsoft form opens its answers in the app once it has collected; a draft opens in Forms.
    public static func answersHere(_ row: MsFormPhoneRow) -> Bool { row.state != .draft }

    /// The capsule after a press.
    public static func doneWords(_ press: Press, title: String) -> String {
        press == .close ? "Closed \(title)" : "Reopened \(title)"
    }

    /// When the answers were read: "Read at 2:10 PM", older ones by day; nil before any read.
    public static func readLine(_ answers: MsFormResponsesPhone, now: Date = Date(), calendar: Calendar = .current) -> String? {
        guard let at = answers.at else { return nil }
        let date = Date(timeIntervalSince1970: at / 1000)
        let when = calendar.isDate(date, inSameDayAs: now) ? date.formatted(date: .omitted, time: .shortened) : date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
        return answers.stale ? "Last read at \(when). The newest answers did not load." : "Read at \(when)"
    }
}

// MARK: - Connections

/// Connections on the phone (src/renderer/src/work/connections/model.ts): each host's sign-ins and helpers by group,
/// a row two hosts give alike shown once. Every fix a host offers works in a computer's own window or browser (a
/// sign-in, a consent, the VM's OneDrive), so on the phone a row that is not working offers "Open on <computer>"
/// (`work.reveal`, Settings → Connections there) and no fix of its own.
public enum Connections {
    /// Why a Work host's checks are not on screen as fresh.
    public enum Missed: Equatable, Sendable {
        /// no live link to it
        case away
        /// its health read failed, in Work's words
        case failed(String)
        /// its health came back, its known ends did not
        case lapses
    }

    /// One line for every host whose checks did not come back (`ConnectionsFeed`), never "Nothing to Check": one host
    /// in its own words, with when the rows kept under it were read ("The box did not answer: … Showing 2:10 PM's.");
    /// several by name. Nil for none.
    public static func missedLine(_ missed: [(name: String, why: Missed, keptAt: String?)]) -> String? {
        guard let one = missed.first else { return nil }
        guard missed.count == 1 else {
            let names = missed.map(\.name)
            return "\(names.dropLast().joined(separator: ", ")) and \(names.last!) were not checked."
        }
        let line = switch one.why {
        case .away: "Not connected to \(WorkSearch.nameInLine(one.name))."
        case .failed(let words) where words.isEmpty: "\(one.name) did not answer."
        case .failed(let words): "\(one.name) did not answer: \(words.hasSuffix(".") ? words : words + ".")"
        case .lapses: "\(one.name) did not say what ends soon."
        }
        return one.keptAt.map { "\(line) Showing what it said at \($0)." } ?? line
    }

    public struct Host: Sendable {
        public var id: String
        public var name: String
        public var report: HealthReportPhone?
        public var lapses: [LapsePhone]

        public init(id: String, name: String, report: HealthReportPhone?, lapses: [LapsePhone] = []) {
            self.id = id
            self.name = name
            self.report = report
            self.lapses = lapses
        }
    }

    public struct Row: Identifiable, Hashable, Sendable {
        public var id: String
        public var hostId: String
        public var hostName: String
        public var title: String
        public var line: String?
        public var state: HealthRowPhone.State
        public var until: Double?
    }

    public struct Section: Hashable, Sendable {
        public var group: String
        public var rows: [Row]
    }

    /// The desktop's order: what everything else leans on first; a group not named here follows in the order it came.
    public static let groupOrder = ["LifeOS", "Mail and calendar", "Google", "Office", "Files", "Browser", "Windows VM", "Hosting", "Tools", "Frame.io"]

    /// The first notice of a known end, in days (`LAPSE_NOTICE_DAYS`).
    public static let lapseNoticeDays = 14.0

    public static func sections(_ hosts: [Host]) -> [Section] {
        var placed: [Row] = []
        var rows: [Row: HealthRowPhone] = [:]
        for host in hosts {
            for row in host.report?.rows ?? [] {
                let twin = row.shared == true && row.fix == nil && placed.contains { other in
                    guard let held = rows[other] else { return false }
                    return held.shared == true && held.id == row.id && held.state == row.state && held.line == row.line && held.group == row.group
                }
                if twin { continue }
                let one = Row(id: "\(host.id)\u{0}\(row.id)", hostId: host.id, hostName: host.name, title: row.title, line: row.line, state: row.state, until: row.until)
                placed.append(one)
                rows[one] = row
            }
        }
        var groups: [String] = []
        var byGroup: [String: [Row]] = [:]
        for one in placed {
            guard let row = rows[one] else { continue }
            var shown = one
            // A title two hosts both give is told apart by its host, and only then.
            if placed.contains(where: { $0.hostId != one.hostId && rows[$0]?.group == row.group && $0.title == one.title }) {
                shown.title = "\(one.title) on \(one.hostName)"
            }
            if byGroup[row.group] == nil { groups.append(row.group) }
            byGroup[row.group, default: []].append(shown)
        }
        let rank = { (group: String) in groupOrder.firstIndex(of: group) ?? groupOrder.count }
        return groups.enumerated()
            .sorted { rank($0.element) != rank($1.element) ? rank($0.element) < rank($1.element) : $0.offset < $1.offset }
            .map { Section(group: $0.element, rows: byGroup[$0.element] ?? []) }
    }

    /// Whether the Work list's foot shows Connections: a row that is not working, or a known end inside the first
    /// notice's days.
    public static func needsHim(_ hosts: [Host], now: Date = Date()) -> Bool {
        hosts.contains { host in
            (host.report?.rows ?? []).contains { $0.state != .working }
                || host.lapses.contains { $0.until / 1000 - now.timeIntervalSince1970 <= lapseNoticeDays * 86_400 }
        }
    }

    /// The ends inside the first notice's days, soonest first, each with its host.
    /// `key` is the host's id and the lapse's together: two hosts may name the same lapse.
    public static func ending(_ hosts: [Host], now: Date = Date()) -> [(key: String, host: Host, lapse: LapsePhone)] {
        hosts.flatMap { host in host.lapses.map { (key: "\(host.id)\u{0}\($0.id)", host: host, lapse: $0) } }
            .filter { $0.lapse.until / 1000 - now.timeIntervalSince1970 <= lapseNoticeDays * 86_400 }
            .sorted { $0.lapse.until < $1.lapse.until }
    }

    public static func word(_ state: HealthRowPhone.State) -> String {
        switch state {
        case .working: "Ready"
        case .needsYou: "Needs you"
        case .broken, .unknown: "Broken"
        }
    }

    /// Whether a row offers "Open on <computer>": one that does not work.
    public static func reveals(_ row: Row) -> Bool { row.state != .working }

    /// "Ends today, 3:10 PM", "Ends tomorrow, 1:22 AM", "Ends Feb 17, 1:22 AM", "Ended Feb 17" (`lapseLine`).
    public static func lapseLine(until: Double, now: Date = Date(), calendar: Calendar = .current) -> String {
        let end = Date(timeIntervalSince1970: until / 1000)
        let date = end.formatted(.dateTime.month(.abbreviated).day())
        if end <= now { return "Ended \(date)" }
        let time = end.formatted(date: .omitted, time: .shortened)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: end)).day ?? 0
        if days == 0 { return "Ends today, \(time)" }
        if days == 1 { return "Ends tomorrow, \(time)" }
        return "Ends \(date), \(time)"
    }
}

// MARK: - The Windows VM

/// The Windows VM on the Computers page: its state in a few words, and the one press it offers.
public enum WinvmWords {
    public enum Press: Hashable, Sendable { case wake, sleep }

    /// Whether the page shows the VM at all: one this host keeps and can run.
    public static func shows(_ state: WinvmStatePhone?) -> Bool {
        guard let state, state.cannot == nil else { return false }
        if case .none = state.state { return false }
        return true
    }

    public static func line(_ state: WinvmStatePhone) -> String {
        switch state.state {
        case .none: return "Not set up"
        case .settingUp: return state.step ?? "Setting up"
        case .asleep: return state.heldAsleep == true ? "Asleep until you wake it" : "Asleep"
        case .waking: return state.step ?? "Waking"
        case .awake: return "Awake"
        case .goingToSleep: return "Going to sleep"
        case .unknown(let raw): return raw.capitalized
        }
    }

    /// Wake while it sleeps, Sleep while it is awake; nothing while it moves between the two.
    public static func press(_ state: WinvmStatePhone) -> Press? {
        switch state.state {
        case .asleep: .wake
        case .awake: .sleep
        default: nil
        }
    }

    /// Whether it is on its way somewhere: the row shows its spinner.
    public static func moving(_ state: WinvmStatePhone) -> Bool {
        switch state.state {
        case .waking, .goingToSleep, .settingUp: true
        default: false
        }
    }
}

// MARK: - A dashboard's sources, a project's documents

/// Where a dashboard's numbers open on the phone: a LifeOS sheet in the hosted editor, a Microsoft form's answers on
/// its answers page (a dashboard reads the forms its own host keeps, so the page asks that host). A sheet kept as a
/// file on a host has no place on the phone, so its block opens nothing.
public enum DashSource: Equatable, Sendable {
    case lifeosSheet(id: String, title: String)
    case msform(workspaceId: String, formId: String)

    public static func of(_ from: DashFromPhone?) -> DashSource? {
        switch from?.sheet {
        case .lifeos(let sheet)?: return .lifeosSheet(id: sheet.id, title: from?.sheetTitle ?? "Sheet")
        case .msform(let form)?: return .msform(workspaceId: form.workspaceId, formId: form.formId)
        default: return nil
        }
    }

    /// The block's source: the first figure's that opens, for a row of figures.
    public static func of(_ block: DashBlockPhone) -> DashSource? {
        switch block {
        case .figures(let figures): return figures.figures.lazy.compactMap { of($0.from) }.first
        case .chart(let chart): return of(chart.from)
        case .table(let table): return of(table.from)
        default: return nil
        }
    }
}

/// A LifeOS document or sheet opened in the hosted editor outside a thread (a project's file, a dashboard's sheet):
/// an item with no thread of its own, so the reader page draws it as a thread's LifeOS item (`ItemBody.hosted`).
public enum LifeDocItem {
    public enum Kind: Sendable { case document, sheet }

    public static func item(_ kind: Kind, id: String, title: String, workspaceId: String) -> CanvasItem {
        let table: LifeosSource.Table = kind == .sheet ? .sheets : .docs
        return CanvasItem(
            id: "lifeos:\(table.rawValue):\(id)", sessionId: "", workspaceId: workspaceId, kind: kind == .sheet ? .sheet : .document,
            title: title, source: .lifeos(LifeosSource(table: table, id: id)), state: .open, position: 0, rev: 0, createdAt: 0, updatedAt: 0
        )
    }
}
