import AVKit
import QuickLook
import SwiftUI
import TempCodeClient
import TempCodeContract

/// Where a file opens from the Files place. `page` is the one place a list hands a file to a screen: change
/// its `.item` line to send a seated file elsewhere (the phone-files build's reader).
enum FilesOpen {
    @MainActor @ViewBuilder
    static func page(client: EnvironmentClient, route: FileOpenRoute) -> some View {
        let files = client.work.files
        let place = files.places[route.workspaceId]?.value?.first { $0.id == route.placeId }
        switch place.map({ FilesRules.opening(route.entry, place: $0, caps: files.caps) }) ?? .quickLook(.facts(host: "")) {
        case .item:
            FileItemScreen(client: client, workspaceId: route.workspaceId, entry: route.entry, place: place)
        case .quickLook(let original):
            FileQuickLookScreen(client: client, workspaceId: route.workspaceId, entry: route.entry, original: original, place: place)
        }
    }
}

/// A file seated in the workspace's Files pane (`work.files.open`), on the phone's reader page
/// (`FileReaderPage`, docs/IOS-DESIGN.md "A file on the phone"): a document or sheet in the hosted editor, a
/// PDF, deck, picture or video natively. No thread stands beside it, so Ask finds or starts one. A document
/// or sheet kept as a file whose host will not open it in the hosted editor shows Quick Look in its place.
struct FileItemScreen: View {
    let client: EnvironmentClient
    let workspaceId: String
    let entry: FileEntry
    let place: FilePlace?
    @State private var item: CanvasItem?
    @State private var error: String?
    @State private var round = 0

    var body: some View {
        Group {
            if let item {
                FileReaderPage(client: client, item: item, thread: nil, workspaceId: workspaceId)
                    .environment(\.hostedFallback, fallback)
            } else if let error {
                FilesFailed(title: "Can’t Open \(entry.name)", message: error) { self.error = nil; round += 1 }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(ReaderVerbs.title(entry.name))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: round) {
            do {
                item = try await client.work.files.open(workspaceId, entry)
            } catch {
                self.error = ActionError.wrap(error).message
            }
        }
        .accessibilityIdentifier("files-item")
    }

    /// Quick Look for a file-kept document or sheet, read only: what shows where the hosted editor will not.
    private var fallback: AnyView? {
        guard let place, FilesRules.original(entry, place: place) == .readOnly else { return nil }
        return AnyView(FileQuickLookScreen(client: client, workspaceId: workspaceId, entry: entry, original: .readOnly, place: place))
    }
}

/// Quick Look (docs/IOS-DESIGN.md "Files"): the host's preview pages in a pager over the file's facts, and
/// Open the original where the phone may read the bytes, into a temp file the system's Quick Look (or AVKit,
/// for sound and video) shows; the temp file goes when the preview closes or the screen does. Where the host
/// makes no preview yet (F3), the facts stand alone.
struct FileQuickLookScreen: View {
    let client: EnvironmentClient
    let workspaceId: String
    let entry: FileEntry
    let original: FilesRules.Original
    let place: FilePlace?
    @State private var pages: [Int: UIImage] = [:]
    @State private var pageCount = 0
    @State private var reading = false
    @State private var failure: String?
    @State private var shown: URL?
    @State private var player: AVPlayer?
    /// The temp file read for this screen, removed when it closes.
    @State private var kept: URL?
    @State private var readTask: Task<Void, Never>?

    private var files: FilesHost { client.work.files }
    private var plays: Bool { [.audio, .video].contains(entry.kind) }

