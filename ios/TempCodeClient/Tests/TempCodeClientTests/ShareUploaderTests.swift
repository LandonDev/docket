import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A host scripted call by call: what it answers, what it refuses, and every call in order.
final class ShareHost: @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _begun: [Methods.WorkFilesUpload.Params] = []
    var settings = AttachmentSettings(maxBytes: 1_000, chunkBytes: 4)
    var settingsError: (any Error)?
    var beginError: (any Error)?
    /// Thrown by the chunk call with this number (counted from 1 over the whole run), once.
    var chunkFailures: [Int: any Error] = [:]
    var commitError: (any Error)?
    /// Cancels the sending task when the chunk with this index arrives.
    var cancelAtIndex: Int?
    private var chunkCount = 0

    var calls: [String] { lock.withLock { _calls } }
    var begun: [Methods.WorkFilesUpload.Params] { lock.withLock { _begun } }
    private func note(_ call: String) { lock.withLock { _calls.append(call) } }

    var send: ShareUploader.Send {
        ShareUploader.Send(
            settings: {
                self.note("settings")
                if let error = self.settingsError { throw error }
                return self.settings
            },
            begin: { params in
                self.note("begin")
                if let error = self.beginError { throw error }
                let id = self.lock.withLock { () -> String in
                    self._begun.append(params)
                    return "u\(self._begun.count)"
                }
                return id
            },
            chunk: { uploadId, index, data in
                self.note("chunk \(uploadId) \(index) \(data)")
                if index == self.cancelAtIndex { withUnsafeCurrentTask { $0?.cancel() } }
                let failure = self.lock.withLock { () -> (any Error)? in
                    self.chunkCount += 1
                    return self.chunkFailures.removeValue(forKey: self.chunkCount)
                }
                if let failure { throw failure }
            },
            commit: { uploadId in
                self.note("commit \(uploadId)")
                if let error = self.commitError { throw error }
            },
            abort: { uploadId in self.note("abort \(uploadId)") }
        )
    }
}

@MainActor
@Suite struct ShareUploaderTests {
    private let bytes = Data("ABCDEFGHIJ".utf8)
    private func b64(_ range: Range<Int>) -> String { Data(bytes[range]).base64EncodedString() }

    private func rig() throws -> (ShareRig, ShareHost, ShareUploader) {
        let rig = try ShareRig()
        let host = ShareHost()
        return (rig, host, ShareUploader(inbox: rig.inbox, hostId: "box", hostName: "The box", request: host.send))
    }

    @Test func `settings, begin, the chunks in order from disk, commit; the host has it and the phone keeps no bytes`() async throws {
        let (rig, host, uploader) = try rig()
        let folder = ShareFolder(name: "Events", host: "box", path: "/srv/work/Esports/Events")
        let item = try rig.add(bytes, to: ShareDestination(hostId: "box", workspaceId: "w1", folder: folder))
        var fractions: [Double] = []
        let after = await uploader.send(item) { fractions.append($0) }
        #expect(after.state == .done)
        #expect(after.words == nil)
        #expect(host.calls == ["settings", "begin", "chunk u1 0 \(b64(0 ..< 4))", "chunk u1 1 \(b64(4 ..< 8))", "chunk u1 2 \(b64(8 ..< 10))", "commit u1"])
        let begun = try #require(host.begun.first)
        #expect(begun.workspaceId == "w1")
        #expect(begun.at == .file(.init(host: "box", path: "/srv/work/Esports/Events")))
        #expect(begun.name == "photo.jpeg")
        #expect(begun.size == 10)
        #expect(begun.sha256 == item.sha256)
        #expect(begun.op.count >= 8)
        #expect(begun.asked == nil, "never sent")
        #expect(fractions == [0.4, 0.8, 1, 1])
        #expect(!FileManager.default.fileExists(atPath: rig.inbox.payload(item).path))
        #expect(rig.inbox.item(item.id)?.state == .done)
    }

    @Test func `the workspace's own folder is named as its place`() {
        #expect(ShareFolder.top(name: "Esports").at == .place(.init(id: "folder")))
        #expect(ShareFolder(.place(.init(id: "folder")), name: "Esports") == .top(name: "Esports"))
        #expect(ShareFolder(.file(.init(host: "box", path: "/a")), name: "a") == ShareFolder(name: "a", host: "box", path: "/a"))
        #expect(ShareFolder(.drive(.init(account: "me", folderId: "f")), name: "Drive") == nil, "no other place can be a destination")
        #expect(ShareFolder(.place(.init(id: "lib~1")), name: "Team") == nil)
    }

    @Test func `too large is said before work.files.upload is sent`() async throws {
        let (rig, host, uploader) = try rig()
        host.settings = AttachmentSettings(maxBytes: 5, chunkBytes: 4)
        let item = try rig.add(bytes)
        let after = await uploader.send(item)
        #expect(host.calls == ["settings"])
        #expect(after.state == .refused)
        let limit = ByteCountFormatter.string(fromByteCount: 5, countStyle: .file)
        #expect(after.words == "photo.jpeg is larger than The box takes (\(limit)).")
        #expect(FileManager.default.fileExists(atPath: rig.inbox.payload(item).path), "kept for Try Again or Discard")
    }

