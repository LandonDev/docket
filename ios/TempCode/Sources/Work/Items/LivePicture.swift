import AVFoundation
import Network
import SwiftUI
import TempCodeClient
import TempCodeContract

/// A stream's samples on an `AVSampleBufferDisplayLayer` (docs/agents/live-video.md "The viewer"): each sample is shown
/// as it comes, and the layer keeps the last one, so a stream that ends leaves its last picture as the still.
final class DisplayLayerView: UIView, VideoSampleSink {
    override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
    var display: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }

    override init(frame: CGRect) {
        super.init(frame: frame)
        display.videoGravity = .resizeAspect
        isUserInteractionEnabled = false
    }

    required init?(coder: NSCoder) { nil }

    func enqueue(_ sample: CMSampleBuffer) -> Bool {
        let renderer = display.sampleBufferRenderer
        guard renderer.status != .failed else { return false }
        renderer.enqueue(sample)
        return renderer.status != .failed
    }

    func flush() {
        display.sampleBufferRenderer.flush()
    }
}

/// The display layer in SwiftUI; the view hands its sink to the stream.
struct DisplayLayer: UIViewRepresentable {
    let view: DisplayLayerView

    func makeUIView(context: Context) -> DisplayLayerView { view }
    func updateUIView(_ uiView: DisplayLayerView, context: Context) {}
}

/// Whether the phone's path costs him money now (`NWPath.isExpensive`: mobile data, a hotspot): a stream then waits
/// for his tap instead of starting by itself.
@MainActor @Observable
final class NetworkCost {
    static let shared = NetworkCost()
    private(set) var expensive = false
    @ObservationIgnored private let monitor = NWPathMonitor()

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let expensive = path.isExpensive
            Task { @MainActor in self?.expensive = expensive }
        }
        monitor.start(queue: DispatchQueue(label: "tc.network-cost"))
    }
}

