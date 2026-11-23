import SwiftUI
import TempCodeClient
import TempCodeContract

/// A folder or lens pushed inside the Files place. Not Codable: the place is read again on a cold launch,
/// so the navigation memory keeps the Files screen and drops what was pushed over it.
struct FilesFolderRoute: Hashable {
    let environmentId: String
    let workspaceId: String
    /// The place listed (a lens is a place of its own here: Recent, Starred, From mail).
    let placeId: String
    let at: FolderRef
    let title: String
}

/// A file opened from a list (`FilesOpen.page` draws it).
struct FileOpenRoute: Hashable {
    let environmentId: String
    let workspaceId: String
    let placeId: String
    let entry: FileEntry
}

/// A Work workspace's Files (the files pillar's F9; docs/IOS-DESIGN.md "Files"): Recent and Starred, then the
/// places, then From mail, each pushing its list. The system search field searches the workspace; + opens New
/// for the workspace's folder.
struct FilesScreen: View {
    @Environment(ShellNavigator.self) private var navigator
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    @State private var query = ""
    @State private var making = false

    private var files: FilesHost { client.work.files }
    private var all: [FilePlace] { files.places[workspace.id]?.value ?? [] }

    var body: some View {
        Group {
            switch files.places[workspace.id] {
            case .failed(let message)?:
                FilesFailed(title: "Can’t Read Files", message: message) { Task { await files.loadPlaces(workspace.id) } }
            case .loaded?:
                if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                    FilesSearchList(client: client, workspaceId: workspace.id, query: query, local: files.known(workspace.id), places: all)
                } else {
                    placesList
                }
            case .reading?, nil:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle("Files")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search Files")
        .toolbar {
            if let folder = FilesRules.workspaceFolder(all), FilesNewSheet.offers(folder, caps: files.caps) {
                ToolbarItem(placement: .primaryAction) {
                    Button("New", systemImage: "plus") { making = true }
                        .accessibilityIdentifier("files-new")
                }
            }
        }
        .sheet(isPresented: $making) {
            if let folder = FilesRules.workspaceFolder(all) {
                FilesNewSheet(client: client, workspaceId: workspace.id, place: folder, at: folder.root)
            }
        }
        .task {
            await files.loadPlaces(workspace.id)
            #if DEBUG
            await FilesProof.walk(client: client, workspace: workspace, navigator: navigator)
            #endif
        }
        .navigationDestination(for: FilesFolderRoute.self) { route in
            FolderScreen(client: client, route: route)
        }
        .navigationDestination(for: FileOpenRoute.self) { route in
            FilesOpen.page(client: client, route: route)
        }
        .accessibilityIdentifier("files")
    }

    private var placesList: some View {
        let sections = FilesRules.sections(all)
        return Group {
            if sections.isEmpty {
                ContentUnavailableView("No Places", systemImage: "folder", description: Text("\(client.environment.name) lists no place for this workspace."))
            } else {
                List {
                    if !sections.lenses.isEmpty {
                        Section { ForEach(sections.lenses, id: \.id) { PlaceRow(client: client, workspaceId: workspace.id, place: $0) } }
                    }
                    if !sections.places.isEmpty {
                        Section {
                            ForEach(sections.places, id: \.id) { PlaceRow(client: client, workspaceId: workspace.id, place: $0) }
                        } header: {
                            Text("Places").textStep(.meta, weight: .semibold)
                        }
                    }
                    if !sections.mail.isEmpty {
                        Section { ForEach(sections.mail, id: \.id) { PlaceRow(client: client, workspaceId: workspace.id, place: $0) } }
                    }
                }
                .listStyle(.plain)
                .refreshable { await files.loadPlaces(workspace.id) }
            }
        }
    }
}

/// One place or lens on the Files screen: its glyph, its name, and its one fact (its state while it does not
/// answer, its team, how many files a lens holds).
private struct PlaceRow: View {
    let client: EnvironmentClient
    let workspaceId: String
    let place: FilePlace

