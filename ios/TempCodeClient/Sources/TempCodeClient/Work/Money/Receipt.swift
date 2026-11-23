import Foundation
import Observation
import TempCodeContract

/// One scanned receipt as the phone keeps it until a host answers: the
/// scan's file (under the receipts folder), what the reader found, the four
/// fields as he edits them and the job he chose (its host, its workspace). `key` is made with the scan
/// and never changes, so every part and every retry is the same receipt to
/// the host.
public struct ReceiptDraft: Codable, Hashable, Sendable, Identifiable {
    public enum Field: String, Codable, Hashable, Sendable {
        case amount, date, seller, category
    }

    public let key: String
    /// The scan's file name in the receipts folder.
    public let file: String
    /// The name the host files it under.
    public let name: String
    public let mime: String
    /// What the phone's reader found; nil until it has read the scan.
    public var lines: [ReceiptTextLine]?
    /// As he types it ("48.17"); whole cents on the wire.
    public var amount = ""
    /// YYYY-MM-DD.
    public var date: String?
    public var seller = ""
    public var category: String?
    public var sector: String?
    /// The fields he typed in: the host's parser never fills those.
    public var typed: Set<Field> = []
    /// The job the picker shows: its host, its workspace on that host and its
    /// name there. Save goes to that job and no other.
    public var hostId: String?
    public var workspaceId: String?
    public var job: String?
    /// A part has gone to that host: the job can no longer change, since another
    /// host keeps no record of the key and would file it again.
    public var sent = false
    /// He discarded it on the desktop: its key is spent, and only Discard Receipt is left.
    public var discarded = false
    /// The host's parser has answered for this scan.
    public var parsed = false

    public var id: String { key }

    private enum CodingKeys: String, CodingKey {
        case key, file, name, mime, lines, amount, date, seller, category, sector, typed, hostId, workspaceId, job, sent, discarded, parsed
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        file = try c.decode(String.self, forKey: .file)
        name = try c.decode(String.self, forKey: .name)
        mime = try c.decode(String.self, forKey: .mime)
        lines = try c.decodeIfPresent([ReceiptTextLine].self, forKey: .lines)
        amount = try c.decodeIfPresent(String.self, forKey: .amount) ?? ""
        date = try c.decodeIfPresent(String.self, forKey: .date)
        seller = try c.decodeIfPresent(String.self, forKey: .seller) ?? ""
        category = try c.decodeIfPresent(String.self, forKey: .category)
        sector = try c.decodeIfPresent(String.self, forKey: .sector)
        typed = try c.decodeIfPresent(Set<Field>.self, forKey: .typed) ?? []
        hostId = try c.decodeIfPresent(String.self, forKey: .hostId)
        workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
        job = try c.decodeIfPresent(String.self, forKey: .job)
        // A draft kept before `sent` existed held a host only once a part had gone to it.
        sent = try c.decodeIfPresent(Bool.self, forKey: .sent) ?? (hostId != nil)
        discarded = try c.decodeIfPresent(Bool.self, forKey: .discarded) ?? false
        parsed = try c.decodeIfPresent(Bool.self, forKey: .parsed) ?? false
    }

    init(key: String, file: String, name: String, mime: String) {
        self.key = key
        self.file = file
        self.name = name
        self.mime = mime
    }
}

/// A receipt from the phone (docs/agents/work-money.md, docs/IOS-DESIGN.md
/// "The receipt"): the document camera's scan, read on the phone, its fields
/// asked of a host's one parser, sent in parts to the host that keeps the
/// job's ledger. With an amount and a date the host files it at once; else it
/// waits in To confirm on the desktop. Drafts outlive the sheet and the app:
/// several may wait, oldest first, until a host answers each.
@MainActor @Observable
public final class Receipt {
    public static let noHost = "No host with a job for receipts answered."
    public static let noReader = "No host read the receipt in time."
    public static let partial = "The host has only part of the scan. Save again."
    public static let gone = "The scan is no longer on this iPhone."
    /// The camera's scan could not be written to this phone; it is held in memory until a try succeeds.
    public static let notKept = "This iPhone could not keep the scan."