/// The computer a thread drives, live (docs/IOS-DESIGN.md "Work on the phone"): the stream while the picture is on
/// screen and the app is active, at the phone's own width; a tap opens it full screen. On mobile data it waits for
/// the one control that starts it. A stream that is over leaves its last picture, or says in one muted line why there is none.
struct LivePicture: View {
    let client: EnvironmentClient
    let threadId: String
    /// where the computer runs, for the line a refused stream shows
    let place: String
    /// a tap opens it full screen; the full-screen one itself does not
    var opensFull = true
    @State private var video: LiveVideo?
    @State private var width: CGFloat = 0
    @State private var layer = DisplayLayerView()
    @State private var onScreen = false
    @State private var asked = false
    @State private var fullScreen = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.displayScale) private var displayScale
    private let cost = NetworkCost.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            picture
            if let line {
                QuietNote(text: line.text, action: line.retry ? (title: "Retry", run: { restart() }) : nil)
            }
        }
        .onAppear {
            onScreen = true
            follow()
        }
        .onDisappear {
            onScreen = false
            follow()
        }
        .onChange(of: scenePhase) { follow() }
        .onChange(of: cost.expensive) { follow() }
        .onChange(of: fullScreen) { follow() }
        #if DEBUG
        .task {
            // the video set: `TC_TEST_OPEN=live-full` opens the picture full screen once it plays, as a tap would
            guard opensFull, TestHooks.open == "live-full" else { return }
            for _ in 0..<150 {
                if (video?.frames ?? 0) > 0, TestHooks.once("live-full") {
                    fullScreen = true
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        #endif
        .fullScreenCover(isPresented: $fullScreen) {
            FullScreenLive(client: client, threadId: threadId, place: place)
        }
    }

    private var picture: some View {
        ZStack {
            RoundedRectangle.fieldCorner.fill(Surface.fill)
            DisplayLayer(view: layer)
            if waitsForTap {
                PillButton("Watch", systemImage: "play.fill") {
                    asked = true
                    follow()
                }
                .accessibilityIdentifier("live-watch")
            } else if video?.phase == .opening, (video?.frames ?? 0) == 0 {
                ProgressView()
            }
        }
        .aspectRatio(aspect, contentMode: .fit)
        .clipShape(RoundedRectangle.fieldCorner)
        .overlay { RoundedRectangle.fieldCorner.stroke(Surface.hairline, lineWidth: Hairline.thickness(scale: displayScale)) }
        .contentShape(RoundedRectangle.fieldCorner)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onTapGesture {
            guard opensFull, !waitsForTap, (video?.frames ?? 0) > 0 else { return }
            fullScreen = true
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("The computer the agent is using")
        .accessibilityIdentifier("live-picture")
        #if DEBUG
        .onChange(of: video?.frames ?? 0) { _, frames in LayoutProbe.note("videoFrames", "\(frames)") }
        .onChange(of: phaseName) { _, name in LayoutProbe.note("videoPhase", name) }
        #endif
    }

    private var aspect: CGFloat {
        guard let video, video.width > 0, video.height > 0 else { return 1.6 }
        return CGFloat(video.width) / CGFloat(video.height)
    }

    private var waitsForTap: Bool { cost.expensive && !asked && !(video?.isRunning ?? false) && (video?.frames ?? 0) == 0 }

    /// The one muted line in the picture's place, as the desktop words it.
    private var line: (text: String, retry: Bool)? {
        switch video?.phase {
        case .refused(let reason)?:
            return (reason == .permission ? LiveWords.permission : "Shown on \(place) only", false)
        case .over(.stopped, let retry)?:
            return (LiveWords.stopped, retry)
        case .over(.permission, _)?:
            return (LiveWords.permission, false)
        default:
            return nil
        }
    }

    private var phaseName: String {
        switch video?.phase {
        case nil, .idle?: "idle"
        case .opening?: "opening"
        case .playing?: "playing"
        case .refused?: "refused"
        case .over(let face, _)?: "over-\(face.rawValue)"
        }
    }

    /// Runs the stream while it is on screen, the app active and (on mobile data) he asked; stops it otherwise.
    private func follow() {
        let wanted = onScreen && scenePhase == .active && (!cost.expensive || asked) && !fullScreen
        let video = self.video ?? LiveVideo(client: client, threadId: threadId)
        if self.video == nil { self.video = video }
        if wanted, !video.isRunning, !isOver(video.phase) {
            video.start(sink: layer, maxEdge: LiveWords.edge(width: width, scale: displayScale))
        } else if !wanted, video.isRunning {
            video.stop()
        }
    }

    private func restart() {
        video?.stop()
        video = LiveVideo(client: client, threadId: threadId)
        follow()
    }

    private func isOver(_ phase: LiveVideo.Phase) -> Bool {
        if case .over = phase { return true }
        if case .refused = phase { return true }
        return false
    }
}

/// What a stream's place says, in the desktop's words (surfaces/threads/computer/Viewport.tsx).
enum LiveWords {
    static let stopped = "The preview stopped"
    static let permission = "Turn on Screen Recording for TempCode in System Settings"

    /// The long edge to ask for: the picture's width in pixels, in steps of 64, inside the wire's bounds (`videoEdge`
    /// in src/renderer/src/lib/video/support.ts); before it is measured, the wire's link edge.
    static func edge(width: CGFloat, scale: CGFloat) -> Int {
        guard width > 0 else { return 1_280 }
        return min(3_840, max(256, Int((width * scale / 64).rounded(.up) * 64)))
    }
}

/// The picture full screen, on black: its own stream at the screen's long edge, Done to come back. It turns with the
/// phone as every screen of the app does.
private struct FullScreenLive: View {
    let client: EnvironmentClient
    let threadId: String
    let place: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            LivePicture(client: client, threadId: threadId, place: place, opensFull: false)
                .padding(.horizontal, Layout.textEdge)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Button("Done") { dismiss() }
                .buttonStyle(.glass)
                .padding(Layout.textEdge)
                .accessibilityIdentifier("live-done")
        }
        .accessibilityIdentifier("live-full-screen")
    }
}
