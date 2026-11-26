import SwiftUI
import TempCodeClient
import TempCodeContract

/// A folder or lens of a job's Files (`Route.folder`, the sidebar column): its rows in the host's order, a page
/// at a time; a folder pushes in this column, a file opens in the detail. On a cold launch it paints the names
/// kept from the last read (`FolderKept`) until the host answers. Each row's menu offers only what its place
/// does (`FilesRules.offers`): Star, Add to Thread…, Rename…, Move…, Copy…, Delete; a Trash row, Put Back. A file
/// dragged onto a folder row is Move, asked as the menu asks; onto a Work thread's box, its chip. Where the host draws pictures the bar offers the grid.
struct FolderScreen: View {
    @AppStorage("files.grid") private var grid = false
    let client: EnvironmentClient
    let workspaceId: String
    let placeId: String
    let at: FolderRef
    let title: String
    let through: String?
    @State private var desk: FilesDesk
    @State private var query = ""
    @State private var making = false
    @State private var renaming: FileEntry?
    @State private var newName = ""
    /// Add to Thread's chip, while its sheet is up.
    @State private var adding: ContextChip?

    init(client: EnvironmentClient, workspaceId: String, placeId: String, at: FolderRef, title: String, through: String?) {
        self.client = client
        self.workspaceId = workspaceId
        self.placeId = placeId
        self.at = at
        self.title = title
        self.through = through
        _desk = State(initialValue: FilesDesk(client: client))
    }

    private var files: FilesHost { client.work.files }
    private var places: [FilePlace] {
        let own = files.places[workspaceId]?.value ?? []
        return own + (files.far[workspaceId]?.value ?? []).flatMap(\.places)
    }
    private var place: FilePlace? { places.first { $0.id == placeId } }
    private var listing: WorkRead<FilesHost.Listing>? { files.listing(workspaceId, at) }
    private var uploads: [FilesHost.Upload] { files.uploads[FilesHost.slot(workspaceId, at)] ?? [] }
    private var isLens: Bool { place.map { !FilesRules.isHome($0.kind) } ?? false }
    private var route: Route { .folder(environmentId: client.environment.id, workspaceId: workspaceId, placeId: placeId, at: at, title: title, through: through) }
    private var spot: FilesSpot? { place.map { FilesSpot(environmentId: client.environment.id, workspaceId: workspaceId, place: $0, folder: at, through: through) } }

