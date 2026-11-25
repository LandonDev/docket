import Foundation
import Observation
import TempCodeContract

/// A Work thread's items on one host (milestone 47): what its pane holds, in
/// tab order, as `work.canvas.list` answered and the `work.canvas` push keeps
/// it. The thread screen reads `items(sessionId)` and shows the Item segment
/// while there is one. Also the per-workspace counter a Routines screen reads
/// again on (`work.routines`).
@MainActor @Observable
public final class WorkCanvas {
    /// Open items per thread, in tab order. A thread never listed is absent, not empty.
    public private(set) var items: [String: [CanvasItem]] = [:]
    /// The item an open just showed, per thread: the pager selects it once.
    public private(set) var opened: [String: String] = [:]
    /// The threads with an open item, kept apart from `items` so a reader that must not redraw on every
    /// canvas push (the shell's wide rule) can ask without observing.
    @ObservationIgnored private var withItems: Set<String> = []
    /// Moves on each `work.routines` push, per workspace.
    public private(set) var routinesRev: [String: Int] = [:]
    /// A mail's file on its way to the host, by item id: the share come, nil while the store has not said the size.
    public private(set) var fetching: [String: Double?] = [:]
    /// The file Ask just seated in a thread, per thread: the host's announcement of that open selects nothing (`AskLanding`).
    @ObservationIgnored private var landing: [String: CanvasSource] = [:]

    @ObservationIgnored let socket: TempCodeSocket
    @ObservationIgnored private let tickets = HostedTickets()
    /// The host's `HostCan`, and whether the key may act: `WorkHost` owns both and hands them here.
    @ObservationIgnored let can: HostCan
    @ObservationIgnored private let acts: Bool
    var mayAct: Bool { acts }

    init(socket: TempCodeSocket, can: HostCan = HostCan(), mayAct: Bool = false) {
        self.socket = socket
        self.can = can
        acts = mayAct
    }

    public func items(_ sessionId: String) -> [CanvasItem] { items[sessionId] ?? [] }

    /// Whether the thread has an open item, read without observing (`withItems`).
    public func hasOpenItems(_ sessionId: String) -> Bool { withItems.contains(sessionId) }

    private func set(_ sessionId: String, _ list: [CanvasItem]) {
        items[sessionId] = list
        if list.isEmpty { withItems.remove(sessionId) } else { withItems.insert(sessionId) }
    }

    /// Reads a thread's items; a code thread or an older host answers nothing and keeps none.
    public func load(_ sessionId: String) async {
        guard let answer = try? await socket.request(Methods.WorkCanvasList.self, .init(sessionId: sessionId)) else { return }
        set(sessionId, answer.items)
    }

    func apply(_ push: ServerPush) {
        switch push {
        case .workCanvas(let value):
            set(value.sessionId, value.items)
            if let opened = value.opened {
                if let file = landing[value.sessionId], AskLanding.swallows(opened: opened, items: value.items, file: file) {
                    landing[value.sessionId] = nil
                } else {
                    self.opened[value.sessionId] = opened
                }
            }
        case .workRoutines(let value):
            routinesRev[value.workspaceId, default: 0] += 1
        case .workCanvasFetch(let value):
            // Only while this phone waits on it: a push after the answer adds nothing back.
            if fetching.keys.contains(value.itemId) {
                fetching.updateValue(MailRules.fetchShare(received: value.received, total: value.total), forKey: value.itemId)
            }
        default:
            break
        }
    }

    /// The pager took the push's `opened`.
    public func tookOpened(_ sessionId: String) { opened[sessionId] = nil }

    /// Ask sent his words to a thread about `file`: he lands on its Chat, so the host's announcement that the file was
    /// opened there (already in, or still on its way) selects nothing.
    public func landOnChat(_ sessionId: String, file: CanvasSource) {
        if let shown = opened[sessionId], AskLanding.swallows(opened: shown, items: items(sessionId), file: file) {
            opened[sessionId] = nil
        } else {
            landing[sessionId] = file
        }
    }

    /// Takes an item out of the thread's tab row (its files stay on the host).
    public func close(_ item: CanvasItem) async throws {
        _ = try await socket.request(Methods.WorkCanvasClose.self, .init(itemId: item.id))
    }

    /// The composer's `@`: what the thread may be offered for the words typed (`work.canvas.mentions`, approve,
    /// carried to a far host only while its screen is unlocked).
    public func mentions(_ sessionId: String, text: String) async throws -> MentionAnswer {
        try await socket.request(Methods.WorkCanvasMentions.self, .init(sessionId: sessionId, text: String(text.prefix(MentionTrigger.most))))
    }