    var body: some View {
        NavigationLink(value: FilesFolderRoute(environmentId: client.environment.id, workspaceId: workspaceId, placeId: place.id, at: place.root, title: place.kind == .mail ? "From Mail" : place.name)) {
            FilesRowLabel(symbol: FilesGlyph.of(place), title: place.kind == .mail ? "From Mail" : place.name, fact: fact, dimmed: FilesRules.isDown(place))
        }
        .listRowInsets(Layout.rowInsets)
        .accessibilityIdentifier("files-place-\(place.id)")
    }

    private var fact: String {
        if let count = place.count, place.kind == .mail { return "\(Int(count))" }
        return FilesRules.placeFact(place)
    }
}

/// A folder or lens: its rows in the host's order, a page at a time; folders push, files open. Each row's
/// menu and swipes offer only what its place does (`FilesRules.offers`); a change the host refuses shows its
/// sentence as it is.
struct FolderScreen: View {
    let client: EnvironmentClient
    let route: FilesFolderRoute
    @State private var query = ""
    @State private var making = false
    @State private var renaming: FileEntry?
    @State private var newName = ""
    @State private var failure: String?
    @State private var undo: TrashUndo?

    private var files: FilesHost { client.work.files }
    private var places: [FilePlace] { files.places[route.workspaceId]?.value ?? [] }
    private var place: FilePlace? { places.first { $0.id == route.placeId } }
    private var listing: WorkRead<FilesHost.Listing>? { files.listing(route.workspaceId, route.at) }
    private var uploads: [FilesHost.Upload] { files.uploads[FilesHost.slot(route.workspaceId, route.at)] ?? [] }
    private var isLens: Bool { place.map { !FilesRules.isHome($0.kind) } ?? false }

