import AVFoundation
import AVKit
import Observation
import SwiftUI
import TempCodeClient
import TempCodeContract

/// A meeting's recording, played as it is read (docs/IOS-DESIGN.md "A file on the phone", a meeting): the system's
/// player asks for byte ranges and each is read from the host through `work.meetings.recording`, one chunk at a time,
/// so nothing of it is written to the phone's disk and it starts before the whole file is here. A recording the
/// system cannot play (WebM, Ogg) says it plays on the computer.
@MainActor @Observable
final class MeetingPlayer {
    enum State: Equatable {
        case reading
        case ready
        /// Its type is not one the phone plays.
        case notHere
        case failed(String)
    }

    private(set) var state = State.reading
    private(set) var player: AVPlayer?
    private(set) var video = false
    private(set) var playing = false
    /// Seconds played, as the player last said (twice a second while it plays).
    private(set) var time: Double = 0
    private(set) var duration: Double = 0
    @ObservationIgnored private var loader: RecordingLoader?
    @ObservationIgnored private var ticks: Any?
    @ObservationIgnored private var rate: NSKeyValueObservation?

    /// How often the shown time follows the player.
    private static let tick = CMTime(value: 1, timescale: 2)

    /// Reads the recording's name and size with its first byte, then hands the player a loader for the rest.
    func open(_ itemId: String, canvas: WorkCanvas, video: Bool, duration known: Double) async {
        duration = known
        self.video = video
        do {
            let head = try await canvas.recording(itemId, offset: 0, length: 1)
            guard let type = MeetingRecording.type(of: head.name), head.size > 0 else {
                state = .notHere
                return
            }
            let loader = RecordingLoader(size: head.size, type: type) { offset, length in
                try await canvas.recording(itemId, offset: offset, length: length).data
            }
            guard let url = URL(string: "\(RecordingLoader.scheme)://\(itemId)/recording") else { return }
            let asset = AVURLAsset(url: url)
            asset.resourceLoader.setDelegate(loader, queue: loader.queue)
            let player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
            self.loader = loader
            self.player = player
            ticks = player.addPeriodicTimeObserver(forInterval: Self.tick, queue: .main) { [weak self] now in
                MainActor.assumeIsolated { self?.time = now.seconds.isFinite ? now.seconds : 0 }
            }
            rate = player.observe(\.timeControlStatus) { [weak self] player, _ in
                let now = player.timeControlStatus != .paused
                Task { @MainActor in self?.playing = now }
            }
            if let seconds = try? await asset.load(.duration).seconds, seconds.isFinite, seconds > 0 { duration = seconds }
            state = .ready
        } catch {
            state = .failed(ActionError.wrap(error).message)
        }
    }

    func toggle() {
        guard let player else { return }
        if player.timeControlStatus == .paused { player.play() } else { player.pause() }
    }

    /// To a moment and on from there: a line of the transcript or a task's moment.
    func play(from seconds: Double) {
        guard let player else { return }
        time = seconds
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        player.play()
    }

    func scrub(to seconds: Double) {
        time = seconds
        player?.seek(to: CMTime(seconds: seconds, preferredTimescale: 600))
    }

    /// The view went: the player stops and its reads are cancelled.
    func close() {
        player?.pause()
        if let ticks { player?.removeTimeObserver(ticks) }
        ticks = nil
        rate = nil
        loader?.cancelAll()
        player = nil
        loader = nil
    }
}

