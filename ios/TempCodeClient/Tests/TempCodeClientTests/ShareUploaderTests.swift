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
    /// Thrown by the commit of this upload id, once.
    var commitFailures: [String: any Error] = [:]
    /// Ops whose file the host made: a begin with one answers landed, as the op's row keeps it across a restart.
    var landedOps: Set<String> = []
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
                // Kept before any error: a begin whose answer is lost was still sent.
                let id = self.lock.withLock { () -> String in
                    self._begun.append(params)
                    return "u\(self._begun.count)"
                }
                if let error = self.beginError { throw error }
                return ShareUploader.Begun(uploadId: id, landed: self.lock.withLock { self.landedOps.contains(params.op) })
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
                if let failure = self.lock.withLock({ self.commitFailures.removeValue(forKey: uploadId) }) { throw failure }
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

    /// The same host as another process's uploader reaches it, on the same queue.
    private func sender(_ rig: ShareRig, _ host: ShareHost, as holder: String) -> ShareUploader {
        ShareUploader(inbox: rig.process(holder), hostId: "box", hostName: "The box", request: host.send)
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
        #expect(begun.op == "\(item.id)-0")
        #expect(begun.op.count >= 8, "the host's least")
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
        #expect(after.words == "The box takes files up to 5 bytes.")
        #expect(after.isFinal == true, "no retry makes the file smaller")
        #expect(rig.inbox.item(item.id)?.canRetry == false)
        #expect(FileManager.default.fileExists(atPath: rig.inbox.payload(item).path), "kept for Discard")
    }

    @Test func `the limit is said in units of 1024, as a whole number that never overstates it`() {
        #expect(ShareUploader.tooLarge(host: "Mac", limit: 200 * 1024 * 1024) == "Mac takes files up to 200 MB.")
        #expect(ShareUploader.wholeBinary(512) == "512 bytes")
        #expect(ShareUploader.wholeBinary(1024) == "1 KB")
        #expect(ShareUploader.wholeBinary(1024 * 1024 * 3 / 2) == "1 MB")
        #expect(ShareUploader.wholeBinary(2 * 1024 * 1024 * 1024) == "2 GB")
        #expect(ShareUploader.wholeBinary(5 * 1024 * 1024 * 1024 * 1024) == "5 TB")
    }

    @Test func `a file gone or changed on the phone is refused for good, before or between chunks`() async throws {
        let (rig, host, uploader) = try rig()
        let gone = try rig.add(bytes)
        try FileManager.default.removeItem(at: rig.inbox.payload(gone))
        let first = await uploader.send(gone)
        #expect(first.state == .refused)
        #expect(first.words == "The file is no longer on this phone.")
        #expect(first.isFinal == true)
        let changed = try rig.add(bytes)
        try Data("ABC".utf8).write(to: rig.inbox.payload(changed))
        let second = await uploader.send(changed)
        #expect(second.words == "The file changed on this phone after it was shared.")
        #expect(second.isFinal == true)
        #expect(host.calls.filter { $0.hasPrefix("abort") }.count == 2, "the host drops each partial upload")
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
        #expect(after.canRetry, "the host may take it later")
        #expect(host.calls == ["settings", "begin"])
        // The host keeps its answer for that op: Try Again sends a fresh one.
        host.beginError = nil
        #expect(rig.inbox.retry(item.id))
        #expect(await uploader.send(item).state == .done)
        #expect(host.begun.map(\.op) == ["\(item.id)-0", "\(item.id)-1"])
    }

    @Test func `a begin whose answer was lost is sent again with the same op, from either process`() async throws {
        let (rig, host, uploader) = try rig()
        host.beginError = TransportError.closed(CloseReason(kind: .network, message: "connection lost"))
        let item = try rig.add(bytes)
        #expect(await uploader.send(item).state == .queued)
        host.beginError = nil
        // The app sends it later: the host answers the same upload id for that op, so no second save starts.
        let after = await sender(rig, host, as: "app").send(item)
        #expect(after.state == .done)
        #expect(host.begun.map(\.op) == ["\(item.id)-0", "\(item.id)-0"])
    }

    @Test func `a connection lost once the host answered spends that op`() async throws {
        let (rig, host, uploader) = try rig()
        host.chunkFailures = [2: TransportError.notConnected]
        let item = try rig.add(bytes)
        #expect(await uploader.send(item).state == .queued)
        #expect(rig.inbox.item(item.id)?.attempts == 1)
        #expect(await uploader.send(item).state == .done)
        #expect(host.begun.map(\.op) == ["\(item.id)-0", "\(item.id)-1"])
    }

    @Test func `a commit whose answer was lost is asked again on its upload, and nothing is begun twice`() async throws {
        let (rig, host, uploader) = try rig()
        host.commitError = TransportError.closed(CloseReason(kind: .network, message: "connection lost"))
        let item = try rig.add(bytes)
        #expect(await uploader.send(item).state == .queued)
        #expect(rig.inbox.item(item.id)?.committing == "u1")
        // The host made the file and keeps its answer for the upload: the next send asks that commit, and only it.
        host.commitError = nil
        let after = await sender(rig, host, as: "app").send(item)
        #expect(after.state == .done)
        #expect(host.begun.count == 1)
        #expect(host.calls.suffix(2) == ["settings", "commit u1"])
    }

    @Test func `a lost commit the host no longer knows begins again`() async throws {
        let (rig, host, uploader) = try rig()
        host.commitError = TransportError.notConnected
        let item = try rig.add(bytes)
        #expect(await uploader.send(item).state == .queued)
        // The host made nothing under it (it never had the commit, and the upload ran out): its op says not landed,
        // and the file goes again from begin on a fresh op.
        host.commitError = nil
        host.commitFailures = ["u1": TransportError.server(method: "attachment.commit", message: "unknown upload (expired, aborted or never begun)")]
        let after = await uploader.send(item)
        #expect(after.state == .done)
        #expect(host.begun.map(\.op) == ["\(item.id)-0", "\(item.id)-0", "\(item.id)-1"])
        #expect(host.calls.contains("commit u3"))
        #expect(rig.inbox.item(item.id)?.committing == nil)
    }

    @Test func `a commit that landed before the host restarted is not sent again`() async throws {
        let (rig, host, uploader) = try rig()
        host.commitError = TransportError.closed(CloseReason(kind: .network, message: "connection lost"))
        let item = try rig.add(bytes)
        #expect(await uploader.send(item).state == .queued)
        // The host made the file, then restarted: it no longer knows the upload, but the begin's op says it landed.
        host.commitError = nil
        host.commitFailures = ["u1": TransportError.server(method: "attachment.commit", message: "unknown upload (expired, aborted or never begun)")]
        host.landedOps = ["\(item.id)-0"]
        let after = await uploader.send(item)
        #expect(after.state == .done)
        #expect(host.begun.map(\.op) == ["\(item.id)-0", "\(item.id)-0"])
        #expect(!host.calls.contains { $0.hasPrefix("chunk u2") })
        // Done and the cleared commit are one manifest write.
        #expect(rig.inbox.item(item.id)?.committing == nil)
    }

    @Test func `a lost commit whose op cannot be read stays pending, and begins nothing`() async throws {
        let (rig, host, uploader) = try rig()
        host.commitError = TransportError.notConnected
        let item = try rig.add(bytes)
        #expect(await uploader.send(item).state == .queued)
        host.commitError = nil
        host.commitFailures = ["u1": TransportError.server(method: "attachment.commit", message: "unknown upload (expired, aborted or never begun)")]
        host.beginError = TransportError.server(method: "work.files.upload", message: "The app stopped before this finished.")
        let after = await uploader.send(item)
        #expect(after.state == .refused)
        #expect(after.canRetry)
        #expect(rig.inbox.item(item.id)?.committing == "u1")
        #expect(host.begun.map(\.op) == ["\(item.id)-0", "\(item.id)-0"])
        #expect(!host.calls.contains { $0.hasPrefix("chunk u2") })
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
        #expect(host.begun.map(\.op) == ["\(item.id)-0", "\(item.id)-1"], "a fresh op once the first was answered")
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
        _ = rig.process("app").claim(item.id)
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
        try rig.refuse(refused, "No.")
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
