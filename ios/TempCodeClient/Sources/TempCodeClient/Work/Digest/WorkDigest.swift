import Foundation
import Observation
import TempCodeContract

/// The digest's ledger on one host (docs/agents/work-digest.md "The phone"):
/// read when the Digest screen first opens (`load`), kept by the
/// `work.digest` push from then on, read again when a day is made. Settings
/// → Work reads the settings alone (`readSettings`).
@MainActor @Observable
public final class WorkDigest {
    /// nil until `work.digest.list` answered on this socket.
    public private(set) var ledger: DigestModel.Ledger?
    /// The settings as the host last said them; read on their own by Settings.
    public private(set) var settings: DigestSettings?
    /// The last read's error; nil while reading or once it answered.
    public private(set) var error: String?

    @ObservationIgnored private let socket: TempCodeSocket
    /// Days he opened here that the host has not taken yet, with when: said again on the next socket and laid over
    /// every read until then, so a reconnect never brings back as unseen a day he saw (the desktop's `pendingSeen`).
    @ObservationIgnored private var pendingSeen: [String: Double] = [:]

    init(socket: TempCodeSocket) {
        self.socket = socket
    }

    /// The list and the settings, together.
    public func load() async {
        do {
            async let list = socket.request(Methods.WorkDigestList.self, .init())
            async let get = socket.request(Methods.WorkDigestGet.self, .init())
            let (answer, current) = try await (list, get)
            var read = DigestModel.Ledger(days: answer.days, rows: answer.rows, settings: current)
            for (day, at) in pendingSeen { read.seen(day, at: at) }
            ledger = read
            settings = current
            error = nil
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }

    public func readSettings() async throws {
        settings = try await socket.request(Methods.WorkDigestGet.self, .init())
    }

    /// The pushes. Rows and days before the first read are the read's to bring.
    func apply(_ push: WorkDigestPush) {
        if let next = push.settings { settings = next }
        guard var held = ledger else { return }
        let reread = held.apply(push)
        ledger = held
        if reread { Task { await self.load() } }
    }

    /// He opened the digest with this day in it.
    public func seen(_ day: String) async {
        let at = pendingSeen[day] ?? Date.now.timeIntervalSince1970 * 1000
        ledger?.seen(day, at: at)
        pendingSeen[day] = at
        // Kept until the host answers: a dropped link leaves it pending, said again by `reconnected`.
        do {
            _ = try await socket.request(Methods.WorkDigestSeen.self, .init(day: day))
            pendingSeen[day] = nil
        } catch {}
    }

    /// Writes the time or one group's level on this host; the host keeps only what differs from `clock`.
    @discardableResult
    public func set(at: String? = nil, levels: [String: TellLevel]? = nil) async throws -> DigestSettings {
        let next = try await socket.request(Methods.WorkDigestSet.self, .init(at: at, levels: levels))
        settings = next
        ledger?.settings = next
        return next
    }

    /// Work went off on the host. The ledger goes; a seen mark the host has not taken does not.
    func clear() {
        ledger = nil
        settings = nil
        error = nil
        // A day he saw that the host has not taken stays pending through Work off: said when Work is on again.
    }

    /// A new socket: a ledger read before is read again; one never read waits for the screen.
    func reconnected() async {
        for day in pendingSeen.keys.sorted() { await seen(day) }
        if ledger != nil || error != nil { await load() }
    }

    /// One change written to every host with Work on, at once; answers each host that refused, with why, by environment id.
    public static func setAll(_ hosts: [(environmentId: String, digest: WorkDigest)], at: String? = nil, levels: [String: TellLevel]? = nil) async -> [String: String] {
        // One task per host, all started before the first is awaited. A task group's main-actor child here
        // stops Swift 6.4's region checker ("a pattern it does not understand").
        let writes = hosts.map { host in
            (host.environmentId, Task { @MainActor in _ = try await host.digest.set(at: at, levels: levels) })
        }
        var refused: [String: String] = [:]
        for (id, write) in writes {
            do { try await write.value } catch { refused[id] = ActionError.wrap(error).message }
        }
        return refused
    }
}
