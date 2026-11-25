import Foundation
import TempCodeContract

/// Today's values (docs/agents/work-today.md "The phone"): the desktop's seam
/// (src/renderer/src/work/today/types.ts) with every closure made a value, so a
/// view diffs rows and a cache keeps them. Nothing here reads a socket or LifeKit.

/// A Work workspace with a sector, on a host with Work on: a job.
public struct TodayWorkspace: Hashable, Sendable, Codable {
    public var environmentId: String
    public var workspaceId: String
    public var sector: String
    public var name: String
    public var path: String
    /// Its host's link is open now.
    public var open: Bool

    public init(environmentId: String, workspaceId: String, sector: String, name: String, path: String = "", open: Bool) {
        self.environmentId = environmentId
        self.workspaceId = workspaceId
        self.sector = sector
        self.name = name
        self.path = path
        self.open = open
    }

    public var place: TodayPlace { TodayPlace(environmentId: environmentId, workspaceId: workspaceId) }
}

/// A workspace by host and id: where a row acts.
public struct TodayPlace: Hashable, Sendable, Codable {
    public var environmentId: String
    public var workspaceId: String

    public init(environmentId: String, workspaceId: String) {
        self.environmentId = environmentId
        self.workspaceId = workspaceId
    }
}

/// The jobs, and the host a row of a sector opens on: the Work home's job, else the first whose link is open,
/// else the first (the desktop's `workspaceFor`).
public struct TodayJobs: Hashable, Sendable {
    public var jobs: [TodayWorkspace]
    public var home: String?

    public init(_ jobs: [TodayWorkspace], home: String? = nil) {
        self.jobs = jobs
        self.home = home
    }

    public func of(_ sector: String) -> TodayWorkspace? { TodayModel.workspaceFor(sector, jobs, home: home) }
}

/// What a row's glyph names; the view draws it (`WorkGlyph`).
public enum TodayGlyph: Hashable, Sendable, Codable {
    /// A held act, by its kind.
    case held(OutboxItem.Kind)
    /// A conversation that waits on him.
    case chat
    /// A thread's request for his press: the Outbox's own glyph.
    case request
}

/// The slot before a row's title: a task's tick, or the thing's kind.
public enum TodayLead: Hashable, Sendable, Codable {
    /// `label` is what VoiceOver says of the tick ("Mark Send the notes done").
    case tick(label: String)
    case glyph(TodayGlyph)

    /// The fixtures' name for it.
    public var kind: String {
        switch self {
        case .tick: "tick"
        case .glyph: "glyph"
        }
    }
}

/// What a row's press opens: its thing, by value. `route` is where the phone draws it, or nil while its place is not
/// built: a row with no route is not a button.
public enum TodayTarget: Hashable, Sendable, Codable {
    case held(environmentId: String, ref: HeldRef)
    /// A thread's open request: its sheet over the Outbox (`OutboxRequestCenter`), on the host it waits on.
    case request(environmentId: String, requestId: String)
    /// A meeting in its job's Agenda.
    case event(TodayPlace, eventId: String)
    /// A task's sheet in its job's Tasks; the job is looked up again by sector when he presses.
    case task(TodayPlace, sector: String, taskId: String)
    /// A mail in its job's Mail.
    case mail(TodayPlace, threadId: String)
    /// A conversation in its job's Messages.
    case chat(TodayPlace, chatId: String)
    /// A job's Money.
    case money(TodayPlace)
    /// A Microsoft form in its job's Files tab.
    case form(TodayPlace, formId: String, tenant: String)
    /// The weekly review at the week the host names by its first moment.
    case review(week: Double)
    /// A digest row's own target, on the host that told it.
    case tell(environmentId: String, open: TellOpen?)
    /// A meeting's prep page in its job.
    case prep(TodayPlace, eventId: String)

    /// The desktop's name for where it opens (the fixtures').
    public var name: String {
        switch self {
        case .held: "held"
        case .request: "outbox"
        case .event: "agenda"
        case .task: "tasks"
        case .mail: "mail"
        case .chat: "messages"
        case .money: "money"
        case .form: "msform"
        case .review: "review"
        case .tell: "tell"
        case .prep: "prep"
        }
    }

