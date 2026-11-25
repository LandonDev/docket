import Foundation
import TempCodeContract

/// Mail as a place of the Work tab (docs/agents/work-mail.md "The phone"): which mail he timed the phone may move,
/// send now or take back, where Ask starts the chat beside a mail, when a mail's file must be fetched onto its
/// host, and the marks the host lays on Agenda's events. Pure, for its tests; the screens and `WorkLifeHost` are
/// the app's.
public enum MailRules {
    // MARK: - a composer Send heard late

    /// What Mail says of a composer Send that was Checking once its answer comes late or is read back: the line, and
    /// whether it is one he must act on (the sticky toast too). Nil while nothing is known yet.
    public static func heardLate(_ state: PressState) -> (line: String, tell: Bool)? {
        switch state {
        case .sending, .checking: nil
        case .done: ("Sent", false)
        case .stillWaiting: ("Not sent: the mail is still in Drafts", true)
        case .changed: ("Not sent: the draft changed", true)
        case .gone: ("Not sent: the draft is gone", true)
        case .mayHaveGone: ("May have gone: look in Sent before you send it again", true)
        case .failed: (state.line ?? "Not sent", true)
        }
    }

    // MARK: - a mail he timed

    /// The LifeOS mail id of a mail he timed in Mail, as the Outbox lists it: on its way with a time, its time
    /// LifeOS's own. Its Reschedule, Send Now and Cancel are `work.mail.*`. A send the hold times itself (state
    /// `scheduled`) keeps the Outbox's own verbs; anything else is nil.
    public static func timedInMail(_ item: OutboxItem) -> String? {
        guard item.kind == .mailSend, item.state != .scheduled, item.scheduledFor != nil,
              case .lifeos(let ref) = item.ref, ref.table == .outbox else { return nil }
        return ref.id
    }

    /// The times Reschedule offers: the Outbox's Send later choices, less the one it already has.
    public static func rescheduleChoices(_ item: OutboxItem, now: Date = .now, calendar: Calendar = .current) -> [(label: String, at: Int)] {
        OutboxModel.laterChoices(now: now, calendar: calendar).filter { $0.at != item.scheduledFor }
    }

    /// Send Now's ledger revision: the time he saw it set for.
    public static func rev(_ item: OutboxItem) -> String { String(item.scheduledFor ?? 0) }