    @Test func `a sha mismatch the host refuses at commit keeps its words`() async throws {
        let (rig, host, uploader) = try rig()
        host.commitError = TransportError.server(method: "attachment.commit", message: "sha256 mismatch: the file changed on the way")
        let item = try rig.add(bytes)
        let after = await uploader.send(item)
        #expect(after.state == .refused)
        #expect(after.words == "sha256 mismatch: the file changed on the way")
        #expect(host.calls.last == "abort u1")
        #expect(rig.inbox.items().map(\.state) == [.refused])
    }

    @Test func `the host's refusal at begin is kept in its words and no byte moves`() async throws {
        let (rig, host, uploader) = try rig()
        host.beginError = TransportError.server(method: "work.files.upload", message: "Files cannot take an upload yet: that arrives with its milestone.")
        let item = try rig.add(bytes)
        let after = await uploader.send(item)
        #expect(after.state == .refused)
        #expect(after.words == "Files cannot take an upload yet: that arrives with its milestone.")
        #expect(host.calls == ["settings", "begin"])
    }

    @Test func `cancel aborts the upload on the host and the item goes back to the queue`() async throws {
        let (rig, host, uploader) = try rig()
        host.cancelAtIndex = 1
        let item = try rig.add(bytes)
        // Its own task, so the cancel the host makes is the send's and not the test's.
        let after = await Task { await uploader.send(item) }.value
        #expect(after.state == .queued)
        #expect(host.calls == ["settings", "begin", "chunk u1 0 \(b64(0 ..< 4))", "chunk u1 1 \(b64(4 ..< 8))", "abort u1"])
        #expect(FileManager.default.fileExists(atPath: rig.inbox.payload(item).path))
        #expect(rig.inbox.claim(item.id) != nil, "the claim was let go")
    }

    @Test func `a host that cannot be reached leaves the item queued`() async throws {
        let (rig, host, uploader) = try rig()
        host.settingsError = TransportError.notConnected
        let item = try rig.add(bytes)
        #expect(await uploader.send(item).state == .queued)
        #expect(host.calls == ["settings"])
        // The socket going away mid-upload: nothing to abort over, still queued.
        host.settingsError = nil
        host.chunkFailures = [2: TransportError.notConnected]
        let after = await uploader.send(item)
        #expect(after.state == .queued)
        #expect(after.words == nil)
        #expect(!host.calls.contains { $0.hasPrefix("abort") })
    }

    @Test func `an upload the host forgot starts again from begin, once`() async throws {
        let (rig, host, uploader) = try rig()
        let expired = TransportError.server(method: "attachment.chunk", message: "unknown upload (expired, aborted or never begun)")
        host.chunkFailures = [2: expired]
        let item = try rig.add(bytes)
        let after = await uploader.send(item)
        #expect(after.state == .done)
        #expect(host.calls == [
            "settings", "begin", "chunk u1 0 \(b64(0 ..< 4))", "chunk u1 1 \(b64(4 ..< 8))",
            "begin", "chunk u2 0 \(b64(0 ..< 4))", "chunk u2 1 \(b64(4 ..< 8))", "chunk u2 2 \(b64(8 ..< 10))", "commit u2"
        ])
        #expect(host.begun.count == 2)
        #expect(host.begun[0].op != host.begun[1].op, "a fresh op per attempt")
        // Forgotten twice: the host's words, no third try.
        let again = try rig.add(bytes)
        host.chunkFailures = [6: expired, 7: expired]
        let refused = await uploader.send(again)
        #expect(refused.state == .refused)
        #expect(refused.words == "unknown upload (expired, aborted or never begun)")
        #expect(host.begun.count == 4)
    }

    @Test func `an item another process is sending is left to it`() async throws {
        let (rig, host, uploader) = try rig()
        let item = try rig.add(bytes)
        _ = ShareInbox(root: rig.root.appendingPathComponent("group")).claim(item.id)
        let after = await uploader.send(item)
        #expect(after.state == .sending)
        #expect(host.calls.isEmpty)
    }

    @Test func `a drain sends this host's queued items oldest first and stops when the host is out of reach`() async throws {
        let (rig, host, uploader) = try rig()
        let first = try rig.add(Data("one".utf8))
        rig.clock.advance(1)
        let other = try rig.add(Data("mac".utf8), to: ShareDestination(hostId: "mac", workspaceId: "w9", folder: .top(name: "Admin")))
        rig.clock.advance(1)
        let refused = try rig.add(Data("no".utf8))
        try rig.inbox.mark(refused.id, .refused, words: "No.")
        rig.clock.advance(1)
        let second = try rig.add(Data("two".utf8))
        var seen: [String] = []
        let sent = await uploader.drain { item, _ in if seen.last != item.id { seen.append(item.id) } }
        #expect(sent.map(\.id) == [first.id, second.id])
        #expect(sent.map(\.state) == [.done, .done])
        #expect(seen == [first.id, second.id])
        #expect(rig.inbox.item(other.id)?.state == .queued, "another host's item waits for its own uploader")
        #expect(rig.inbox.item(refused.id)?.state == .refused, "a refused item waits for Try Again")

        let third = try rig.add(Data("three".utf8))
        rig.clock.advance(1)
        let fourth = try rig.add(Data("four".utf8))
        host.settingsError = TransportError.notConnected
        let held = await uploader.drain()
        #expect(held.map(\.id) == [third.id])
        #expect(rig.inbox.item(fourth.id)?.state == .queued)
    }
}
