import SwiftUI
import TempCodeClient
import TempCodeContract
import UIKit

/// His reply's Send on the phone (docs/agents/work-messages.md "The phone"), the Outbox's rule for every outward
/// press: refused at once with no link; the owner's check (`PressGates`) once an attempt; then five seconds with
/// Undo in which the host hears nothing (`SendWait`); then, if the link and the key still hold, one
/// `work.messages.send` with a fresh attempt key the host answers once, written to `PressLedger` before it leaves.
/// Going to the background or losing the link inside the five seconds puts the words back and says so. The words
/// live in the conversation's `ReplyDesk` (`MessagesDesks`), which this drives.
@MainActor @Observable
final class MessagesPresses {
    /// One press of his Send in one conversation.
    nonisolated struct Press: Sendable, Hashable {
        var key: String
        var environmentId: String
        var workspaceId: String
        var chatId: String
        var attempt: String
        var words: String
        /// The conversation's name, for the line said off it ("Not sent to Dana Lee: …").
        var name: String
    }

    typealias Wait = SendWait<Press>

    static let shared = MessagesPresses()

    private(set) var wait = Wait()
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var clients: (String) -> EnvironmentClient? = { _ in nil }
    @ObservationIgnored private var background: NSObjectProtocol?
    private let desks = MessagesDesks.shared
    /// The conversations on screen now, counted by desk key (ChatScreen's task): a reply put back or refused in one he
    /// left is also the sticky toast, as Mail's and the Outbox's are.
    private var showing: [String: Int] = [:]
    /// Each conversation's name as he last sent in it, for a line said off it after a late read-back.
    @ObservationIgnored private var names: [String: String] = [:]

