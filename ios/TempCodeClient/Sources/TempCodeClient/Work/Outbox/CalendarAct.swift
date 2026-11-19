import Foundation
import TempCodeContract

/// A held calendar act as a person reads it (the desktop's `opFields`,
/// work/agenda/calendarAct.ts): Event, When, Where, who is asked, the reply.
/// A LifeOS act's payload is its whole `calendarOps` row, so the generic
/// reader would list ids, epoch numbers and JSON; this reads it as the act.
public extension OutboxModel {
    /// The act's fields in his words, or nil for a kind that is not a calendar act. A LifeOS act's
    /// own change leads (the new title, time or place is what goes); the event as the host bound it
    /// for the press fills what the act leaves out. Dates are words, never numbers.
    nonisolated static func calendarFields(kind: OutboxItem.Kind, payload: JSONValue?, locale: Locale = .current, timeZone: TimeZone = .current) -> [Field]? {
        guard case .object(let o)? = payload else { return kind == .calendarOp || kind == .officeCalendarOp ? [] : nil }
        var rows: [(String, String)] = []
        let when = { (start: Double, end: Double?, allDay: Bool) in whenWords(start, end, allDay: allDay, locale: locale, timeZone: timeZone) }
        switch kind {
        case .calendarOp:
            let p = object(o["payload"])
            let op = string(o["kind"])
            if let title = string(p["title"]) ?? string(o["eventTitle"]) { rows.append(("Event", title)) }
            if let start = number(p["startsAt"]) ?? number(o["eventStartsAt"]) {
                rows.append(("When", when(start, number(p["endsAt"]) ?? number(o["eventEndsAt"]), bool(p["allDay"]))))
            }
            if op == "propose", let instead = number(p["proposedStart"]) { rows.append(("Instead", when(instead, number(p["proposedEnd"]), false))) }
            if let place = string(p["location"]) ?? string(o["eventLocation"]) { rows.append(("Where", place)) }
            if case .array(let list)? = p["attendees"], !list.isEmpty {
                rows.append(("Invites", list.compactMap { person -> String? in
                    let a = object(person)
                    guard let address = string(a["address"]) else { return nil }
                    return string(a["name"]).map { "\($0) <\(address)>" } ?? address
                }.joined(separator: ", ")))
            }
            if case .array(let list)? = p["uninvite"], !list.isEmpty { rows.append(("Uninvites", list.compactMap { string($0) }.joined(separator: ", "))) }
            if bool(p["series"]) { rows.append(("Applies to", "Every occurrence")) }
            if let reply = op.flatMap({ replies[$0] }) { rows.append(("Reply", reply)) }
            if let note = string(p["comment"]) { rows.append(("Note", note)) }
            if let details = string(p["notes"]) { rows.append(("Details", details)) }
            // An account's own calendar is named by its address; another (shared, a team's) by its id too.
            let account = string(o["account"])
            if let calendar = string(o["calendarId"]), calendar != account {
                rows.append(("Calendar", account.map { "\(calendar), \($0)" } ?? calendar))
            } else if let account {
                rows.append(("Calendar", account))
            }
        case .officeCalendarOp:
            if string(o["op"]) == "create" {
                let e = object(o["event"])
                if let subject = string(e["subject"]) { rows.append(("Event", subject)) }
                if let start = iso(e["start"]) { rows.append(("When", when(start, iso(e["end"]), false))) }
                if let place = string(e["location"]) { rows.append(("Where", place)) }
                if case .array(let list)? = e["attendees"], !list.isEmpty { rows.append(("Invites", list.compactMap { string($0) }.joined(separator: ", "))) }
                if let body = string(e["body"]) { rows.append(("Details", HtmlWords.of(body))) }
                if let account = string(e["account"]) { rows.append(("Calendar", account)) }
            } else {
                if let subject = string(o["subject"]) { rows.append(("Event", subject)) }
                if let start = iso(o["start"]) { rows.append(("When", when(start, nil, false))) }
                if let organizer = string(o["organizer"]) { rows.append(("From", organizer)) }
                if let reply = string(o["answer"]).flatMap({ replies[$0] }) { rows.append(("Reply", reply)) }
                if let note = string(o["comment"]) { rows.append(("Note", note)) }
            }
        default:
            return nil
        }
        return rows.map { Field(key: $0.0.lowercased(), path: [$0.0], label: $0.0, value: $0.1, edit: nil) }
    }

