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
    /// Moves on each `work.routines` push, per workspace.
    public private(set) var routinesRev: [String: Int] = [:]

    @ObservationIgnored private let socket: TempCodeSocket

    init(socket: TempCodeSocket) {
        self.socket = socket
    }

    public func items(_ sessionId: String) -> [CanvasItem] { items[sessionId] ?? [] }

    /// Reads a thread's items; a code thread or an older host answers nothing and keeps none.
    public func load(_ sessionId: String) async {
        guard let answer = try? await socket.request(Methods.WorkCanvasList.self, .init(sessionId: sessionId)) else { return }
        items[sessionId] = answer.items
    }

    func apply(_ push: ServerPush) {
        switch push {
        case .workCanvas(let value):
            items[value.sessionId] = value.items
            if let opened = value.opened { self.opened[value.sessionId] = opened }
        case .workRoutines(let value):
            routinesRev[value.workspaceId, default: 0] += 1
        default:
            break
        }
    }

    /// The pager took the push's `opened`.
    public func tookOpened(_ sessionId: String) { opened[sessionId] = nil }

    /// Takes an item out of the thread's tab row (its files stay on the host).
    public func close(_ item: CanvasItem) async throws {
        _ = try await socket.request(Methods.WorkCanvasClose.self, .init(itemId: item.id))
    }

    // MARK: - each kind's reads and presses

    public func ticket(_ source: Methods.WorkGuestsTicket.Params.Source, title: String) async throws -> String {
        try await socket.request(Methods.WorkGuestsTicket.self, .init(source: source, title: title)).url
    }

    public func makeGuestLink(_ draft: GuestLinkDraft, source: Methods.WorkGuestsCreate.Params.Source, title: String) async throws -> Methods.WorkGuestsCreate.Output {
        try await socket.request(Methods.WorkGuestsCreate.self, .init(source: source, title: title, name: draft.trimmedName, role: draft.role.wire, expiresAt: draft.expiresAtMs))
    }

    public func pdf(_ itemId: String) async throws -> PdfPhoneView {
        try await socket.request(Methods.WorkPdfOpen.self, .init(itemId: itemId))
    }

    /// The PDF's bytes as the view named them, read in frames.
    public func pdfData(_ view: PdfPhoneView) async throws -> Data {
        try await ChunkedRead.all(size: Int(view.size)) { offset, length in
            try await self.socket.request(Methods.WorkPdfRead.self, .init(itemId: view.itemId, which: .file, rev: view.rev, offset: offset, length: length))
        }
    }

    public func deck(_ itemId: String) async throws -> DeckPhoneView {
        try await socket.request(Methods.WorkSlidesOpen.self, .init(itemId: itemId))
    }

    /// One of a deck's renders (a PDF): `proposed` while changes wait.
    public func deckData(_ itemId: String, proposed: Bool, size: Int) async throws -> Data {
        try await ChunkedRead.all(size: size) { offset, length in
            try await self.socket.request(Methods.WorkSlidesRead.self, .init(itemId: itemId, which: proposed ? .proposed : .file, offset: offset, length: length))
        }
    }

    public func reviewDeck(_ itemId: String, accept: Bool) async throws -> DeckPhoneView {
        try await socket.request(Methods.WorkSlidesReview.self, .init(itemId: itemId, changes: .string("all"), verdict: accept ? .accept : .reject))
    }

    /// `plays`: what this viewer can decode, so the host prepares it (an HLS proxy, tiles).
    public func media(_ itemId: String) async throws -> MediaPhoneView {
        try await socket.request(Methods.WorkMediaView.self, .init(itemId: itemId, plays: ["hls", "tiles"]))
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

    public func responses(_ itemId: String) async throws -> FormResponses {
        try await socket.request(Methods.WorkFormsResponses.self, .init(itemId: itemId))
    }

    public func dashboard(_ itemId: String) async throws -> DashboardPhoneView {
        try await socket.request(Methods.WorkDashboardsOpen.self, .init(itemId: itemId))
    }

    public func versions(_ source: CanvasSource) async throws -> HistoryVersionsPhone {
        try await socket.request(Methods.WorkHistoryVersions.self, .init(source: source))
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
}
