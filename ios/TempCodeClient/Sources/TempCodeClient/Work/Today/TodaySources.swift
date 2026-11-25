import Foundation
import TempCodeContract

/// Each of Today's sources as a pure function from plain inputs to rows and marks: the desktop's
/// work/today/{held,meetings,due,waiting}.ts and work/<pillar>/today.ts with no hook. The inputs decode the JSON
/// the desktop reads (LifeOS's rows, the hosts' answers), so the fixtures and the next agent's reads share them.
public enum TodaySources {
    // MARK: - sections

    public static let held = TodaySection(id: "held", title: "Waiting on you", order: 10, empty: "Nothing waits on your press", fold: 5, bones: .lines)
    public static let meetings = TodaySection(id: "meetings", title: "Meetings", order: 20, empty: "No meetings today", lifeos: true, bones: .lines)
    public static let due = TodaySection(id: "due", title: "Due", order: 30, empty: "Nothing due today", fold: 7, lifeos: true, bones: .tick)
    public static let waiting = TodaySection(id: "waiting", title: "Waiting on others", order: 40, empty: "No one owes you a reply", fold: 5, lifeos: true, bones: .lines)
    public static let messages = TodaySection(id: "messages", title: "Messages", order: 45, empty: "No one is waiting on a reply", fold: 5, lifeos: true)
    public static let money = TodaySection(id: "money", title: "Owed", order: 60, empty: "", fold: 5)
    public static let responses = TodaySection(id: "msforms", title: "Responses", order: 70, empty: "", fold: 5)

    /// Each source's own section, by id; nil for those that add rows or marks to another.
    public static func section(of source: String) -> TodaySection? {
        ["held": held, "meetings": meetings, "due": due, "waiting": waiting, "messages": messages, "money": money, "msforms": responses][source]
    }

    // MARK: - Waiting on you (today/held.ts)

    /// A held item and the host that holds it.
    public struct HeldItem: Hashable, Sendable, Decodable {
        public var environmentId: String
        public var item: OutboxItem

        public init(environmentId: String, item: OutboxItem) {
            self.environmentId = environmentId
            self.item = item
        }

