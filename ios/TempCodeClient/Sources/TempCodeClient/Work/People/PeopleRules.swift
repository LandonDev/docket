import Foundation
import TempCodeContract

/// People on the phone (docs/agents/work-people.md "The phone"): LifeOS's `people:directory` and `people:page`,
/// read through LifeKit on the LifeOS session, joined with the host's guest links (`work.guests.list`) and the
/// forms a person answered (`work.msforms.byPerson`), as the desktop joins them (src/renderer/src/work/people/
/// model.ts). There is no `work.people.*`. Pure, for its tests.

/// One person of a sector, as `people:directory` answers: newest contact first, then by name.
public nonisolated struct DirectoryPerson: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var emails: [String]
    public var lastAt: Double?
    /// The sector whose directory listed them; the phone sets it, LifeOS does not send it.
    public var sector: String?

    enum CodingKeys: String, CodingKey { case id = "_id", name, emails, lastAt, sector }

    public init(id: String, name: String, emails: [String], lastAt: Double? = nil, sector: String? = nil) {
        self.id = id
        self.name = name
        self.emails = emails
        self.lastAt = lastAt
        self.sector = sector
    }
}

/// `people:page`: who they are and what is live with them in the sector.
public nonisolated struct PersonPage: Codable, Hashable, Sendable {
    public struct Person: Codable, Hashable, Sendable {
        public var id: String
        public var name: String
        public var notes: String
        public var emails: [String]
        public var phones: [String]
        enum CodingKeys: String, CodingKey { case id = "_id", name, notes, emails, phones }
        public init(id: String, name: String, notes: String = "", emails: [String] = [], phones: [String] = []) {
            self.id = id
            self.name = name
            self.notes = notes
            self.emails = emails
            self.phones = phones
        }
    }

    public struct Mail: Codable, Hashable, Sendable, Identifiable {
        public var id: String
        public var subject: String
        public var snippet: String
        public var lastMessageAt: Double
        public var unread: Bool
        enum CodingKeys: String, CodingKey { case id = "_id", subject, snippet, lastMessageAt, unread }
        public init(id: String, subject: String, snippet: String = "", lastMessageAt: Double, unread: Bool = false) {
            self.id = id
            self.subject = subject
            self.snippet = snippet
            self.lastMessageAt = lastMessageAt
            self.unread = unread
        }
    }

    public struct Event: Codable, Hashable, Sendable, Identifiable {
        public var id: String
        public var title: String
        public var startsAt: Double
        public var endsAt: Double?
        public var allDay: Bool?
        public var location: String?
        enum CodingKeys: String, CodingKey { case id = "_id", title, startsAt, endsAt, allDay, location }
        public init(id: String, title: String, startsAt: Double, endsAt: Double? = nil, allDay: Bool? = nil, location: String? = nil) {
            self.id = id
            self.title = title
            self.startsAt = startsAt
            self.endsAt = endsAt
            self.allDay = allDay
            self.location = location
        }
    }

    public struct Task: Codable, Hashable, Sendable, Identifiable {
        public var id: String
        public var title: String
        public var status: String
        public var dueAt: Double?
        /// They asked for it, or he waits on them for it.
        public var relation: String
        enum CodingKeys: String, CodingKey { case id = "_id", title, status, dueAt, relation }
        public init(id: String, title: String, status: String = "open", dueAt: Double? = nil, relation: String) {
            self.id = id
            self.title = title
            self.status = status
            self.dueAt = dueAt
            self.relation = relation
        }
    }

    public struct Shared: Codable, Hashable, Sendable {
        public var table: String
        public var id: String
        public var title: String
        public init(table: String, id: String, title: String) {
            self.table = table
            self.id = id
            self.title = title
        }
    }

    public var person: Person
    public var lastAt: Double?
    public var mail: [Mail]
    public var coming: [Event]
    public var recent: [Event]
    public var tasks: [Task]
    public var shared: [Shared]

    public init(person: Person, lastAt: Double? = nil, mail: [Mail] = [], coming: [Event] = [], recent: [Event] = [], tasks: [Task] = [], shared: [Shared] = []) {
        self.person = person
        self.lastAt = lastAt
        self.mail = mail
        self.coming = coming
        self.recent = recent
        self.tasks = tasks
        self.shared = shared
    }
}

