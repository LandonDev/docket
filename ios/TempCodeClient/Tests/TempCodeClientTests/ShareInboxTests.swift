import Foundation
import Testing
@testable import TempCodeClient

/// A clock a test moves by hand.
final class ShareClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date = Date()

    func now() -> Date { lock.withLock { date } }
    func advance(_ seconds: TimeInterval) { lock.withLock { date += seconds } }
}

/// A fresh folder standing in for the app group, and a file to share from it.
struct ShareRig {
    let root: URL
    let clock = ShareClock()
    let inbox: ShareInbox
    let destination = ShareDestination(hostId: "box", workspaceId: "w1", folder: .top(name: "Dummy Esports"))

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("share-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let clock = clock
        inbox = ShareInbox(root: root.appendingPathComponent("group"), now: { clock.now() })
    }

    func file(_ data: Data, named name: String = "photo.jpeg") throws -> URL {
        let folder = root.appendingPathComponent("from-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(name)
        try data.write(to: url)
        return url
    }

    func add(_ data: Data, named name: String = "photo.jpeg", as given: String? = nil, to destination: ShareDestination? = nil) throws -> ShareItem {
        try inbox.add(try file(data, named: name), to: destination ?? self.destination, name: given)
    }

    var itemsDir: URL { root.appendingPathComponent("group/items", isDirectory: true) }

    /// The same queue as another process sees it: its own claims, the same clock.
    func process(_ holder: String) -> ShareInbox {
        let clock = clock
        return ShareInbox(root: root.appendingPathComponent("group"), now: { clock.now() }, holder: holder)
    }

    /// What a send that the host refused leaves: claimed, then marked.
    func refuse(_ item: ShareItem, _ words: String, final: Bool = false) throws {
        _ = try #require(inbox.claim(item.id))
        try inbox.mark(item.id, .refused, words: words, isFinal: final)
    }
}

@Suite struct ShareInboxTests {
    @Test func `what a host refused is listed for its own workspace alone`() throws {
        let rig = try ShareRig()
        let mine = try rig.add(Data("a".utf8), named: "a.txt")
        let other = try rig.add(Data("b".utf8), named: "b.txt", to: ShareDestination(hostId: "box", workspaceId: "w2", folder: .top(name: "Unify")))
        let waiting = try rig.add(Data("c".utf8), named: "c.txt")
        try rig.refuse(mine, "Receipts is not there any more.")
        try rig.refuse(other, "No.")
        #expect(rig.inbox.refused(hostId: "box", workspaceId: "w1").map(\.id) == [mine.id])
        #expect(rig.inbox.refused(hostId: "box", workspaceId: "w1").first?.words == "Receipts is not there any more.")
        #expect(rig.inbox.refused(hostId: "mac", workspaceId: "w1").isEmpty)
        #expect(rig.inbox.item(waiting.id)?.state == .queued)
    }