    var body: some View {
        VStack(spacing: 0) {
            if let player {
                VideoPlayer(player: player)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if pageCount > 0 {
                pager
            } else {
                facts
            }
            foot
        }
        .navigationTitle(ReaderVerbs.title(entry.name))
        .navigationBarTitleDisplayMode(.inline)
        .quickLookPreview($shown)
        .onChange(of: shown) { if shown == nil, player == nil { drop() } }
        .task { await files.seen(workspaceId, entry) }
        .task {
            await firstPage()
            #if DEBUG
            // The Files proof: Open the original once the screen is up (`TC_TEST_ACTION=files-original`).
            if TestHooks.action == "files-original", TestHooks.once("files-original") { readTask = Task { await openOriginal() } }
            #endif
        }
        .onDisappear {
            readTask?.cancel()
            player?.pause()
            drop()
        }
        .accessibilityIdentifier("files-quicklook")
    }

    // MARK: - the pager

    private var pager: some View {
        TabView {
            ForEach(1 ... pageCount, id: \.self) { page in
                Group {
                    if let image = pages[page] {
                        Image(uiImage: image).resizable().scaledToFit().padding(Layout.textEdge)
                    } else {
                        ProgressView()
                    }
                }
                .task { await load(page) }
            }
        }
        .tabViewStyle(.page(indexDisplayMode: pageCount > 1 ? .automatic : .never))
        .indexViewStyle(.page(backgroundDisplayMode: .always))
        .accessibilityIdentifier("files-pager")
    }

    private func firstPage() async {
        // A preview only where the bytes may come here: a shared library's files are facts alone on the phone.
        guard let ref = entry.ref, original == .allowed || original == .readOnly else { return }
        guard let answer = try? await files.preview(workspaceId, ref, page: 1, width: previewWidth), let png = answer.png, let image = Self.image(png) else { return }
        pages[1] = image
        pageCount = max(1, Int(answer.pages ?? 1))
    }

    private func load(_ page: Int) async {
        guard pages[page] == nil, let ref = entry.ref,
              let answer = try? await files.preview(workspaceId, ref, page: page, width: previewWidth), let png = answer.png, let image = Self.image(png) else { return }
        pages[page] = image
    }

    /// A phone's width at three pixels a point: the host makes it at most 2048 wide.
    private let previewWidth = 1290

    private static func image(_ base64: String) -> UIImage? { Data(base64Encoded: base64).flatMap(UIImage.init(data:)) }

    // MARK: - the facts

    private var facts: some View {
        VStack(spacing: 12) {
            Image(systemName: FilesGlyph.of(entry.kind))
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(entry.name)
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
                .lineLimit(3)
            Text(factLine).textStep(.meta).multilineTextAlignment(.center)
            if let by = entry.by, !by.isEmpty {
                Text("Saved by \(by)").textStep(.meta)
            }
        }
        .padding(.horizontal, Layout.textEdge * 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    /// Kind, size and when it changed, in one line; then where it lives.
    private var factLine: String {
        var parts = [FilesWords.kind(entry.kind)]
        if let size = entry.size { parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)) }
        if let changed = entry.changed, changed > 0 { parts.append(FilesRules.changedWords(Int(changed))) }
        return parts.joined(separator: " · ")
    }

    // MARK: - the foot: Open the original, or why it stays where it is

    @ViewBuilder private var foot: some View {
        VStack(spacing: 8) {
            if let failure {
                Text(failure).textStep(.meta, tint: Tint.destructiveText).multilineTextAlignment(.center)
            }
            switch original {
            case .allowed:
                openButton
            case .readOnly:
                Text("Edit on your computer").textStep(.meta)
                openButton
            case .tooBig:
                Text("Over 50 MB. Open it on your computer.").textStep(.meta)
            case .facts(let host):
                Text(host.isEmpty ? "Open it on your computer." : "On \(host)").textStep(.meta)
            }
        }
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder private var openButton: some View {
        if player == nil {
            if reading {
                ProgressView().frame(minHeight: 44)
            } else {
                WideButton(plays ? "Play" : "Open the Original", systemImage: plays ? "play.fill" : "eye", prominent: true) {
                    readTask = Task { await openOriginal() }
                }
                .accessibilityIdentifier("files-open-original")
            }
        }
    }

    private func openOriginal() async {
        failure = nil
        if let kept { return show(kept) }
        reading = true
        defer { reading = false }
        do {
            let file = try await files.original(workspaceId, entry)
            // The screen closed while it read: nothing shows it, so it goes now.
            guard !Task.isCancelled else { return OriginalFiles.remove(file) }
            kept = file
            show(file)
        } catch {
            if !Task.isCancelled { failure = ActionError.wrap(error).message }
        }
    }

    private func show(_ file: URL) {
        if plays {
            player = AVPlayer(url: file)
            player?.play()
        } else {
            shown = file
        }
    }

    /// The temp file goes with its preview.
    private func drop() {
        if let kept { OriginalFiles.remove(kept) }
        kept = nil
        player = nil
    }
}

/// A kind's word (`ENTRY_KIND_WORDS`).
enum FilesWords {
    static func kind(_ kind: FileEntry.Kind) -> String {
        switch kind {
        case .folder: "Folder"
        case .document: "Document"
        case .sheet: "Sheet"
        case .deck: "Deck"
        case .pdf: "PDF"
        case .picture: "Picture"
        case .video: "Video"
        case .audio: "Audio"
        case .text: "Text"
        case .archive: "Archive"
        case .other, .unknown: "File"
        }
    }
}