    /// The line for a receipt pinned to a host that does not answer.
    public static func noAnswer(from job: String) -> String { "\(job)'s host did not answer. The receipt is kept on this phone." }
    /// The host answered `dropped`: he discarded this one on the desktop.
    public static let discardedOnDesktop = "This receipt was discarded on the desktop."

    /// `add` while a scan that could not be written is still held: the new one is refused, the held one kept.
    public struct ScanHeld: Error {}
    /// LifeOS's six sectors in the order its screens list them.
    public static let sectorOrder = ["cosmic", "hypixel", "purdue", "ref", "unify", "life"]

    static let draftsKey = "work.money.receipt"
    static let sectorKey = "work.money.sector"

    /// Every receipt that waits for a host, oldest first.
    public private(set) var drafts: [ReceiptDraft] {
        didSet { store() }
    }
    /// The receipt the sheet shows.
    public private(set) var currentKey: String?
    /// Asking the hosts which jobs they keep.
    public private(set) var finding = false
    /// Reading the scan on the phone, then asking a host's parser.
    public private(set) var reading = false
    public private(set) var saving = false
    /// The last failure, kept beside the draft.
    public private(set) var error: String?
    /// A scan the camera gave that this phone could not write, held until `keepAgain` succeeds.
    public private(set) var unkept: ReceiptScanBytes?
    /// Why it could not be written: the system's words.
    public private(set) var unkeptReason: String?
    /// Where the last saved receipt went, in his words: "Filed in Unify", or that it waits on the desktop.
    public private(set) var outcome: String?
    /// The sector the last filed receipt went to: first in the picker.
    public private(set) var lastSector: String?
    /// Each host's jobs, in the order the hosts answered.
    private var answers: [Answer] = []

    private struct Answer {
        let host: any MoneyHost
        let jobs: [MoneyState.Job]
    }

    @ObservationIgnored private let source: any TextSource
    @ObservationIgnored private let folder: URL
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let wait: Duration
    @ObservationIgnored private let makeKey: () -> String
    @ObservationIgnored private let now: () -> Date
    /// The scan's pages as pictures, for the reader, while the app runs.
    @ObservationIgnored private var pages: [String: [Data]] = [:]

    /// `folder` holds the scans (Application Support in the app); `wait` is
    /// how long a host has to answer before the sheet says none did.
    public init(source: any TextSource, folder: URL, defaults: UserDefaults = .standard, wait: Duration = .seconds(3), makeKey: @escaping () -> String = { UUID().uuidString }, now: @escaping () -> Date = Date.init) {
        self.source = source
        self.folder = folder
        self.defaults = defaults
        self.wait = wait
        self.makeKey = makeKey
        self.now = now
        drafts = defaults.data(forKey: Self.draftsKey).flatMap { try? JSONDecoder().decode([ReceiptDraft].self, from: $0) } ?? []
        lastSector = defaults.string(forKey: Self.sectorKey)
        currentKey = drafts.first?.key
    }

    // MARK: - what the sheet reads

    public var current: ReceiptDraft? { drafts.first { $0.key == currentKey } ?? drafts.first }
    /// How many receipts wait on this phone.
    public var pending: Int { drafts.count }
    /// The current receipt's place in the queue, from 1.
    public var position: Int? { current.flatMap { draft in drafts.firstIndex { $0.key == draft.key } }.map { $0 + 1 } }

    public var amount: String {
        get { current?.amount ?? "" }
        set { edit(.amount) { $0.amount = newValue } }
    }
    public var date: String? {
        get { current?.date }
        set { edit(.date) { $0.date = newValue } }
    }
    public var seller: String {
        get { current?.seller ?? "" }
        set { edit(.seller) { $0.seller = newValue } }
    }
    public var category: String? {
        get { current?.category }
        set { edit(.category) { $0.category = newValue } }
    }
    public var sector: String? { current?.sector }
    /// Some part has gone to a host: the job can no longer change.
    public var pinned: Bool { current?.sent == true }
    /// While a scan that could not be written is held, nothing else is scanned or saved.
    public var canScan: Bool { unkept == nil }
    /// The line under the job: the last failure, or that the desktop discarded it.
    public var problem: String? { current?.discarded == true ? Self.discardedOnDesktop : error }

