import Foundation
import Observation
import TempCodeContract

/// The Search tab's Work scope as it runs (docs/agents/work-search.md "The
/// window", the port of controller.ts): every change of his words asks each
/// host at once for what it knows without the network; the sources a host
/// names are asked one by one 120 ms after his last key, so each lands when
/// it is ready. A new keystroke cancels every ask still out, and an answer
/// for words he has since changed is dropped by the model.
@MainActor @Observable
public final class WorkSearchRun {
    /// One `work.search.query` of one host.
    public typealias Ask = @MainActor (_ host: String, _ params: Methods.WorkSearchQuery.Params) async throws -> WorkSearchAnswer

    public private(set) var model = WorkSearchModel()

    @ObservationIgnored private var asks: [Task<Void, Never>] = []
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private let now: @Sendable () -> ContinuousClock.Instant

    public init(sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }, now: @escaping @Sendable () -> ContinuousClock.Instant = { .now }) {
        self.sleep = sleep
        self.now = now
    }

    /// The rows as the list draws them, and the one a Return on the open Duo's keyboard takes.
    public var rows: [WorkSearchModel.Row] { model.rows() }

    /// A new generation: his words, the kind (nil: every kind) and the hosts. `offline` are hosts with Work on
    /// that cannot be asked, each one quiet line.
    public func search(_ text: String, kind: String? = nil, hosts: [WorkSearchModel.Host], offline: [String] = [], ask: @escaping Ask) {
        cancel()
        model = model.begin(text: text, kind: kind, hosts: hosts, offline: offline)
        let gen = model.gen
        let typedAt = now()
        for host in hosts {
            let params = model.params(for: host)
            asks.append(Task { [weak self] in
                let answer: WorkSearchAnswer
                do {
                    answer = try await self?.timed { try await ask(host.id, params) } ?? WorkSearchAnswer(groups: [], pending: [], quiet: [])
                } catch {
                    guard let self, !Task.isCancelled else { return }
                    self.model = self.model.failed(gen: gen, host: host.id, source: nil)
                    return
                }
                guard let self, !Task.isCancelled else { return }
                let landed = self.model.landInstant(gen: gen, host: host.id, answer)
                self.model = landed.model
                guard !landed.ask.isEmpty, gen == self.model.gen else { return }
                let waited = self.now() - typedAt
                if waited < WorkSearch.networkWait {
                    do { try await self.sleep(WorkSearch.networkWait - waited) } catch { return }
                }
                guard !Task.isCancelled, gen == self.model.gen else { return }
                for one in landed.ask {
                    let params = self.model.params(for: host, sources: [one.source])
                    self.asks.append(Task { [weak self] in
                        do {
                            let found = try await self?.timed { try await ask(host.id, params) }
                            guard let self, let found, !Task.isCancelled else { return }
                            self.model = self.model.landSource(gen: gen, host: host.id, source: one.source, found)
                        } catch {
                            guard let self, !Task.isCancelled else { return }
                            self.model = self.model.failed(gen: gen, host: host.id, source: one)
                        }
                    })
                }
            })
        }
    }

    /// One ask, given `WorkSearch.askWait`: a host that says nothing by then is its quiet line. Whichever ends
    /// first answers; the other is cancelled.
    private func timed(_ work: @escaping @MainActor () async throws -> WorkSearchAnswer) async throws -> WorkSearchAnswer {
        let sleep = self.sleep
        let once = AskOnce()
        let job = Task { @MainActor in
            do { once.finish(.success(try await work())) } catch { once.finish(.failure(error)) }
        }
        let timer = Task { @MainActor in
            try? await sleep(WorkSearch.askWait)
            job.cancel()
            once.finish(.failure(CancellationError()))
        }
        defer {
            job.cancel()
            timer.cancel()
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { once.wait($0) }
        } onCancel: {
            job.cancel()
            timer.cancel()
        }
    }

    /// An arrow on the open Duo's keyboard.
    public func step(by: Int) { model = model.step(rows, by: by) }

    /// Nothing still out is waited on: the scope left, the tab closed.
    public func cancel() {
        for task in asks { task.cancel() }
        asks = []
    }
}

/// One ask's answer or its wait's end, whichever comes first, given to the caller once.
@MainActor private final class AskOnce {
    private var result: Result<WorkSearchAnswer, any Error>?
    private var waiting: CheckedContinuation<WorkSearchAnswer, any Error>?

    func wait(_ continuation: CheckedContinuation<WorkSearchAnswer, any Error>) {
        if let result { continuation.resume(with: result) } else { waiting = continuation }
    }

    func finish(_ result: Result<WorkSearchAnswer, any Error>) {
        guard self.result == nil else { return }
        self.result = result
        waiting?.resume(with: result)
        waiting = nil
    }
}