    /// What the Outbox says of a mail after his Send Now whose answer was lost. Gone from the list, or sent: it
    /// went. Still timed as he saw it: it waits, and his press never landed. Timed earlier: LifeOS took the Send
    /// Now. Failed: LifeOS's words. Nil while it is on its way with no time: nothing is known yet.
    public static func sendNowTruth(_ item: OutboxItem?, rev: String?) -> PressTruth? {
        guard let item else { return .done }
        switch item.state {
        case .sent: return .done
        case .failed:
            if item.outcomeUnknown == true { return .mayHaveGone }
            return .failed(item.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
        case .discarded: return .gone
        default: break
        }
        guard let at = item.scheduledFor else { return item.state == .sending ? nil : .gone }
        guard let seen = rev.flatMap(Int.init) else { return .waiting(rev: String(at)) }
        if at < seen { return .done }
        return .waiting(rev: String(at))
    }

    // MARK: - Ask: the chat beside a mail

    /// The sectors whose mail gets no Ask (src/shared/work/mailChat.ts `MAIL_CHAT_WITHHELD`; none today).
    public static let withheld: Set<String> = []

    /// The job a mail's chat lives in, when Ask is offered: the key may adopt a chat (`work.mail.chat.adopt`), the
    /// sector is not withheld, and a job of that sector is on this host (the job's own on a job's page). Nil: no Ask.
    public static func askIn(sector: String?, mayAdopt: Bool, workspaceId: String?, jobs: [String: String]) -> String? {
        guard mayAdopt, let sector, !withheld.contains(sector) else { return nil }
        return workspaceId ?? jobs[sector]
    }

    /// What `session.create` adopts before the chat's first message: a mail chat about one mail thread.
    public static func adopt(workspaceId: String, mailThreadId: String) -> Methods.SessionCreate.Params.MailAdopt {
        .init(workspaceId: workspaceId, kind: .mail, mailThreadId: mailThreadId)
    }

    /// The chat Ask opens: the newest about this mail that the phone knows, else the first the host found (the
    /// phone may not have its row yet). Nil: Ask starts a new one.
    public static func chatToOpen(found: [String], known: Set<String>) -> String? {
        found.first(where: known.contains) ?? found.first
    }

    // MARK: - a mail's file

    /// The item's bytes come from LifeOS's store onto the host first (`work.canvas.fetch`): a mail's attachment,
    /// or a chat's file, which rides the same arm.
    public static func fetches(_ item: CanvasItem) -> Bool {
        if case .mail = item.source { return true }
        return false
    }

    /// The share of a fetch that has come, for a bar; nil while the store has not said the size.
    public static func fetchShare(received: Double, total: Double?) -> Double? {
        guard let total, total > 0 else { return nil }
        return min(1, max(0, received / total))
    }

    /// Save to Workspace is offered on a fetched file of a job's pane, to a key that may keep it.
    public static func keeps(_ item: CanvasItem, mayKeep: Bool) -> Bool {
        mayKeep && fetches(item)
    }

    /// The line after Save to Workspace: the name the copy took ("Budget (1).xlsx" when the name was taken).
    public static func keptLine(_ name: String) -> String { "Saved to the workspace as \(name)" }

    // MARK: - Agenda's marks

    /// The host's mark on one event: when to leave (the host's own, by the drive) and a line a clash.
    public struct EventMark: Sendable, Hashable {
        public var leave: Date?
        public var lines: [String]

        public init(leave: Date? = nil, lines: [String] = []) {
            self.leave = leave
            self.lines = lines
        }
    }

    /// Every event's mark from `work.clashes.list` over Agenda's window, keyed by event id: each clash as the
    /// desktop's `clashLines` says it from that event's side, and the list's leave times. `jobName` names a
    /// sector's job ("Ref") where the other event is another job's.
    public static func marks(clashes: [ClashPhoneRow], leaves: [ClashLeaveRow], jobName: (String) -> String, calendar: Calendar = .current) -> [String: EventMark] {
        var out: [String: EventMark] = [:]
        for leave in leaves {
            out[leave.eventId, default: EventMark()].leave = Date(timeIntervalSince1970: leave.leaveAt / 1000)
        }
        var mine: [String: [ClashPhoneRow]] = [:]
        for clash in clashes {
            mine[clash.a.eventId, default: []].append(clash)
            mine[clash.b.eventId, default: []].append(clash)
        }
        for (eventId, list) in mine {
            out[eventId, default: EventMark()].lines = lines(list, eventId: eventId, jobName: jobName, calendar: calendar)
        }
        return out
    }

    /// An event's lines, one a clash (`clashLines`): two drive clashes that read alike each take the other's start.
    public static func lines(_ clashes: [ClashPhoneRow], eventId: String, jobName: (String) -> String, calendar: Calendar = .current) -> [String] {
        let lines = clashes.map { line($0, eventId: eventId, jobName: jobName, calendar: calendar) }
        return lines.enumerated().map { i, line in
            clashes[i].kind == .drive && lines.filter({ $0 == line }).count > 1 ? "\(line), \(time(clashes[i], eventId: eventId, calendar: calendar))" : line
        }
    }

    /// "Overlaps Varsity Basketball (Ref), 6:00 PM"; "15 min short after Staff meeting (Purdue)" on the later
    /// event, "… before …" on the earlier (`clashLine`).
    public static func line(_ clash: ClashPhoneRow, eventId: String, jobName: (String) -> String, calendar: Calendar = .current) -> String {
        let earlier = eventId == clash.a.eventId
        let (own, other) = earlier ? (clash.a, clash.b) : (clash.b, clash.a)
        let named = other.sector == own.sector ? other.title : "\(other.title) (\(jobName(other.sector)))"
        if clash.kind == .overlap { return "Overlaps \(named), \(time(clash, eventId: eventId, calendar: calendar))" }
        return "\(shortWords(clash)) \(earlier ? "before" : "after") \(named)"
    }

    /// "15 min short", "About 15 min short" for a drive worked out without the map.
    static func shortWords(_ clash: ClashPhoneRow) -> String {
        guard let by = clash.shortBy else { return clash.measured == false ? "About not enough time" : "Not enough time" }
        let short = "\(ClashRules.shortMinutes(clash, by)) min short"
        return clash.measured == false ? "About \(short)" : short
    }

    /// The other event's start as a line says it (`clashTime`): its clock, with its weekday when it starts on
    /// another day within three, or its date past that.
    static func time(_ clash: ClashPhoneRow, eventId: String, calendar: Calendar) -> String {
        let (own, other) = eventId == clash.a.eventId ? (clash.a, clash.b) : (clash.b, clash.a)
        let at = Date(timeIntervalSince1970: other.startsAt / 1000), on = Date(timeIntervalSince1970: own.startsAt / 1000)
        let apart = abs(calendar.dateComponents([.day], from: calendar.startOfDay(for: on), to: calendar.startOfDay(for: at)).day ?? 0)
        let locale = calendar.locale ?? .current
        var clock = Date.FormatStyle(date: .omitted, time: .shortened, locale: locale)
        clock.timeZone = calendar.timeZone
        let time = at.formatted(clock).replacingOccurrences(of: "\u{202F}", with: " ")
        if apart == 0 { return time }
        var day = apart <= 3 ? Date.FormatStyle(locale: locale).weekday(.abbreviated) : Date.FormatStyle(locale: locale).month(.abbreviated).day()
        day.timeZone = calendar.timeZone
        return apart <= 3 ? "\(at.formatted(day)) \(time)" : "\(at.formatted(day)), \(time)"
    }
}