    @Test func `a shared file is copied byte for byte and its SHA-256 is the file's`() throws {
        let rig = try ShareRig()
        let abc = try rig.add(Data("abc".utf8), named: "abc.txt")
        #expect(abc.sha256 == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(abc.size == 3)
        #expect(abc.name == "abc.txt")
        #expect(abc.state == .queued)
        // A million bytes and more, so the copy runs over several reads.
        let big = Data(repeating: UInt8(ascii: "a"), count: 1_000_000)
        let item = try rig.add(big, named: "a.bin", as: "  Million.bin ")
        #expect(item.sha256 == "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0")
        #expect(item.size == big.count)
        #expect(item.name == "Million.bin", "the name he typed, trimmed")
        #expect(try Data(contentsOf: rig.inbox.payload(item)) == big)
        let mixed = Data((0 ..< 3_000_000).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ $0 >> 9) })
        let copied = try rig.add(mixed, named: "mixed.bin")
        #expect(try Data(contentsOf: rig.inbox.payload(copied)) == mixed)
        #expect(Set(rig.inbox.items().map(\.id)) == [abc.id, item.id, copied.id])
    }

    @Test func `the item keeps where it goes and reads the same from another process`() throws {
        let rig = try ShareRig()
        let folder = ShareFolder(name: "Events", host: "box", path: "/srv/work/Dummy Esports/Events")
        let item = try rig.add(Data("x".utf8), to: ShareDestination(hostId: "box", workspaceId: "w2", folder: folder))
        let other = ShareInbox(root: rig.root.appendingPathComponent("group"))
        #expect(other.items() == [item])
        #expect(item.destination == ShareDestination(hostId: "box", workspaceId: "w2", folder: folder))
        #expect(!item.folder.isTop)
        #expect(rig.destination.folder.isTop)
    }

    @Test func `items are oldest first`() throws {
        let rig = try ShareRig()
        let first = try rig.add(Data("1".utf8))
        rig.clock.advance(1)
        let second = try rig.add(Data("2".utf8))
        rig.clock.advance(1)
        let third = try rig.add(Data("3".utf8))
        #expect(rig.inbox.items().map(\.id) == [first.id, second.id, third.id])
        #expect(first.createdAt < second.createdAt)
    }

    @Test func `a copy cut short leaves no item, and a sweep removes it once it is plainly dead`() throws {
        let rig = try ShareRig()
        let kept = try rig.add(Data("kept".utf8))
        // What a crash mid-copy leaves: the folder and part of the bytes, no manifest.
        let half = rig.itemsDir.appendingPathComponent("half-item", isDirectory: true)
        try FileManager.default.createDirectory(at: half, withIntermediateDirectories: true)
        try Data("par".utf8).write(to: half.appendingPathComponent("payload"))
        #expect(rig.inbox.items().map(\.id) == [kept.id])
        #expect(rig.inbox.item("half-item") == nil)
        rig.inbox.sweep()
        #expect(FileManager.default.fileExists(atPath: half.path), "a copy still running in the other process is left alone")
        rig.clock.advance(ShareInbox.halfGrace + 1)
        rig.inbox.sweep()
        #expect(!FileManager.default.fileExists(atPath: half.path))
        #expect(rig.inbox.items().map(\.id) == [kept.id], "a whole item outlives the sweep")
    }

    @Test func `a file that cannot be read leaves nothing behind`() throws {
        let rig = try ShareRig()
        let missing = rig.root.appendingPathComponent("gone.jpeg")
        #expect(throws: (any Error).self) { try rig.inbox.add(missing, to: rig.destination) }
        let left = (try? FileManager.default.contentsOfDirectory(atPath: rig.itemsDir.path)) ?? []
        #expect(left.isEmpty)
    }

    @Test func `a claim is one process's: sending until it is marked, then free again`() throws {
        let rig = try ShareRig()
        let item = try rig.add(Data("abc".utf8))
        let claimed = try #require(rig.inbox.claim(item.id))
        #expect(claimed.state == .sending)
        #expect(rig.inbox.item(item.id)?.state == .sending)
        #expect(rig.inbox.claim(item.id) == nil, "the other process cannot take it")
        let other = rig.process("app")
        #expect(other.claim(item.id) == nil)
        #expect(throws: (any Error).self, "only the holder marks it") { try other.mark(item.id, .done) }
        #expect(rig.inbox.item(item.id)?.state == .sending)
        try rig.inbox.mark(item.id, .refused, words: "Files cannot take an upload yet.")
        let refused = try #require(rig.inbox.item(item.id))
        #expect(refused.state == .refused)
        #expect(refused.words == "Files cannot take an upload yet.")
        #expect(other.claim(item.id) == nil, "a refused item is not sent until Try Again")
        // Try Again: queued once more, the old words gone, and then it can be claimed.
        #expect(other.retry(item.id))
        #expect(rig.inbox.item(item.id)?.state == .queued)
        #expect(rig.inbox.item(item.id)?.words == nil)
        #expect(other.claim(item.id)?.state == .sending)
    }

    @Test func `Try Again moves a refused item alone, read from disk, and leaves anything else as it is`() throws {
        let rig = try ShareRig()
        let other = rig.process("app")
        let item = try rig.add(Data("abc".utf8))
        #expect(!rig.inbox.retry(item.id), "queued already")
        #expect(rig.inbox.item(item.id)?.state == .queued)
        try rig.refuse(item, "No.", final: true)
        #expect(other.retry(item.id))
        _ = try #require(other.claim(item.id))
        // A row shown before the other process took the item again: its Try Again changes nothing.
        #expect(!rig.inbox.retry(item.id), "another process is sending it")
        #expect(rig.inbox.item(item.id)?.state == .sending)
        try other.mark(item.id, .done)
        #expect(!rig.inbox.retry(item.id), "the host has it")
        #expect(rig.inbox.item(item.id)?.state == .done)
        #expect(!rig.inbox.retry("never-was"))
    }

    @Test func `only the process holding the claim marks an item, also once its claim was taken back`() throws {
        let rig = try ShareRig()
        let other = rig.process("app")
        let item = try rig.add(Data("abc".utf8))
        #expect(throws: (any Error).self, "queued and unclaimed") { try rig.inbox.mark(item.id, .done) }
        #expect(rig.inbox.item(item.id)?.state == .queued)
        _ = try #require(rig.inbox.claim(item.id))
        rig.clock.advance(ShareInbox.claimLease + 1)
        // The first process went quiet past its lease; the other takes the item back and sends it.
        _ = try #require(other.claim(item.id))
        #expect(throws: (any Error).self, "the first process no longer holds it") { try rig.inbox.mark(item.id, .queued) }
        #expect(rig.inbox.item(item.id)?.state == .sending)
        try other.mark(item.id, .done)
        #expect(rig.inbox.item(item.id)?.state == .done)
    }

    @Test func `discard waits out another process's live claim, and takes its own or a dead one`() throws {
        let rig = try ShareRig()
        let other = rig.process("app")
        let item = try rig.add(Data("abc".utf8))
        _ = try #require(other.claim(item.id))
        #expect(!rig.inbox.discard(item.id))
        #expect(rig.inbox.item(item.id)?.state == .sending)
        #expect(other.discard(item.id), "its own claim")
        #expect(rig.inbox.item(item.id) == nil)

        let dead = try rig.add(Data("dead".utf8))
        _ = try #require(other.claim(dead.id))
        rig.clock.advance(ShareInbox.claimLease + 1)
        #expect(rig.inbox.discard(dead.id), "a claim past its lease belongs to a process that died")
        #expect(rig.inbox.item(dead.id) == nil)

        let free = try rig.add(Data("free".utf8))
        #expect(rig.inbox.discard(free.id))
        #expect(rig.inbox.items().isEmpty)
    }

    @Test func `a refusal no retry can change is kept final until Try Again, and an older manifest is not final`() throws {
        let rig = try ShareRig()
        let item = try rig.add(Data("abc".utf8))
        try rig.refuse(item, "The file is no longer on this phone.", final: true)
        let refused = try #require(rig.inbox.item(item.id))
        #expect(refused.isFinal == true)
        #expect(!refused.canRetry)
        #expect(rig.inbox.retry(item.id))
        #expect(rig.inbox.item(item.id)?.canRetry == true)
        // A manifest written before the flag.
        let old = #"{"createdAt":1,"folder":{"name":"Esports"},"hostId":"box","id":"old","name":"a.txt","sha256":"\#(item.sha256)","size":3,"state":"refused","words":"No.","workspaceId":"w1"}"#
        let decoded = try JSONDecoder().decode(ShareItem.self, from: Data(old.utf8))
        #expect(decoded.isFinal == nil)
        #expect(decoded.attempts == nil)
        #expect(decoded.canRetry)
    }

    @Test func `a claim left by a process that died is taken back after its lease`() throws {
        let rig = try ShareRig()
        let item = try rig.add(Data("abc".utf8))
        #expect(rig.inbox.claim(item.id) != nil)
        rig.clock.advance(ShareInbox.claimLease / 2)
        rig.inbox.touch(item.id)
        rig.clock.advance(ShareInbox.claimLease / 2 + 1)
        #expect(rig.inbox.claim(item.id) == nil, "touched within its lease: still held")
        rig.clock.advance(ShareInbox.claimLease)
        #expect(rig.inbox.item(item.id)?.state == .queued)
        #expect(rig.inbox.claim(item.id)?.state == .sending)
    }

    @Test func `done drops the bytes at once and the item at the next sweep; discard drops all of it`() throws {
        let rig = try ShareRig()
        let done = try rig.add(Data("done".utf8))
        rig.clock.advance(1)
        let waiting = try rig.add(Data("waiting".utf8))
        rig.clock.advance(1)
        let refused = try rig.add(Data("refused".utf8))
        _ = rig.inbox.claim(done.id)
        try rig.inbox.mark(done.id, .done)
        #expect(!FileManager.default.fileExists(atPath: rig.inbox.payload(done).path))
        #expect(rig.inbox.item(done.id)?.state == .done)
        try rig.refuse(refused, "No.")
        rig.inbox.sweep()
        #expect(rig.inbox.items().map(\.id) == [waiting.id, refused.id])
        rig.inbox.discard(refused.id)
        #expect(rig.inbox.items().map(\.id) == [waiting.id])
        #expect(!FileManager.default.fileExists(atPath: rig.itemsDir.appendingPathComponent(refused.id).path))
        #expect(throws: (any Error).self) { try rig.inbox.mark(refused.id, .queued) }
    }
}
