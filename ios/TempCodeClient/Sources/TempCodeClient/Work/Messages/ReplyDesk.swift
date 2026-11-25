import Foundation
import Observation

/// His reply in one conversation on the phone (docs/agents/work-messages.md "The phone"): the words in the field, a
/// Send on its way, and what came of it. Pure: the app's `MessagesPresses` runs the five seconds (`SendWait`), the
/// owner's check and the host; this keeps his words.
///
/// The rules, as the desktop's composer keeps them: Send empties the field at the press and nothing goes twice;
/// Undo inside the five seconds puts the words back before whatever he typed since, a line between; a refusal does
/// the same and says why; an answer that did not come keeps the words aside under "Checking…" until the host is read
/// back by the press's attempt key, and words that may have gone are never put back under a plain Send: they wait
/// aside until he presses Use Words.
public struct ReplyDesk: Sendable, Hashable {
    /// A Send of his, from the press until the host's answer.
    public struct Out: Sendable, Hashable {
        public enum Phase: Sendable, Hashable {
            /// Its five seconds, with Undo.
            case counting
            /// Gone to the host.
            case sending
            /// No answer came: read back by `attempt` on the next link.
            case checking
        }

        /// The key the host answers this press once by (`work.messages.send {attempt}`).
        public var attempt: String
        public var words: String
        public var phase: Phase
    }

    public var field: String
    public private(set) var out: Out?
    /// Words that may have gone, oldest first: kept off the field until he asks for them.
    public private(set) var aside: [String] = []
    /// Why the last press did not go, until he types or presses again.
    public private(set) var refusal: String?

    public init(field: String = "") {
        self.field = field
    }

    /// What the field holds, as a press would send it.
    public var words: String { field.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Send can be pressed: words within LifeOS's limit, and no press of his on its way here.
    public var canSend: Bool { !words.isEmpty && words.count <= MessagesRules.replyMax && out == nil }

    /// The line under the field while a press is out or after one did not go.
    public var line: String? {
        switch out?.phase {
        case .checking: return PressState.checking.line
        case .sending: return PressState.sending.line
        case .counting, nil: break
        }
        if let refusal { return refusal }
        return aside.isEmpty ? nil : "May have gone. Check above before sending it again."
    }

    /// He typed: the old refusal goes.
    public mutating func type(_ text: String) {
        field = text
        refusal = nil
    }

    /// His Send: the field's words leave it under `attempt`. Nil: nothing to send, or one is already out.
    public mutating func press(attempt: String) -> Out? {
        guard canSend else { return nil }
        let press = Out(attempt: attempt, words: words, phase: .counting)
        out = press
        field = ""
        refusal = nil
        return press
    }

    /// Undo inside the five seconds: nothing was sent, the words come back before what he typed since.
    public mutating func undo() {
        guard let press = out, press.phase == .counting else { return }
        out = nil
        field = Self.join(press.words, field)
    }

    /// The five seconds did not end in a send (the app left the screen, the link dropped): back, saying why.
    public mutating func putBack(_ line: String) {
        guard let press = out, press.phase == .counting else { return }
        out = nil
        field = Self.join(press.words, field)
        refusal = line
    }

    /// The five seconds ended and the press went to the host.
    public mutating func dispatched() {
        guard out?.phase == .counting else { return }
        out?.phase = .sending
    }

    /// What the host said of the press.
    public enum Answer: Sendable, Hashable {
        /// LifeOS took it: its own row now shows it, Sending with Undo.
        case sent
        /// Refused in the host's or LifeOS's words: nothing went.
        case refused(String)
        /// The host's "It may have gone": its words.
        case mayHaveGone(String)
        /// No answer came (`PressLedger.Unknown`): read back on the next link.
        case unknown
    }

    public mutating func answered(_ answer: Answer) {
        guard let press = out, press.phase != .counting else { return }
        switch answer {
        case .sent:
            out = nil
        case .refused(let words):
            out = nil
            field = Self.join(press.words, field)
            refusal = words.isEmpty ? "Not sent" : words
        case .mayHaveGone:
            out = nil
            aside.append(press.words)
        case .unknown:
            out?.phase = .checking
        }
    }

    /// The host read back by the attempt key (`PressLedger`'s state for it): sent, never got it, refused, or unknown.
    public mutating func readBack(attempt: String, state: PressState) {
        guard let press = out, press.attempt == attempt else { return }
        switch state {
        case .done, .gone:
            out = nil
        case .stillWaiting, .changed:
            // The host never had it: his words are his to send again.
            out = nil
            field = Self.join(press.words, field)
            refusal = "Not sent"
        case .failed(let words):
            out = nil
            field = Self.join(press.words, field)
            refusal = PressState.failed(words).line
        case .mayHaveGone:
            out = nil
            aside.append(press.words)
        case .sending, .checking:
            break
        }
    }

    /// A press of his read back after a relaunch, with its words no longer on this iPhone (the record keeps no words):
    /// the line says what became of it, never silently.
    public mutating func readBackWithoutWords(_ state: PressState) {
        switch state {
        case .stillWaiting, .changed, .gone: refusal = Self.wordsLostLine
        case .failed(let words): refusal = "\(PressState.failed(words).line ?? "Not sent"). The words were not kept on this iPhone."
        case .mayHaveGone: refusal = "May have gone. Check above before sending it again."
        case .done, .sending, .checking: break
        }
    }

    public static let wordsLostLine = "Not sent. The words were not kept on this iPhone."

    /// His reply taken back inside LifeOS's undo time (`work.messages.undo`): its words, before what he typed since.
    public mutating func takeBack(_ words: String) {
        guard !words.isEmpty else { return }
        field = Self.join(words, field)
        refusal = nil
    }

    /// Use Words: what may have gone, oldest first, a line apart, before what he typed since; the line goes.
    public mutating func useWords() {
        guard !aside.isEmpty else { return }
        field = Self.join(aside.joined(separator: "\n"), field)
        aside = []
    }

    /// Words put back before what he typed since, a line between.
    static func join(_ back: String, _ typed: String) -> String {
        typed.isEmpty ? back : "\(back)\n\(typed)"
    }
}

/// Every conversation's desk on this phone, by `MessagesDesks.key`, while the app runs. The read-back of a press
/// whose answer was lost lands here by its attempt key (`WorkHost.checkChatPresses`).
@MainActor @Observable
public final class MessagesDesks {
    public static let shared = MessagesDesks()

