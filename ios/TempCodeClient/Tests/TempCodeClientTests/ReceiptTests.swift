import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A host's Money calls, answered as a test says.
@MainActor
private final class StubHost: MoneyHost {
    let hostId: String
    var jobs: [MoneyState.Job]
    /// Never answers `work.money.state` (a host asleep behind the relay).
    var asleep = false
    /// Never answers `work.money.parse`.
    var parseAsleep = false
    var fields = MoneyReceiptFields(amount: 1043, date: "2026-11-21", who: "Blue Heron Coffee", category: "Meals")
    /// Thrown on the part with this index.
    var failAt: Int?
    var failure = "timed out"
    /// Files the receipt, then the answer is lost on the way back.
    var loseAnswer = false
    /// The ledger is a sheet others can open: a filing only waits there as a suggestion.
    var suggests = false
    /// Keys he discarded on the desktop: the host answers `dropped`.
    var dropped: Set<String> = []
    /// Holds `parse` until `answerParse()` (a parser still working when he presses Save).
    var parseGated = false
    /// Holds `receive` of this part until `answerPart()`.
    var gatedPart: Int?
    private var parseGate: CheckedContinuation<Void, Never>?
    private var partGate: CheckedContinuation<Void, Never>?
    private(set) var parsed: [(lines: [ReceiptTextLine], sector: String?)] = []
    private(set) var received: [ReceiptPart] = []
    /// The host's record by key: a repeat answers the first.
    private var kept: [String: MoneyReceived] = [:]

    init(_ hostId: String = "box", sectors: [String] = ["unify"]) {
        self.hostId = hostId
        jobs = sectors.map { MoneyState.Job(workspaceId: "\(hostId)-ws-\($0)", name: $0.capitalized, sector: $0, made: true, categories: ["Meals", "Software", "Travel"]) }
    }

    func moneyState() async throws -> MoneyState {
        if asleep { try await Task.sleep(for: .seconds(3600)) }
        return MoneyState(host: hostId, jobs: jobs)
    }

    func parse(lines: [ReceiptTextLine], sector: String?) async throws -> MoneyReceiptFields {
        parsed.append((lines, sector))
        if parseGated { await withCheckedContinuation { parseGate = $0 } }
        if parseAsleep { try await Task.sleep(for: .seconds(3600)) }
        return fields
    }

    func receive(_ part: ReceiptPart) async throws -> MoneyReceived {
        received.append(part)
        if part.part == gatedPart {
            gatedPart = nil
            await withCheckedContinuation { partGate = $0 }
        }
        if let first = kept[part.key] { return first }
        if dropped.contains(part.key) { return MoneyReceived(id: "r-\(part.key)", state: .dropped) }
        if part.part == failAt { throw ActionError.refused(message: failure, forbidden: false) }
        guard part.part == part.parts - 1 else { return MoneyReceived(id: "r-\(part.key)", state: .partial) }
        let files = part.fields.amount != nil && part.fields.date != nil
        let answer = MoneyReceived(id: "r-\(part.key)", state: files ? .filed : .ready, suggested: files && suggests ? true : nil)
        kept[part.key] = answer
        if loseAnswer {
            loseAnswer = false
            throw ActionError.refused(message: failure, forbidden: false)
        }
        return answer
    }

    var parseHeld: Bool { parseGate != nil }
    var partHeld: Bool { partGate != nil }

    func answerParse() {
        parseGate?.resume()
        parseGate = nil
    }

    func answerPart() {
        partGate?.resume()
        partGate = nil
    }

    /// The bytes of the last whole send, joined in order.
    var joined: Data { received.suffix(received.last.map { $0.parts } ?? 0).reduce(into: Data()) { $0.append($1.data) } }
}

