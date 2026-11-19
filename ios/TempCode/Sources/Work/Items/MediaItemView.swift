import AVKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// Images and video (milestone 47): the newest version. A video plays the
/// host's fMP4 proxy, its segments fetched and joined into one file here;
/// its comments are listed by time, and Comment pins his words to the frame
/// the player shows. A picture is drawn from its Deep Zoom tiles.
struct MediaItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem

    var body: some View {
        ItemLoad(read: { try await client.work.canvas.media(item.id) }) { view, reload in
            if let version = view.versions.max(by: { $0.n < $1.n }) {
                switch version.state {
                case .failed:
                    ContentUnavailableView(version.name, systemImage: "exclamationmark.triangle", description: Text(version.error ?? "The host could not read this file."))
                case .ready, .probing, .preparing, .unknown:
                    switch MediaPick.of(version.plays) {
                    case .segments(let initSegment, let count, let table):
                        VideoVersionView(client: client, item: item, view: view, versionId: version.id, initSegment: initSegment, count: count, table: table, reload: reload)
                    case .picture(_, let width, let height, let tile, let overlap, let levels, let minLevel):
                        PictureView(client: client, itemId: item.id, versionId: version.id, grid: TileGrid(width: width, height: height, tile: tile, levels: levels, minLevel: minLevel, maxSide: 2048), tile: Int(tile), overlap: Int(overlap))
                    case .preparing, .none:
                        Preparing(reload: reload)
                    }
                }
            } else {
                ContentUnavailableView("Nothing to Show", systemImage: "photo")
            }
        }
        .accessibilityIdentifier("media-item")
    }
}

/// The host is still cutting the proxy or the tiles: read again in a moment.
private struct Preparing: View {
    let reload: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Preparing for the phone").textStep(.meta).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Every two seconds until the host's answer replaces this view: a task runs once per appearance,
        // and a single reload left a proxy still being cut on this screen for good.
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                reload()
            }
        }
    }
}