    private init() {
        // Leaving the screen cancels what waits: nothing goes early, nothing goes unseen.
        background = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { MessagesPresses.shared.leftScreen() }
        }
    }

    func attach(_ clients: @escaping (String) -> EnvironmentClient?) {
        self.clients = clients
        // A reply read back late (a lost answer) is said off its conversation too, as the direct answer is.
        MessagesDesks.heardLate = { key, state in MessagesPresses.shared.heardLate(key, state) }
    }

    /// Counts the conversation as on screen until the calling view's task ends.
    func shown(_ key: String) async {
        showing[key, default: 0] += 1
        TickLedger.begin("chat.shown"); defer { TickLedger.end("chat.shown") }
        while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
        showing[key, default: 1] -= 1
        if showing[key] == 0 { showing[key] = nil }
    }

    /// The words go back into their field; and when that conversation is not on screen, the line is also the sticky
    /// toast, named, so a reply that did not go is seen wherever he is.
    private func putBack(_ press: Press, _ line: String) {
        desks.update(press.key) { $0.putBack(line) }
        tellOff(press, line)
    }

    private func heardLate(_ key: String, _ state: PressState) {
        guard let line = MessagesRules.lateLine(state),
              let named = MessagesRules.offLine(line, name: names[key] ?? "", shown: showing[key, default: 0] > 0) else { return }
        FleetToastCenter.shared.post(message: named)
    }

    private func tellOff(_ press: Press, _ line: String) {
        guard let named = MessagesRules.offLine(line, name: press.name, shown: showing[press.key, default: 0] > 0) else { return }
        FleetToastCenter.shared.post(message: named)
    }

    /// The press counting its five seconds while its conversation is off screen (he went Back, or to another tab):
    /// the tab's foot shows its Undo instead (`ElsewhereUndo`).
    var offScreenCounting: Wait.Press? {
        wait.countingOffScreen { showing[$0.payload.key, default: 0] > 0 }
    }

    /// The press counting its five seconds in this conversation, for its capsule.
    func counting(_ key: String) -> Wait.Press? {
        wait.counting?.payload.key == key ? wait.counting : nil
    }

    /// His Send. Nil: the words wait their five seconds. Else the line that says why nothing started.
    func send(key: String, client: EnvironmentClient, workspaceId: String, chatId: String, chatName: String) async -> String? {
        guard OutboxPresses.linked(client) else { return PendingPresses.notConnected(client.environment.name) }
        let ref = ChatPress.ref(workspaceId: workspaceId, chatId: chatId)
        if client.work.presses.busy(host: client.environment.id, ref: ref) { return PressState.checking.line }
        let words = desks.desk(key).words
        guard desks.desk(key).canSend else { return nil }
        // Frozen before the check: the host and its key. The check's pass holds only for them (`PressGates.allow`).
        let frozen = PressGates.key(client.environment, revoked: client.work.keyRevoked)
        if let line = await PressGates.shared.pass(client, .messagesSend, ref: ref, rev: String(words.hashValue), reason: "Send to \(chatName)") {
            return line
        }
        // The words the check was asked for are the words that wait: a field changed meanwhile sends nothing, and keeps
        // what he typed.
        guard desks.desk(key).words == words else { return "Not sent: the words changed while you were asked. Press Send again." }
        let attempt = ChatPress.newAttempt()
        guard let out = desks.update(key, { $0.press(attempt: attempt) }) else { return nil }
        let press = Press(key: key, environmentId: client.environment.id, workspaceId: workspaceId, chatId: chatId, attempt: attempt, words: out.words, name: chatName)
        names[key] = chatName
        wait.press(Wait.Press(id: attempt, host: client.environment.id, hostName: client.environment.name, rev: 0, line: "Sending to \(chatName)", payload: press, key: frozen), now: Self.now)
        if wait.counting?.id == attempt {
            AccessibilityNotification.Announcement("Sending to \(chatName). Undo for five seconds.").post()
        }
        schedule()
        watchLinks()
        return nil
    }

    /// Undo inside the five seconds: nothing was sent, the words go back into the field.
    func undo() {
        guard let press = wait.undo(now: Self.now) else { return }
        desks.update(press.payload.key) { $0.undo() }
        schedule()
    }

    private func leftScreen() {
        let held = [wait.counting].compactMap { $0 } + wait.queued
        wait.leftScreen()
        for press in held { putBack(press.payload, "Not sent: TempCode left the screen") }
        schedule()
    }

    // MARK: - the clock

    private static var now: Double { Date().timeIntervalSince1970 }

    private func schedule() {
        timer?.cancel()
        guard let deadline = wait.deadline else { return }
        timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, deadline - Self.now)))
            guard !Task.isCancelled else { return }
            self?.fire()
        }
    }

    private func fire() {
        guard let counting = wait.counting else { return }
        guard let client = clients(counting.host) else {
            wait.drop(counting.id, why: .notPaired, now: Self.now)
            putBack(counting.payload, "Not sent: the host is not paired")
            return schedule()
        }
        let check = Wait.Check(linked: OutboxPresses.linked(client), maySend: client.work.may(.messagesSend), rev: 0, key: PressGates.shared.liveKey(counting.host))
        guard let press = wait.due(now: Self.now, check: check) else {
            if let notice = wait.notice, notice.presses.contains(where: { $0.id == counting.id }) {
                putBack(counting.payload, notice.line)
            }
            return schedule()
        }
        let p = press.payload
        desks.update(p.key) { $0.dispatched() }
        Task {
            let answer: ReplyDesk.Answer
            do {
                _ = try await client.work.sendReply(workspaceId: p.workspaceId, chatId: p.chatId, text: p.words, attempt: p.attempt, key: press.key)
                answer = .sent
            } catch is PressLedger.Unknown {
                answer = .unknown
            } catch {
                let words = ActionError.wrap(error).message
                answer = words.hasPrefix(MessagesRules.mayHaveGone) ? .mayHaveGone(words) : .refused(words)
            }
            desks.update(p.key) { $0.answered(answer) }
            switch answer {
            case .refused(let words): tellOff(p, "Not sent: \(words)")
            case .mayHaveGone(let words): tellOff(p, words)
            case .sent, .unknown: break
            }
            wait.landed(press.id, now: Self.now)
            schedule()
            watchLinks()
        }
    }

    // MARK: - the link

    /// A waiting press's link or key changing: a lost one puts that host's words back.
    private func watchLinks() {
        let hosts = Set(([wait.counting].compactMap { $0 } + wait.queued).map(\.host))
        guard !hosts.isEmpty else { return }
        withObservationTracking {
            for host in hosts {
                if let client = clients(host) { _ = (OutboxPresses.linked(client), client.work.may(.messagesSend)) }
            }
        } onChange: { [weak self] in
            Task { @MainActor in self?.recheck(hosts) }
        }
    }

    private func recheck(_ hosts: Set<String>) {
        for host in hosts {
            let held = ([wait.counting].compactMap { $0 } + wait.queued).filter { $0.host == host }
            let client = clients(host)
            if client.map(OutboxPresses.linked) != true {
                wait.linkLost(host: host, now: Self.now)
            } else if client?.work.may(.messagesSend) != true {
                wait.keyLost(host: host, now: Self.now)
            } else {
                continue
            }
            let line = wait.notice?.line ?? "Not sent"
            for press in held { putBack(press.payload, line) }
        }
        schedule()
        watchLinks()
    }
}