/// The phone's reader, answering what the test says.
@MainActor
private final class StubText: TextSource {
    var lines = [ReceiptTextLine(text: "BLUE HERON COFFEE", box: [40, 30, 400, 70], score: 0.98), ReceiptTextLine(text: "TOTAL 10.43", box: [40, 300, 400, 340], score: 0.97)]
    private(set) var reads = 0

    func lines(of pages: [Data]) async throws -> [ReceiptTextLine] {
        reads += 1
        return lines
    }
}

/// One phone: its defaults and its receipts folder, so a second `Receipt` on them is a relaunch.
private struct Phone {
    let defaults = UserDefaults(suiteName: "receipt-\(UUID().uuidString)")!
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("receipts-\(UUID().uuidString)")
    let text = StubText()

    @MainActor
    func receipt(keys: [String] = ["key-0001", "key-0002", "key-0003"], wait: Duration = .milliseconds(80)) -> Receipt {
        var left = keys
        return Receipt(source: text, folder: folder, defaults: defaults, wait: wait, makeKey: { left.removeFirst() }, now: { Date(timeIntervalSince1970: 1_795_000_000) })
    }
}

private let scan = Data("a made-up receipt".utf8)

@Suite @MainActor struct ReceiptTests {
    @Test func `a scan is kept at once, and a relaunch finds it with what he typed`() throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let draft = try receipt.add(file: scan, mime: "image/jpeg", pages: [scan])
        #expect(draft.key == "key-0001")
        #expect(draft.name.hasSuffix(".jpg"))
        receipt.amount = "48.17"
        receipt.seller = "Heron"
        // Cancel or a quit: a new Receipt on the same defaults and folder.
        let again = phone.receipt()
        #expect(again.pending == 1)
        #expect(again.current?.key == "key-0001")
        #expect(again.amount == "48.17")
        #expect(again.seller == "Heron")
        #expect(again.current.flatMap(again.scan) == scan)
    }

    @Test func `the key is kept across a failed save and a relaunch, and the retry goes to the same host`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        try receipt.add(file: scan, mime: "image/jpeg", pages: [scan])
        let other = StubHost("mac")
        let box = StubHost("box")
        await receipt.find([box])
        box.failAt = 0
        receipt.amount = "10.43"
        #expect(await receipt.save([box]) == nil)
        #expect(receipt.error == "timed out")
        #expect(receipt.pending == 1)

        // A relaunch: the Mac answers first now, and the receipt still goes to the box's job it showed.
        let again = phone.receipt()
        box.failAt = nil
        await again.find([other])
        await again.find([other, box])
        #expect(again.chosen?.hostId == "box")
        let answer = await again.save([other, box])
        #expect(answer?.state == .ready)
        #expect(other.received.isEmpty)
        #expect(box.received.map(\.key) == ["key-0001", "key-0001"])
        #expect(again.pending == 0)
    }

    @Test func `a lost answer resent files nothing twice: the host answers the first`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let host = StubHost()
        try receipt.add(file: scan, mime: "image/jpeg", pages: [])
        receipt.amount = "10.43"
        receipt.date = "2026-11-21"
        await receipt.find([host])
        host.loseAnswer = true
        #expect(await receipt.save([host]) == nil)
        #expect(receipt.pending == 1)
        #expect(await receipt.save([host])?.state == .filed)
        #expect(host.received.map(\.key) == ["key-0001", "key-0001"])
        #expect(receipt.pending == 0)
    }

    @Test func `parts are each at most 2 MiB and join back to the same bytes`() {
        let bytes = Data((0..<(5 * 1024 * 1024 + 17)).map { UInt8($0 % 251) })
        let parts = ReceiptParts.cut(bytes)
        #expect(parts.count == 3)
        #expect(parts.allSatisfy { $0.count <= 2 * 1024 * 1024 })
        #expect(parts.reduce(into: Data()) { $0.append($1) } == bytes)
        #expect(ReceiptParts.cut(Data()) == [Data()])
        #expect(ReceiptParts.cut(Data([1, 2, 3, 4, 5]), max: 2) == [Data([1, 2]), Data([3, 4]), Data([5])])
        // A slice that does not start at zero cuts the same.
        let slice = bytes[10..<20]
        #expect(ReceiptParts.cut(slice, max: 4).reduce(into: Data()) { $0.append($1) } == Data(slice))
    }

    @Test func `one key rides every part, each with the lines and the fields, in order`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let host = StubHost()
        let bytes = Data((0..<(4 * 1024 * 1024 + 1)).map { UInt8($0 % 7) })
        try receipt.add(file: bytes, mime: "application/pdf", pages: [scan, scan])
        await receipt.find([host])
        await receipt.read([host])
        #expect(await receipt.save([host])?.state == .filed)
        #expect(host.received.map(\.key) == ["key-0001", "key-0001", "key-0001"])
        #expect(host.received.map(\.part) == [0, 1, 2])
        #expect(host.received.allSatisfy { $0.parts == 3 && $0.sector == "unify" && $0.mime == "application/pdf" && $0.name.hasSuffix(".pdf") })
        #expect(host.received.allSatisfy { $0.lines == phone.text.lines && $0.fields.amount == 1043 && $0.fields.date == "2026-11-21" })
        #expect(host.joined == bytes)
        // Filed: the draft and its file are gone.
        #expect(receipt.pending == 0)
        #expect(try FileManager.default.contentsOfDirectory(atPath: phone.folder.path).isEmpty)
    }

    @Test func `the host's parser fills only the fields he has not typed in`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let host = StubHost()
        try receipt.add(file: scan, mime: "image/jpeg", pages: [scan])
        receipt.seller = "Heron Cafe"
        await receipt.find([host])
        await receipt.read([host])
        #expect(phone.text.reads == 1)
        #expect(host.parsed.first?.sector == "unify")
        #expect(host.parsed.first?.lines == phone.text.lines)
        #expect(receipt.amount == "10.43")
        #expect(receipt.date == "2026-11-21")
        #expect(receipt.seller == "Heron Cafe")
        #expect(receipt.category == "Meals")
        // Asked once per scan: reopening the sheet asks nothing again.
        await receipt.read([host])
        #expect(phone.text.reads == 1)
        #expect(host.parsed.count == 1)
    }

    @Test func `a relaunched JPEG draft that was never read is read from its file`() async throws {
        let phone = Phone()
        try phone.receipt().add(file: scan, mime: "image/jpeg", pages: [])
        let again = phone.receipt()
        let host = StubHost()
        await again.find([host])
        await again.read([host])
        #expect(phone.text.reads == 1)
        #expect(again.amount == "10.43")
    }

    @Test func `a JPEG handed over with no pages is read from its file, a PDF without its pages is not read`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let host = StubHost()
        try receipt.add(file: scan, mime: "image/jpeg", pages: [])
        await receipt.find([host])
        await receipt.read([host])
        #expect(phone.text.reads == 1)
        try receipt.add(file: scan, mime: "application/pdf", pages: [])
        await receipt.read([host])
        #expect(phone.text.reads == 1)
        // Unread, it goes without lines: the host reads it itself.
        #expect(await receipt.save([host])?.state == .ready)
        #expect(host.received.last?.lines == nil)
    }

    @Test func `no host in time leaves the fields empty and says so`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let asleep = StubHost()
        asleep.asleep = true
        try receipt.add(file: scan, mime: "image/jpeg", pages: [scan])
        await receipt.find([asleep])
        #expect(receipt.error == Receipt.noHost)
        #expect(receipt.sectors.isEmpty)
        #expect(!receipt.canSave)
        #expect(await receipt.save([asleep]) == nil)

        let reader = StubHost()
        reader.parseAsleep = true
        await receipt.read([reader])
        #expect(receipt.amount.isEmpty)
        #expect(receipt.date == nil)
        #expect(receipt.seller.isEmpty)
        #expect(receipt.pending == 1)
    }

    @Test func `a parser that does not answer in time says so, and the fields stay`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let host = StubHost()
        host.parseAsleep = true
        try receipt.add(file: scan, mime: "image/jpeg", pages: [scan])
        await receipt.find([host])
        await receipt.read([host])
        #expect(receipt.error == Receipt.noReader)
        #expect(receipt.amount.isEmpty)
        #expect(receipt.canSave)
    }

    @Test func `a host asleep does not hold up one that answers`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let asleep = StubHost("mac", sectors: ["cosmic"])
        asleep.asleep = true
        let box = StubHost("box", sectors: ["unify"])
        try receipt.add(file: scan, mime: "image/jpeg", pages: [scan])
        await receipt.find([asleep, box])
        #expect(receipt.error == nil)
        #expect(receipt.sectors == ["unify"])
        #expect(receipt.sector == "unify")
    }

    @Test func `an amount with no date still sends, and the host's ready answer clears the draft`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let host = StubHost()
        try receipt.add(file: scan, mime: "image/jpeg", pages: [])
        receipt.amount = "$12.50"
        receipt.seller = "  Office Depot "
        await receipt.find([host])
        let answer = await receipt.save([host])
        #expect(answer?.state == .ready)
        let sent = try #require(host.received.first)
        #expect(sent.fields.amount == 1250)
        #expect(sent.fields.date == nil)
        #expect(sent.fields.who == "Office Depot")
        #expect(sent.lines == nil)
        #expect(receipt.pending == 0)
        #expect(phone.receipt().pending == 0)
    }

    @Test func `no amount is allowed, a word in Amount is not`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        try receipt.add(file: scan, mime: "image/jpeg", pages: [])
        await receipt.find([StubHost()])
        #expect(receipt.canSave)
        receipt.amount = "about ten"
        #expect(!receipt.amountValid)
        #expect(!receipt.canSave)
        receipt.amount = "10"
        #expect(receipt.canSave)
    }

    @Test func `the sector used last leads the picker, and only sectors with a job are offered`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let host = StubHost(sectors: ["cosmic", "ref", "unify"])
        try receipt.add(file: scan, mime: "image/jpeg", pages: [])
        await receipt.find([host])
        #expect(receipt.sectors == ["cosmic", "ref", "unify"])
        #expect(receipt.sector == "cosmic")
        receipt.pick(sector: "ref")
        #expect(await receipt.save([host]) != nil)

        let next = phone.receipt()
        try next.add(file: scan, mime: "image/jpeg", pages: [])
        await next.find([host])
        #expect(next.sectors == ["ref", "cosmic", "unify"])
        #expect(next.sector == "ref")
        #expect(next.categories == ["Meals", "Software", "Travel"])
        #expect(next.jobName("ref") == "Ref")
    }

    @Test func `several wait, oldest first, and a saved one hands the sheet the next`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let host = StubHost()
        try receipt.add(file: scan, mime: "image/jpeg", pages: [])
        try receipt.add(file: scan, mime: "image/jpeg", pages: [])
        #expect(receipt.pending == 2)
        #expect(receipt.current?.key == "key-0002")
        receipt.showOldest()
        #expect(receipt.current?.key == "key-0001")
        #expect(receipt.position == 1)
        await receipt.find([host])
        await receipt.save([host])
        #expect(receipt.current?.key == "key-0002")
        receipt.discard()
        #expect(receipt.pending == 0)
        #expect(try FileManager.default.contentsOfDirectory(atPath: phone.folder.path).isEmpty)
    }

    @Test func `a read category the job does not list is still offered`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let host = StubHost()
        host.fields = MoneyReceiptFields(amount: nil, date: nil, who: nil, category: "Coffee")
        try receipt.add(file: scan, mime: "image/jpeg", pages: [scan])
        await receipt.find([host])
        await receipt.read([host])
        #expect(receipt.categories == ["Meals", "Software", "Travel", "Coffee"])
        #expect(receipt.amount.isEmpty)
    }

    @Test func `the wire names the phone, carries the part as base64, and sends a missing date as null`() throws {
        let part = ReceiptPart(key: "key-0001", sector: "unify", name: "Receipt.jpg", mime: "image/jpeg", part: 0, parts: 1, data: scan, lines: [ReceiptTextLine(text: "TOTAL 10.43", box: [1, 2, 3], score: 0.9)], fields: .init(amount: 1043, date: nil, who: nil, category: nil))
        let json = try #require(String(data: JSONEncoder().encode(part.params), encoding: .utf8))
        #expect(json.contains(#""source":"phone""#))
        #expect(json.contains(#""date":null"#))
        #expect(json.contains(scan.base64EncodedString()))
        // A box that is not four numbers is left off rather than refused.
        #expect(!json.contains(#""box""#))
        // No parse answered: `seen` is left out, and the host may fill what is empty.
        #expect(!json.contains("seen"))
    }

    @Test func `what Save sends is what he saw at the press: a parse that answers during the Save changes nothing sent`() async throws {
        let phone = Phone()
        // Long enough that the parser is still asked when he presses Save.
        let receipt = phone.receipt(wait: .seconds(30))
        let host = StubHost()
        host.parseGated = true
        host.gatedPart = 0
        let bytes = Data((0..<(2 * 1024 * 1024 + 9)).map { UInt8($0 % 5) })
        try receipt.add(file: bytes, mime: "image/jpeg", pages: [scan])
        await receipt.find([host])
        let reading = Task { await receipt.read([host]) }
        #expect(await eventually { host.parseHeld })
        // Blank amount and date at the press.
        let saving = Task { await receipt.save([host]) }
        #expect(await eventually { host.partHeld })
        host.answerParse()
        await reading.value
        host.answerPart()
        let answer = await saving.value
        #expect(answer?.state == .ready)
        #expect(host.received.count == 2)
        #expect(host.received.allSatisfy { $0.fields.amount == nil && $0.fields.date == nil && $0.fields.who == nil && !$0.seen })
    }

    @Test func `a receipt whose parse answered before the press says he saw it`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let host = StubHost()
        try receipt.add(file: scan, mime: "image/jpeg", pages: [scan])
        await receipt.find([host])
        await receipt.read([host])
        receipt.seller = ""
        #expect(await receipt.save([host])?.state == .filed)
        let sent = try #require(host.received.first)
        #expect(sent.seen)
        #expect(sent.fields.who == nil)
        #expect(sent.params.seen == true)
        #expect(receipt.outcome == "Filed in Unify")
    }

    @Test func `once a part may have arrived, a retry goes to that host and never to another`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let box = StubHost("box")
        let mac = StubHost("mac")
        try receipt.add(file: scan, mime: "image/jpeg", pages: [])
        await receipt.find([box])
        // The part reaches the box, and no answer comes back.
        box.failAt = 0
        #expect(await receipt.save([box, mac]) == nil)
        #expect(receipt.pinned)
        #expect(box.received.count == 1)
        // The box asleep: the Mac keeps the same job, and is never asked.
        box.asleep = true
        box.failAt = nil
        #expect(await receipt.save([mac, box]) == nil)
        #expect(receipt.error == "Unify's host did not answer. The receipt is kept on this phone.")
        #expect(mac.received.isEmpty)
        // The box unpaired: the same.
        #expect(await receipt.save([mac]) == nil)
        #expect(receipt.error == Receipt.noAnswer(from: "Unify"))
        #expect(mac.received.isEmpty)
        // A relaunch keeps the pin, and the job cannot move to the Mac's.
        let again = phone.receipt()
        box.asleep = false
        await again.find([mac, box])
        again.pick(try #require(again.jobs.first { $0.hostId == "mac" }))
        #expect(again.chosen?.hostId == "box")
        #expect(await again.save([mac, box])?.state == .ready)
        #expect(mac.received.isEmpty)
        #expect(box.received.map(\.key) == ["key-0001", "key-0001"])
        #expect(again.outcome == "Waiting in Money on the desktop")
    }

    @Test func `the job shown at the press is the job it goes to, and never another in its sector`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let box = StubHost("box")
        let mac = StubHost("mac")
        try receipt.add(file: scan, mime: "image/jpeg", pages: [])
        await receipt.find([box])
        await receipt.find([box, mac])
        // The find ends at the box's answer; the Mac's joins the picker when it lands.
        #expect(await eventually { receipt.jobs.count == 2 })
        #expect(receipt.jobs.map(\.hostId) == ["box", "mac"])
        #expect(receipt.chosen?.hostId == "box")
        receipt.pick(try #require(receipt.jobs.first { $0.hostId == "mac" }))
        #expect(receipt.chosen?.workspaceId == "mac-ws-unify")
        // The Mac goes quiet: the box keeps a Unify job too, and is never asked.
        mac.asleep = true
        #expect(await receipt.save([box, mac]) == nil)
        #expect(receipt.error == Receipt.noAnswer(from: "Unify"))
        #expect(box.received.isEmpty)
        #expect(mac.received.isEmpty)
        #expect(!receipt.pinned)
        // Back: it goes to the Mac's workspace by its id, with the sector beside it.
        mac.asleep = false
        #expect(await receipt.save([box, mac]) != nil)
        #expect(box.received.isEmpty)
        let sent = try #require(mac.received.first)
        #expect(sent.workspaceId == "mac-ws-unify")
        #expect(sent.params.workspaceId == "mac-ws-unify")
        #expect(sent.params.sector == "unify")
    }

    @Test func `with no job chosen, Save stays off and says no host answered`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let asleep = StubHost()
        asleep.asleep = true
        try receipt.add(file: scan, mime: "image/jpeg", pages: [])
        await receipt.find([asleep])
        #expect(receipt.chosen == nil)
        #expect(!receipt.canSave)
        #expect(receipt.problem == Receipt.noHost)
        #expect(await receipt.save([asleep]) == nil)
        #expect(asleep.received.isEmpty)
    }

    @Test func `while a scan is held, a second scan is refused and the held one stays`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let host = StubHost()
        try receipt.add(file: scan, mime: "image/jpeg", pages: [])
        await receipt.find([host])
        #expect(receipt.canSave)
        // The folder goes read-only: the next scan cannot be written.
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: phone.folder.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: phone.folder.path) }
        let first = Data("the first held scan".utf8)
        #expect(throws: (any Error).self) { try receipt.add(file: first, mime: "image/jpeg", pages: []) }
        #expect(receipt.unkept?.file == first)
        #expect(!receipt.canScan)
        #expect(!receipt.canSave)
        #expect(await receipt.save([host]) == nil)
        #expect(host.received.isEmpty)
        #expect(throws: Receipt.ScanHeld.self) { try receipt.add(file: Data("a second".utf8), mime: "image/jpeg", pages: []) }
        #expect(receipt.unkept?.file == first)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: phone.folder.path)
        let kept = try #require(receipt.keepAgain())
        #expect(receipt.scan(kept) == first)
        #expect(receipt.pending == 2)
        #expect(receipt.canScan)
    }

    @Test func `a receipt discarded on the desktop stays, says so, and only Discard is left`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let host = StubHost()
        host.dropped = ["key-0001"]
        try receipt.add(file: scan, mime: "image/jpeg", pages: [])
        await receipt.find([host])
        #expect(await receipt.save([host]) == nil)
        #expect(receipt.pending == 1)
        #expect(receipt.problem == Receipt.discardedOnDesktop)
        #expect(receipt.outcome == nil)
        #expect(!receipt.canSave)
        // A relaunch knows it too.
        let again = phone.receipt()
        #expect(again.problem == Receipt.discardedOnDesktop)
        #expect(!again.canSave)
        again.discard()
        #expect(again.pending == 0)
    }

    @Test func `a filing that only waits as a suggestion says so`() async throws {
        let phone = Phone()
        let receipt = phone.receipt()
        let host = StubHost()
        host.suggests = true
        try receipt.add(file: scan, mime: "image/jpeg", pages: [scan])
        await receipt.find([host])
        await receipt.read([host])
        #expect(await receipt.save([host])?.suggested == true)
        #expect(receipt.outcome == "Suggested in Unify's ledger")
    }

    @Test func `a scan this phone cannot write is held in memory, said, and kept on a second try`() throws {
        let phone = Phone()
        // A file where the folder should be: nothing can be written under it.
        try Data("in the way".utf8).write(to: phone.folder)
        let receipt = phone.receipt()
        #expect(throws: (any Error).self) { try receipt.add(file: scan, mime: "image/jpeg", pages: [scan]) }
        #expect(receipt.pending == 0)
        #expect(receipt.unkept == ReceiptScanBytes(file: scan, mime: "image/jpeg", pages: [scan]))
        #expect(receipt.unkeptReason != nil)
        #expect(receipt.keepAgain() == nil)
        #expect(receipt.unkept != nil)

        try FileManager.default.removeItem(at: phone.folder)
        let kept = try #require(receipt.keepAgain())
        #expect(receipt.unkept == nil)
        #expect(receipt.unkeptReason == nil)
        #expect(receipt.pending == 1)
        #expect(receipt.scan(kept) == scan)
        #expect(phone.receipt().pending == 1)
    }

    @Test func `a held scan he lets go is gone`() throws {
        let phone = Phone()
        try Data("in the way".utf8).write(to: phone.folder)
        let receipt = phone.receipt()
        _ = try? receipt.add(file: scan, mime: "image/jpeg", pages: [])
        #expect(receipt.unkept != nil)
        receipt.dropUnkept()
        #expect(receipt.unkept == nil)
        #expect(receipt.keepAgain() == nil)
    }

    @Test func `where a saved receipt went, in his words`() {
        #expect(Receipt.outcomeLine(MoneyReceived(id: "r", state: .filed), job: "Purdue Esports") == "Filed in Purdue Esports")
        #expect(Receipt.outcomeLine(MoneyReceived(id: "r", state: .filed, suggested: true), job: "Unify") == "Suggested in Unify's ledger")
        #expect(Receipt.outcomeLine(MoneyReceived(id: "r", state: .ready), job: "Unify") == "Waiting in Money on the desktop")
        #expect(Receipt.outcomeLine(MoneyReceived(id: "r", state: .reading), job: "Unify") == "Waiting in Money on the desktop")
        #expect(Receipt.outcomeLine(MoneyReceived(id: "r", state: .dropped), job: "Unify") == nil)
    }

    @Test(arguments: [
        ("48.17", 4817), ("$1,204.50", 120_450), ("12", 1200), ("12.5", 1250), (" $ 3.07 ", 307), (".99", 99), ("1,000", 100_000),
        ("", nil), ("0", nil), ("0.00", nil), ("12.345", nil), ("1,20.00", nil), ("12,34", nil), ("ten", nil), ("-4.00", nil), ("1.2.3", nil), ("$", nil), (".", nil)
    ] as [(String, Int?)])
    func `the amount he types becomes whole cents`(text: String, cents: Int?) {
        #expect(ReceiptAmount.cents(text) == cents)
    }

    @Test func `cents show as the field holds them`() {
        #expect(ReceiptAmount.text(1043) == "10.43")
        #expect(ReceiptAmount.text(1205) == "12.05")
        #expect(ReceiptAmount.text(99) == "0.99")
        #expect(ReceiptAmount.text(120_450) == "1204.50")
    }
}