    /// The thread's tab order (`work.canvas.reorder`): the list the host answers is kept at once; its push says the same.
    public func reorder(_ sessionId: String, order: [String]) async throws {
        let answer = try await socket.request(Methods.WorkCanvasReorder.self, .init(sessionId: sessionId, order: order))
        set(sessionId, answer.items)
    }

    // MARK: - each kind's reads and presses

    /// A mail's file onto its host, into the item's own folder, before its kind reads it (`work.canvas.fetch`,
    /// approve; carried to a far host only while its screen is unlocked). Its progress lands in `fetching`.
    @discardableResult
    public func fetch(_ item: CanvasItem) async throws -> Int {
        fetching.updateValue(nil, forKey: item.id)
        defer { fetching.removeValue(forKey: item.id) }
        return Int(try await socket.request(Methods.WorkCanvasFetch.self, .init(itemId: item.id)).size)
    }

    /// A fetched file whole, read by range (`work.canvas.read`): Share and Save to Files in the reader.
    public func fetchedData(_ item: CanvasItem, size: Int) async throws -> Data {
        let socket = socket
        let itemId = item.id
        return try await ChunkedRead.all(size: size) { offset, length in
            let part = try await socket.request(Methods.WorkCanvasRead.self, .init(itemId: itemId, offset: offset, length: length))
            return FileBytes(data: part.data, size: part.size, rev: "")
        }
    }

    /// Save to Workspace: a copy in the job's folder under the file's own name; answers the name it took.
    public func keep(_ item: CanvasItem) async throws -> String {
        try await socket.request(Methods.WorkCanvasKeep.self, .init(itemId: item.id)).name
    }

    public func ticket(_ source: Methods.WorkGuestsTicket.Params.Source, title: String) async throws -> String {
        try await socket.request(Methods.WorkGuestsTicket.self, .init(source: source, title: title)).url
    }

    /// Asks for an item's ticket now, while its page is still being pushed (`HostedTickets`).
    public func warmTicket(_ item: CanvasItem) {
        guard case .hosted(let source) = ItemBody.of(item) else { return }
        tickets.warm(item.id) { try await self.ticket(source, title: item.title) }
    }

    /// The ticket asked early for this item, else a new one. Used once.
    public func ticket(for item: CanvasItem, source: Methods.WorkGuestsTicket.Params.Source) async throws -> String {
        try await tickets.take(item.id) { try await self.ticket(source, title: item.title) }
    }

    public func makeGuestLink(_ draft: GuestLinkDraft, source: Methods.WorkGuestsCreate.Params.Source, title: String) async throws -> Methods.WorkGuestsCreate.Output {
        try await socket.request(Methods.WorkGuestsCreate.self, .init(source: source, title: title, name: draft.trimmedName, role: draft.role.wire, expiresAt: draft.expiresAtMs))
    }

    public func pdf(_ itemId: String) async throws -> PdfPhoneView {
        try await socket.request(Methods.WorkPdfOpen.self, .init(itemId: itemId))
    }

    /// The PDF's bytes as the view named them, read in frames two at a time, every one of the view's `rev`.
    /// `progress` hears the share read after each frame.
    public func pdfData(_ view: PdfPhoneView, progress: ((Double) -> Void)? = nil) async throws -> Data {
        let size = Int(view.size)
        let socket = socket
        let itemId = view.itemId, rev = view.rev
        return try await ChunkedRead.pinned(size: size, rev: rev, read: { offset, length in
            try await socket.request(Methods.WorkPdfRead.self, .init(itemId: itemId, which: .file, rev: rev, offset: offset, length: length))
        }, landed: { progress?(ChunkedRead.share(read: $0, of: size)) })
    }

    /// The PDF's first page as one picture of the view's `rev`, drawn `width` pixels wide by the host; nil from a
    /// host that has none to give (an older one, a picture too large), when the open reads the file alone.
    public func pdfFirst(_ view: PdfPhoneView, width: Int) async -> FirstPicture? {
        guard let page = try? await socket.request(Methods.WorkPdfFirst.self, .init(itemId: view.itemId, rev: view.rev, width: width)) else { return nil }
        return FirstPicture.of(page, rev: view.rev)
    }

