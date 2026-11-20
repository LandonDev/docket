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

/// The display layer in SwiftUI. One layer per stream, moved to whichever place holds it: the list's picture gives it
/// to its full screen while that is open, so both show the same stream (`LiveLayer`).
struct DisplayLayer: UIViewRepresentable {
    let view: DisplayLayerView
    /// this place holds the layer now
    var holds = true

    func makeUIView(context: Context) -> UIView {
        let host = UIView()
        host.isUserInteractionEnabled = false
        adopt(host)
        return host
    }

    func updateUIView(_ host: UIView, context: Context) { adopt(host) }

    private func adopt(_ host: UIView) {
        guard holds, view.superview !== host else { return }
        view.removeFromSuperview()
        view.frame = host.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.addSubview(view)
    }
}

/// A picture's one layer, and whether its full screen holds it now.
@MainActor @Observable
final class LiveLayer {
    @ObservationIgnored let view = DisplayLayerView()
    var full = false
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
/// screen and the app is active, at the phone's own width; a tap opens it full screen on the same stream. On mobile
/// data it waits for the one control that starts it. A stream that is over leaves its last picture, or says in one
/// muted line why there is none.
struct LivePicture: View {
    let client: EnvironmentClient
    let threadId: String
    /// where the computer runs, for the line a refused stream shows
    let place: String
    @State private var video: LiveVideo?
    @State private var width: CGFloat = 0
    @State private var layer = LiveLayer()
    @State private var onScreen = false
    @State private var asked = false
    @State private var fullScreen = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.displayScale) private var displayScale
    private let cost = NetworkCost.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            picture
            if let line = video.flatMap({ LiveWords.line($0.phase, place: place) }) {
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
        #if DEBUG
        .task {
            // the video set: `TC_TEST_OPEN=live-full` (or `live-drive`, which then takes over) opens the picture full
            // screen once it plays, as a tap would
            guard TestHooks.open == "live-full" || TestHooks.open == "live-drive" else { return }
            for _ in 0..<150 {
                if (video?.frames ?? 0) > 0, TestHooks.once("live-full") {
                    openFull()
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        #endif
        .fullScreenCover(isPresented: $fullScreen, onDismiss: {
            layer.full = false
            follow()
        }) {
            if let video {
                FullScreenLive(client: client, threadId: threadId, place: place, video: video, layer: layer)
            }
        }
    }

    private var picture: some View {
        ZStack {
            RoundedRectangle.fieldCorner.fill(Surface.fill)
            DisplayLayer(view: layer.view, holds: !layer.full)
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
            // a picture that plays, or one the display shows another page in place of: full screen takes it
            guard !waitsForTap, (video?.frames ?? 0) > 0 || video?.phase == .refused(.busy) else { return }
            openFull()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("The computer the agent is using")
        .accessibilityIdentifier("live-picture")
        #if DEBUG
        .onChange(of: video?.frames ?? 0) { _, frames in LayoutProbe.note("videoFrames", "\(frames)") }
        .onChange(of: phaseName) { _, name in LayoutProbe.note("videoPhase", name) }
        #endif
    }

    private var aspect: CGFloat { LiveWords.aspect(video) }

    private var waitsForTap: Bool { cost.expensive && !asked && !(video?.isRunning ?? false) && (video?.frames ?? 0) == 0 }

    private var phaseName: String {
        switch video?.phase {
        case nil, .idle?: "idle"
        case .opening?: "opening"
        case .playing?: "playing"
        case .refused?: "refused"
        case .over(let face, _)?: "over-\(face.rawValue)"
        }
    }

    private func openFull() {
        layer.full = true
        fullScreen = true
    }

    /// Runs the stream while it is on screen (here or full screen), the app active and (on mobile data) he asked; stops
    /// it otherwise.
    private func follow() {
        let wanted = (onScreen || fullScreen) && scenePhase == .active && (!cost.expensive || asked)
        let video = self.video ?? LiveVideo(client: client, threadId: threadId)
        if self.video == nil { self.video = video }
        if wanted, !video.isRunning, !isOver(video.phase) {
            video.start(sink: layer.view, maxEdge: video.asked?.maxEdge ?? LiveWords.edge(width: width, scale: displayScale), take: video.asked?.take ?? false, drive: video.asked?.drive ?? false)
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
    /// `busy`: the box's one display shows another page; full screen takes it
    static let busy = "Another page is on screen"

    /// The one muted line in the picture's place, and whether Retry goes with it; nil while it plays.
    static func line(_ phase: LiveVideo.Phase, place: String) -> (text: String, retry: Bool)? {
        switch phase {
        case .refused(.busy?): (busy, false)
        case .refused(.permission?): (permission, false)
        case .refused: ("Shown on \(place) only", false)
        case .over(.stopped, let retry): (stopped, retry)
        case .over(.permission, _): (permission, false)
        default: nil
        }
    }

    static func aspect(_ video: LiveVideo?) -> CGFloat {
        guard let video, video.width > 0, video.height > 0 else { return 1.6 }
        return CGFloat(video.width) / CGFloat(video.height)
    }

    /// The long edge to ask for: the picture's width in pixels, in steps of 64, inside the wire's bounds (`videoEdge`
    /// in src/renderer/src/lib/video/support.ts); before it is measured, the wire's link edge.
    static func edge(width: CGFloat, scale: CGFloat) -> Int {
        guard width > 0 else { return 1_280 }
        return min(3_840, max(256, Int((width * scale / 64).rounded(.up) * 64)))
    }
}

/// The picture full screen, on black, on the list's own stream (docs/IOS-DESIGN.md "Work on the phone"): it asks to
/// take the box's display, and opens the stream again at the new size when he turns the phone. Its foot holds Take
/// Over where the computer takes input and Stop; while he drives, the keyboard, Paste and Hand Back. His touches go to
/// the computer as `PhoneDriving` maps them; a pinch zooms the picture here alone.
private struct FullScreenLive: View {
    let client: EnvironmentClient
    let threadId: String
    let place: String
    let video: LiveVideo
    let layer: LiveLayer
    @State private var surface = DriveControl()
    @State private var input: PhoneDriving
    @State private var landscape: Bool?
    @State private var pressing = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.displayScale) private var displayScale

    init(client: EnvironmentClient, threadId: String, place: String, video: LiveVideo, layer: LiveLayer) {
        self.client = client
        self.threadId = threadId
        self.place = place
        self.video = video
        self.layer = layer
        _input = State(initialValue: PhoneDriving(send: { [weak video] in video?.input($0) }, paste: { [weak video] text in
            Task { try? await video?.paste(text) }
        }))
    }

    /// The tile this screen shows now: its thread's, or its pane's page once Take Over moved the row there.
    private var tile: ComputerTile? {
        ComputerTiles.find(ComputerEntries.tiles([client]), host: client.environment.id, threadId: threadId, pane: ComputerEntries.pane(of: threadId, on: client))
    }

    private var canOperate: Bool { client.environment.caps.contains(.operate) || client.environment.caps.contains(.admin) }
    private var driving: Bool { tile?.driving == true && tile?.drivable == true }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            DriveSurface(control: surface, layer: layer, aspect: LiveWords.aspect(video), input: driving && video.asked?.drive == true ? input : nil)
                .ignoresSafeArea(.keyboard)
                .onGeometryChange(for: CGSize.self) { $0.size } action: { turned($0) }
            if video.phase == .opening, video.frames == 0 {
                ProgressView().tint(.white)
            }
        }
        .overlay(alignment: .topTrailing) {
            Button("Done") { dismiss() }
                .tcGlassButton()
                .padding(Layout.textEdge)
                .accessibilityIdentifier("live-done")
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { foot }
        .environment(\.colorScheme, .dark)
        .onChange(of: driving) { ask() }
        .onChange(of: tile?.threadId) { ask() }
        .onDisappear {
            input.release()
            surface.keyboard(false)
        }
        .accessibilityIdentifier("live-full-screen")
        #if DEBUG
        .onChange(of: driving, initial: true) { _, on in LayoutProbe.note("videoDriving", on ? "1" : "0") }
        .task { await testDrive() }
        #endif
    }

    /// One row at the foot: the line a stream that is not playing says, then the buttons, at their full size.
    private var foot: some View {
        VStack(spacing: 8) {
            if let line = LiveWords.line(video.phase, place: place) {
                Text(line.text).textStep(.meta).multilineTextAlignment(.center)
            }
            if let error {
                Text(error).textStep(.meta, tint: Tint.destructiveText).multilineTextAlignment(.center)
            }
            if let tile, canOperate {
                HStack(spacing: 12) {
                    if driving {
                        iconButton(surface.keyboardUp ? "keyboard.chevron.compact.down" : "keyboard", label: surface.keyboardUp ? "Hide Keyboard" : "Keyboard", id: "live-keyboard") {
                            surface.keyboard(!surface.keyboardUp)
                        }
                        iconButton("doc.on.clipboard", label: "Paste", id: "live-paste") {
                            if let text = UIPasteboard.general.string, !text.isEmpty { Task { try? await video.paste(text) } }
                        }
                        Button("Hand Back") { drive(tile, owner: false) }
                            .tcGlassButton(prominent: true)
                            .accessibilityIdentifier("live-hand-back")
                    } else {
                        if !tile.idle {
                            iconButton("stop.fill", label: "Stop", id: "live-stop") { stop(tile) }
                        }
                        if tile.drivable {
                            Button("Take Over") { drive(tile, owner: true) }
                                .tcGlassButton()
                                .accessibilityIdentifier("live-take-over")
                        }
                    }
                }
                .controlSize(.large)
                .buttonBorderShape(.capsule)
                .disabled(pressing)
            }
        }
        .padding(.horizontal, Layout.textEdge)
        .padding(.bottom, 8)
    }

    private func iconButton(_ glyph: String, label: String, id: String, run: @escaping () -> Void) -> some View {
        Button(action: run) { Image(systemName: glyph) }
            .tcGlassButton()
            .buttonBorderShape(.circle)
            .accessibilityLabel(label)
            .accessibilityIdentifier(id)
    }

    /// The first size sets what a turn is; a turn asks the stream again at the picture's new width.
    private func turned(_ size: CGSize) {
        guard size.width > 0, size.height > 0 else { return }
        let now = size.width > size.height
        let was = landscape
        landscape = now
        if was == nil || was != now { ask(width: min(size.width, size.height * LiveWords.aspect(video)), turned: was != nil) }
    }

    /// What this screen needs of the stream: the display taken, his wheel when he drives, the size after a turn.
    private func ask(width: CGFloat? = nil, turned: Bool = false) {
        let edge = turned ? LiveWords.edge(width: width ?? 0, scale: displayScale) : (video.asked?.maxEdge ?? LiveWords.edge(width: width ?? 0, scale: displayScale))
        if !driving {
            input.release()
            surface.keyboard(false)
        }
        video.want(.init(threadId: tile?.threadId ?? threadId, maxEdge: edge, take: true, drive: driving))
    }

    /// Take Over or Hand Back, one call on the host (`computer.drive`), which stops what drove it after he has it.
    private func drive(_ tile: ComputerTile, owner: Bool) {
        pressing = true
        error = nil
        Task {
            defer { pressing = false }
            do {
                _ = try await client.request(Methods.ComputerDrive.self, .init(computer: tile.driveName, driver: owner ? .owner : .agent))
            } catch {
                self.error = ActionError.wrap(error).message
            }
        }
    }

    /// Stop: computer use ends for the thread's turn, on the thread's own host (`computer.stop`).
    private func stop(_ tile: ComputerTile) {
        pressing = true
        error = nil
        Task {
            defer { pressing = false }
            do {
                _ = try await client.request(Methods.ComputerStop.self, .init(sessionId: tile.threadId))
            } catch {
                self.error = ActionError.wrap(error).message
            }
        }
    }

    #if DEBUG
    /// The video set: `TC_TEST_OPEN=live-drive` takes over once the picture plays, then, once a stream he drives shows
    /// frames, taps its middle and types "Hi", so the server counts his input.
    private func testDrive() async {
        guard TestHooks.open == "live-drive" else { return }
        for _ in 0..<200 {
            if let tile, tile.drivable, !driving, video.frames > 0, TestHooks.once("live-take-over") { drive(tile, owner: true) }
            if driving, video.asked?.drive == true, video.phase == .playing, video.frames > 0, TestHooks.once("live-tap") {
                try? await Task.sleep(for: .milliseconds(500))
                input.tap(0.5, 0.5)
                input.type("Hi")
                return
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }
    #endif
}

/// What the full screen's buttons ask of its touch surface: the keyboard up or down.
@MainActor @Observable
final class DriveControl {
    private(set) var keyboardUp = false
    @ObservationIgnored weak var view: DriveView?

    func keyboard(_ up: Bool) {
        guard let view else { return }
        if up { view.keys.becomeFirstResponder() } else if view.keys.isFirstResponder { view.keys.resignFirstResponder() }
        keyboardUp = view.keys.isFirstResponder
    }

    func keyboardLeft() { keyboardUp = false }
}

/// The full screen's picture and his touches on it, in UIKit for its gestures.
private struct DriveSurface: UIViewRepresentable {
    let control: DriveControl
    let layer: LiveLayer
    let aspect: CGFloat
    /// his input while he drives; nil while he watches
    let input: PhoneDriving?

    func makeUIView(context: Context) -> DriveView {
        let view = DriveView()
        control.view = view
        view.control = control
        updateUIView(view, context: context)
        return view
    }

    func updateUIView(_ view: DriveView, context: Context) {
        if layer.full, layer.view.superview !== view.picture {
            layer.view.removeFromSuperview()
            layer.view.frame = view.picture.bounds
            layer.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.picture.addSubview(layer.view)
        }
        view.aspect = aspect
        view.input = input
    }
}

/// The picture at its own aspect inside the screen, zoomed by a pinch, and the gestures that drive it: a tap clicks, a
/// long press right-clicks, one finger drags with the button down, two scroll. Watching, one finger pans a zoomed
/// picture instead.
final class DriveView: UIView {
    let picture = UIView()
    let keys = KeyCatcher()
    weak var control: DriveControl?
    var aspect: CGFloat = 1.6 {
        didSet { if aspect != oldValue { setNeedsLayout() } }
    }
    var input: PhoneDriving? {
        didSet { [tap, press, scroll].forEach { $0.isEnabled = input != nil } }
    }
    private var zoom: CGFloat = 1
    private var offset = CGPoint.zero
    private var pinchFrom: (zoom: CGFloat, point: CGPoint)?
    private var panFrom = CGPoint.zero
    private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
    private lazy var press = UILongPressGestureRecognizer(target: self, action: #selector(pressed))
    private lazy var drag = UIPanGestureRecognizer(target: self, action: #selector(dragged))
    private lazy var scroll = UIPanGestureRecognizer(target: self, action: #selector(scrolled))
    private lazy var pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched))

    override init(frame: CGRect) {
        super.init(frame: frame)
        picture.isUserInteractionEnabled = false
        addSubview(picture)
        addSubview(keys)
        keys.typed = { [weak self] in self?.input?.type($0) }
        keys.deleted = { [weak self] in self?.input?.deleteBackward() }
        keys.left = { [weak self] in self?.control?.keyboardLeft() }
        drag.maximumNumberOfTouches = 1
        scroll.minimumNumberOfTouches = 2
        scroll.maximumNumberOfTouches = 2
        for gesture in [tap, press, drag, scroll, pinch] as [UIGestureRecognizer] { addGestureRecognizer(gesture) }
        isAccessibilityElement = true
        accessibilityLabel = "The computer the agent is using"
    }

    required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        let fit = AVMakeRect(aspectRatio: CGSize(width: aspect, height: 1), insideRect: bounds)
        picture.transform = .identity
        picture.frame = fit
        applyZoom()
    }

    /// Where a gesture is, as shares of the picture: its own coordinates undo the zoom.
    private func share(_ gesture: UIGestureRecognizer) -> (Double, Double) {
        let p = gesture.location(in: picture)
        let size = picture.bounds.size
        guard size.width > 0, size.height > 0 else { return (0, 0) }
        return (p.x / size.width, p.y / size.height)
    }

    @objc private func tapped(_ g: UITapGestureRecognizer) {
        let (x, y) = share(g)
        input?.tap(x, y)
    }

    @objc private func pressed(_ g: UILongPressGestureRecognizer) {
        guard g.state == .began else { return }
        let (x, y) = share(g)
        input?.longPress(x, y)
    }

    @objc private func dragged(_ g: UIPanGestureRecognizer) {
        guard let input else {
            // watching: one finger moves a zoomed picture
            guard zoom > 1 else { return }
            if g.state == .began { panFrom = offset }
            let t = g.translation(in: self)
            offset = CGPoint(x: panFrom.x + t.x, y: panFrom.y + t.y)
            applyZoom()
            if g.state == .ended || g.state == .cancelled { settle() }
            return
        }
        let (x, y) = share(g)
        switch g.state {
        case .began:
            // where the finger came down, before the pan's own slop
            let t = g.translation(in: picture)
            let size = picture.bounds.size
            input.dragBegan(x - t.x / max(size.width, 1), y - t.y / max(size.height, 1))
            input.dragMoved(x, y)
        case .changed: input.dragMoved(x, y)
        case .ended, .cancelled, .failed: input.dragEnded(x, y)
        default: break
        }
    }

    @objc private func scrolled(_ g: UIPanGestureRecognizer) {
        guard g.state == .changed || g.state == .ended else { return }
        let t = g.translation(in: picture)
        g.setTranslation(.zero, in: picture)
        let (x, y) = share(g)
        input?.scroll(dx: t.x, dy: t.y, x, y)
    }

    /// The pinch zooms the picture here alone, about the point between the fingers, which it follows.
    @objc private func pinched(_ g: UIPinchGestureRecognizer) {
        // a point of the picture at `q` from its middle shows at center + offset + zoom × q
        let at = g.location(in: self)
        let center = picture.center
        switch g.state {
        case .began:
            pinchFrom = (zoom, CGPoint(x: (at.x - center.x - offset.x) / zoom, y: (at.y - center.y - offset.y) / zoom))
        case .changed:
            guard let from = pinchFrom else { return }
            zoom = min(4, max(1, from.zoom * g.scale))
            offset = CGPoint(x: at.x - center.x - zoom * from.point.x, y: at.y - center.y - zoom * from.point.y)
            applyZoom()
        default:
            pinchFrom = nil
            settle()
        }
    }

    /// Back inside the screen: no edge of a zoomed picture leaves a gap, and a picture zoomed out all the way is centered.
    private func settle() {
        if zoom < 1.02 { zoom = 1 }
        let room = CGPoint(x: (zoom - 1) * picture.bounds.width / 2, y: (zoom - 1) * picture.bounds.height / 2)
        offset = CGPoint(x: min(room.x, max(-room.x, offset.x)), y: min(room.y, max(-room.y, offset.y)))
        UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.25, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
            self.applyZoom()
        }
    }

    private func applyZoom() {
        picture.transform = CGAffineTransform(translationX: offset.x, y: offset.y).scaledBy(x: zoom, y: zoom)
    }
}

/// The keyboard he raises while he drives: what it types, as the keys say it, with nothing changed on the way (no
/// autocorrection, capitals, smart quotes or dashes).
final class KeyCatcher: UIView, UIKeyInput {
    var typed: ((String) -> Void)?
    var deleted: (() -> Void)?
    var left: (() -> Void)?

    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no
    var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
    var inlinePredictionType: UITextInlinePredictionType = .no
    var keyboardAppearance: UIKeyboardAppearance = .dark

    override var canBecomeFirstResponder: Bool { true }
    // always text before the caret, so delete always reaches the page
    var hasText: Bool { true }
    func insertText(_ text: String) { typed?(text) }
    func deleteBackward() { deleted?() }

    override func resignFirstResponder() -> Bool {
        let done = super.resignFirstResponder()
        if done { left?() }
        return done
    }
}
