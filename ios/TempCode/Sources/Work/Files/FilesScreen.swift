import SwiftUI
import TempCodeClient
import TempCodeContract

/// A file opened from a list (`FilesOpen.page` draws it), made from `Route.filesFile`.
struct FileOpenRoute: Hashable {
    let environmentId: String
    let workspaceId: String
    let placeId: String
    let entry: FileEntry
}

/// Files for every job (docs/IOS-DESIGN.md "Files"): a place of the Work tab, in the sidebar column. Each job's
/// places under its name (Recent and Starred, its places, the computers its host reaches, From Mail, Trash),
/// narrowed by the job filter. A place pushes its folder in this column (`Route.folder`); a file opens in the
/// detail (`Route.filesFile`). The search field finds across the jobs shown; Go to (⌘P) jumps by name; the
/// searches he saved on his computer run from the bar.
struct FilesPlaceScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    let job: String?
    @State private var pick: String?
    @State private var query = ""
    @State private var found: FilesFound?
    /// A saved search running in the list in place of the places.
    @State private var saved: SavedRun?
    @State private var searches: [String: [SavedFileSearch]] = [:]
    /// Typed, saved, Try Again's or a pull's: only the newest search started sets `found`.
    @State private var searchRuns = FilesGoToRules.Lookups()
    @State private var goingTo = false
    @State private var making: FilesRoot.Job?

    init(job: String?) {
        self.job = job
        _pick = State(initialValue: job)
    }

    var body: some View {
        let clients = model.registry.ordered.filter(\.work.isOn)
        let jobs = FilesRoot.unique(clients.flatMap { FilesRoot.jobs(environmentId: $0.environment.id, workspaces: $0.workspaces) })
        let shown = FilesRoot.shown(jobs, pick: pick)
        let bands = shown.compactMap { job in model.registry.client(job.environmentId).map { Shown(job: job, client: $0) } }
        let searching = saved != nil || !query.trimmingCharacters(in: .whitespaces).isEmpty
        let ids = searching ? (found?.rows.map(\.id) ?? []) : bands.flatMap(\.ids)
        WorkPlaceScreen(
            place: .files,
            job: job,
            ids: ids,
            loading: searching ? found.map { !$0.waiting.isEmpty } ?? true : bands.contains { $0.places == nil },
            empty: searching ? PlaceEmpty(title: "No Results", line: saved == nil ? "Nothing here is called “\(query)”." : nil)
                : PlaceEmpty(title: jobs.isEmpty ? "No Jobs Yet" : "No Places", line: jobs.isEmpty ? "Files shows the places of each job." : nil),
            failure: searching ? found?.note : Self.failure(bands),
            // A failed search asks its hosts again; a failed place reads the places again.
            retry: { if searching { await search(shown) } else { await load(bands) } },
            jobs: jobs.count > 1 ? jobs.map { PlaceJob(id: $0.id, name: $0.name, sector: $0.sector) } : [],
            filter: jobs.count > 1 ? $pick : nil,
            search: $query,
            refresh: { if searching { await search(shown) } else { await load(bands) } }
        ) {
            if searching {
                FoundRows(found: found, saved: saved, multiJob: shown.count > 1) { saved = nil }
            } else {
                ForEach(bands) { band in
                    ShareRefusedSection(client: band.client, workspaceId: band.job.workspaceId)
                    BandSection(band: band, named: bands.count > 1)
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Go To", systemImage: "arrow.forward.circle") { goingTo = true }
                    .keyboardShortcut("p", modifiers: .command)
                    .accessibilityIdentifier("files-go-to")
            }
            if !savedMenu(shown).isEmpty {
                ToolbarItem(placement: .primaryAction) {
                    Menu("Saved Searches", systemImage: "text.magnifyingglass") {
                        ForEach(savedMenu(shown), id: \.search.id) { run in
                            Button(shown.count > 1 ? "\(run.search.name) (\(run.job.name))" : run.search.name) { query = ""; saved = run }
                        }
                    }
                    .accessibilityIdentifier("files-saved")
                }
            }
            if shown.count == 1, let one = bands.first, let folder = FilesRules.workspaceFolder(one.client.work.files.places[one.job.workspaceId]?.value ?? []),
               FilesNewSheet.offers(folder, caps: one.client.work.files.caps) {
                ToolbarItem(placement: .primaryAction) {
                    Button("New", systemImage: "plus") { making = one.job }
                        .keyboardShortcut("n", modifiers: .command)
                        .accessibilityIdentifier("files-new")
                }
            }
        }
        .sheet(isPresented: $goingTo) { FilesGoTo(jobs: shown) }
        .sheet(item: $making) { job in
            if let client = model.registry.client(job.environmentId), let folder = FilesRules.workspaceFolder(client.work.files.places[job.workspaceId]?.value ?? []) {
                FilesNewSheet(client: client, workspaceId: job.workspaceId, place: folder, at: folder.root)
            }
        }
        .onChange(of: query) { if !query.isEmpty { saved = nil } }
        .task(id: shown.map(\.id)) {
            await load(bands)
            #if DEBUG
            await FilesProof.walk(jobs: shown, registry: model.registry, navigator: navigator)
            if let words = TestHooks.filesQuery, query.isEmpty, TestHooks.once("files-query") { query = words }
            #endif
        }
        .task(id: SearchKey(query: query, jobs: shown.map(\.id), saved: saved?.search.id)) { await search(shown) }
        .accessibilityIdentifier("files")
    }

    /// Each job's places and the computers its host reaches, and the searches saved for it.
    private func load(_ bands: [Shown]) async {
        await withTaskGroup(of: Void.self) { group in
            for band in bands {
                let files = band.client.work.files
                let id = band.job.workspaceId
                ShareRefused.shared.read(client: band.client, workspaceId: id)
                group.addTask { await files.loadPlaces(id) }
                group.addTask { await files.loadFar(id) }
            }
        }
        for band in bands {
            searches[band.job.id] = (try? await band.client.work.files.searches(band.job.workspaceId)) ?? searches[band.job.id] ?? []
        }
    }

    /// The search as he types: the rows the phone holds at once, then each job's host's answer once he pauses.
    /// A new keystroke cancels the asks still out; an answer for older words never lands (`FilesFound`), and a
    /// search started since, typed, saved or pulled, stops this one setting the rows (`searchRuns`).
    private func search(_ jobs: [FilesRoot.Job]) async {
        let run = searchRuns.start()
        if let saved {
            var now = FilesFound(query: saved.search.name, jobs: [saved.job], local: [:])
            found = now
            guard let client = model.registry.client(saved.job.environmentId) else { return }
            do { now.land(try await client.work.files.search(saved.job.workspaceId, saved.search), job: saved.job, query: saved.search.name) } catch { now.fail(job: saved.job, query: saved.search.name) }
            if !Task.isCancelled, searchRuns.publishes(run) { found = now }
            return
        }
        let words = query.trimmingCharacters(in: .whitespaces)
        guard !words.isEmpty else { return found = nil }
        let local = Dictionary(jobs.map { job in (job.id, model.registry.client(job.environmentId)?.work.files.known(job.workspaceId) ?? []) }, uniquingKeysWith: { first, _ in first })
        found = FilesFound(query: words, jobs: jobs, local: local)
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled, searchRuns.publishes(run) else { return }
        await withTaskGroup(of: (FilesRoot.Job, [FileEntry]?).self) { group in
            for job in jobs {
                guard let files = model.registry.client(job.environmentId)?.work.files else { continue }
                group.addTask { (job, try? await files.search(job.workspaceId, words)) }
            }
            for await (job, answer) in group {
                guard !Task.isCancelled, searchRuns.publishes(run) else { return }
                if let answer { found?.land(answer, job: job, query: words) } else { found?.fail(job: job, query: words) }
            }
        }
    }

    private func savedMenu(_ jobs: [FilesRoot.Job]) -> [SavedRun] {
        jobs.flatMap { job in (searches[job.id] ?? []).map { SavedRun(job: job, search: $0) } }
    }

    /// The jobs whose places could not be read, in one line; the places that did read stay below it.
    private static func failure(_ bands: [Shown]) -> String? {
        let failed = bands.compactMap { band -> (String, String)? in
            guard case .failed(let message)? = band.client.work.files.places[band.job.workspaceId] else { return nil }
            return (band.job.name, FilesRules.sentence(message))
        }
        guard let first = failed.first else { return nil }
        if failed.count == 1 { return bands.count == 1 ? first.1 : "\(first.0): \(first.1)" }
        return "\(failed.map(\.0).joined(separator: ", ")) did not answer."
    }
}