    /// The amount as whole cents; nil when the field is empty or not a sum.
    public var cents: Int? { ReceiptAmount.cents(amount) }
    /// An empty amount is allowed (it waits on the desktop); a word is not.
    public var amountValid: Bool { amount.trimmingCharacters(in: .whitespaces).isEmpty || cents != nil }
    /// Save needs a job chosen (a host answered), a sum or nothing in Amount, and a key not spent on the desktop.
    public var canSave: Bool {
        guard let draft = current, draft.hostId != nil, draft.workspaceId != nil, draft.sector != nil else { return false }
        return amountValid && !saving && !draft.discarded && canScan
    }

    /// Every job a host answered with, the last sector used first, then LifeOS's order, then by host in the order they answered.
    public var jobs: [ReceiptJob] {
        let all = answers.flatMap { answer in
            answer.jobs.compactMap { job in job.sector.map { ReceiptJob(hostId: answer.host.hostId, workspaceId: job.workspaceId, name: job.name, sector: $0, categories: job.categories) } }
        }
        let order = sectors
        return order.flatMap { sector in all.filter { $0.sector == sector } }
    }

    /// The job the draft holds, from the hosts' answers or as kept with the draft.
    public var chosen: ReceiptJob? {
        guard let draft = current, let hostId = draft.hostId, let workspaceId = draft.workspaceId, let sector = draft.sector else { return nil }
        return jobs.first { $0.hostId == hostId && $0.workspaceId == workspaceId }
            ?? ReceiptJob(hostId: hostId, workspaceId: workspaceId, name: draft.job ?? sector.capitalized, sector: sector, categories: [])
    }

    /// What the picker offers: every job, and the one the draft holds though its host has not answered.
    public var choices: [ReceiptJob] {
        var list = jobs
        if let held = chosen, !list.contains(where: { $0.id == held.id }) { list.insert(held, at: 0) }
        return list
    }

    /// The sectors some host keeps a job in: the last one used first, then LifeOS's order.
    public var sectors: [String] {
        let held = Set(answers.flatMap { $0.jobs.compactMap(\.sector) })
        var order = Self.sectorOrder.filter(held.contains) + held.subtracting(Self.sectorOrder).sorted()
        if let last = lastSector, let index = order.firstIndex(of: last) { order.insert(order.remove(at: index), at: 0) }
        return order
    }

    /// The chosen job's categories, and what was read or picked when the job does not list it.
    public var categories: [String] {
        var list = chosen?.categories ?? []
        if let picked = category, !picked.isEmpty, !list.contains(picked) { list.append(picked) }
        return list
    }

    /// The job a sector's receipts go to, by the name its host gives it.
    public func jobName(_ sector: String) -> String? { job(in: sector)?.name }

    /// The scan's bytes, for the sheet's picture.
    public func scan(_ draft: ReceiptDraft) -> Data? { try? Data(contentsOf: url(draft.file)) }
    /// The pages the camera gave, while the app runs.
    public func pictures(_ draft: ReceiptDraft) -> [Data] { pages[draft.key] ?? [] }

    // MARK: - his presses

    /// A new scan: kept at once (the file, then the draft), shown by the sheet.
    /// When the file cannot be written the scan is held in memory (`unkept`)
    /// and the error is thrown; `keepAgain` tries once more.
    @discardableResult
    public func add(file data: Data, mime: String, pages: [Data]) throws -> ReceiptDraft {
        // The held scan is the only copy: a second may never take its place.
        guard canScan else { throw ScanHeld() }
        return try write(file: data, mime: mime, pages: pages)
    }