    /// Where the phone opens it. A job's view the phone has a screen for (`DigestModel.phoneViews`) opens at the view;
    /// A conversation opens in Messages; a meeting, and its prep mark, open the meeting's page; Money opens the job's
    /// Money page; the review opens Review (its week is set by the press: `ReviewDesk.named`).
    public var route: Route? {
        func view(_ place: TodayPlace, _ name: String) -> Route? {
            DigestModel.phoneViews.contains(name) ? .workView(environmentId: place.environmentId, workspaceId: place.workspaceId, view: name) : nil
        }
        switch self {
        case .held(let environmentId, let ref): return .outboxItem(environmentId: environmentId, ref: OutboxModel.key(ref))
        // The Outbox, where the screen opens the request's sheet over its Asked row.
        case .request: return .place(.outbox)
        case .event(let place, let eventId), .prep(let place, let eventId):
            return .prep(environmentId: place.environmentId, workspaceId: place.workspaceId, eventId: eventId)
        case .task(let place, _, _): return view(place, "tasks")
        case .mail(let place, _): return view(place, "mail")
        case .form(let place, _, _): return view(place, "forms")
        case .chat(let place, let chatId): return .chat(environmentId: place.environmentId, workspaceId: place.workspaceId, chatId: chatId)
        case .money(let place): return view(place, "money")
        case .review: return .place(.review)
        case .tell(let environmentId, let open): return DigestModel.route(open, environmentId: environmentId)
        }
    }
}

/// What a verb's press does, by value; the screen runs it through the host or LifeKit.
public enum TodayPress: Hashable, Sendable, Codable {
    /// A new thread's composer in the job with the meeting in it; nothing runs until he sends.
    case prepare(TodayPlace, eventId: String)
    /// `work.tasks.done` on the job's host; Undo is `tasks:reopen`.
    case done(sector: String, taskId: String)
    /// `tasks:snooze` to the next morning; Undo is `tasks:unsnooze`.
    case tomorrow(sector: String, taskId: String)
    /// `work.mail.nudge`: the host starts a thread that drafts the follow-up (held, as every draft).
    case nudge(TodayPlace, threadId: String)
    /// `mailWaits:dismiss` fenced by `since`; Undo is `mailWaits:putBack`.
    case dismiss(sector: String, threadId: String, since: Double)
    /// `chats:markRead` on the page's one session.
    case markRead(chatId: String, at: Double)
    /// The Clash dialog for one clash.
    case resolve(environmentId: String, clashId: String)
}

/// A row's verb.
public struct TodayAct: Hashable, Sendable, Codable {
    public var label: String
    public var press: TodayPress

    public init(_ label: String, _ press: TodayPress) {
        self.label = label
        self.press = press
    }
}

/// A thing in a section (the desktop's `TodayRow`).
public struct TodayRow: Hashable, Sendable, Codable, Identifiable {
    /// `<kind>:<stable id>`; the same key twice is one row.
    public var key: String
    public var section: String
    public var sector: String?
    /// The job's name, where the row knows the very workspace it belongs to.
    public var job: String?
    public var title: String
    public var detail: String?
    /// The detail is a fault: drawn in the failed tone.
    public var detailLate = false
    /// What the section orders by, ascending; a row with none keeps its place after those with one.
    public var at: Double?
    /// The trailing fact ("2:00 PM", "6 days").
    public var when: String?
    /// One live line under `when` ("Leave 5:10 PM", "in 25 min", "Now").
    public var whenLine: String?
    public var late = false
    /// It is over: drawn muted, folded at the section's head.
    public var past = false
    public var lead: TodayLead?
    /// The workspace the row's presses act on, where it was built for one.
    public var workspace: TodayPlace?
    public var open: TodayTarget?
    /// At most two.
    public var acts: [TodayAct] = []
    /// A LifeOS row's supplier: the host whose session read it, which may not be the host its press opens on. A
    /// sign-out there takes it out of every host's kept rows (`WorkCache.withoutLifeos`). Nil on a row kept before.
    public var suppliedBy: String?

    public var id: String { key }
    /// Where a press goes on the phone; nil: the row is not a button.
    public var route: Route? { open?.route }

    public init(key: String, section: String, sector: String?, title: String) {
        self.key = key
        self.section = section
        self.sector = sector
        self.title = title
    }
}

/// Something said about a row another source made, found by its key; a mark never makes a row.
public struct TodayMark: Hashable, Sendable {
    public var key: String
    public var note: String?
    public var whenLine: String?
    /// The note is a fault (a clash).
    public var late = false
    public var open: TodayTarget?
    public var act: TodayAct?

    public init(key: String) { self.key = key }
}

