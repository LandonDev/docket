import Foundation
import TempCodeContract

/// Where a notification or a Live Activity tap lands: a thread on a host,
/// and the row to open on. Read off an APNs payload's `tc` object (what
/// infra/hub sends) or the activity's `tempcode://thread/<env>/<session>?seq=`.
/// A notice of Work's (`tc.work`, docs/agents/work-digest.md "The phone") has
/// no thread of its own: the day's digest opens the Digest, a tell that
/// cannot wait opens its target where the phone has a route for it.
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
    /// A Work view a tell opens (`tc.work.open.view`, one the phone draws).
    public var view: WorkView?

    public struct WorkView: Sendable, Hashable {
        public var workspaceId: String
        public var view: String

        public init(workspaceId: String, view: String) {
            self.workspaceId = workspaceId
            self.view = view
        }
    }

    public init(environmentId: String, sessionId: String, seq: Int? = nil, held: String? = nil, work: Bool = false, view: WorkView? = nil) {
        self.environmentId = environmentId
        self.sessionId = sessionId
        self.seq = seq
        self.held = held
        self.work = work
        self.view = view
    }

    /// The `tc` object of a hub notification; a payload without a thread (a host down) is nil, unless it is Work's.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let tc = userInfo["tc"] as? [AnyHashable: Any] else { return nil }
        if let work = tc["work"] as? [AnyHashable: Any] {
            self.init(work: work, environmentId: tc["environmentId"] as? String ?? "")
            return
        }
        guard let environmentId = tc["environmentId"] as? String, !environmentId.isEmpty,
              let sessionId = tc["threadId"] as? String, !sessionId.isEmpty else { return nil }
        self.init(environmentId: environmentId, sessionId: sessionId, seq: PushTarget.int(tc["seq"]), held: PushTarget.held(tc["held"]))
    }

    /// `tc.work`: `{key, digest}` opens the Digest; `{key, tell, by?, open?}` opens a held item, a Work
    /// view the phone draws or a thread, on the notice's host, and the Digest otherwise.
    private init(work: [AnyHashable: Any], environmentId: String) {
        self.init(environmentId: environmentId, sessionId: "", work: true)
        guard work["tell"] is String, let open = work["open"] as? [AnyHashable: Any], !environmentId.isEmpty else { return }
        if let held = PushTarget.held(open["held"]) {
            self.held = held
        } else if let view = open["view"] as? String, DigestModel.phoneViews.contains(view), let workspaceId = open["workspaceId"] as? String, !workspaceId.isEmpty {
            self.view = WorkView(workspaceId: workspaceId, view: view)
        } else if open["held"] == nil, let thread = open["thread"] as? String, !thread.isEmpty {
            sessionId = thread
        }
    }

    /// Where the tap goes: a held item over the Outbox, a Work view, the thread, or for a notice
    /// of Work's with none of those, the Digest.
    public var route: Route {
        if !environmentId.isEmpty {
            if let held { return .outboxItem(environmentId: environmentId, ref: held) }
            if let view { return .workView(environmentId: environmentId, workspaceId: view.workspaceId, view: view.view) }
            if !sessionId.isEmpty { return .thread(environmentId: environmentId, sessionId: sessionId, seq: seq) }
        }
        return .digest
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