    /// A deck's first slide as its own one-page PDF, in one ask, of the picture's rev the view named beside the
    /// render's `rev`.
    public func slideFirst(_ deck: DeckPhoneView, proposed: Bool, rev: String) async -> FirstPicture? {
        guard let first = FirstPicture.firstSlide(of: deck, proposed: proposed),
              let frame = try? await socket.request(Methods.WorkSlidesSlide.self, .init(itemId: deck.itemId, which: proposed ? .proposed : .file, slide: first.id, offset: 0, length: Int(first.pic.size))) else { return nil }
        return FirstPicture.of(frame, pic: first.pic.rev, render: rev)
    }

    /// A highlight over words he picked on one page: a box per line, the words, his note. Answers the view after it.
    public func mark(_ itemId: String, page: Int, quads: [[Double]], text: String, note: String? = nil) async throws -> PdfPhoneView {
        let boxes = quads.map { $0.map { JSONValue.number($0) } }
        return try await socket.request(Methods.WorkPdfMark.self, .init(itemId: itemId, page: page, quads: boxes, text: text, note: note))
    }

    public func unmark(_ itemId: String, markId: String) async throws -> PdfPhoneView {
        try await socket.request(Methods.WorkPdfUnmark.self, .init(itemId: itemId, markId: markId))
    }

    /// His own value for a field; nil empties it.
    public func setField(_ itemId: String, key: String, value: Methods.WorkPdfSetField.Params.Value?) async throws -> PdfPhoneView {
        try await socket.request(Methods.WorkPdfSetField.self, .init(itemId: itemId, key: key, value: value))
    }

    /// Takes or drops an agent's values: the fields he saw, by key, never the host's "all".
    public func reviewFields(_ itemId: String, keys: [String], accept: Bool) async throws -> PdfPhoneView {
        try await socket.request(Methods.WorkPdfReview.self, .init(itemId: itemId, keys: .array(keys), verdict: accept ? .accept : .reject))
    }

    /// One frame of a PDF at a `rev`.
    func pdfFrame(_ itemId: String, rev: String, offset: Int, length: Int) async throws -> FileBytes {
        try await socket.request(Methods.WorkPdfRead.self, .init(itemId: itemId, which: .file, rev: rev, offset: offset, length: length))
    }

    /// One frame of a deck's own render.
    func deckFrame(_ itemId: String, offset: Int, length: Int) async throws -> FileBytes {
        try await socket.request(Methods.WorkSlidesRead.self, .init(itemId: itemId, which: .file, offset: offset, length: length))
    }

    public func deck(_ itemId: String) async throws -> DeckPhoneView {
        try await socket.request(Methods.WorkSlidesOpen.self, .init(itemId: itemId))
    }

    /// One of a deck's renders (a PDF): `proposed` while changes wait. `rev` is the render's rev as the view advertised
    /// it: a frame of any other render (the changes moved on meanwhile) fails the read, never shows in its place.
    public func deckData(_ itemId: String, proposed: Bool, size: Int, rev: String, progress: ((Double) -> Void)? = nil) async throws -> Data {
        let socket = socket
        return try await ChunkedRead.pinned(size: size, rev: rev, read: { offset, length in
            try await socket.request(Methods.WorkSlidesRead.self, .init(itemId: itemId, which: proposed ? .proposed : .file, offset: offset, length: length))
        }, landed: { progress?(ChunkedRead.share(read: $0, of: size)) })
    }

    /// Accept or reject every waiting change, bound to the proposed render he saw (`rev`): the host refuses the press
    /// when the changes moved on since, and nothing is applied to what he did not see.
    public func reviewDeck(_ itemId: String, accept: Bool, rev: String) async throws -> DeckPhoneView {
        try await socket.request(Methods.WorkSlidesReview.self, .init(itemId: itemId, changes: .string("all"), verdict: accept ? .accept : .reject, rev: rev))
    }

    /// `plays`: what this viewer can decode, so the host prepares it (an HLS proxy, tiles).
    public func media(_ itemId: String, canRead: Bool) async throws -> MediaPhoneView {
        try await socket.request(Methods.WorkMediaView.self, .init(itemId: itemId, plays: MediaPick.asks(canRead: canRead)))
    }

    /// A proxy, an original or a picture by its media token, in ranges (`media.read`, admin), written
    /// to `file` as they land. A read that fails leaves no file.
    public func mediaFile(token: String, to file: URL) async throws {
        try await MediaFiles.write(to: file) { handle in
            try await ChunkedRead.media(read: { offset, length in
                try await self.socket.request(Methods.MediaRead.self, .init(token: token, offset: offset, length: length))
            }, write: { try handle.write(contentsOf: $0) })
        }
    }