public struct TodaySection: Hashable, Sendable {
    public enum Bones: String, Hashable, Sendable { case lines, tick }

    public var id: String
    public var title: String
    public var order: Int
    /// The line when it has no row; empty: drawn only while it has a row.
    public var empty: String
    /// How many rows show before "N more"; nil shows all.
    public var fold: Int?
    /// It reads LifeOS.
    public var lifeos = false
    public var bones: Bones?

    public init(id: String, title: String, order: Int, empty: String, fold: Int? = nil, lifeos: Bool = false, bones: Bones? = nil) {
        self.id = id
        self.title = title
        self.order = order
        self.empty = empty
        self.fold = fold
        self.lifeos = lifeos
        self.bones = bones
    }
}

/// A LifeOS session that is down, in its true state (the desktop's `LifeosDown`).
public enum TodayDown: String, Hashable, Sendable, Codable {
    case unreachable, unanswered, refused, pairing, off, withheld
    case signedOut = "signed-out"
}

/// What a failure's Retry asks again, by value.
public indirect enum TodayRetry: Hashable, Sendable {
    /// One host's read of a source on hosts (the Outbox's, the digest's, an each-workspace read).
    case host(String)
    /// A LifeOS list read afresh, every read let go.
    case lifeos(what: String)
    /// One lost read: its own host and narrowed session alone.
    case lost(environmentId: String, sector: String?, down: Bool)
    /// Each of these once (one down session's line for the page).
    case each([TodayRetry])
}

/// A read that did not come back.
public struct TodayFailure: Hashable, Sendable {
    public struct Left: Hashable, Sendable {
        public var job: String?
        public var what: String
    }

    public var environmentId: String
    public var error: String
    /// The whole line in its place, for a read no host is at fault for.
    public var said: String?
    public var down: TodayDown?
    /// With `down`: what of which job the down session left out.
    public var left: Left?
    /// With `down`: the sector of the session that is down.
    public var sector: String?
    /// In place of `down`: the job's session on another host waits on that host's LifeOS, which said it is connecting.
    /// Said once for the page with what it left out, the computer named, and no press.
    public var waits = false
    public var retry: TodayRetry?

    public init(environmentId: String, error: String, said: String? = nil, down: TodayDown? = nil, left: Left? = nil, sector: String? = nil, waits: Bool = false, retry: TodayRetry? = nil) {
        self.environmentId = environmentId
        self.error = error
        self.said = said
        self.down = down
        self.left = left
        self.sector = sector
        self.waits = waits
        self.retry = retry
    }
}

/// What a source answered.
public struct TodayAnswer: Hashable, Sendable {
    /// Nil: nothing to show yet (not an empty list).
    public var rows: [TodayRow]?
    public var marks: [TodayMark] = []
    public var loading = false
    /// With `loading`: its rows are a whole earlier answer read again.
    public var stale = false
    /// A read it needs was not made, its host offline.
    public var away = false
    public var failed: [TodayFailure] = []
    /// One muted line at the foot of the source's own section.
    public var note: String?

    public init(rows: [TodayRow]? = nil, marks: [TodayMark] = [], loading: Bool = false, stale: Bool = false, away: Bool = false, failed: [TodayFailure] = [], note: String? = nil) {
        self.rows = rows
        self.marks = marks
        self.loading = loading
        self.stale = stale
        self.away = away
        self.failed = failed
        self.note = note
    }
}

/// One source and what it last answered. `kept`: its rows are its last whole answer, shown while it reads again.
public struct TodayFed: Hashable, Sendable {
    public var source: String
    public var section: TodaySection?
    public var answer: TodayAnswer
    public var kept = false
    public var away = false

    public init(source: String, section: TodaySection?, answer: TodayAnswer, kept: Bool = false, away: Bool = false) {
        self.source = source
        self.section = section
        self.answer = answer
        self.kept = kept
        self.away = away
    }
}

/// What a read on hosts passes on beside its rows (the desktop's `readState`).
public struct TodayReadState: Hashable, Sendable {
    public var loading = false
    public var stale = false
    public var away = false
    public var failed: [TodayFailure] = []

    public init(loading: Bool = false, stale: Bool = false, away: Bool = false, failed: [TodayFailure] = []) {
        self.loading = loading
        self.stale = stale
        self.away = away
        self.failed = failed
    }

    public func answer(rows: [TodayRow]) -> TodayAnswer {
        TodayAnswer(rows: rows, loading: loading, stale: stale, away: away, failed: failed)
    }
}