private struct VideoVersionView: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let view: MediaPhoneView
    let versionId: String
    let initSegment: String
    let count: Int
    let table: FrameTable
    let reload: () -> Void
    @State private var player: AVPlayer?
    @State private var loaded = 0
    @State private var failure: String?
    @State private var comment = ""
    @State private var posting = false
    @State private var notes: [MediaPhoneNote] = []
    @State private var postError: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if let player {
                    VideoPlayer(player: player)
                } else if let failure {
                    ContentUnavailableView("Can’t Play This", systemImage: "exclamationmark.triangle", description: Text(failure))
                } else {
                    VStack(spacing: 8) {
                        ProgressView(value: Double(loaded), total: Double(max(1, count + 1)))
                            .frame(maxWidth: 200)
                        Text("Loading video").textStep(.meta).foregroundStyle(.secondary)
                    }
                }
            }
            .aspectRatio(16 / 9, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .background(Color.black)
            List {
                ForEach(notes.sorted { ($0.anchor.frame ?? 0) < ($1.anchor.frame ?? 0) }, id: \.id) { note in
                    Button {
                        if let frame = note.anchor.frame { player?.seek(to: CMTime(seconds: table.frameCentre(frame), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) }
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(mediaClock(table.frameStart(note.anchor.frame ?? 0)))
                                .textStep(.stamp)
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                                .frame(width: 44, alignment: .leading)
                            Text(note.body).textStep(.title).foregroundStyle(note.state == .suggested ? .secondary : .primary)
                        }
                    }
                    .buttonStyle(.pressable)
                }
            }
            .listStyle(.plain)
            .overlay {
                if notes.isEmpty { Text("No comments").textStep(.meta).foregroundStyle(.secondary) }
            }
            if client.work.canApprove {
                HStack(spacing: 8) {
                    TextField("Comment at this frame", text: $comment)
                        .textFieldStyle(.roundedBorder)
                        .focused($focused)
                        .accessibilityIdentifier("media-comment")
                    Button("Post") { Task { await post() } }
                        .disabled(comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || posting || player == nil)
                        .accessibilityIdentifier("media-post")
                }
                .padding(.horizontal, Layout.textEdge)
                .padding(.vertical, 8)
                if let postError {
                    Text(postError).textStep(.meta, tint: Tint.destructiveText)
                        .padding(.horizontal, Layout.textEdge)
                        .padding(.bottom, 8)
                }
            }
        }
        .onAppear { notes = view.notes.filter { $0.anchor.versionId == versionId && $0.kind == .comment } }
        .task { await load() }
    }

    /// The init segment and every media segment, joined: one fragmented MP4 the player reads from disk.
    private func load() async {
        let file = FileManager.default.temporaryDirectory.appending(path: "tc-media-\(item.id)-\(versionId).mp4")
        if !FileManager.default.fileExists(atPath: file.path()) {
            do {
                var joined = try await client.work.canvas.mediaSegment(item.id, versionId: versionId, index: nil)
                loaded = 1
                for index in 0..<count {
                    joined.append(try await client.work.canvas.mediaSegment(item.id, versionId: versionId, index: index))
                    loaded = index + 2
                }
                try joined.write(to: file, options: .atomic)
            } catch {
                failure = ActionError.wrap(error).message
                return
            }
        }
        player = AVPlayer(url: file)
        #if DEBUG
        // The work set: `TC_TEST_ACTION=media-comment:<words>` posts them at the frame three seconds in.
        if let action = TestHooks.action, action.hasPrefix("media-comment:"), TestHooks.once("media-comment"), let player {
            await player.seek(to: CMTime(seconds: 3, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
            comment = String(action.dropFirst("media-comment:".count))
            await post()
        }
        #endif
    }

    private func post() async {
        guard let player else { return }
        posting = true
        defer { posting = false }
        let frame = table.frameAt(player.currentTime().seconds)
        do {
            postError = nil
            let note = try await client.work.canvas.comment(item.id, versionId: versionId, frame: frame, body: comment.trimmingCharacters(in: .whitespacesAndNewlines))
            notes.append(note)
            comment = ""
            focused = false
        } catch {
            postError = ActionError.wrap(error).message
        }
    }
}

/// A picture from its Deep Zoom tiles at a level no wider than the screen needs, pinch to zoom.
private struct PictureView: View {
    let client: EnvironmentClient
    let itemId: String
    let versionId: String
    let grid: TileGrid
    let tile: Int
    let overlap: Int
    @State private var image: UIImage?
    @State private var failure: String?
    @State private var zoom: CGFloat = 1

    var body: some View {
        Group {
            if let image {
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(width: UIScreen.main.bounds.width * zoom)
                }
                .gesture(MagnifyGesture().onChanged { zoom = min(4, max(1, $0.magnification)) })
            } else if let failure {
                ContentUnavailableView("Can’t Show This", systemImage: "exclamationmark.triangle", description: Text(failure))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await load() }
    }

    private func load() async {
        let size = CGSize(width: grid.width, height: grid.height)
        let renderer = UIGraphicsImageRenderer(size: size, format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }())
        var tiles: [(CGPoint, UIImage)] = []
        do {
            for y in 0..<grid.rows {
                for x in 0..<grid.columns {
                    let data = try await client.work.canvas.mediaTile(itemId, versionId: versionId, level: grid.level, x: x, y: y)
                    if let piece = UIImage(data: data) { tiles.append((CGPoint(x: x * tile, y: y * tile), piece)) }
                }
            }
        } catch {
            failure = ActionError.wrap(error).message
            return
        }
        // A tile past the first in its row or column starts `overlap` pixels before its cell.
        image = renderer.image { _ in
            for (origin, piece) in tiles {
                piece.draw(at: CGPoint(x: origin.x - (origin.x > 0 ? CGFloat(overlap) : 0), y: origin.y - (origin.y > 0 ? CGFloat(overlap) : 0)))
            }
        }
    }
}