    public func mediaSegment(_ itemId: String, versionId: String, index: Int?) async throws -> Data {
        let answer = try await socket.request(Methods.WorkMediaSegment.self, .init(itemId: itemId, versionId: versionId, index: index.map { .integer($0) } ?? .string("init")))
        guard let data = Data(base64Encoded: answer.data) else { throw ChunkedRead.Failure.notBase64 }
        return data
    }

    public func mediaTile(_ itemId: String, versionId: String, level: Int, x: Int, y: Int) async throws -> Data {
        let answer = try await socket.request(Methods.WorkMediaTile.self, .init(itemId: itemId, versionId: versionId, level: level, x: x, y: y))
        guard let data = Data(base64Encoded: answer.data) else { throw ChunkedRead.Failure.notBase64 }
        return data
    }

    /// His comment at a frame of a version.
    public func comment(_ itemId: String, versionId: String, frame: Int, body: String) async throws -> MediaPhoneNote {
        try await socket.request(Methods.WorkMediaNote.self, .init(itemId: itemId, kind: .comment, anchor: .init(versionId: versionId, frame: frame), body: body))
    }

    public func meeting(_ itemId: String) async throws -> MeetingPhone? {
        try await socket.request(Methods.WorkMeetingsGet.self, .init(itemId: itemId)).meeting
    }

    /// A range of a meeting's original recording, its name and whole size (`work.meetings.recording`, at most one chunk).
    public func recording(_ itemId: String, offset: Int, length: Int) async throws -> (name: String, size: Int, data: Data) {
        let answer = try await socket.request(Methods.WorkMeetingsRecording.self, .init(itemId: itemId, offset: offset, length: min(length, MeetingRecording.chunk)))
        guard let data = Data(base64Encoded: answer.dataBase64) else { throw ChunkedRead.Failure.notBase64 }
        return (answer.name, Int(answer.size), data)
    }

    /// His word on the tasks a meeting yielded: accept files each in LifeOS, reject drops it. Answers the meeting after
    /// it, and each task LifeOS would not file with why.
    public func decide(meeting itemId: String, actionIds: [String], accept: Bool) async throws -> (meeting: MeetingPhone, failed: [(id: String, error: String)]) {
        let answer = try await socket.request(Methods.WorkMeetingsDecide.self, .init(itemId: itemId, actionIds: actionIds, decision: accept ? .accept : .reject))
        return (answer.meeting, answer.failed.map { ($0.id, $0.error) })
    }

    public func responses(_ itemId: String) async throws -> FormResponses {
        try await socket.request(Methods.WorkFormsResponses.self, .init(itemId: itemId))
    }

    public func dashboard(_ itemId: String) async throws -> DashboardPhoneView {
        try await socket.request(Methods.WorkDashboardsOpen.self, .init(itemId: itemId))
    }

    public func versions(_ source: CanvasSource) async throws -> HistoryVersionsPhone {
        try await socket.request(Methods.WorkHistoryVersions.self, .init(source: source))
    }

    /// The document back to a version: written at once on his own, a branch of suggestions on one others can open.
    public func restore(_ source: CanvasSource, versionId: String) async throws -> HistoryWritePhone {
        try await socket.request(Methods.WorkHistoryRestore.self, .init(source: source, versionId: versionId))
    }

    /// A version against the item as it is now.
    public func compare(_ source: CanvasSource, from versionId: String) async throws -> HistoryComparePhone {
        try await socket.request(Methods.WorkHistoryCompare.self, .init(source: source, from: .string(versionId), to: .string("live")))
    }

    public func browser(_ sessionId: String) async throws -> BrowserState {
        try await socket.request(Methods.WorkBrowserState.self, .init(sessionId: sessionId))
    }

    /// Take over (`owner`) or hand back (`agent`).
    public func drive(_ sessionId: String, owner: Bool) async throws -> BrowserState {
        try await socket.request(Methods.WorkBrowserDrive.self, .init(sessionId: sessionId, driver: owner ? .owner : .agent))
    }

    public func routines(_ workspaceId: String) async throws -> [RoutinePhoneRow] {
        try await socket.request(Methods.WorkRoutinesList.self, .init(workspaceId: workspaceId)).routines
    }

    public func pause(_ routine: RoutinePhoneRow, _ paused: Bool) async throws -> RoutinePhoneRow {
        try await socket.request(Methods.WorkRoutinesPause.self, .init(id: routine.id, paused: paused))
    }

    /// The job's Microsoft forms, newest change first, as its host keeps them.
    public func msforms(_ workspaceId: String) async throws -> [MsFormPhoneRow] {
        try await socket.request(Methods.WorkMsformsList.self, .init(workspaceId: workspaceId)).forms
    }
}