/// Who a Work search asks, and how a hit opens on the phone.
public nonisolated enum WorkSearchHosts {
    public struct Input: Sendable, Hashable {
        public var id: String
        public var name: String
        public var platform: String?
        public var workOn: Bool
        public var open: Bool
        /// The key may ask `work.search.query` on this lane.
        public var may: Bool

        public init(id: String, name: String, platform: String?, workOn: Bool, open: Bool, may: Bool) {
            self.id = id
            self.name = name
            self.platform = platform
            self.workOn = workOn
            self.open = open
            self.may = may
        }
    }

    /// The hosts to ask, the Work home first (the desktop's `workHome`: the box, else the first), and the hosts
    /// with Work on that are not connected, each as its quiet line's words ("Purdue laptop is offline"), as the
    /// desktop's `searchHosts` gives them. A key that may not search a host leaves it out: a host
    /// would only refuse it. When the home is not connected the first host that is stands in, so LifeOS is
    /// still asked once.
    public static func hosts(_ inputs: [Input]) -> (hosts: [WorkSearchModel.Host], offline: [String]) {
        let on = inputs.filter { $0.workOn && $0.may }
        let home = (on.first { $0.platform == "linux" } ?? on.first)?.id
        var hosts = on.filter(\.open).map { WorkSearchModel.Host(id: $0.id, name: $0.name, home: $0.id == home) }
        if !hosts.isEmpty, !hosts.contains(where: \.home) { hosts[0].home = true }
        return (hosts.filter(\.home) + hosts.filter { !$0.home }, on.filter { !$0.open }.map { "\($0.name) is offline" })
    }

    /// The Work scope is offered while some host with Work on lets this key search it.
    public static func offered(_ inputs: [Input]) -> Bool { inputs.contains { $0.workOn && $0.may } }
}

/// Where a hit opens on the phone (docs/agents/ios-client.md "Search's Work scope"); nil: the phone has no place
/// for it, so its row is shown but is not a button.
public nonisolated enum WorkSearchTarget: Sendable, Equatable {
    case route(Route)
    /// A file: seated through `work.files.open` on the job's host, then opened as the item the host made.
    case file(environmentId: String, workspaceId: String, ref: JSONValue, name: String, key: String)

    public static func of(_ hit: WorkSearchHit, environmentId: String) -> Self? {
        let job = hit.workspaceId.flatMap { $0.isEmpty ? nil : $0 }
        switch hit.open {
        case .thread(let thread):
            return .route(.thread(environmentId: environmentId, sessionId: thread.sessionId, seq: thread.seq))
        case .file(let file):
            guard let job, let ref = file.ref else { return nil }
            let key = hit.key.hasPrefix("file:") ? String(hit.key.dropFirst(5)) : hit.key
            return .file(environmentId: environmentId, workspaceId: job, ref: ref, name: file.name, key: key)
        case .view(let view):
            if let place = WorkPlace(rawValue: view.view), WorkPlace.shipped.contains(place), job == nil { return .route(.place(place)) }
            guard let job else { return nil }
            let at = { (name: String) in string(view.with?[name]) }
            switch view.view {
            case "people": return at("person").map { .route(.person(environmentId: environmentId, workspaceId: job, personId: $0)) }
            case "messages": return at("chat").map { .route(.chat(environmentId: environmentId, workspaceId: job, chatId: $0)) }
            case "agenda", "prep": return at("event").map { .route(.prep(environmentId: environmentId, workspaceId: job, eventId: $0)) }
            default:
                if DigestModel.phoneViews.contains(view.view) { return .route(.workView(environmentId: environmentId, workspaceId: job, view: view.view)) }
                return nil
            }
        case .chip(let found):
            let chip = found.chip
            if case .held = chip.kind, let id = workId(chip.ref, pillar: "outbox") {
                return .route(.outboxItem(environmentId: environmentId, ref: "host:\(id)"))
            }
            guard let job, let row = lifeosRef(chip.ref) else { return nil }
            let id = row.id
            switch row.table {
            case "tasks": return .route(.workView(environmentId: environmentId, workspaceId: job, view: "tasks"))
            case "events": return .route(.prep(environmentId: environmentId, workspaceId: job, eventId: id))
            case "people": return .route(.person(environmentId: environmentId, workspaceId: job, personId: id))
            default: return nil
            }
        case .unknown:
            return nil
        }
    }

    private static func string(_ value: WorkSearchOpen.Case0.With?) -> String? {
        guard case .value(let scalar) = value else { return nil }
        switch scalar {
        case .string(let s): return s.isEmpty ? nil : s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool, .unknown: return nil
        }
    }

    /// A chip's ref read as JSON, which survives whichever union case the generator made of it.
    private static func refObject(_ ref: some Encodable) -> [String: JSONValue]? {
        guard let data = try? JSONEncoder().encode(ref), case .object(let object)? = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        return object
    }

    private static func workId(_ ref: some Encodable, pillar: String) -> String? {
        guard let o = refObject(ref), o["at"] == .string("work"), o["pillar"] == .string(pillar), case .string(let id)? = o["id"] else { return nil }
        return id
    }

    private static func lifeosRef(_ ref: some Encodable) -> (table: String, id: String)? {
        guard let o = refObject(ref), o["at"] == .string("lifeos"), case .string(let table)? = o["table"], case .string(let id)? = o["id"] else { return nil }
        return (table, id)
    }
}
