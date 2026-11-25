import CoreTransferable
import SwiftUI
import TempCodeClient
import TempCodeContract
import UniformTypeIdentifiers

/// A file row dragged onto a folder row: which file, in which job and place, and the folder it lies in.
nonisolated struct FileDrag: Codable, Transferable, Sendable {
    let environmentId: String
    let workspaceId: String
    let placeId: String
    let folder: FolderRef
    let through: String?
    let entry: FileEntry
    /// The row as the chip a thread's box takes when it is dropped there (`ChipDrag` reads this key alone).
    var chip: ContextChip? = nil

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .json)
    }
}

/// Where a change is pressed: the folder shown, its place, and the far computer it is listed through.
struct FilesSpot: Equatable {
    let environmentId: String
    let workspaceId: String
    let place: FilePlace
    let folder: FolderRef
    let through: String?
}

/// The presses that change things in a folder, each through the rules the desktop asks by (src/shared/work/
/// files.ts `refusal` and `questionFor`, the host's `admitWrite`): a change the place will not take says why in
/// the grammar's words; a change others will see asks its one question first, and his yes goes with it
/// (`asked`); whatever the host still refuses shows in its own words. Delete puts Undo over the list's foot.
@MainActor @Observable
final class FilesDesk {
    /// The one question before a change others will see.
    struct Ask: Identifiable {
        let id = UUID()
        let title: String
        let body: String?
        let confirm: String
        let destructive: Bool
        let run: @MainActor () async -> Void
    }

    var asking: Ask?
    var failure: String?
    var undo: TrashUndo?
    /// The folder the last delete was made in, for its Undo.
    @ObservationIgnored private(set) var lastSpot: FilesSpot?
    /// The Move… or Copy… sheet, by the rows it carries.
    var choosing: Choosing?
    /// A change on its way: the rows it names wait.
    private(set) var busy = false

    struct Choosing: Identifiable {
        let id = UUID()
        let verb: FilePlace.Can
        let entries: [FileEntry]
        let from: FilesSpot
    }

    let client: EnvironmentClient
    init(client: EnvironmentClient) { self.client = client }

    private var files: FilesHost { client.work.files }

    /// Move or copy `entries` from `from` into the folder `to` of `place`.
    func change(_ verb: FilePlace.Can, _ entries: [FileEntry], from: FilesSpot, to place: FilePlace, folder: FolderRef) {
        guard let first = entries.first else { return }
        if FilesRules.key(folder) == FilesRules.key(from.folder) { return }
        if let entryFolder = first.folder, FilesRules.key(entryFolder) == FilesRules.key(folder) { return }
        if let no = FilesRules.refusal(from.place, verb, entry: first, to: place) { return failure = no.text }
        // The host's door asks approve of a remote key for a place others can open: said here in its words.
        guard FilesRules.offers(from.place, verb, entry: first, to: place, caps: files.caps) else {
            return failure = "Others can open that place: this key may not change it."
        }
        let run: @MainActor (Bool) async -> Void = { asked in
            await self.running {
                if verb == .copy {
                    try await self.files.copy(from.workspaceId, entries, to: folder, from: from.folder, asked: asked)
                } else {
                    try await self.files.move(from.workspaceId, entries, to: folder, from: from.folder, asked: asked)
                }
            }
        }
        if let question = FilesRules.question(from.place, verb, entry: first, to: place) {
            let (title, body) = Self.split(question)
            asking = Ask(title: title, body: body, confirm: verb == .copy ? "Copy" : "Move", destructive: false) { await run(true) }
        } else {
            Task { await run(false) }
        }
    }

    /// Delete: at once, with Undo, in his own place; asked first where others can open it or no bin takes it.
    func trash(_ entries: [FileEntry], in spot: FilesSpot) {
        guard let first = entries.first else { return }
        lastSpot = spot
        let run: @MainActor (Bool, Bool) async -> Void = { asked, forGood in
            await self.running {
                let ids = try await self.files.trash(spot.workspaceId, entries, in: spot.folder, asked: asked, forGood: forGood)
                if !ids.isEmpty { self.undo = TrashUndo(ids: ids, line: entries.count == 1 ? "Deleted \(first.name)" : "Deleted \(entries.count) items") }
            }
        }
        guard FilesRules.deleteAsks(spot.place, entry: first) else {
            Task { await run(false, false) }
            return
        }
        let words = FilesRules.deleteAsk(spot.place, names: entries.map(\.name))
        let forGood = spot.place.bin == false
        asking = Ask(title: words.title, body: words.body, confirm: "Delete", destructive: true) {
            await run(FilesRules.question(spot.place, .trash, entry: first) != nil, forGood)
        }
    }

    /// Put Back: the Trash rows, by the ids the delete answered or the Trash lens lists.
    func restore(_ ids: [String], in spot: FilesSpot) async {
        await running { try await self.files.restore(spot.workspaceId, ids, in: spot.folder) }
    }

    private func running(_ change: @MainActor () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do {
            try await change()
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } catch {
            failure = ActionError.wrap(error).message
        }
    }