    private func write(file data: Data, mime: String, pages: [Data]) throws -> ReceiptDraft {
        let key = makeKey()
        let ext = mime == "application/pdf" ? "pdf" : "jpg"
        let file = "\(key).\(ext)"
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: url(file), options: .atomic)
        } catch {
            unkept = ReceiptScanBytes(file: data, mime: mime, pages: pages)
            unkeptReason = error.localizedDescription
            throw error
        }
        unkept = nil
        unkeptReason = nil
        var draft = ReceiptDraft(key: key, file: file, name: "Receipt \(Self.stamp(now())).\(ext)", mime: mime)
        // Hosts that answered already: the picker's first job until he picks.
        if let first = jobs.first { Self.hold(first, in: &draft) }
        self.pages[key] = pages
        drafts.append(draft)
        currentKey = key
        error = nil
        return draft
    }

    /// The held scan, written again; nil while it still cannot be.
    @discardableResult
    public func keepAgain() -> ReceiptDraft? {
        guard let held = unkept else { return nil }
        return try? write(file: held.file, mime: held.mime, pages: held.pages)
    }

    /// He let the held scan go.
    public func dropUnkept() {
        unkept = nil
        unkeptReason = nil
    }

    /// Home's press with receipts waiting: the oldest first.
    public func showOldest() {
        currentKey = drafts.first?.key
        error = nil
    }

    /// The job he picked: its host and workspace are held with the draft, and Save goes there.
    public func pick(_ job: ReceiptJob) {
        guard let key = current?.key, !pinned else { return }
        update(key) { Self.hold(job, in: &$0) }
    }

    /// The first job in a sector (the proof's hook names a sector).
    public func pick(sector: String) {
        if let job = jobs.first(where: { $0.sector == sector }) { pick(job) }
    }

    private static func hold(_ job: ReceiptJob, in draft: inout ReceiptDraft) {
        draft.sector = job.sector
        draft.hostId = job.hostId
        draft.workspaceId = job.workspaceId
        draft.job = job.name
    }

    /// He let this one go: the draft and its file are removed.
    public func discard() {
        guard let key = current?.key else { return }
        remove(key)
        error = nil
    }

    // MARK: - the hosts

    /// Asks every host which jobs it keeps, at once. A host with a job in the
    /// chosen sector ends the wait (the first to answer wins); with none in
    /// time the fields stay as they are and `error` says so. A later answer
    /// still joins the picker.
    public func find(_ hosts: [any MoneyHost]) async {
        finding = true
        defer { finding = false }
        let wanted = sector
        _ = await first(hosts, { try await $0.moneyState() }, accept: { state in
            wanted.map { want in state.jobs.contains { $0.sector == want } } ?? state.jobs.contains { $0.sector != nil }
        }, each: { [weak self] host, state in self?.take(host, state) })
        if jobs.isEmpty, chosen == nil { error = Self.noHost }
    }

    /// Reads the scan on the phone (once), then asks the first host to answer
    /// `work.money.parse` for the fields, filling only those he has not typed
    /// in. With no answer in time the fields stay and `error` says so.
    public func read(_ hosts: [any MoneyHost]) async {
        guard let draft = current else { return }
        let key = draft.key
        reading = true
        defer { reading = false }
        if draft.lines == nil {
            // A JPEG is its own one page; a PDF's pages are known only while the app that scanned it runs.
            let held = pages[key] ?? []
            let pictures = held.isEmpty && draft.mime == "image/jpeg" ? scan(draft).map { [$0] } ?? [] : held
            if !pictures.isEmpty, let lines = try? await source.lines(of: pictures) {
                update(key) { $0.lines = lines }
            }
        }
        guard let now = drafts.first(where: { $0.key == key }), let lines = now.lines, !lines.isEmpty, !now.parsed else { return }
        let sector = now.sector
        let holding = sector.map { want in hosts.filter { host in answers.contains { $0.host.hostId == host.hostId && $0.jobs.contains { $0.sector == want } } } } ?? []
        guard case let (_, fields)? = await first(holding.isEmpty ? hosts : holding, { try await $0.parse(lines: lines, sector: sector) }) else {
            if error == nil { error = Self.noReader }
            return
        }
        if error == Self.noReader { error = nil }
        fill(key, fields)
    }

    /// Sends the scan in parts, in order, to the job the picker shows, awaiting
    /// each. What goes is what he saw at the press: a parser that answers
    /// during the Save changes nothing sent. The job's host is the only one
    /// asked: while it does not answer the draft stays and `error` says so;
    /// another job in the sector is never chosen for him. Once a part has gone
    /// the job is fixed. Filed or waiting in To confirm, the draft and its file
    /// are removed; discarded on the desktop, it stays with its key spent.
    @discardableResult
    public func save(_ hosts: [any MoneyHost]) async -> MoneyReceived? {
        guard canSave, let pressed = current, let sector = pressed.sector, let hostId = pressed.hostId, let workspaceId = pressed.workspaceId else { return nil }
        guard let data = scan(pressed) else {
            error = Self.gone
            return nil
        }
        let key = pressed.key
        let job = pressed.job ?? sector.capitalized
        saving = true
        defer { saving = false }
        error = nil
        outcome = nil
        guard let host = hosts.first(where: { $0.hostId == hostId }), await first([host], { try await $0.moneyState() }) != nil else {
            error = Self.noAnswer(from: job)
            return nil
        }
        // Fixed before the first byte goes: a part may arrive though no answer comes back.
        update(key) { $0.sent = true }
        let seller = pressed.seller.trimmingCharacters(in: .whitespacesAndNewlines)
        let fields = ReceiptPart.Fields(amount: ReceiptAmount.cents(pressed.amount), date: pressed.date, who: seller.isEmpty ? nil : seller, category: pressed.category)
        let parts = ReceiptParts.cut(data)
        do {
            var answer: MoneyReceived?
            for (index, bytes) in parts.enumerated() {
                let got = try await host.receive(ReceiptPart(key: key, sector: sector, workspaceId: workspaceId, name: pressed.name, mime: pressed.mime, part: index, parts: parts.count, data: bytes, lines: pressed.lines, fields: fields, seen: pressed.parsed))
                answer = got
                // A repeat of a receipt the host already has answers the first at once.
                if got.state != .partial { break }
            }
            guard let answer, answer.state != .partial else {
                error = Self.partial
                return nil
            }
            if answer.state == .dropped {
                // Not a success: the key is spent, and the draft waits for his Discard.
                update(key) { $0.discarded = true }
                return nil
            }
            remove(key)
            lastSector = sector
            defaults.set(sector, forKey: Self.sectorKey)
            outcome = Self.outcomeLine(answer, job: job)
            return answer
        } catch {
            self.error = ActionError.wrap(error).message
            return nil
        }
    }

    /// Where a saved receipt went: the ledger, or To confirm on the desktop.
    static func outcomeLine(_ answer: MoneyReceived, job: String) -> String? {
        switch answer.state {
        case .filed: answer.suggested == true ? "Suggested in \(job)'s ledger" : "Filed in \(job)"
        case .ready, .reading: "Waiting in Money on the desktop"
        default: nil
        }
    }

    // MARK: - inside

    private func url(_ file: String) -> URL { folder.appendingPathComponent(file) }

    private func store() {
        if let data = try? JSONEncoder().encode(drafts) { defaults.set(data, forKey: Self.draftsKey) }
    }

    /// His own edit of a field: kept, and never filled by the parser after.
    private func edit(_ field: ReceiptDraft.Field, _ change: (inout ReceiptDraft) -> Void) {
        guard let key = current?.key else { return }
        update(key) {
            change(&$0)
            $0.typed.insert(field)
        }
    }

    private func update(_ key: String, _ change: (inout ReceiptDraft) -> Void) {
        guard let index = drafts.firstIndex(where: { $0.key == key }) else { return }
        change(&drafts[index])
    }

    private func remove(_ key: String) {
        guard let draft = drafts.first(where: { $0.key == key }) else { return }
        try? FileManager.default.removeItem(at: url(draft.file))
        pages[key] = nil
        drafts.removeAll { $0.key == key }
        if currentKey == key { currentKey = drafts.first?.key }
    }

    /// The parser's answer into the fields he has not typed in.
    private func fill(_ key: String, _ fields: MoneyReceiptFields) {
        update(key) { draft in
            draft.parsed = true
            if !draft.typed.contains(.amount), let amount = fields.amount, amount >= 1 { draft.amount = ReceiptAmount.text(Int(amount.rounded())) }
            if !draft.typed.contains(.date), let date = fields.date { draft.date = date }
            if !draft.typed.contains(.seller), let who = fields.who, !who.isEmpty { draft.seller = who }
            if !draft.typed.contains(.category), let category = fields.category, !category.isEmpty { draft.category = category }
        }
    }

    private func take(_ host: any MoneyHost, _ state: MoneyState) {
        answers.removeAll { $0.host.hostId == host.hostId }
        answers.append(Answer(host: host, jobs: state.jobs))
        if !sectors.isEmpty, error == Self.noHost { error = nil }
        // A draft with no job yet takes the picker's first (in its sector, if it has one) until he picks.
        guard let draft = current, draft.hostId == nil else { return }
        if let first = jobs.first(where: { draft.sector == nil || $0.sector == draft.sector }) { update(draft.key) { Self.hold(first, in: &$0) } }
    }

    private func job(in sector: String) -> MoneyState.Job? {
        answers.lazy.compactMap { $0.jobs.first { $0.sector == sector } }.first
    }

    /// The first of `hosts` whose call answers with a value `accept` takes, or
    /// nil once every one has failed or `wait` has passed. `each` hears every
    /// answer, a late one too.
    private func first<T: Sendable>(
        _ hosts: [any MoneyHost],
        _ call: @escaping @MainActor @Sendable (any MoneyHost) async throws -> T,
        accept: @escaping @MainActor @Sendable (T) -> Bool = { _ in true },
        each: (@MainActor @Sendable (any MoneyHost, T) -> Void)? = nil
    ) async -> (any MoneyHost, T)? {
        guard !hosts.isEmpty else { return nil }
        let wait = self.wait
        return await withCheckedContinuation { done in
            let race = FirstAnswer<T>(left: hosts.count, done: done)
            for host in hosts {
                Task {
                    let value = try? await call(host)
                    if let value { each?(host, value) }
                    race.answer(host, value.flatMap { accept($0) ? $0 : nil })
                }
            }
            Task {
                try? await Task.sleep(for: wait)
                race.end()
            }
        }
    }

    static func stamp(_ date: Date) -> String {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "yyyy-MM-dd 'at' HH.mm"
        return format.string(from: date)
    }
}

