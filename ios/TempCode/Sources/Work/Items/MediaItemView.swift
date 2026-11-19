import AVKit
import ImageIO
import SwiftUI
import TempCodeClient
import TempCodeContract

/// Images and video (milestone 47): the newest version. A video plays the
/// host's HLS proxy (its segments fetched and joined into one file here), or,
/// for a key that may read files, the proxy or the original by its media
/// token; its comments are listed by time, and Comment pins his words to the
/// frame the player shows. A picture is drawn from its Deep Zoom tiles, or
/// read whole by its token.
struct MediaItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem

    var body: some View {
        let canRead = client.work.canAdmin
        ItemLoad(read: { try await client.work.canvas.media(item.id, canRead: canRead) }) { view, reload in
            if let version = view.versions.max(by: { $0.n < $1.n }) {
                switch version.state {
                case .failed:
                    ContentUnavailableView(version.name, systemImage: "exclamationmark.triangle", description: Text(version.error ?? "The host could not read this file."))
                case .ready, .probing, .preparing, .unknown:
                    switch MediaPick.of(version.plays, ready: version.state == .ready, canRead: canRead) {
                    case .segments(let initSegment, let count, let table):
                        VideoVersionView(client: client, item: item, view: view, versionId: version.id, source: .segments(init: initSegment, count: count), table: table, reload: reload)
                            .id(version.id)
                    case .file(let token, let table):
                        VideoVersionView(client: client, item: item, view: view, versionId: version.id, source: .token(token), table: table, reload: reload)
                            .id(version.id)
                    case .image(let token):
                        TokenPicture(client: client, token: token)
                    case .picture(_, let width, let height, let tile, let overlap, let levels, let minLevel):
                        PictureView(client: client, itemId: item.id, versionId: version.id, grid: TileGrid(width: width, height: height, tile: tile, levels: levels, minLevel: minLevel, maxSide: 2048), tile: Int(tile), overlap: Int(overlap))
                    case .preparing:
                        Preparing(reload: reload)
                    case .none:
                        ContentUnavailableView(version.name, systemImage: "desktopcomputer", description: Text("This file opens on the computer."))
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
    /// The HLS proxy's segments, or a file read by its media token.
    enum Source {
        case segments(init: String, count: Int)
        case token(String)
    }

    let client: EnvironmentClient
    let item: CanvasItem
    let view: MediaPhoneView
    let versionId: String
    let source: Source
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
                        if case .segments(_, let count) = source {
                            ProgressView(value: Double(loaded), total: Double(count + 1))
                                .frame(maxWidth: 200)
                        } else {
                            ProgressView()
                        }
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
                            VStack(alignment: .leading, spacing: 2) {
                                Text(MediaNoteBy.name(note.by)).textStep(.meta, weight: .medium)
                                Text(note.body).textStep(.title).foregroundStyle(note.state == .suggested ? .secondary : .primary)
                            }
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
                // The steer field's shape (AgentDetailScreen): a field on the chrome step and a round send, both 44 pt to touch.
                let empty = comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Comment at this frame", text: $comment, axis: .vertical)
                        .font(.body)
                        .lineLimit(1...4)
                        .focused($focused)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .frame(minHeight: Layout.rowHeight)
                        .background(Surface.chrome, in: RoundedRectangle.fieldCorner)
                        .hairlineBorder(RoundedRectangle.fieldCorner)
                        .accessibilityIdentifier("media-comment")
                    Button { Task { await post() } } label: {
                        ZStack {
                            Circle().fill(Color(.label)).opacity(empty || posting ? 0.3 : 1)
                            Image(systemName: "arrow.up")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(Color(.systemBackground))
                        }
                        .frame(width: 28, height: 28)
                        .frame(width: Layout.rowHeight, height: Layout.rowHeight)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.pressable)
                    .disabled(empty || posting || player == nil)
                    .accessibilityLabel("Post")
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
        let file = MediaFiles.file(item: item.id, version: versionId)
        if !FileManager.default.fileExists(atPath: file.path()) {
            do {
                switch source {
                case .segments(_, let count):
                    // Each segment goes to disk as it lands: a long recording never sits whole in memory.
                    try await MediaFiles.write(to: file) { handle in
                        try handle.write(contentsOf: try await client.work.canvas.mediaSegment(item.id, versionId: versionId, index: nil))
                        loaded = 1
                        for index in 0..<count {
                            try handle.write(contentsOf: try await client.work.canvas.mediaSegment(item.id, versionId: versionId, index: index))
                            loaded = index + 2
                        }
                    }
                case .token(let token):
                    try await client.work.canvas.mediaFile(token: token, to: file)
                }
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

/// A picture read whole by its media token, decoded at the size a phone shows.
private struct TokenPicture: View {
    let client: EnvironmentClient
    let token: String
    @State private var image: UIImage?
    @State private var failure: String?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let failure {
                ContentUnavailableView("Can’t Show This", systemImage: "exclamationmark.triangle", description: Text(failure))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            do {
                let file = MediaFiles.file(item: "picture", version: token, ext: "img")
                if !FileManager.default.fileExists(atPath: file.path()) { try await client.work.canvas.mediaFile(token: token, to: file) }
                // Decoded at the size a phone shows, never whole: a 40 MP picture is 160 MB as pixels.
                let options = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2048] as CFDictionary
                guard let source = CGImageSourceCreateWithURL(file as CFURL, nil), let picture = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else {
                    failure = "The picture could not be read."
                    return
                }
                image = UIImage(cgImage: picture)
            } catch {
                failure = ActionError.wrap(error).message
            }
        }
    }
}