/// A job shown, with its host.
private struct Shown: Identifiable {
    let job: FilesRoot.Job
    let client: EnvironmentClient
    var id: String { job.id }
    var files: FilesHost { client.work.files }
    /// The places as read; nil while the first read is out.
    var places: [FilePlace]? {
        switch files.places[job.workspaceId] {
        case .loaded(let places)?: places
        case .failed?: []
        case .reading?, nil: nil
        }
    }
    var band: FilesRoot.Band { FilesRoot.band(job, places: places ?? [], far: files.far[job.workspaceId]?.value ?? []) }
    /// The rows' ids in the list's order, as `BandSection` draws them.
    var ids: [String] {
        let band = band
        let places = band.lenses + band.places + band.far.flatMap(\.places) + band.mail + (band.trash.map { [$0] } ?? [])
        return places.map { "\(job.id)|\($0.id)" } + band.far.filter { $0.failed != nil }.map { "\(job.id)|far:\($0.host)" }
    }
}

/// A saved search and the job it was saved in.
struct SavedRun: Equatable {
    let job: FilesRoot.Job
    let search: SavedFileSearch
}

nonisolated private struct SearchKey: Equatable {
    let query: String
    let jobs: [String]
    let saved: String?
}

/// One job's places: its name over them while more than one job shows.
private struct BandSection: View {
    let band: Shown
    let named: Bool

