import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// His chat reply through the phone's record of presses (Work/Outbox/PressLedger.swift with the attempt key of
/// Work/Messages/ChatPress.swift): written down with its key before it leaves, a lost answer Checking, then
/// read back by the key on the next link, the read never sending.
@Suite @MainActor struct MessagesPressTests {
    private static func ledger(_ file: URL?) -> PressLedger {
        PressLedger(file: file, now: { 100 }, wait: { _ in try? await Task.sleep(for: .seconds(3600)) })
    }

    private static func file() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("messages-press-\(UUID().uuidString)").appendingPathComponent(PressLedger.fileName)
    }

    private static let ref = ChatPress.ref(workspaceId: "w1", chatId: "c1")

    /// A reply whose answer the socket lost after it left: Checking, with its key on disk.
    private func lost(_ ledger: PressLedger, attempt: String = "phone-a1") async {
        do {
            _ = try await ledger.run(.chatReply, host: "box", hostName: "The box", ref: Self.ref, rev: nil, attempt: attempt, linked: true) { () async throws -> String in
                throw TransportError.cancelled
            }
            Issue.record("a lost answer threw nothing")
        } catch {
            #expect(error is PressLedger.Unknown)
        }
    }

    @Test func `a reply is written down with its attempt key before it leaves; a second press there waits`() async throws {
        let file = Self.file()
        let ledger = Self.ledger(file)
        await lost(ledger)
        #expect(PendingPresses.load(from: file, now: 0).presses.map(\.attempt) == ["phone-a1"])
        #expect(ledger.state(host: "box", ref: Self.ref) == .checking)
        await #expect(throws: ActionError.self) {
            try await ledger.run(.chatReply, host: "box", hostName: "The box", ref: Self.ref, rev: nil, attempt: "phone-a2", linked: true) { "out_2" }
        }
    }

    @Test func `the Outbox's read-back leaves a chat reply alone; the key's read settles it`() async {
        let ledger = Self.ledger(Self.file())
        await lost(ledger)
        var read: [String] = []
        await ledger.check(host: "box") { press in
            read.append(press.ref)
            return nil
        }
        #expect(read.isEmpty)
        #expect(ledger.busy(host: "box", ref: Self.ref))
        var asked: [String?] = []
        let resolved = await ledger.check(host: "box", where: { $0 == .chatReply }) { press in
            asked.append(press.attempt)
            return PressTruth.chat(MessagesAttempt(state: .sent, id: "out_1"), rev: press.rev)
        }
        #expect(asked == ["phone-a1"])
        #expect(resolved.map(\.state) == [.done])
        #expect(!ledger.busy(host: "box", ref: Self.ref) && ledger.state(host: "box", ref: Self.ref) == nil)
    }

    @Test func `a key the host never heard is his to send again; a refusal says its words; still sending stays Checking`() async {
        let never = Self.ledger(Self.file())
        await lost(never)
        let a = await never.check(host: "box", where: { $0 == .chatReply }) { PressTruth.chat(MessagesAttempt(state: .none), rev: $0.rev) }
        #expect(a.map(\.state) == [.stillWaiting])

        let refused = Self.ledger(Self.file())
        await lost(refused)
        let b = await refused.check(host: "box", where: { $0 == .chatReply }) { _ in PressTruth.chat(MessagesAttempt(state: .refused, words: "Too long"), rev: nil) }
        #expect(b.map(\.state) == [.failed("Too long")])

        let waiting = Self.ledger(Self.file())
        await lost(waiting)
        let c = await waiting.check(host: "box", where: { $0 == .chatReply }) { _ in PressTruth.chat(MessagesAttempt(state: .sending), rev: nil) }
        #expect(c.map(\.state) == [.checking])
        #expect(waiting.busy(host: "box", ref: Self.ref))

        // A read that fails leaves it for the next link.
        let d = await waiting.check(host: "box", where: { $0 == .chatReply }) { _ in throw TransportError.cancelled }
        #expect(d.isEmpty && waiting.busy(host: "box", ref: Self.ref))
    }

    @Test func `the host's answer by key, as the phone reads it`() {
        #expect(PressTruth.chat(MessagesAttempt(state: .sent, id: "o"), rev: nil) == .done)
        #expect(PressTruth.chat(MessagesAttempt(state: .none), rev: "r") == .waiting(rev: "r"))
        #expect(PressTruth.chat(MessagesAttempt(state: .sending), rev: nil) == nil)
        #expect(PressTruth.chat(MessagesAttempt(state: .refused, words: "No"), rev: nil) == .failed("No"))
        #expect(PressTruth.chat(MessagesAttempt(state: .unknown, words: "It may have gone"), rev: nil) == .mayHaveGone)
        #expect(PressTruth.chat(MessagesAttempt(state: .unrecognized("later")), rev: nil) == .mayHaveGone)
    }

    @Test func `a chat's file is seated in the job's Messages pane as the mail arm from chat`() throws {
        #expect(ChatPress.pane(workspaceId: "w1") == "msgpane_w1")
        let file = ChatFile(id: "f1", name: "plan.pdf", contentType: "application/pdf", size: 1200, status: .stored)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ChatPress.fileSource(chatId: "c1", messageId: "m1", file: file))) as? [String: Any]
        #expect(json?["at"] as? String == "mail")
        #expect(json?["from"] as? String == "chat")
        #expect(json?["threadId"] as? String == "c1" && json?["messageId"] as? String == "m1" && json?["partId"] as? String == "f1")
        #expect(json?["size"] as? Int == 1200)
    }

    @Test func `a chat ref names its job; each press has a fresh key`() {
        #expect(Self.ref == "chat:w1:c1")
        #expect(ChatPress.workspace(ofRef: Self.ref) == "w1")
        #expect(ChatPress.workspace(ofRef: "chat:w1:c:1") == "w1")
        #expect(ChatPress.workspace(ofRef: "host:h1") == nil)
        #expect(ChatPress.workspace(ofRef: "chat::c1") == nil)
        let a = ChatPress.newAttempt(), b = ChatPress.newAttempt()
        #expect(a != b && a.hasPrefix("phone-") && (8...64).contains(a.count))
    }
}