    var body: some View {
        Group {
            if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                FilesSearchList(client: client, workspaceId: route.workspaceId, query: query, local: listing?.value?.entries ?? [], places: places)
            } else {
                content
            }
        }
        .navigationTitle(route.title)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search \(route.title)")
        .toolbar {
            if let place, FilesNewSheet.offers(place, caps: files.caps) {
                ToolbarItem(placement: .primaryAction) {
                    Button("New", systemImage: "plus") { making = true }
                        .accessibilityIdentifier("files-new")
                }
            }
        }
        .sheet(isPresented: $making) {
            if let place { FilesNewSheet(client: client, workspaceId: route.workspaceId, place: place, at: route.at) }
        }
        .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
                .textInputAutocapitalization(.sentences)
                .accessibilityIdentifier("files-rename-field")
            Button("Cancel", role: .cancel) {}
            Button("Rename") { if let entry = renaming { Task { await rename(entry, to: newName) } } }
        }
        .alert("Couldn’t Do That", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(failure ?? "") }
        .filesUndoInset($undo) { pending in Task { await putBack(pending) } }
        .task {
            if files.places[route.workspaceId]?.value == nil { await files.loadPlaces(route.workspaceId) }
            await files.list(route.workspaceId, route.at)
        }
        .onDisappear { undo = nil }
        .accessibilityIdentifier("files-folder")
    }

    @ViewBuilder private var content: some View {
        switch listing {
        case .failed(let message)?:
            if let place, FilesRules.isDown(place), let words = FilesRules.stateWords(place) {
                FilesFailed(title: words, message: message, symbol: FilesGlyph.of(place)) { Task { await retry() } }
            } else {
                FilesFailed(title: "Can’t Open \(route.title)", message: message) { Task { await retry() } }
            }
        case .loaded(let shown)?:
            if shown.entries.isEmpty, uploads.isEmpty {
                ContentUnavailableView(emptyTitle, systemImage: place.map { FilesGlyph.of($0) } ?? "folder")
            } else {
                rows(shown)
            }
        case .reading?, nil:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var emptyTitle: String {
        switch place?.kind {
        case .recent?: "Nothing Recent"
        case .starred?: "Nothing Starred"
        case .mail?: "No Files from Mail"
        default: "No Files"
        }
    }

    private func rows(_ shown: FilesHost.Listing) -> some View {
        List {
            if let place, place.state.state == .asleep, let at = shown.asOf ?? place.state.at {
                Text("\(place.host.isEmpty ? place.name : place.host) is asleep. As of \(FilesRules.changedWords(Int(at))).")
                    .textStep(.meta)
                    .listRowInsets(Layout.rowInsets)
                    .listRowSeparator(.hidden)
            }
            ForEach(uploads) { upload in
                UploadRow(upload: upload) { files.dismissUpload(route.workspaceId, route.at, id: upload.id) }
                    .listRowInsets(Layout.rowInsets)
            }
            ForEach(shown.entries, id: \.key) { entry in
                entryRow(entry)
                    .onAppear { if entry.key == shown.entries.last?.key { Task { await files.more(route.workspaceId, route.at) } } }
            }
            if shown.next != nil {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .refreshable { await files.list(route.workspaceId, route.at) }
    }

    private func entryRow(_ entry: FileEntry) -> some View {
        let home = place.map { FilesRules.home(of: entry, in: $0, places: places) }
        let can = { (verb: FilePlace.Can) in home.map { FilesRules.offers($0, verb, entry: entry, caps: files.caps) } ?? false }
        return FileRow(client: client, workspaceId: route.workspaceId, placeId: home?.id ?? route.placeId, entry: entry, inLens: isLens)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if can(.trash) {
                    Button("Delete", systemImage: "trash", role: .destructive) { Task { await trash(entry) } }
                }
            }
            .swipeActions(edge: .leading) {
                if files.caps.operate {
                    Button(entry.starred == true ? "Unstar" : "Star", systemImage: entry.starred == true ? "star.slash" : "star") { Task { await star(entry) } }
                        .tint(Tint.warning)
                }
            }
            .contextMenu {
                if files.caps.operate {
                    Button(entry.starred == true ? "Unstar" : "Star", systemImage: entry.starred == true ? "star.slash" : "star") { Task { await star(entry) } }
                }
                if can(.rename) {
                    Button("Rename…", systemImage: "pencil") { newName = entry.name; renaming = entry }
                }
                if can(.trash) {
                    Button("Delete", systemImage: "trash", role: .destructive) { Task { await trash(entry) } }
                }
            }
    }

    // MARK: - presses

    private func retry() async {
        await files.loadPlaces(route.workspaceId)
        await files.list(route.workspaceId, route.at)
    }

    private func star(_ entry: FileEntry) async {
        do { try await files.star(route.workspaceId, entry, on: entry.starred != true) } catch { failure = ActionError.wrap(error).message }
    }

    private func rename(_ entry: FileEntry, to name: String) async {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name != entry.name else { return }
        if let problem = FilesRules.nameProblem(name) { return failure = problem }
        do { try await files.rename(route.workspaceId, entry, to: name, in: route.at) } catch { failure = ActionError.wrap(error).message }
    }

    private func trash(_ entry: FileEntry) async {
        do {
            let ids = try await files.trash(route.workspaceId, [entry], in: route.at)
            if !ids.isEmpty { undo = TrashUndo(ids: ids, line: "Deleted \(entry.name)") }
        } catch {
            failure = ActionError.wrap(error).message
        }
    }

    private func putBack(_ pending: TrashUndo) async {
        do { try await files.restore(route.workspaceId, pending.ids, in: route.at) } catch { failure = ActionError.wrap(error).message }
    }
}

/// A file or folder row: a folder pushes its list, a file opens.
struct FileRow: View {
    let client: EnvironmentClient
    let workspaceId: String
    /// The place the row lives in (a lens's row: its own home).
    let placeId: String
    let entry: FileEntry
    let inLens: Bool

    var body: some View {
        Group {
            if let folder = entry.folder {
                NavigationLink(value: FilesFolderRoute(environmentId: client.environment.id, workspaceId: workspaceId, placeId: placeId, at: folder, title: entry.name)) { label }
            } else {
                NavigationLink(value: FileOpenRoute(environmentId: client.environment.id, workspaceId: workspaceId, placeId: placeId, entry: entry)) { label }
            }
        }
        .listRowInsets(Layout.rowInsets)
        .accessibilityIdentifier("files-row-\(entry.name)")
    }

    private var label: some View {
        FilesRowLabel(symbol: FilesGlyph.of(entry.kind), title: entry.name, fact: FilesRules.fact(entry, inLens: inLens), bold: entry.fresh == true)
    }
}

/// The house list row as the Files place draws it: the glyph in the 28 pt mark slot, the name, one fact as
/// the stamp. A fresh file (a thread made it and he has not opened it) carries its name in semibold.
struct FilesRowLabel: View {
    let symbol: String
    let title: String
    let fact: String
    var bold = false
    var dimmed = false
    @ScaledMetric(relativeTo: .subheadline) private var mark: CGFloat = 28

    var body: some View {
        HStack(spacing: Layout.rowGap + 2) {
            Image(systemName: symbol)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: mark, height: mark)
            Text(title)
                .textStep(.title, weight: bold ? .semibold : .regular)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            if !fact.isEmpty {
                Text(fact).textStep(.stamp).lineLimit(1).monospacedDigit()
            }
        }
        .opacity(dimmed ? 0.5 : 1)
        .frame(minHeight: Layout.rowHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// An upload under way into the folder: its name, the bar, and on a failure the reason with Dismiss.
private struct UploadRow: View {
    let upload: FilesHost.Upload
    let dismiss: () -> Void
    @ScaledMetric(relativeTo: .subheadline) private var mark: CGFloat = 28

    var body: some View {
        HStack(spacing: Layout.rowGap + 2) {
            Image(systemName: upload.failed == nil ? "arrow.up.circle" : "exclamationmark.circle")
                .font(.subheadline)
                .foregroundStyle(upload.failed == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(Tint.destructive))
                .frame(width: mark, height: mark)
            VStack(alignment: .leading, spacing: 4) {
                Text(upload.name).textStep(.title).lineLimit(1).truncationMode(.middle)
                if let failed = upload.failed {
                    Text(failed).textStep(.meta, tint: Tint.destructiveText).lineLimit(2)
                } else {
                    ProgressView(value: upload.fraction).progressViewStyle(.linear)
                }
            }
            if upload.failed != nil {
                Button("Dismiss", action: dismiss).font(.footnote).rowActionHit()
            }
        }
        .frame(minHeight: Layout.rowHeight)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("files-upload")
    }
}

/// A read that failed: why, and the one press.
struct FilesFailed: View {
    let title: String
    let message: String
    var symbol = "exclamationmark.triangle"
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(message)
        } actions: {
            Button("Try Again", action: retry)
        }
    }
}

/// Each kind's glyph, the desktop's in SF Symbols.
enum FilesGlyph {
    static func of(_ kind: FileEntry.Kind) -> String {
        switch kind {
        case .folder: "folder"
        case .document: "doc.text"
        case .sheet: "tablecells"
        case .deck: "rectangle.on.rectangle"
        case .pdf: "doc.richtext"
        case .picture: "photo"
        case .video: "film"
        case .audio: "waveform"
        case .text: "doc.plaintext"
        case .archive: "archivebox"
        case .other, .unknown: "doc"
        }
    }

    static func of(_ place: FilePlace) -> String {
        switch place.kind {
        case .recent: "clock"
        case .starred: "star"
        case .mail: "envelope"
        case .lifeos: "doc.text"
        case .onedrive: "cloud"
        case .teams: "person.2"
        case .drive: "externaldrive"
        case .trash: "trash"
        default: "folder"
        }
    }
}