    public private(set) var desks: [String: ReplyDesk] = [:]

    public init() {}

    /// One conversation of one job on one host.
    public nonisolated static func key(environmentId: String, workspaceId: String, chatId: String) -> String {
        "\(environmentId)|\(workspaceId)|\(chatId)"
    }

    public func desk(_ key: String) -> ReplyDesk { desks[key] ?? ReplyDesk() }

    @discardableResult
    public func update<T>(_ key: String, _ change: (inout ReplyDesk) -> T) -> T {
        var desk = desks[key] ?? ReplyDesk()
        let out = change(&desk)
        desks[key] = desk
        return out
    }

    /// A press read back on its host's link: the desk whose press it was says what became of it. A press no desk holds
    /// (a relaunch since: the record kept no words) still says so on its conversation's desk (`host`, `ref`).
    public func readBack(attempt: String, state: PressState, host: String? = nil, ref: String? = nil) {
        let holders = desks.filter { $0.value.out?.attempt == attempt }.map(\.key)
        for key in holders {
            update(key) { $0.readBack(attempt: attempt, state: state) }
            Self.heardLate?(key, state)
        }
        guard holders.isEmpty, let host, let ref, let workspaceId = ChatPress.workspace(ofRef: ref), let chatId = ChatPress.chat(ofRef: ref) else { return }
        let key = Self.key(environmentId: host, workspaceId: workspaceId, chatId: chatId)
        update(key) { $0.readBackWithoutWords(state) }
        Self.heardLate?(key, state)
    }

    /// A read-back said on its conversation, by desk key: the app says it off the conversation too when that one is
    /// not on screen (`MessagesPresses`, `MessagesRules.lateLine`).
    public static var heardLate: (@MainActor (String, PressState) -> Void)?
}