/// A job a host keeps, as the picker offers it: Save sends to `workspaceId` on `hostId`.
public struct ReceiptJob: Hashable, Sendable, Identifiable {
    public let hostId: String
    public let workspaceId: String
    public let name: String
    public let sector: String
    public let categories: [String]

    public var id: String { "\(hostId)/\(workspaceId)" }

    public init(hostId: String, workspaceId: String, name: String, sector: String, categories: [String]) {
        self.hostId = hostId
        self.workspaceId = workspaceId
        self.name = name
        self.sector = sector
        self.categories = categories
    }
}

/// A scan as the camera gave it: the file the host keeps and the pages the reader reads.
public struct ReceiptScanBytes: Hashable, Sendable {
    public let file: Data
    public let mime: String
    public let pages: [Data]

    public init(file: Data, mime: String, pages: [Data]) {
        self.file = file
        self.mime = mime
        self.pages = pages
    }
}

/// `Receipt.first`'s bookkeeping: resumes once, with the first answer taken,
/// or with nil when every host has answered without one or the wait is over.
@MainActor private final class FirstAnswer<T: Sendable> {
    private var left: Int
    private var done: CheckedContinuation<(any MoneyHost, T)?, Never>?

    init(left: Int, done: CheckedContinuation<(any MoneyHost, T)?, Never>) {
        self.left = left
        self.done = done
    }

    func answer(_ host: any MoneyHost, _ value: T?) {
        left -= 1
        if let value {
            done?.resume(returning: (host, value))
            done = nil
        } else if left == 0 {
            end()
        }
    }

    func end() {
        done?.resume(returning: nil)
        done = nil
    }
}