public enum PeopleRules {
    /// The page's sections, in the desktop's order; a section with nothing is not drawn.
    public enum Section: String, Sendable, Hashable, CaseIterable {
        case mail, coming, asked, waiting, shared, recent, answered

        public var title: String {
            switch self {
            case .mail: "Mail"
            case .coming: "Coming Up"
            case .asked: "Asked for by Them"
            case .waiting: "Waiting on Them"
            case .shared: "Shared with Them"
            case .recent: "Past Meetings"
            case .answered: "Answered"
            }
        }
    }

    /// Every job's directory as one list: each person once (the first job in the list's order that names them),
    /// newest contact first, then by name.
    public static func directory(_ pages: [(sector: String, people: [DirectoryPerson])]) -> [DirectoryPerson] {
        var seen = Set<String>()
        var out: [DirectoryPerson] = []
        for page in pages {
            for var person in page.people where seen.insert(person.id).inserted {
                person.sector = person.sector ?? page.sector
                out.append(person)
            }
        }
        return out.sorted { a, b in
            if (a.lastAt ?? 0) != (b.lastAt ?? 0) { return (a.lastAt ?? 0) > (b.lastAt ?? 0) }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    /// The people a search keeps, in the list's order: every word typed is in their name or an address of theirs.
    public static func find(_ rows: [DirectoryPerson], _ query: String) -> [DirectoryPerson] {
        let words = fold(query).split(separator: " ").map(String.init)
        guard !words.isEmpty else { return rows }
        return rows.filter { person in
            let hay = fold(([person.name] + person.emails).joined(separator: " "))
            return words.allSatisfy(hay.contains)
        }
    }

    /// A row's second line: their first address.
    public static func rowLine(_ person: DirectoryPerson) -> String? { person.emails.first }

    /// The guest links made for them: live and named for them (a link names its guest by the words he typed, folded
    /// for case, accents and spacing). One item shared twice is listed once, by its newest link.
    public static func links(_ links: [GuestLinkRow], name: String, now: Double) -> [GuestLinkRow] {
        let who = fold(name)
        guard !who.isEmpty else { return [] }
        var seen = Set<String>()
        return links
            .filter { $0.revokedAt == nil && Double($0.expiresAt) > now && fold($0.name) == who }
            .sorted { $0.createdAt > $1.createdAt }
            .filter { seen.insert("\($0.source.table.rawValue):\($0.source.id)").inserted }
    }

    /// What a link lets them do, and until when: "Can comment until Dec 3".
    public static func linkWords(_ link: GuestLinkRow, calendar: Calendar) -> String {
        let verb = switch link.role {
        case .view: "view"
        case .comment: "comment"
        default: "edit"
        }
        let until = Date(timeIntervalSince1970: Double(link.expiresAt) / 1000)
            .formatted(Date.FormatStyle(locale: calendar.locale ?? .current, calendar: calendar, timeZone: calendar.timeZone).month(.abbreviated).day())
        return "Can \(verb) until \(until)"
    }

    /// The forms they answered, across their addresses, each once, newest answer first.
    public static func answered(_ rows: [MsFormsByPerson]) -> [MsFormAnswered] {
        var seen = Set<String>()
        return rows.flatMap(\.forms)
            .sorted { ($0.at ?? 0) > ($1.at ?? 0) }
            .filter { seen.insert($0.formId).inserted }
    }

    /// The sections that have something, in order.
    public static func sections(_ page: PersonPage, links: [GuestLinkRow], answered: [MsFormAnswered]) -> [Section] {
        Section.allCases.filter { section in
            switch section {
            case .mail: !page.mail.isEmpty
            case .coming: !page.coming.isEmpty
            case .asked: page.tasks.contains { $0.relation == "asked" }
            case .waiting: page.tasks.contains { $0.relation == "waiting" }
            case .shared: !page.shared.isEmpty
            case .recent: !page.recent.isEmpty
            case .answered: !answered.isEmpty
            }
        }
    }

    /// Their addresses and numbers as one comma line.
    public static func reachLine(_ person: PersonPage.Person) -> String? {
        let all = person.emails + person.phones
        return all.isEmpty ? nil : all.joined(separator: ", ")
    }

    /// The shared items to ask LifeOS about: the links' own items, each once.
    public static func sharedAsk(_ links: [GuestLinkRow]) -> [[String: String]] {
        links.map { ["table": $0.source.table.rawValue, "id": $0.source.id] }
    }

    /// Case, accents and spacing aside.
    public static func fold(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: nil)
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
