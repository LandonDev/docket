import Foundation
import TempCodeContract

/// Where a notification or a Live Activity tap lands: a thread on a host,
/// and the row to open on. Read off an APNs payload's `tc` object (what
/// infra/hub sends) or the activity's `tempcode://thread/<env>/<session>?seq=`.
/// A notice of Work's (`tc.work`, docs/agents/work-digest.md "The phone") has
/// no thread of its own: the day's digest opens the Digest, a tell that
/// cannot wait opens its target where the phone has a route for it
/// (`DigestModel.route`, the one rule a Digest row's press shares).
public struct PushTarget: Sendable, Hashable {
    /// Empty for a notice of Work's that names no host.
    public var environmentId: String
    /// Empty for a notice of Work's that opens no thread.
    public var sessionId: String
    public var seq: Int?
    /// An act held for the owner's press (`tc.held`): the tap opens this item
    /// in the Outbox (`OutboxModel.key`), never a Send of its own.
    public var held: String?
    /// `tc.work` was on the notice: a notice of Work's, not a thread's.
    public var work: Bool
    /// Where a tell opens (`tc.work.open`): a place, a view, a held item, Settings → Work or a thread.
    public var tell: Route?
    /// A thread's request for his press (a tell keyed `request:<id>`): the tap opens its sheet over the Outbox.
    public var request: String?
    /// A host went down or came back (`host_down`, `host_up`): no thread, so the tap opens Hosts.
    public var hostEvent = false

    public init(environmentId: String, sessionId: String, seq: Int? = nil, held: String? = nil, work: Bool = false, tell: Route? = nil) {
        self.environmentId = environmentId
        self.sessionId = sessionId
        self.seq = seq
        self.held = held
        self.work = work
        self.tell = tell
    }

    /// The `tc` object of a hub notification; a host's own notice (`host_down`, `host_up`) opens Hosts; any
    /// other payload without a thread is nil, unless it is Work's.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let tc = userInfo["tc"] as? [AnyHashable: Any] else { return nil }
        if let work = tc["work"] as? [AnyHashable: Any] {
            self.init(work: work, environmentId: tc["environmentId"] as? String ?? "")
            return
        }
        guard let environmentId = tc["environmentId"] as? String, !environmentId.isEmpty else { return nil }
        guard let sessionId = tc["threadId"] as? String, !sessionId.isEmpty else {
            guard let event = tc["event"] as? String, event == "host_down" || event == "host_up" else { return nil }
            self.init(environmentId: environmentId, sessionId: "")
            hostEvent = true
            return
        }
        self.init(environmentId: environmentId, sessionId: sessionId, seq: PushTarget.int(tc["seq"]), held: PushTarget.held(tc["held"]))
    }

    /// `tc.work`: `{key, digest}` opens the Digest; `{key, tell, by?, open?}` opens what the tell
    /// names where the phone has a screen for it, and the Digest otherwise.
    private init(work: [AnyHashable: Any], environmentId: String) {
        self.init(environmentId: environmentId, sessionId: "", work: true)
        guard let tell = work["tell"] as? String, !environmentId.isEmpty || !tell.hasPrefix("request:") else { return }
        // A thread's request (the tell's key `request:<id>`): its open names the thread that asked, but the sheet is
        // where he answers it, so the key wins.
        if tell.hasPrefix("request:"), tell.count > "request:".count {
            request = String(tell.dropFirst("request:".count))
            return
        }
        // A clash's tell (`clash:<id>`) opens the clash, whatever its open names.
        if let clash = DigestModel.route(nil, environmentId: environmentId, key: tell) {
            self.tell = clash
            return
        }
        guard let open = work["open"] as? [String: Any], JSONSerialization.isValidJSONObject(open),
              let data = try? JSONSerialization.data(withJSONObject: open),
              let target = try? JSONDecoder().decode(TellOpen.self, from: data) else { return }
        self.tell = DigestModel.route(target, environmentId: environmentId, key: tell)
        // The thread on screen shows no notice for itself (`NavigationRouter.isVisible` reads `sessionId`).
        if case .thread(_, let thread, _)? = self.tell { sessionId = thread }
    }

    /// Where the tap goes: the Outbox under a request's sheet, what a tell names, a held item over the
    /// Outbox, the thread, or for a notice of Work's with none of those, the Digest.
    public var route: Route {
        if request != nil, !environmentId.isEmpty { return .place(.outbox) }
        if let tell { return tell }
        if hostEvent { return .hosts }
        if !environmentId.isEmpty {
            if let held { return .outboxItem(environmentId: environmentId, ref: held) }
            if !sessionId.isEmpty { return .thread(environmentId: environmentId, sessionId: sessionId, seq: seq) }
        }
        return .place(.digest)
    }

    /// `tc.held` as a held item's key; nil when absent or not a ref this build knows.
    private static func held(_ value: Any?) -> String? {
        guard let object = value as? [String: Any], JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let ref = try? JSONDecoder().decode(HeldRef.self, from: data) else { return nil }
        if case .unknown = ref { return nil }
        return OutboxModel.key(ref)
    }

    /// `tempcode://thread/<environment>/<session>?seq=<n>`, as the Live Activity's widgetURL.
    public init?(url: URL) {
        guard url.scheme == "tempcode", url.host == "thread" else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        let seq = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "seq" }?.value.flatMap(Int.init)
        self.init(environmentId: parts[0], sessionId: parts[1], seq: seq)
    }

    private static func int(_ value: Any?) -> Int? {
        switch value {
        case let n as Int: n
        case let n as Double: Int(n)
        case let s as String: Int(s)
        default: nil
        }
    }
}