    var body: some View {
        let shown = band.band
        Section {
            ForEach(shown.lenses + shown.places, id: \.id) { place in
                PlaceRow(band: band, place: place)
            }
            ForEach(shown.far) { desk in
                if let failed = desk.failed {
                    FarDownRow(name: desk.name, words: failed) { Task { await band.files.loadFar(band.job.workspaceId) } }
                        .id("\(band.job.id)|far:\(desk.host)")
                } else {
                    ForEach(desk.places, id: \.id) { place in PlaceRow(band: band, place: place, through: desk) }
                }
            }
            ForEach(shown.mail + (shown.trash.map { [$0] } ?? []), id: \.id) { place in
                PlaceRow(band: band, place: place)
            }
        } header: {
            if named { JobHeader(job: band.job) }
        }
    }
}

/// A job's name over its places, led by its sector's dot.
struct JobHeader: View {
    let job: FilesRoot.Job

    // Built as the Outbox's band: the dot at the text edge with the name after it, never hung in the margin.
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            SectorDot(sector: job.sector, size: 7)
            Text(job.name)
                .textStep(.meta, weight: .semibold, tint: Color(.label))
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, Layout.rowVertical)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Surface.chrome)
        .textCase(nil)
        .accessibilityAddTraits(.isHeader)
        .listRowInsets(EdgeInsets())
    }
}

/// One place, lens or computer's place: its glyph, its name, its one fact (its state while it does not answer,
/// its team, the computer it is on). It pushes its folder in this column.
private struct PlaceRow: View {
    @Environment(ShellNavigator.self) private var navigator
    let band: Shown
    let place: FilePlace
    var through: FilesHost.FarDesktop?

    var body: some View {
        let title = place.kind == .mail ? "From Mail" : place.name
        Button {
            navigator.open(.folder(environmentId: band.client.environment.id, workspaceId: band.job.workspaceId, placeId: place.id, at: place.root, title: title, through: through?.host))
        } label: {
            FilesRowLabel(symbol: through == nil ? FilesGlyph.of(place) : "desktopcomputer", title: title, fact: fact, dimmed: FilesRules.isDown(place))
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .id("\(band.job.id)|\(place.id)")
        .accessibilityIdentifier("files-place-\(place.id)")
    }

    private var fact: String {
        if let count = place.count, place.kind == .mail { return "\(Int(count))" }
        if let through, FilesRules.stateWords(place) == nil { return through.name }
        return FilesRules.placeFact(place)
    }
}

/// A computer the job may use that did not answer its host: its name at half strength and the host's words; a
/// press asks again.
private struct FarDownRow: View {
    let name: String
    let words: String
    let retry: () -> Void

    var body: some View {
        Button(action: retry) {
            FilesRowLabel(symbol: "desktopcomputer", title: name, fact: "Not reachable", dimmed: true)
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .accessibilityHint(words)
        .accessibilityIdentifier("files-far-down")
    }
}

/// What a search found across the jobs shown, newest change first; each row leads with its job's dot while
/// several jobs show. A folder pushes, a file opens in the detail.
private struct FoundRows: View {
    @Environment(AppModel.self) private var model
    let found: FilesFound?
    let saved: SavedRun?
    let multiJob: Bool
    let clear: () -> Void

    var body: some View {
        Section {
            ForEach(found?.rows ?? []) { row in
                if let client = model.registry.client(row.job.environmentId) {
                    let places = client.work.files.places[row.job.workspaceId]?.value ?? []
                    let home = FilesRules.homeId(of: row.entry, places: places) ?? (FilesRules.isOwn(row.entry) ? FilesRules.workspaceFolder(places)?.id : nil) ?? ""
                    FileRow(client: client, workspaceId: row.job.workspaceId, placeId: home, entry: row.entry, inLens: true, sector: multiJob ? row.job.sector : nil)
                        .id(row.id)
                }
            }
        } header: {
            if let saved {
                SectionHeader(saved.search.name) {
                    Button("Clear", systemImage: "xmark.circle.fill", action: clear)
                        .labelStyle(.iconOnly)
                        .foregroundStyle(.secondary)
                        .frame(minWidth: Layout.rowHeight)
                        .accessibilityIdentifier("files-saved-clear")
                }
                .listRowInsets(EdgeInsets())
            }
        }
    }
}

/// A job's own Files, from its page or a notice that names its view: the place narrowed to that job.
struct FilesScreen: View {
    let client: EnvironmentClient
    let workspace: WorkspaceMeta