    var body: some View {
        let shown = listing?.value
        let rows = query.trimmingCharacters(in: .whitespaces).isEmpty ? shown?.entries ?? [] : FilesRules.filter(shown?.entries ?? [], query: query)
        let gridOffered = FilesRules.gridOffered(shown?.entries ?? [], far: through != nil, place: place)
        Group {
            switch listing {
            case .failed(let message)?:
                if let place, FilesRules.isDown(place), let words = FilesRules.stateWords(place) {
                    FilesFailed(title: words, message: message, symbol: FilesGlyph.of(place)) { Task { await retry() } }
                } else {
                    FilesFailed(title: "Can’t Open \(title)", message: message) { Task { await retry() } }
                }
            case .loaded(let shown)?:
                // An empty folder read again that failed is the list's failed-read row alone, never "No Files".
                if rows.isEmpty, uploads.isEmpty, !(query.isEmpty && shown.failed != nil) {
                    if query.isEmpty {
                        ContentUnavailableView(emptyTitle, systemImage: place.map { FilesGlyph.of($0) } ?? "folder")
                    } else {
                        ContentUnavailableView.search(text: query)
                    }
                } else if grid, gridOffered, query.isEmpty {
                    FilesGrid(client: client, workspaceId: workspaceId, entries: rows, menu: menu, open: open) {
                        head(shown)
                    } foot: {
                        foot(shown)
                    } more: {
                        Task { await files.more(workspaceId, at) }
                    }
                    .refreshable { await files.list(workspaceId, at, through: through, press: true) }
                } else {
                    list(shown, rows: rows)
                }
            case .reading?, nil:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search \(title)")
        .toolbar {
            if gridOffered {
                ToolbarItem(placement: .secondaryAction) {
                    Button(grid ? "View as List" : "View as Icons", systemImage: grid ? "list.bullet" : "square.grid.2x2") { grid.toggle() }
                        .accessibilityIdentifier("files-grid")
                }
            }
            if let place, through == nil, FilesNewSheet.offers(place, caps: files.caps) {
                ToolbarItem(placement: .primaryAction) {
                    Button("New", systemImage: "plus") { making = true }
                        .keyboardShortcut("n", modifiers: .command)
                        .accessibilityIdentifier("files-new")
                }
            }
        }
        .sheet(isPresented: $making) {
            if let place { FilesNewSheet(client: client, workspaceId: workspaceId, place: place, at: at) }
        }
        .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
                .textInputAutocapitalization(.sentences)
                .accessibilityIdentifier("files-rename-field")
            Button("Cancel", role: .cancel) {}
            Button("Rename") { if let entry = renaming { Task { await rename(entry, to: newName) } } }
        }
        .sheet(item: $adding) { chip in
            AddToThreadSheet(client: client, workspaceId: workspaceId, chip: chip) { sessionId in
                navigator.open(.thread(environmentId: client.environment.id, sessionId: sessionId, seq: nil))
            }
        }
        .filesDesk(desk)
        .placeTop(route, ids: rows.map(\.key))
        .task {
            if files.places[workspaceId]?.value == nil { await files.loadPlaces(workspaceId) }
            if through != nil, files.far[workspaceId]?.value == nil { await files.loadFar(workspaceId) }
            await files.list(workspaceId, at, through: through)
        }
        .task(id: grid && gridOffered ? rows.map(\.key) : []) {
            if grid, gridOffered { await files.loadThumbs(workspaceId, rows, size: FilesRules.thumbSize) }
        }
        .onDisappear { desk.undo = nil }
        .accessibilityIdentifier("files-folder")
    }

    private var emptyTitle: String {
        switch place?.kind {
        case .recent?: "Nothing Recent"
        case .starred?: "Nothing Starred"
        case .mail?: "No Files from Mail"
        case .trash?: "Trash Is Empty"
        default: "No Files"
        }
    }

    private func list(_ shown: FilesHost.Listing, rows: [FileEntry]) -> some View {
        List {
            head(shown)
            ForEach(uploads) { upload in
                UploadRow(upload: upload) { files.dismissUpload(workspaceId, at, id: upload.id) }
                    .listRowInsets(Layout.rowInsets)
            }
            ForEach(rows, id: \.key) { entry in
                entryRow(entry)
                    .id(entry.key)
                    .onAppear { if entry.key == shown.entries.last?.key { Task { await files.more(workspaceId, at) } } }
            }
            foot(shown)
        }
        .listStyle(.plain)
        .refreshable { await files.list(workspaceId, at, through: through, press: true) }
    }

    /// Above the rows, in the list and the grid alike: a read again that failed, the host's words over what
    /// stays shown; a sleeping machine's one muted line.
    @ViewBuilder private func head(_ shown: FilesHost.Listing) -> some View {
        if let failed = shown.failed {
            FailedRead(words: failed, retry: { await retry() }, identifier: "files-folder-failed")
                .listRowSeparator(.hidden)
        }
        if let place, place.state.state == .asleep, let at = shown.asOf ?? place.state.at {
            Text("\(place.host.isEmpty ? place.name : place.host) is asleep. As of \(FilesRules.changedWords(Int(at))).")
                .textStep(.meta)
                .listRowInsets(Layout.rowInsets)
                .listRowSeparator(.hidden)
        }
    }

    /// The foot, in the list and the grid alike: a spinner only while the next page is asked for; a page that
    /// failed says why, with Try Again.
    @ViewBuilder private func foot(_ shown: FilesHost.Listing) -> some View {
        if shown.next != nil {
            if files.loadingMore(workspaceId, at) {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            } else if let failed = shown.moreFailed {
                FailedRead(words: failed, retry: { await files.more(workspaceId, at) }, identifier: "files-more-failed")
                    .listRowSeparator(.hidden)
            }
        }
    }

    /// The place a row lives in: a lens's row, its own home.
    private func home(of entry: FileEntry) -> FilePlace? {
        place.map { FilesRules.home(of: entry, in: $0, places: places) }
    }

    @ViewBuilder private func entryRow(_ entry: FileEntry) -> some View {
        let row = FileRow(client: client, workspaceId: workspaceId, placeId: home(of: entry)?.id ?? placeId, entry: entry, inLens: isLens, through: through)
            .contextMenu { menu(entry) }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if offers(.trash, entry) {
                    Button("Delete", systemImage: "trash", role: .destructive) { trash(entry) }
                } else if place?.kind == .trash, client.work.may(.filesRestore) {
                    Button("Put Back", systemImage: "arrow.uturn.backward") { putBack(entry) }.tint(Tint.info)
                }
            }
            .swipeActions(edge: .leading) {
                if starOffered(entry) {
                    Button(entry.starred == true ? "Unstar" : "Star", systemImage: entry.starred == true ? "star.slash" : "star") { Task { await star(entry) } }
                        .tint(Tint.warning)
                }
            }
        if let folder = entry.folder, let target = home(of: entry), through == nil {
            row.dropDestination(for: FileDrag.self) { drags, _ in
                drop(drags, into: folder, of: target)
            }
        } else if entry.folder == nil, entry.ref != nil, let spot {
            row.draggable(FileDrag(environmentId: spot.environmentId, workspaceId: workspaceId, placeId: home(of: entry)?.id ?? placeId, folder: at, through: through, entry: entry, chip: through == nil ? chip(of: entry) : nil)) {
                FilesRowLabel(symbol: FilesGlyph.of(entry.kind), title: ReaderVerbs.title(entry.name), fact: "")
            }
        } else {
            row
        }
    }