    /// "Copy to Esports? Everyone in that team can open it." as the dialog's title and its message.
    static func split(_ question: String) -> (String, String?) {
        guard let mark = question.firstIndex(of: "?") else { return (question, nil) }
        let rest = question[question.index(after: mark)...].trimmingCharacters(in: .whitespaces)
        return (String(question[...mark]), rest.isEmpty ? nil : rest)
    }
}

extension View {
    /// The desk's question, its failure in the host's words, Delete's Undo and the Move… or Copy… sheet.
    func filesDesk(_ desk: FilesDesk) -> some View {
        modifier(FilesDeskModifier(desk: desk))
    }
}

private struct FilesDeskModifier: ViewModifier {
    @Bindable var desk: FilesDesk

    func body(content: Content) -> some View {
        content
            .confirmationDialog(desk.asking?.title ?? "", isPresented: Binding(get: { desk.asking != nil }, set: { if !$0 { desk.asking = nil } }), titleVisibility: .visible, presenting: desk.asking) { ask in
                Button(ask.confirm, role: ask.destructive ? .destructive : nil) { Task { await ask.run() } }
                Button("Cancel", role: .cancel) {}
            } message: { ask in
                if let body = ask.body { Text(body) }
            }
            .alert("Couldn’t Do That", isPresented: Binding(get: { desk.failure != nil }, set: { if !$0 { desk.failure = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(FilesRules.sentence(desk.failure ?? "")) }
            .filesUndoInset($desk.undo) { pending in
                guard let spot = desk.lastSpot else { return }
                Task { await desk.restore(pending.ids, in: spot) }
            }
            .sheet(item: $desk.choosing) { choosing in
                FilesMoveSheet(desk: desk, choosing: choosing)
            }
    }
}

/// Move… and Copy…: the job's places, then their folders a level at a time; the folder shown takes the press.
/// A place the change cannot go to says why under the list and draws no press; one others can open asks its
/// question once the sheet goes.
struct FilesMoveSheet: View {
    @Environment(\.dismiss) private var dismiss
    let desk: FilesDesk
    let choosing: FilesDesk.Choosing

    private var files: FilesHost { desk.client.work.files }
    private var places: [FilePlace] {
        (files.places[choosing.from.workspaceId]?.value ?? []).filter { FilesRules.isHome($0.kind) && $0.kind != .lifeos }
    }
    private var title: String {
        let what = choosing.entries.count == 1 ? "“\(choosing.entries[0].name)”" : "\(choosing.entries.count) Items"
        return "\(choosing.verb == .copy ? "Copy" : "Move") \(what)"
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(places, id: \.id) { place in
                    NavigationLink(value: MoveTarget(place: place, folder: place.root, title: place.name)) {
                        FilesRowLabel(symbol: FilesGlyph.of(place), title: place.name, fact: FilesRules.placeFact(place), dimmed: FilesRules.isDown(place))
                    }
                    .listRowInsets(Layout.rowInsets)
                }
            }
            .listStyle(.plain)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: MoveTarget.self) { target in
                MoveFolderList(desk: desk, choosing: choosing, target: target) { dismiss() }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier("files-move-sheet")
    }
}

private struct MoveTarget: Hashable {
    let place: FilePlace
    let folder: FolderRef
    let title: String
}

/// One folder in the sheet: its folders push; the bar's press puts the rows here.
private struct MoveFolderList: View {
    let desk: FilesDesk
    let choosing: FilesDesk.Choosing
    let target: MoveTarget
    let done: () -> Void

    private var files: FilesHost { desk.client.work.files }
    private var refusal: String? {
        guard let first = choosing.entries.first else { return nil }
        if FilesRules.key(target.folder) == FilesRules.key(choosing.from.folder) { return "It is already here." }
        return FilesRules.refusal(choosing.from.place, choosing.verb, entry: first, to: target.place)?.text
    }

    var body: some View {
        let listing = files.listing(choosing.from.workspaceId, target.folder)
        let moving = Set(choosing.entries.map(\.key))
        let folders = (listing?.value?.entries ?? []).filter { $0.folder != nil && !moving.contains($0.key) }
        List {
            ForEach(folders, id: \.key) { entry in
                if let folder = entry.folder {
                    NavigationLink(value: MoveTarget(place: target.place, folder: folder, title: entry.name)) {
                        FilesRowLabel(symbol: "folder", title: entry.name, fact: "")
                    }
                    .listRowInsets(Layout.rowInsets)
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if listing?.value == nil, case .failed(let message)? = listing {
                FilesFailed(title: "Can’t Open \(target.title)", message: message) { Task { await files.list(choosing.from.workspaceId, target.folder) } }
            } else if listing?.value == nil {
                ProgressView()
            }
        }
        .navigationTitle(target.title)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: Layout.rowVertical) {
                if let refusal {
                    Text(refusal).textStep(.meta).multilineTextAlignment(.center)
                } else {
                    Button {
                        done()
                        desk.change(choosing.verb, choosing.entries, from: choosing.from, to: target.place, folder: target.folder)
                    } label: {
                        Text(choosing.verb == .copy ? "Copy Here" : "Move Here").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
                    .accessibilityIdentifier("files-move-here")
                }
            }
            .padding(Layout.textEdge)
        }
        .task { await files.list(choosing.from.workspaceId, target.folder) }
    }
}