    var body: some View {
        FilesPlaceScreen(job: ProjectPairs.key(client.environment.id, workspace))
    }
}

// MARK: - rows every Files list shares

/// A file or folder row: a folder pushes its list in the sidebar column, a file opens in the detail. A kept
/// row (no ref, from the phone's disk) is drawn and opens nothing until its folder is read fresh. A file row
/// drags as itself onto a folder row (`FileDrag`).
struct FileRow: View {
    @Environment(ShellNavigator.self) private var navigator
    let client: EnvironmentClient
    let workspaceId: String
    /// The place the row lives in (a lens's row: its own home).
    let placeId: String
    let entry: FileEntry
    let inLens: Bool
    /// The computer the folder is listed through, when it is one.
    var through: String?
    /// The job's sector, for its dot where several jobs show.
    var sector: String?

    private var route: Route? {
        if let folder = entry.folder {
            return .folder(environmentId: client.environment.id, workspaceId: workspaceId, placeId: placeId, at: folder, title: entry.name, through: through)
        }
        guard entry.ref != nil else { return nil }
        return .filesFile(environmentId: client.environment.id, workspaceId: workspaceId, placeId: placeId, entry: entry)
    }

    var body: some View {
        let route = route
        let opening = client.work.files.opening[FilesRules.openingTag(entry.key)]
        Button { if let route { navigator.open(route) } } label: {
            FilesRowLabel(symbol: FilesGlyph.of(entry.kind), title: ReaderVerbs.title(entry.name), fact: FilesRules.fact(entry, inLens: inLens), bold: entry.fresh == true, sector: sector, progress: opening)
        }
        .buttonStyle(.pressable)
        .disabled(route == nil)
        .listRowInsets(Layout.rowInsets)
        .placeSelected(route != nil && navigator.detailRoot == route)
        .accessibilityAddTraits(route != nil && navigator.detailRoot == route ? .isSelected : [])
        .accessibilityIdentifier("files-row-\(entry.name)")
    }
}

/// The house list row as Files draws it: the glyph in the 28 pt mark slot, the name, one fact as the stamp. A
/// fresh file (a thread made it and he has not opened it) carries its name in semibold. While a file of another
/// computer is copied in to open, a bar under the name follows the bytes.
struct FilesRowLabel: View {
    let symbol: String
    let title: String
    let fact: String
    var bold = false
    var dimmed = false
    var sector: String?
    var progress: Double?
    @ScaledMetric(relativeTo: .subheadline) private var mark: CGFloat = 28
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: Layout.rowGap + 2) {
            Image(systemName: symbol)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: mark, height: mark)
                .opacity(dimmed ? 0.5 : 1)
                .overlay(alignment: .topLeading) {
                    if let sector {
                        Circle().fill(Tint.sector(sector)).frame(width: Layout.dotSize, height: Layout.dotSize).accessibilityHidden(true)
                    }
                }
            VStack(alignment: .leading, spacing: Layout.rowVertical) {
                // At accessibility sizes the whole name wraps, so two files that differ at the end are told apart.
                Text(title)
                    .textStep(.title, weight: bold ? .semibold : .regular)
                    .lineLimit(typeSize.isAccessibilitySize ? 4 : 1)
                    .truncationMode(.middle)
                    .opacity(dimmed ? 0.5 : 1)
                if let progress {
                    ProgressView(value: progress)
                        .progressViewStyle(.linear)
                        .accessibilityLabel("Copying")
                }
            }
            Spacer(minLength: Layout.rowGap)
            if !fact.isEmpty, progress == nil {
                // In the secondary label ink at full strength, a down place's state too: the tertiary stamp read
                // at about 2:1 (baseline f04), and the row's half strength is its name's alone.
                Text(fact).textStep(.stamp, tint: Color(.secondaryLabel)).lineLimit(1).monospacedDigit()
            }
        }
        .frame(minHeight: Layout.rowHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// An upload under way into the folder: its name, the bar, and on a failure the reason with Dismiss.
struct UploadRow: View {
    let upload: FilesHost.Upload
    let dismiss: () -> Void
    @ScaledMetric(relativeTo: .subheadline) private var mark: CGFloat = 28

    var body: some View {
        HStack(spacing: Layout.rowGap + 2) {
            Image(systemName: upload.failed == nil ? "arrow.up.circle" : "exclamationmark.circle")
                .font(.subheadline)
                .foregroundStyle(upload.failed == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(Tint.destructive))
                .frame(width: mark, height: mark)
            VStack(alignment: .leading, spacing: Layout.rowVertical) {
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
            Text(FilesRules.sentence(message))
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
        case .form: "checklist"
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