/// The system player's byte ranges answered from the host. Each request reads its ranges in turn and is cancelled
/// when the player drops it.
final class RecordingLoader: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    static let scheme = "tc-recording"
    let queue = DispatchQueue(label: "dev.landon.tempcode.recording")
    private let size: Int
    private let type: String
    private let read: @Sendable (_ offset: Int, _ length: Int) async throws -> Data
    /// Touched on `queue` alone.
    private var running: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(size: Int, type: String, read: @escaping @Sendable (_ offset: Int, _ length: Int) async throws -> Data) {
        self.size = size
        self.type = type
        self.read = read
    }

    /// A request crossing into the read's task: only `respond` and `finish` touch it, in order.
    private struct Held: @unchecked Sendable { let request: AVAssetResourceLoadingRequest }

    func resourceLoader(_ loader: AVAssetResourceLoader, shouldWaitForLoadingOfRequestedResource request: AVAssetResourceLoadingRequest) -> Bool {
        if let info = request.contentInformationRequest {
            info.contentType = type
            info.contentLength = Int64(size)
            info.isByteRangeAccessSupported = true
        }
        guard let data = request.dataRequest else {
            request.finishLoading()
            return true
        }
        let offset = Int(data.currentOffset != 0 ? data.currentOffset : data.requestedOffset)
        let length = data.requestsAllDataToEndOfResource ? size - offset : data.requestedLength - (offset - Int(data.requestedOffset))
        let ranges = MeetingRecording.ranges(offset: offset, length: length, size: size)
        let held = Held(request: request)
        let key = ObjectIdentifier(request)
        let read = self.read
        let queue = self.queue
        running[key] = Task { [weak self] in
            do {
                for range in ranges {
                    try Task.checkCancellation()
                    let bytes = try await read(range.lowerBound, range.count)
                    queue.async { held.request.dataRequest?.respond(with: bytes) }
                }
                queue.async { held.request.finishLoading() }
            } catch is CancellationError {
                // The player dropped the request: it is not finished.
            } catch {
                queue.async { held.request.finishLoading(with: error) }
            }
            queue.async { self?.running[key] = nil }
        }
        return true
    }

    func resourceLoader(_ loader: AVAssetResourceLoader, didCancel request: AVAssetResourceLoadingRequest) {
        running.removeValue(forKey: ObjectIdentifier(request))?.cancel()
    }

    func cancelAll() {
        queue.async { [self] in
            running.values.forEach { $0.cancel() }
            running = [:]
        }
    }
}

/// The player's own row for a recording with no picture: Play or Pause, the system's slider, and the time played
/// and the whole in tabular digits. A video is the system's player at its shape over the black matte.
struct MeetingPlayerBar: View {
    let player: MeetingPlayer

    var body: some View {
        switch player.state {
        case .reading:
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: Layout.rowHeight)
                .accessibilityLabel("Reading the recording")
        case .notHere:
            Text("This recording plays on your computer.")
                .textStep(.meta)
                .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
                .padding(.horizontal, Layout.textEdge)
        case .failed(let words):
            Text(words)
                .textStep(.meta, tint: Tint.destructiveText)
                .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
                .padding(.horizontal, Layout.textEdge)
        case .ready:
            if player.video, let avPlayer = player.player {
                VideoPlayer(player: avPlayer)
                    .aspectRatio(16 / 9, contentMode: .fit)
                    .background(Color.black)
                    .accessibilityIdentifier("meeting-video")
            } else {
                audio
            }
        }
    }

    private var audio: some View {
        HStack(spacing: 12) {
            Button(player.playing ? "Pause" : "Play", systemImage: player.playing ? "pause.fill" : "play.fill") { player.toggle() }
                .labelStyle(.iconOnly)
                .font(.title3)
                .frame(width: Layout.rowHeight, height: Layout.rowHeight)
                .contentShape(Rectangle())
                .buttonStyle(.pressable)
                .contentTransition(.symbolEffect(.replace))
                .accessibilityIdentifier("meeting-play")
            Slider(value: Binding(get: { min(player.time, max(player.duration, 0)) }, set: { player.scrub(to: $0) }), in: 0...max(player.duration, 1))
                .accessibilityLabel("Position")
                .accessibilityValue(mediaClock(player.time))
            Text("\(mediaClock(player.time)) / \(mediaClock(player.duration))")
                .textStep(.stamp)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .fixedSize()
        }
        .padding(.horizontal, Layout.textEdge)
        .frame(minHeight: Layout.rowHeight)
    }
}