        enum CodingKeys: String, CodingKey { case environmentId }
        /// The desktop's `HostItem`: the item's own fields with its host beside them.
        public init(from decoder: any Decoder) throws {
            environmentId = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .environmentId)
            item = try OutboxItem(from: decoder)
        }
    }

    /// The Outbox's one count: master's rule, `OutboxModel.needsHim`, and no copy of it here.
    public static func needsHim(_ item: OutboxItem) -> Bool {
        OutboxModel.needsHim(item)
    }

    /// A held ref's two parts as the desktop names them.
    static func refParts(_ ref: HeldRef) -> (at: String, id: String) {
        switch ref {
        case .host(let r): return ("host", r.id)
        case .lifeos(let r): return ("lifeos", r.id)
        case .unknown(let v):
            guard case .object(let o) = v else { return ("", "") }
            let text = { (key: String) -> String in if case .string(let s)? = o[key] { s } else { "" } }
            return (text("at"), text("id"))
        }
    }

    /// A held item's row key: the same on every surface that names it.
    public static func heldKey(environmentId: String, ref: HeldRef) -> String {
        let (at, id) = refParts(ref)
        return "held:\(environmentId):\(at):\(id)"
    }

    /// The place a held item is in: Work Chats for an item of no workspace, else its workspace's name.
    public static func placeOf(_ held: HeldItem, names: [TodayPlace: String]) -> String? {
        placeOf(environmentId: held.environmentId, workspaceId: held.item.workspaceId, names: names)
    }

    static func placeOf(environmentId: String, workspaceId: String?, names: [TodayPlace: String]) -> String? {
        guard let workspaceId, workspaceId != OutboxModel.workChatsKey else { return "Work Chats" }
        return names[TodayPlace(environmentId: environmentId, workspaceId: workspaceId)]
    }

    /// A held row's two lines (the desktop's `rowWords`): a change to a shared file leads with the file and its count
    /// of changes; a Google share with who and how; every other kind splits its summary at the first ": ".
    static func heldWords(_ item: OutboxItem) -> (act: String, about: String?) {
        if item.kind == .officeEdit || item.kind == .googleEdit, let changed = OutboxModel.kindHeading(kind: item.kind, payload: item.payload, sent: item.state == .sent) {
            let o: [String: JSONValue] = if case .object(let o)? = item.payload { o } else { [:] }
            let name: String? = if case .string(let s)? = o["name"] { s } else { nil }
            let lead = name.flatMap { item.summary.range(of: " in \($0): ") }
            let about = lead.map { String(item.summary[$0.upperBound...]) } ?? OutboxModel.splitSummary(item.summary).about
            let n: Int = if case .array(let edits)? = o["edits"] { edits.count } else { 1 }
            guard let about, n > 1 else { return (changed, about) }
            let first = about.replacingOccurrences(of: #" and \d+ more$"#, with: "", options: .regularExpression)
                .replacingOccurrences(of: #"^\d+ (boxes|places), "#, with: "", options: .regularExpression)
            return (changed, "\(n) changes: \(first)")
        }
        if let share = OutboxModel.shareWords(item) { return share }
        return OutboxModel.splitSummary(item.summary)
    }

    /// A thread's open request and the host it waits on, with the thread's title where the phone knows it.
    public struct HeldRequest: Hashable, Sendable, Decodable {
        public var environmentId: String
        public var request: OutboxRequest
        public var thread: String?

        public init(environmentId: String, request: OutboxRequest, thread: String? = nil) {
            self.environmentId = environmentId
            self.request = request
            self.thread = thread
        }

        enum CodingKeys: String, CodingKey { case environmentId, thread }
        /// The desktop's `HostRequest`: the request's own fields with its host beside them; `thread` is the fixture's.
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            environmentId = try c.decode(String.self, forKey: .environmentId)
            thread = try c.decodeIfPresent(String.self, forKey: .thread)
            request = try OutboxRequest(from: decoder)
        }
    }

    /// A request's row key: the desktop's `held:` + `requestKey`.
    public static func requestKey(_ r: HeldRequest) -> String { "held:request:\(r.environmentId):\(r.request.id)" }

    /// A request's one name (the desktop's `requestName`): what its rows do in one sentence, else the host's head.
    static func requestName(_ request: OutboxRequest) -> String {
        let rows = request.rows.filter { $0.item != nil }
        return rows.isEmpty ? request.head : RequestSheetModel.sentence(rows)
    }

    /// The held items as rows, oldest first: the act, what it is about, when it was held. Today adds no way to send.
    /// A thread's open request is one row, "Asked in" its thread, and the items it lists are not listed again.
    public static func heldRows(_ waiting: [HeldItem], requests: [HeldRequest] = [], now: Double, names: [TodayPlace: String], calendar: Calendar) -> [TodayRow] {
        let asked = OutboxModel.askedKeys(requests.map { OutboxModel.RequestEntry(environmentId: $0.environmentId, request: $0.request) })
        let askedRows = requests.map { held -> TodayRow in
            let request = held.request
            var row = TodayRow(key: requestKey(held), section: Self.held.id, sector: request.sector, title: requestName(request))
            row.job = placeOf(environmentId: held.environmentId, workspaceId: request.workspaceId, names: names)
            row.detail = held.thread.map { "Asked in \($0)" }
            row.at = Double(request.createdAt)
            row.when = TodayWords.heldWhen(Double(request.createdAt), now: now, calendar)
            row.lead = .glyph(.request)
            row.open = .request(environmentId: held.environmentId, requestId: request.id)
            return row
        }
        return askedRows + waiting.filter { needsHim($0.item) && !asked.contains("\($0.environmentId):\(OutboxModel.key($0.item.ref))") }.map { held in
            let item = held.item
            let (act, about) = heldWords(item)
            let detail: String? = switch item.state {
            case .failed: item.error ?? "Couldn't send"
            case .stale: "Out of date"
            default: about ?? item.account
            }
            var row = TodayRow(key: heldKey(environmentId: held.environmentId, ref: item.ref), section: Self.held.id, sector: item.sector, title: act)
            row.job = placeOf(held, names: names)
            row.detail = detail.flatMap { $0.isEmpty ? nil : $0 }
            row.detailLate = item.state == .failed || item.state == .stale
            row.at = Double(item.createdAt)
            row.when = TodayWords.heldWhen(Double(item.createdAt), now: now, calendar)
            row.lead = .glyph(.held(item.kind))
            row.open = .held(environmentId: held.environmentId, ref: item.ref)
            return row
        }
    }

    /// A host whose list did not come.
    public struct HostError: Hashable, Sendable, Decodable {
        public var environmentId: String
        public var error: String
        public init(environmentId: String, error: String) {
            self.environmentId = environmentId
            self.error = error
        }
    }

    /// The Outbox's store as Today's answer: still loading until its first list, each host that failed with Retry.
    public static func heldAnswer(_ waiting: [HeldItem], requests: [HeldRequest] = [], loaded: Bool, errors: [HostError], now: Double, names: [TodayPlace: String], calendar: Calendar) -> TodayAnswer {
        TodayAnswer(rows: heldRows(waiting, requests: requests, now: now, names: names, calendar: calendar), loading: !loaded, failed: hostFailures(errors))
    }

    /// What a Work host that has not linked on this launch answers for a list only its socket reads (the Outbox's,
    /// the digest's): no list, and "Not connected", as the desktop's closed link refuses at once. The page takes it
    /// out of its section and names the host at its foot (`TodayModel.apart`).
    public static let notConnected = "Not connected"

    static func hostFailures(_ errors: [HostError]) -> [TodayFailure] {
        errors.map { TodayFailure(environmentId: $0.environmentId, error: $0.error, retry: .host($0.environmentId)) }
    }

    // MARK: - LifeOS reads (today/lifeos.ts `answerOf`)

    /// A read some job needs that did not come back.
    public struct Lost: Hashable, Sendable, Decodable {
        public var environmentId: String
        public var sector: String?
        public var error: String
        public var down: TodayDown?
        /// The job's session on another host waits on that host's LifeOS, which said it is connecting.
        public var waits: Bool?
        public init(environmentId: String, sector: String?, error: String, down: TodayDown? = nil, waits: Bool = false) {
            self.environmentId = environmentId
            self.sector = sector
            self.error = error
            self.down = down
            self.waits = waits ? true : nil
        }
    }

    /// What a sector no session covers fails with.
    public static let notCovered = "No signed-in host can read this job"

    /// A LifeOS list's read, as plain facts: LifeOS refused the read itself (`error`), a read some job needs is still
    /// out (`pending`), the reads beside the first that failed (`lost`).
    public struct LifeosRead: Hashable, Sendable, Decodable {
        public var error: String?
        public var pending = false
        public var lost: [Lost] = []
        public init(error: String? = nil, pending: Bool = false, lost: [Lost] = []) {
            self.error = error
            self.pending = pending
            self.lost = lost
        }
        enum CodingKeys: String, CodingKey { case error, pending, lost }
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            error = try c.decodeIfPresent(String.self, forKey: .error)
            pending = try c.decodeIfPresent(Bool.self, forKey: .pending) ?? false
            lost = try c.decodeIfPresent([Lost].self, forKey: .lost) ?? []
        }
    }

    /// What a LifeOS section answers from its read (`rows` nil: still to build). `sessionDown`: the page's one line
    /// says it, never the section. `what` is "meetings", "tasks", "mail".
    public static func lifeosAnswer(_ read: LifeosRead, rows: [TodayRow]?, sessionDown: Bool, host: String, what: String, note: String? = nil, jobs: TodayJobs) -> TodayAnswer {
        func failure(_ lost: Lost) -> TodayFailure {
            let job = lost.sector.flatMap { jobs.of($0)?.name }
            let of = "\(job.map { "\($0)'s " } ?? "")\(what)"
            if lost.error == notCovered { return TodayFailure(environmentId: lost.environmentId, error: lost.error, said: "No signed-in host can read \(of)") }
            // A wait on that host's LifeOS: said once for the page with what it left out, and no press.
            if lost.waits == true {
                return TodayFailure(environmentId: lost.environmentId, error: lost.error, said: "\(of.prefix(1).uppercased())\(of.dropFirst()) left out", left: .init(job: job, what: what), sector: lost.sector, waits: true)
            }
            let retry = TodayRetry.lost(environmentId: lost.environmentId, sector: lost.sector, down: lost.down != nil)
            if let down = lost.down {
                return TodayFailure(environmentId: lost.environmentId, error: lost.error, said: "\(of.prefix(1).uppercased())\(of.dropFirst()) left out", down: down, left: .init(job: job, what: what), sector: lost.sector, retry: retry)
            }
            return TodayFailure(environmentId: lost.environmentId, error: lost.error, said: "LifeOS could not read \(of)", retry: retry)
        }
        if let error = read.error, !sessionDown {
            return TodayAnswer(rows: [], failed: [TodayFailure(environmentId: host, error: error, said: "LifeOS could not read \(what)", retry: .lifeos(what: what))])
        }
        guard let rows else { return TodayAnswer(loading: true) }
        return TodayAnswer(rows: rows, loading: read.pending, failed: read.lost.map(failure), note: note)
    }

    // MARK: - Meetings (today/meetings.ts)

    /// An event as LifeOS's `events:range` answers it.
    public struct Event: Hashable, Sendable, Decodable {
        public struct Travel: Hashable, Sendable, Decodable { public var departedAt: Double? }
        public struct Attendee: Hashable, Sendable, Decodable { public var address: String }
        public var id: String
        public var title: String
        public var sector: String
        public var startsAt: Double
        public var endsAt: Double?
        public var allDay: Bool
        public var hidden: Bool?
        public var location: String?
        public var leaveAt: Double?
        public var travel: Travel?
        public var attendees: [Attendee]?

        enum CodingKeys: String, CodingKey {
            case id = "_id"
            case title, sector, startsAt, endsAt, allDay, hidden, location, leaveAt, travel, attendees
        }

        public init(id: String, title: String, sector: String, startsAt: Double, endsAt: Double? = nil, allDay: Bool = false, location: String? = nil, leaveAt: Double? = nil) {
            self.id = id
            self.title = title
            self.sector = sector
            self.startsAt = startsAt
            self.endsAt = endsAt
            self.allDay = allDay
            self.location = location
            self.leaveAt = leaveAt
        }
    }

    /// One of a sector's people (`people:directory`).
    public struct Person: Hashable, Sendable, Decodable {
        public var name: String
        public var emails: [String]
        public init(name: String, emails: [String]) {
            self.name = name
            self.emails = emails
        }
    }

    public static func eventKey(_ id: String) -> String { "event:\(id)" }
    static let hour = 3_600_000.0

    /// When an event stops taking time; an all-day event with no end runs to the next midnight.
    static func endOf(_ e: Event, _ calendar: Calendar) -> Double {
        if let end = e.endsAt { return max(end, e.startsAt) }
        return e.allDay ? TodayModel.dayAfter(e.startsAt, 1, calendar: calendar) : e.startsAt
    }

    /// The days in [from, to) that hold events, each with every event that takes part of it: all-day first, then by
    /// start, longer first on ties (work-kit's `groupByDay`).
    static func groupByDay(_ events: [Event], from: Double, to: Double, _ calendar: Calendar) -> [(day: Double, events: [Event])] {
        var out: [(day: Double, events: [Event])] = []
        var day = TodayModel.ms(calendar.startOfDay(for: TodayModel.date(from)))
        while day < to {
            let next = TodayModel.dayAfter(day, 1, calendar: calendar)
            let held = events.enumerated().filter { _, e in
                let end = endOf(e, calendar)
                return e.startsAt < next && (end > day || (end == e.startsAt && e.startsAt >= day))
            }.sorted { a, b in
                if a.element.allDay != b.element.allDay { return a.element.allDay }
                if a.element.startsAt != b.element.startsAt { return a.element.startsAt < b.element.startsAt }
                let ea = endOf(a.element, calendar), eb = endOf(b.element, calendar)
                return ea != eb ? ea > eb : a.offset < b.offset
            }.map(\.element)
            if !held.isEmpty { out.append((day, held)) }
            day = next
        }
        return out
    }

    /// The one live line under a meeting's time: "Leave 5:10 PM" while that is ahead, then "in 25 min" within the
    /// hour, then "Now" while it runs; nothing for an all-day event or one that is over.
    public static func liveLine(_ e: Event, now: Double, _ calendar: Calendar) -> String? {
        let leave = e.allDay || e.startsAt <= now || e.travel?.departedAt != nil ? nil : e.leaveAt
        if let leave, leave > now { return "Leave \(TodayWords.clock(leave, calendar))" }
        if e.allDay { return nil }
        if e.startsAt > now { return e.startsAt - now <= hour ? "in \(max(1, Int(((e.startsAt - now) / 60_000).rounded(.up)))) min" : nil }
        return endOf(e, calendar) > now ? "Now" : nil
    }

    /// Where it is and who of the job's people is there: "CoRec 2212, with Dana Reyes".
    public static func placeAndPeople(_ e: Event, _ people: [Person]) -> String? {
        var byAddress: [String: Int] = [:]
        for (i, p) in people.enumerated() { for email in p.emails { byAddress[email.lowercased()] = i } }
        var met: [Int] = []
        for a in e.attendees ?? [] {
            if let i = byAddress[a.address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()], !met.contains(i) { met.append(i) }
        }
        let names = met.isEmpty ? nil : met.prefix(3).map { people[$0].name }.joined(separator: ", ") + (met.count > 3 ? ", and \(met.count - 3) more" : "")
        if let location = e.location, !location.isEmpty, let names { return "\(location), with \(names)" }
        return e.location ?? names.map { "With \($0)" }
    }

    /// Today's meetings as rows, and the line for when they are all over. A sector with no job is left out.
    public static func meetingRows(_ events: [Event], day: (from: Double, to: Double), now: Double, jobs: TodayJobs, people: [String: [Person]], calendar: Calendar) -> (rows: [TodayRow], note: String?) {
        let mine = events.filter { $0.hidden != true && jobs.of($0.sector) != nil }
        let days = groupByDay(mine, from: day.from, to: TodayModel.dayAfter(day.from, 2, calendar: calendar), calendar)
        let today = days.first { $0.day == day.from }?.events ?? []
        let rows = today.enumerated().map { at, e -> TodayRow in
            let workspace = jobs.of(e.sector)!
            let past = endOf(e, calendar) < now
            var row = TodayRow(key: eventKey(e.id), section: meetings.id, sector: e.sector, title: e.title)
            row.detail = placeAndPeople(e, people[e.sector] ?? []).flatMap { $0.isEmpty ? nil : $0 }
            row.at = Double(at)
            row.when = e.allDay ? "All day" : TodayWords.clock(e.startsAt, calendar)
            row.whenLine = past ? nil : liveLine(e, now: now, calendar)
            row.past = past
            row.workspace = workspace.place
            row.open = .event(workspace.place, eventId: e.id)
            if !past { row.acts = [TodayAct("Prepare", .prepare(workspace.place, eventId: e.id))] }
            return row
        }
        guard !rows.isEmpty, rows.allSatisfy(\.past) else { return (rows, nil) }
        let tomorrow = TodayModel.dayAfter(day.from, 1, calendar: calendar)
        guard let next = days.first(where: { $0.day == tomorrow })?.events.first(where: { !$0.allDay }) else { return (rows, nil) }
        return (rows, "Tomorrow starts at \(TodayWords.clock(next.startsAt, calendar)) with \(next.title).")
    }

    // MARK: - Due (today/due.ts)

    /// A task as LifeOS's `tasks:list` answers it.
    public struct Task: Hashable, Sendable, Decodable {
        public var id: String
        public var title: String
        public var sector: String
        public var status: String
        public var priority: String?
        public var dueAt: Double?
        public var pinned: Bool?
        /// The LifeOS project it is filed under.
        public var projectId: String?
        enum CodingKeys: String, CodingKey {
            case id = "_id"
            case title, sector, status, priority, dueAt, pinned, projectId
        }
        public init(id: String, title: String, sector: String, status: String = "open", dueAt: Double? = nil, pinned: Bool? = nil, projectId: String? = nil) {
            self.id = id
            self.title = title
            self.sector = sector
            self.status = status
            self.dueAt = dueAt
            self.pinned = pinned
            self.projectId = projectId
        }
    }

    /// A LifeOS project as `projects:list` answers it: the name a Due row's second line says.
    public struct Project: Hashable, Sendable, Decodable {
        public var id: String
        public var name: String
        public var sector: String?
        enum CodingKeys: String, CodingKey {
            case id = "_id"
            case name, sector
        }
        public init(id: String, name: String, sector: String? = nil) {
            self.id = id
            self.name = name
            self.sector = sector
        }
    }

    /// The names a Due row's project is said by (the desktop's `projectRead`): nil `rows` while out, the sectors
    /// whose names came whole (nil: every one), and whether a read of them failed.
    public struct ProjectNames: Hashable, Sendable, Decodable {
        public var rows: [Project]?
        public var known: [String]?
        public var failed: Bool?
        public init(rows: [Project]?, known: [String]? = nil, failed: Bool = false) {
            self.rows = rows
            self.known = known
            self.failed = failed
        }
    }

    /// A task's project as its row knows it (the desktop's `projectOfTask`): by name once LifeOS lists it, none once
    /// its job's names came whole without it, and by its id alone while that job's names are out or failed, so Open
    /// project still opens it.
    public static func projectOf(_ task: Task, _ names: ProjectNames) -> Project? {
        guard let id = task.projectId else { return nil }
        if let named = names.rows?.first(where: { $0.id == id }) { return named }
        let known = names.rows != nil && (names.known.map { $0.contains(task.sector) } ?? true)
        return known ? nil : Project(id: id, name: "")
    }

    /// The sectors whose project names came whole (the desktop's `known`, lifeos.ts). With the whole session's names in
    /// and its cover known: every job's sector but those still unsure (one a narrowed session reads whose names are
    /// out or failed, one nothing covers). Else, with the cover still out or no whole session, only the narrowed
    /// sessions' sectors whose own names came. A known sector without the task's project says no project.
    public static func namesKnown(whole: Bool, cover: TodayCover?, jobs: [String], unsure: Set<String>, came: Set<String>) -> [String] {
        if whole, cover != nil { return Set(jobs).subtracting(unsure).sorted() }
        return came.subtracting(unsure).sorted()
    }

    /// The one quiet line when a job's names failed and a row shows its project by Open project alone.
    public static let namesLost = "Project names did not load"

    public static func namesNote(_ names: ProjectNames?, rows: [TodayRow]?) -> String? {
        guard names?.failed == true, rows?.contains(where: { $0.detail == nil && $0.acts.contains { $0.label == "Open project" } }) == true else { return nil }
        return namesLost
    }

    public static func taskKey(_ id: String) -> String { "task:\(id)" }

    /// work-kit's Today group: pinned, or due before the next local midnight.
    public static func isTodayTask(_ task: Task, now: Double, _ calendar: Calendar) -> Bool {
        if task.pinned == true { return true }
        guard let due = task.dueAt else { return false }
        return due < TodayModel.dayAfter(now, 1, calendar: calendar)
    }

    /// Today's tasks as rows: the most overdue first, then today's by time, then the pinned with no date. The tick
    /// completes through the job's host; Tomorrow snoozes to the next morning. With `names`, a task of a LifeOS project
    /// names it on the second line and adds Open project, which opens it by id even while the names are out.
    public static func dueRows(_ tasks: [Task], now: Double, jobs: TodayJobs, names: ProjectNames? = nil, calendar: Calendar) -> [TodayRow] {
        tasks.filter { isTodayTask($0, now: now, calendar) && jobs.of($0.sector) != nil }.map { task in
            let workspace = jobs.of(task.sector)!
            var row = TodayRow(key: taskKey(task.id), section: due.id, sector: task.sector, title: task.title)
            if let dueAt = task.dueAt {
                row.at = dueAt
                row.when = TodayWords.due(dueAt, now: now, calendar)
                row.late = dueAt < now
            }
            row.workspace = workspace.place
            row.lead = .tick(label: "Mark \(task.title) done")
            row.open = .task(workspace.place, sector: task.sector, taskId: task.id)
            row.acts = [TodayAct("Tomorrow", .tomorrow(sector: task.sector, taskId: task.id))]
            if let names, let project = projectOf(task, names) {
                if !project.name.isEmpty { row.detail = project.name }
                row.acts.append(TodayAct("Open project", .openProject(sector: task.sector, projectId: project.id)))
            }
            return row
        }
    }

    /// The session a LifeOS row's verbs go through (the desktop's `sessionOf`): the one that read it, as the row was
    /// stamped when it was built (`suppliedBy`, `suppliedScope`): the supplier's own job session for a narrowed read,
    /// else its whole session. The verb's check, its write and its Undo all name this one session, never another
    /// host's in host order and never a scope read later. Nil for a row with no supplier (a chat, an older kept row),
    /// which goes by its sector.
    public static func sessionOf(_ row: TodayRow) -> (environmentId: String, sector: String?)? {
        guard let supplier = row.suppliedBy else { return nil }
        return (supplier, row.suppliedScope)
    }

    /// The tick's press for a Due row.
    public static func tick(_ row: TodayRow) -> TodayPress? {
        guard case .task(_, let sector, let taskId)? = row.open, case .tick? = row.lead else { return nil }
        return .done(sector: sector, taskId: taskId)
    }

    // MARK: - Waiting on others (today/waiting.ts)

    /// A mail no one answered, as LifeOS's `mailWaits:list` pages it.
    public struct Wait: Hashable, Sendable, Decodable {
        public struct Address: Hashable, Sendable, Decodable {
            public var name: String?
            public var address: String
            public init(name: String? = nil, address: String) {
                self.name = name
                self.address = address
            }
        }
        public struct Waiting: Hashable, Sendable, Decodable {
            public var since: Double
            public var dueAt: Double
            public var asked: Bool
            public var to: [Address]
        }
        public var id: String
        public var subject: String
        public var sector: String?
        public var ownSector: String?
        public var waiting: Waiting
        enum CodingKeys: String, CodingKey {
            case id = "_id"
            case subject, sector, ownSector, waiting
        }
    }

    public static func mailKey(_ id: String) -> String { "mail:\(id)" }

    /// The waits as rows: whom he wrote to, the subject, how long he has waited. A sector with no job is left out.
    public static func waitingRows(_ waits: [Wait], today: Double, jobs: TodayJobs, calendar: Calendar) -> [TodayRow] {
        waits.compactMap { wait in
            guard let sector = wait.sector ?? wait.ownSector, let workspace = jobs.of(sector) else { return nil }
            var row = TodayRow(key: mailKey(wait.id), section: waiting.id, sector: sector, title: TodayWords.waitingWho(wait.waiting.to))
            row.detail = wait.subject.isEmpty ? nil : wait.subject
            row.at = wait.waiting.since
            row.when = TodayWords.waitedFor(wait.waiting.since, today: today, calendar)
            row.workspace = workspace.place
            row.open = .mail(workspace.place, threadId: wait.id)
            row.acts = [TodayAct("Nudge", .nudge(workspace.place, threadId: wait.id)), TodayAct("Dismiss", .dismiss(sector: sector, threadId: wait.id, since: wait.waiting.since))]
            return row
        }
    }

    /// Past the fifth page LifeOS still says there is more: the section never says no one owes him (`away`).
    public static func waitingAnswer(_ answer: TodayAnswer, beyond: Bool) -> TodayAnswer {
        guard beyond, answer.rows != nil else { return answer }
        var out = answer
        out.away = true
        return out
    }

    // MARK: - each job's answer

    /// One job's answer to a read on hosts.
    public struct JobAnswer<Value: Hashable & Sendable>: Hashable, Sendable {
        public var workspace: TodayWorkspace
        public var value: Value
        public init(_ workspace: TodayWorkspace, _ value: Value) {
            self.workspace = workspace
            self.value = value
        }
    }

    // MARK: - Messages (messages/today.ts)

    /// A conversation that waits on his answer (`work.messages.unanswered`).
    public struct Chat: Hashable, Sendable, Decodable {
        public var chatId: String
        public var chat: String
        public var who: String
        public var text: String
        public var at: Double
        public init(chatId: String, chat: String, who: String, text: String, at: Double) {
            self.chatId = chatId
            self.chat = chat
            self.who = who
            self.text = text
            self.at = at
        }
    }

    public static func chatKey(_ chatId: String, at: Double) -> String { "chat:\(chatId):\(Int(at))" }

    /// The waiting conversations as rows, newest first. One row a conversation: where two hosts answer it at two last
    /// messages, the newest. `readTo`: how far he read each chat from Today, so an older copy makes no row.
    public static func chatRows(_ answers: [JobAnswer<[Chat]>], now: Double, readTo: [String: Double] = [:], calendar: Calendar) -> [TodayRow] {
        var order: [String] = []
        var newest: [String: (TodayWorkspace, Chat)] = [:]
        for answer in answers {
            for chat in answer.value where chat.at > (readTo[chat.chatId] ?? -.infinity) {
                if let had = newest[chat.chatId] {
                    if chat.at > had.1.at { newest[chat.chatId] = (answer.workspace, chat) }
                } else {
                    order.append(chat.chatId)
                    newest[chat.chatId] = (answer.workspace, chat)
                }
            }
        }
        let rows = order.compactMap { newest[$0] }.map { workspace, chat -> TodayRow in
            var row = TodayRow(key: chatKey(chat.chatId, at: chat.at), section: messages.id, sector: workspace.sector, title: !chat.who.isEmpty && chat.who != chat.chat ? "\(chat.who) in \(chat.chat)" : chat.chat)
            row.job = workspace.name
            row.detail = chat.text.isEmpty ? nil : chat.text
            row.at = -chat.at
            row.when = TodayWords.chatTime(chat.at, now: now, calendar)
            row.lead = .glyph(.chat)
            row.open = .chat(workspace.place, chatId: chat.chatId)
            row.acts = [TodayAct("Mark read", .markRead(chatId: chat.chatId, at: chat.at))]
            return row
        }
        return rows.enumerated().sorted { ($0.element.at ?? 0, $0.offset) < ($1.element.at ?? 0, $1.offset) }.map(\.element)
    }

    // MARK: - Owed (money/today.ts)

    /// A job's `work.money.owed`.
    public struct Owed: Hashable, Sendable, Decodable {
        public struct Row: Hashable, Sendable, Decodable {
            public var row: Int
            public var who: String
            public var what: String
            public var amount: Double
            public var since: String?
            public var way: String
            public var reimburse: Bool
        }
        public var rows: [Row]
        public var problems: [String]?
    }

    /// What is owed, each open row of every job's ledger, and a job whose ledger cannot be read. `today` is the local
    /// day ("2026-11-24").
    public static func owedRows(_ answers: [JobAnswer<Owed>], today: String, calendar: Calendar) -> [TodayRow] {
        answers.flatMap { answer -> [TodayRow] in
            let w = answer.workspace
            let problems = (answer.value.problems ?? []).map { _ -> TodayRow in
                var row = TodayRow(key: "money:\(w.environmentId):\(w.workspaceId):problem", section: money.id, sector: w.sector, title: "What is owed is not known")
                row.job = w.name
                row.detail = "The ledger could not be read"
                row.open = .money(w.place)
                return row
            }
            let owed = answer.value.rows.map { r -> TodayRow in
                let title = r.reimburse ? [r.what, r.who].first { !$0.isEmpty } ?? "Entry" : (r.who.isEmpty ? "Entry" : r.who)
                var row = TodayRow(key: "money:\(w.environmentId):\(w.workspaceId):\(r.row):\(r.way)", section: money.id, sector: w.sector, title: title)
                row.job = w.name
                row.detail = "\(r.reimburse ? "To be paid back" : r.way == "toHim" ? "Owes you" : "You owe") \(TodayWords.money(r.amount))"
                row.at = r.since.flatMap { TodayWords.localNoon($0, calendar) }
                row.when = TodayWords.since(r.since, today: today)
                row.open = .money(w.place)
                return row
            }
            return problems + owed
        }
    }

    // MARK: - Responses (msforms/today.ts)

    /// A Microsoft form as `work.msforms.list` answers it, the parts Today reads.
    public struct Form: Hashable, Sendable, Decodable {
        public var formId: String
        public var tenant: String
        public var title: String
        public var unseen: Int
        public var lastAnswerAt: Double?
    }

    /// One row a form with answers he has not seen: counts and titles alone, no answer and no name.
    public static func responseRows(_ answers: [JobAnswer<[Form]>]) -> [TodayRow] {
        answers.flatMap { answer in
            answer.value.filter { $0.unseen > 0 }.map { f in
                let w = answer.workspace
                var row = TodayRow(key: "msforms:\(w.environmentId):\(w.workspaceId):\(f.formId)", section: responses.id, sector: w.sector, title: f.title)
                row.job = w.name
                row.detail = "\(f.unseen) new \(f.unseen == 1 ? "response" : "responses")"
                row.at = f.lastAnswerAt
                row.open = .form(w.place, formId: f.formId, tenant: f.tenant)
                return row
            }
        }
    }

    // MARK: - clashes (clashes/today.ts): marks on meetings

    /// LifeOS's `clashes:range`.
    public struct ClashRange: Hashable, Sendable, Decodable {
        public var clashes: [TodayClash]
        public var leaves: [TodayLeave]
        public init(clashes: [TodayClash], leaves: [TodayLeave]) {
            self.clashes = clashes
            self.leaves = leaves
        }
    }

    /// The marks at `now`: each clashing event's line in its own words with Resolve, and the leave-by of an event he
    /// drives to as its live line until the drive would have him there. `host` is the session's.
    public static func clashMarks(_ range: ClashRange, workspaces: [TodayWorkspace], host: String, day: Double, now: Double, calendar: Calendar) -> [TodayMark] {
        var byEvent: [(id: String, clashes: [TodayClash])] = []
        for clash in range.clashes {
            for side in [clash.a, clash.b] {
                if let i = byEvent.firstIndex(where: { $0.id == side.eventId }) { byEvent[i].clashes.append(clash) } else { byEvent.append((side.eventId, [clash])) }
            }
        }
        var marks: [TodayMark] = []
        let label = { (sector: String) in workspaces.first { $0.sector == sector }?.name ?? TodayWords.sectorName(sector) }
        for (eventId, list) in byEvent {
            // Still his to settle: until the later event is over, and while this event is not.
            let live = list.filter { $0.b.endsAt > now && ($0.a.eventId == eventId ? $0.a : $0.b).endsAt > now }
            guard let first = live.first else { continue }
            var mark = TodayMark(key: eventKey(eventId))
            mark.note = TodayWords.clashLine(first, eventId: eventId, on: day, label: label, calendar) + (live.count > 1 ? ", and \(live.count - 1) more" : "")
            mark.late = true
            mark.act = TodayAct("Resolve", .resolve(environmentId: host, clashId: first.id))
            marks.append(mark)
        }
        // One leave an event, the last LifeOS gave, in the place of its first.
        var leaves: [(id: String, leave: TodayLeave)] = []
        for leave in range.leaves {
            if let i = leaves.firstIndex(where: { $0.id == leave.eventId }) { leaves[i].leave = leave } else { leaves.append((leave.eventId, leave)) }
        }
        for (eventId, leave) in leaves where now < leave.leaveAt + (leave.minutes ?? 0) * 60_000 {
            if let i = marks.firstIndex(where: { $0.key == eventKey(eventId) }) {
                marks[i].whenLine = TodayWords.leaveLine(leave, calendar)
            } else {
                var mark = TodayMark(key: eventKey(eventId))
                mark.whenLine = TodayWords.leaveLine(leave, calendar)
                marks.append(mark)
            }
        }
        return marks
    }

    /// The clashes source's answer: still to answer while the read is out; a read LifeOS refused is one line under
    /// Also ("LifeOS could not read clashes"), and nothing while the session is down (the page's one line says it).
    public static func clashAnswer(_ range: ClashRange?, loading: Bool, error: String?, sessionDown: Bool, workspaces: [TodayWorkspace], host: String, day: Double, now: Double, calendar: Calendar) -> TodayAnswer {
        if loading { return TodayAnswer(loading: true) }
        if let error {
            return sessionDown ? TodayAnswer() : TodayAnswer(failed: [TodayFailure(environmentId: host, error: error, said: "LifeOS could not read clashes")])
        }
        return TodayAnswer(marks: clashMarks(range ?? ClashRange(clashes: [], leaves: []), workspaces: workspaces, host: host, day: day, now: now, calendar: calendar))
    }

    // MARK: - prep (prep/today.ts): marks on meetings

    /// One of `work.prep.upcoming`'s meetings.
    public struct PrepMeeting: Hashable, Sendable, Decodable {
        public var workspaceId: String
        public var eventId: String
        public var state: String
    }

    /// A press opens the meeting's page in its job; the row says "Prep is ready" once a brief stands. A host answers
    /// every job of its own, so a meeting is taken from its own job's answer alone.
    public static func prepMarks(_ answers: [JobAnswer<[PrepMeeting]>]) -> [TodayMark] {
        var marks: [TodayMark] = []
        for answer in answers {
            for meeting in answer.value where meeting.workspaceId == answer.workspace.workspaceId {
                var mark = TodayMark(key: eventKey(meeting.eventId))
                if meeting.state == "briefed" { mark.note = "Prep is ready" }
                mark.open = .prep(answer.workspace.place, eventId: meeting.eventId)
                if let i = marks.firstIndex(where: { $0.key == mark.key }) { marks[i] = mark } else { marks.append(mark) }
            }
        }
        return marks
    }

    // MARK: - the review (review/today.ts)

    /// `work.review.ready`'s answer.
    public struct ReviewReady: Hashable, Sendable, Decodable {
        public var from: Double
        public var madeAt: Double
    }

    /// One row under Also while a review waits unopened; the key is the digest's, so the two never show it twice.
    public static func reviewRow(_ ready: ReviewReady, now: Double, calendar: Calendar) -> TodayRow {
        let week = TodayWords.weekNamed(ready.from, calendar)
        var row = TodayRow(key: "review:\(Int(ready.from))", section: TodayModel.also.id, sector: nil, title: TodayWords.readyTitle(week.from, now: now, calendar))
        row.detail = TodayWords.weekWords(week.from, calendar)
        row.at = ready.madeAt
        row.open = .review(week: ready.from)
        return row
    }

    /// The review's answer from each linked host with a job: the newest week wins; until every host asked has
    /// answered, a review may yet be waiting. `now` is the day's first moment, as the desktop passes it.
    public static func reviewAnswer(asked: [String], answered: [String: ReviewReady?], now: Double, calendar: Calendar) -> TodayAnswer {
        let newest = answered.values.compactMap { $0 }.max { $0.from < $1.from }
        let out = asked.contains { answered[$0] == nil }
        return TodayAnswer(rows: newest.map { [reviewRow($0, now: now, calendar: calendar)] } ?? [], loading: out)
    }

    // MARK: - the digest (digest/today.ts): rows under Also

    /// The groups no section of Today reads, and the kinds besides.
    public static let alsoGroups: Set<String> = ["results", "ending", "system"]
    public static let alsoKinds: Set<String> = ["docs.guest", "guests.edited", "guests.opened"]

    /// Today's rows of the digest: what was in today's digest and what was told since, in the groups Today does not
    /// read itself.
    public static func alsoRows(_ rows: [TellRow], day: (from: Double, to: Double), now: Double, calendar: Calendar) -> [TodayRow] {
        let today = TodayWords.localDay(day.from, calendar)
        return rows.filter { r in
            (r.day == today || (r.day == nil && r.at >= day.from && r.at < day.to)) && (alsoGroups.contains(r.group.rawValue) || alsoKinds.contains(r.kind))
        }.map { r in
            var row = TodayRow(key: "tell:\(r.key.map { "k:\($0)" } ?? "i:\(r.host):\(r.id)")", section: TodayModel.also.id, sector: r.sector, title: r.title)
            row.detail = r.detail.flatMap { $0.isEmpty ? nil : $0 }
            row.at = r.at
            row.when = DigestModel.when(r, now: TodayModel.date(now), day: today, calendar: calendar, locale: calendar.locale ?? .current)
            row.open = .tell(environmentId: r.host, open: r.open)
            return row
        }
    }

    /// The digest's answer: loading until its first read, each host that failed with Retry.
    public static func alsoAnswer(_ rows: [TellRow], loaded: Bool, errors: [HostError], day: (from: Double, to: Double), now: Double, calendar: Calendar) -> TodayAnswer {
        TodayAnswer(rows: alsoRows(rows, day: day, now: now, calendar: calendar), loading: !loaded, failed: hostFailures(errors))
    }
}

/// One event of a clash as LifeOS answers it.
public struct TodayClashSide: Hashable, Sendable, Decodable {
    public var eventId: String
    public var sector: String
    public var title: String
    public var startsAt: Double
    public var endsAt: Double
}

/// Two events he cannot both make: `a` the earlier, `b` the later.
public struct TodayClash: Hashable, Sendable, Decodable {
    public var id: String
    public var kind: String
    public var a: TodayClashSide
    public var b: TodayClashSide
    public var minutes: Double?
    public var measured: Bool?
    public var shortBy: Double?
}

/// When to leave for an event, from where he will be.
public struct TodayLeave: Hashable, Sendable, Decodable {
    public var eventId: String
    public var leaveAt: Double
    public var minutes: Double?
}