    /// The row's menu, shared by the list and the grid: only what its place does for this key.
    @ViewBuilder private func menu(_ entry: FileEntry) -> some View {
        if place?.kind == .trash {
            if client.work.may(.filesRestore) { Button("Put Back", systemImage: "arrow.uturn.backward") { putBack(entry) } }
        } else {
            if starOffered(entry) {
                Button(entry.starred == true ? "Unstar" : "Star", systemImage: entry.starred == true ? "star.slash" : "star") { Task { await star(entry) } }
            }
            if through == nil, client.work.may(.sessionSend), let chip = chip(of: entry) {
                Button("Add to Thread…", systemImage: "text.bubble") { adding = chip }
            }
            if offers(.rename, entry) {
                Button("Rename…", systemImage: "pencil") { newName = entry.name; renaming = entry }
            }
            if offers(.move, entry), let spot {
                Button("Move…", systemImage: "folder") { desk.choosing = .init(verb: .move, entries: [entry], from: spot.at(home(of: entry))) }
            }
            if mayCopy(entry), let spot {
                Button("Copy…", systemImage: "doc.on.doc") { desk.choosing = .init(verb: .copy, entries: [entry], from: spot.at(home(of: entry))) }
            }
            if offers(.trash, entry) {
                Divider()
                Button("Delete", systemImage: "trash", role: .destructive) { trash(entry) }
            }
        }
    }

    // MARK: - what a row offers

    /// The row as the `file` chip a thread's box takes (`FileChips`): its place and its path inside it.
    private func chip(of entry: FileEntry) -> ContextChip? {
        FileChips.of(entry, place: home(of: entry).map(FileChips.Place.init))
    }

    /// A far computer's folder is read here and changed on that computer (`farWhy`).
    private func offers(_ verb: FilePlace.Can, _ entry: FileEntry) -> Bool {
        guard through == nil, entry.ref != nil || entry.folder != nil, let home = home(of: entry) else { return false }
        return FilesRules.offers(home, verb, entry: entry, caps: files.caps)
    }

    /// Copy… needs only a place to put it: the place it lives in may hand out a copy to any place that takes one.
    private func mayCopy(_ entry: FileEntry) -> Bool {
        guard through == nil, entry.ref != nil || entry.folder != nil, let home = home(of: entry), files.caps.operate else { return false }
        return !(home.shared && home.kind != .drive) && home.kind != .lifeos
    }

    private func starOffered(_ entry: FileEntry) -> Bool {
        files.caps.operate && through == nil && (entry.ref != nil || entry.folder != nil) && place?.kind != .trash
    }

    // MARK: - presses

    private func open(_ entry: FileEntry) {
        // The grid's tile: the same route the row takes.
        if let folder = entry.folder {
            navigatorOpen(.folder(environmentId: client.environment.id, workspaceId: workspaceId, placeId: home(of: entry)?.id ?? placeId, at: folder, title: entry.name, through: through))
        } else if entry.ref != nil {
            navigatorOpen(.filesFile(environmentId: client.environment.id, workspaceId: workspaceId, placeId: home(of: entry)?.id ?? placeId, entry: entry))
        }
    }

    @Environment(ShellNavigator.self) private var navigator
    private func navigatorOpen(_ route: Route) { navigator.open(route) }