    /// What the detail and the thread's card draw for an item: a calendar act as its fields, any
    /// other act through the generic reader.
    nonisolated static func actView(_ item: OutboxItem) -> PayloadView {
        if let fields = calendarFields(kind: item.kind, payload: item.payload) { return PayloadView(fields: fields) }
        if let view = kindView(kind: item.kind, payload: item.payload) { return view }
        var view = payloadView(item.payload)
        // A computer act's tool word ("left_click") under a title that already says what the click does: left out.
        if item.kind == .computerAct { view.fields.removeAll { $0.path == ["args", "action"] } }
        return view
    }

    /// A calendar act's list line: when it lands ("Fri, Nov 20, 2:00 to 2:30 PM").
    nonisolated static func calendarWhen(kind: OutboxItem.Kind, payload: JSONValue?) -> String? {
        let fields = calendarFields(kind: kind, payload: payload)
        return (fields?.first { $0.label == "Instead" } ?? fields?.first { $0.label == "When" })?.value
    }

    /// "Fri, Nov 20, 2:00 to 2:30 PM"; a day item is its day alone, or its first and last day; one day
    /// period for both ends is said once; an event across days names both. Milliseconds in, as the
    /// host keeps them.
    nonisolated static func whenWords(_ startsAt: Double, _ endsAt: Double?, allDay: Bool = false, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        let day = DateFormatter()
        day.locale = locale
        day.timeZone = timeZone
        day.setLocalizedDateFormatFromTemplate("EEEMMMd")
        let time = DateFormatter()
        time.locale = locale
        time.timeZone = timeZone
        time.setLocalizedDateFormatFromTemplate("jmm")
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let start = Date(timeIntervalSince1970: startsAt / 1000)
        if allDay {
            // A day item's end is the midnight after its last day: the last day is the one before it.
            guard let endsAt, endsAt > startsAt else { return day.string(from: start) }
            let last = Date(timeIntervalSince1970: (endsAt - 1) / 1000)
            return calendar.isDate(start, inSameDayAs: last) ? day.string(from: start) : "\(day.string(from: start)) to \(day.string(from: last))"
        }
        let from = time.string(from: start)
        guard let endsAt, endsAt > startsAt else { return "\(day.string(from: start)), \(from)" }
        let end = Date(timeIntervalSince1970: endsAt / 1000)
        let to = time.string(from: end)
        // An event that spans days names both: "Fri, Nov 20, 9:00 PM to Sat, Nov 21, 2:00 AM".
        if !calendar.isDate(start, inSameDayAs: end) { return "\(day.string(from: start)), \(from) to \(day.string(from: end)), \(to)" }
        if let period = [time.amSymbol, time.pmSymbol].compactMap({ $0 }).first(where: { !$0.isEmpty && from.hasSuffix($0) && to.hasSuffix($0) }) {
            let bare = String(from.dropLast(period.count)).trimmingCharacters(in: .whitespaces)
            return "\(day.string(from: start)), \(bare) to \(to)"
        }
        return "\(day.string(from: start)), \(from) to \(to)"
    }

    private nonisolated static let replies = ["accept": "Yes", "decline": "No", "tentative": "Maybe"]

    private nonisolated static func object(_ value: JSONValue?) -> [String: JSONValue] {
        if case .object(let o)? = value { return o }
        return [:]
    }

    private nonisolated static func string(_ value: JSONValue?) -> String? {
        guard case .string(let s)? = value else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    private nonisolated static func number(_ value: JSONValue?) -> Double? {
        if case .number(let n)? = value { return n }
        return nil
    }

    private nonisolated static func bool(_ value: JSONValue?) -> Bool {
        if case .bool(let b)? = value { return b }
        return false
    }

    /// An Outlook time ("2026-11-20T14:00:00-05:00", fractions or not) in milliseconds.
    private nonisolated static func iso(_ value: JSONValue?) -> Double? {
        guard let text = string(value) else { return nil }
        let plain = ISO8601DateFormatter()
        let fraction = ISO8601DateFormatter()
        fraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return (plain.date(from: text) ?? fraction.date(from: text)).map { $0.timeIntervalSince1970 * 1000 }
    }
}