    private func drop(_ drags: [FileDrag], into folder: FolderRef, of target: FilePlace) -> Bool {
        let mine = drags.filter { $0.environmentId == client.environment.id && $0.workspaceId == workspaceId }
        guard let first = mine.first else {
            desk.failure = drags.isEmpty ? nil : "A file moves only within its own job here. Use Copy… on your computer to put it in another."
            return false
        }
        guard let from = places.first(where: { $0.id == first.placeId }) else { return false }
        if first.through != nil { desk.failure = "Change that computer's files on that computer itself."; return false }
        desk.change(.move, mine.map(\.entry), from: FilesSpot(environmentId: first.environmentId, workspaceId: workspaceId, place: from, folder: first.folder, through: nil), to: target, folder: folder)
        return true
    }

    private func retry() async {
        await files.loadPlaces(workspaceId)
        await files.list(workspaceId, at, through: through, press: true)
    }

    private func star(_ entry: FileEntry) async {
        do { try await files.star(workspaceId, entry, on: entry.starred != true) } catch { desk.failure = ActionError.wrap(error).message }
    }

    private func rename(_ entry: FileEntry, to name: String) async {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name != entry.name else { return }
        if let problem = FilesRules.nameProblem(name) { return desk.failure = problem }
        do { try await files.rename(workspaceId, entry, to: name, in: at) } catch { desk.failure = ActionError.wrap(error).message }
    }

    private func trash(_ entry: FileEntry) {
        guard let spot else { return }
        desk.trash([entry], in: spot.at(home(of: entry)))
    }

    /// A Trash row's id is its key after `trash:`.
    private func putBack(_ entry: FileEntry) {
        guard let spot, entry.key.hasPrefix("trash:") else { return }
        Task { await desk.restore([String(entry.key.dropFirst("trash:".count))], in: spot) }
    }
}

private extension FilesSpot {
    /// The same folder, as seen from the place a lens's row lives in.
    func at(_ home: FilePlace?) -> FilesSpot {
        FilesSpot(environmentId: environmentId, workspaceId: workspaceId, place: home ?? place, folder: folder, through: through)
    }
}

/// The folder as icons: the host's small picture of each file where it makes one, else the kind's glyph; the
/// name under it. A tile opens as its row does and holds the same menu. The list's head and foot frame the
/// tiles, and the last tile shown asks for the next page as the last row does.
struct FilesGrid<Actions: View, Head: View, Foot: View>: View {
    let client: EnvironmentClient
    let workspaceId: String
    let entries: [FileEntry]
    @ViewBuilder let menu: (FileEntry) -> Actions
    let open: (FileEntry) -> Void
    @ViewBuilder let head: () -> Head
    @ViewBuilder let foot: () -> Foot
    let more: () -> Void
    @ScaledMetric(relativeTo: .caption) private var tile: CGFloat = 96

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Layout.textEdge) {
                head()
                // From the top, so a two-line name never lifts its tile above its neighbours.
                LazyVGrid(columns: [GridItem(.adaptive(minimum: tile), spacing: Layout.rowGap, alignment: .top)], spacing: Layout.textEdge) {
                    ForEach(entries, id: \.key) { entry in
                        Button { open(entry) } label: { FilesTile(client: client, entry: entry, edge: tile) }
                            .buttonStyle(.pressable)
                            .contextMenu { menu(entry) }
                            .id(entry.key)
                            .accessibilityIdentifier("files-tile-\(entry.name)")
                            .onAppear { if entry.key == entries.last?.key { more() } }
                    }
                }
                foot()
            }
            .padding(Layout.textEdge)
        }
    }
}

private struct FilesTile: View {
    let client: EnvironmentClient
    let entry: FileEntry
    let edge: CGFloat

    var body: some View {
        let picture = client.work.files.thumbs[FilesHost.thumbKey(entry)].flatMap(UIImage.init(data:))
        VStack(spacing: Layout.rowVertical) {
            ZStack {
                RoundedRectangle.rowCorner.fill(Surface.chrome)
                if let picture {
                    Image(uiImage: picture)
                        .resizable()
                        .scaledToFit()
                        .clipShape(.rowCorner)
                        .transition(.opacity)
                } else {
                    Image(systemName: FilesGlyph.of(entry.kind))
                        .font(.title2)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: edge, height: edge)
            .animation(Motion.base, value: picture != nil)
            // Our own two endings dropped, as the reader's bar names the file (`ReaderVerbs.title`).
            Text(ReaderVerbs.title(entry.name))
                .font(.caption)
                .fontWeight(entry.fresh == true ? .semibold : .regular)
                .lineLimit(2)
                .truncationMode(.middle)
                .multilineTextAlignment(.center)
                .frame(width: edge)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel([entry.name, FilesRules.fact(entry, inLens: false)].filter { !$0.isEmpty }.joined(separator: ", "))
    }
}
