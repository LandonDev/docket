import SwiftUI
import TempCodeClient
import TempCodeContract
import WebKit

/// A LifeOS document or sheet in the hosted editor (milestone 47): a ticket
/// from the host that serves LifeOS's documents (`work.guests.ticket`, good
/// once within two minutes) opens `/w/open` signed in as him, full width.
/// The page draws its own loading and its own review; the system's edit
/// menu on a selection leads with Ask, then Comment for a document.
///
/// The web view is one the app made ready beforehand (`HostedWebPool`), on
/// screen at once, and the ticket was asked when he opened the item
/// (`HostedTickets`): the page starts to load the moment the host answers.
///
/// A pass ends when the host restarts (it keeps them in memory). The page then
/// says so (`HostedNote.passEnded`) and the view asks a new ticket and opens
/// the same file again in place, once in a row (`HostedRejoin`); a second end
/// before the page opened leaves the page's own words.
struct HostedItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let source: Methods.WorkGuestsTicket.Params.Source
    /// nil where no thread stands beside the item: the edit menu has no Ask.
    let ask: ((ContextChip) -> Void)?
    @Environment(ReaderCommands.self) private var commands: ReaderCommands?
    @Environment(\.hostedFallback) private var fallback
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var url: URL?
    @State private var failed = false
    /// A file's host said why it does not open here: its words, and nothing to try again.
    @State private var refusal: String?
    @State private var round = 0
    @State private var rejoin = HostedRejoin()
    @State private var shown = false
    @Environment(\.scenePhase) private var phase
    /// The page's side of the native frame: its first paint, the format under the caret, Find's count.
    @State private var frame = HostedFrame()
    /// How far the page has loaded, for the paper's bar until it says it has drawn.
    @State private var progress: Double = 0

    /// On screen with the app in front: a ticket asked now is one he sees used.
    private var forward: Bool { shown && phase == .active }

    var body: some View {
        Group {
            if let refusal {
                // Opened from Files, a file its host will not open here still shows what Quick Look has of it.
                if let fallback {
                    fallback
                } else {
                    // The bar already names the file, and the host's words say where it opens.
                    ContentUnavailableView("Can’t Open Here", systemImage: "desktopcomputer", description: Text(refusal))
                }
            } else if failed {
                ContentUnavailableView {
                    Label("This page cannot be reached right now", systemImage: "wifi.exclamationmark")
                } description: {
                    Text("\(client.environment.name) did not answer.")
                } actions: {
                    Button("Try Again") { failed = false; again() }
                }
            } else {
                ZStack {
                    // The paper's shape at once, under the app's bar: the page fades in over it once it has drawn.
                    if !frame.drawn {
                        ReaderLoading(progress: url == nil ? nil : progress)
                            .transition(.opacity)
                    }
                    HostedWebView(
                        url: url,
                        frame: frame,
                        find: commands?.find ?? 0,
                        onFail: { failed = true },
                        onProgress: { progress = $0 },
                        onNote: { note in if rejoin.heard(note, forward: forward) == .rejoin { again() } },
                        onAsk: ask.map { ask in { (quote: String) in ask(ChipWords.selection(in: item, quote: quote)) } },
                        // Comment is a document's: a sheet keeps no comments.
                        onComment: item.kind == .document ? commands?.comment : nil
                    )
                    // A page that failed gets a new web view with its new ticket.
                    .id(round)
                    .ignoresSafeArea(.container, edges: .bottom)
                    .opacity(frame.drawn ? 1 : 0)
                    // Hidden, it takes no touch: the keyboard never rises under the loading paper.
                    .allowsHitTesting(frame.drawn)
                    .accessibilityHidden(!frame.drawn)
                }
                .animation(reduceMotion ? nil : Motion.base, value: frame.drawn)
                // Above the keyboard while he types in a page that formats: Style, Bold, Italic, the lists.
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if frame.formatRow { HostedFormatRow(frame: frame) }
                }
            }
        }
        .task(id: round) {
            // Back on screen with its page still loaded (from Page Preview, a swipe back): no new ticket, which nothing would redeem.
            guard url == nil else { return }
            do {
                let address = try await client.work.canvas.ticket(for: item, source: source)
                // The owner's own pass draws no title or role bar: the app's bar is the only heading.
                guard let parsed = URL(string: HostedBridge.framed(address)) else { failed = true; return }
                url = parsed
            } catch {
                // A request cut off because the view went away is no answer: the next showing asks again.
                if Task.isCancelled || (error as? TransportError) == .cancelled || error is CancellationError { return }
                switch HostedFailure.of(error, item: item) {
                case .refused(let words): refusal = words
                case .unreachable: failed = true
                }
            }
        }
        .onAppear {
            shown = true
            // More's Undo, Redo and Find ask this page.
            commands?.frame = frame
            if rejoin.cameForward() { again() }
        }
        .onDisappear {
            shown = false
            if commands?.frame === frame { commands?.frame = nil }
        }
        .onChange(of: phase) { if forward, rejoin.cameForward() { again() } }
        .accessibilityIdentifier("hosted-item")
    }

    /// A new web view on a new ticket, as Try Again: the old page's session storage holds a renewal key that
    /// opens nothing, and a new ticket on the same path would only change the fragment of the page it is on.
    private func again() {
        url = nil
        frame.reset()
        progress = 0
        round += 1
    }
}

/// The format row above the keyboard (docs/IOS-DESIGN.md "A file on the phone"): the line's style, Bold, Italic
/// and the lists, each asking the page over the bridge and lit by what the page says of the caret.
struct HostedFormatRow: View {
    let frame: HostedFrame
    @ScaledMetric(relativeTo: .body) private var slot: CGFloat = Layout.rowHeight

    var body: some View {
        let state = frame.state
        HStack(spacing: 0) {
            if !state.styles.isEmpty {
                Menu {
                    Picker("Style", selection: Binding(get: { state.style ?? "" }, set: { frame.run(.style($0)) })) {
                        ForEach(state.styles, id: \.self) { Text($0).tag($0) }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(state.style ?? "Style").lineLimit(1)
                        Image(systemName: "chevron.up.chevron.down").imageScale(.small).foregroundStyle(.secondary)
                    }
                    .frame(minHeight: slot)
                    .padding(.horizontal, Layout.textEdge)
                    .contentShape(Rectangle())
                }
                .accessibilityLabel("Style")
                .accessibilityValue(state.style ?? "")
                .accessibilityIdentifier("format-style")
                Divider().frame(maxHeight: slot / 2)
            }
            mark("bold", label: "Bold", on: state.bold) { frame.run(.bold) }
            mark("italic", label: "Italic", on: state.italic) { frame.run(.italic) }
            Divider().frame(maxHeight: slot / 2)
            ForEach(HostedList.allCases, id: \.self) { list in
                mark(list.symbol, label: list.title, on: state.list == list) { frame.run(.list(list)) }
            }
            Spacer(minLength: 0)
        }
        .tint(.primary)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Format")
        .accessibilityIdentifier("format-row")
    }

    /// One press of the row: a glyph in a 44 pt slot, on the selected fill while the caret's words have it.
    private func mark(_ symbol: String, label: String, on: Bool, run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Image(systemName: symbol)
                .frame(width: slot, height: slot)
                .background(on ? Surface.groupSelected : .clear, in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("format-\(symbol)")
    }
}

/// One hosted web view kept ready (the phone's reader, PF2): made a moment after a Work screen shows, so
/// the web process is up and the page's script is compiled before he opens a document. Its data store is
/// not persistent, as every hosted view's: nothing of a page outlives its view.
@MainActor
final class HostedWebPool {
    static let shared = HostedWebPool()
    private var ready: AskingWebView?
    private var warming = false
    #if DEBUG
    /// Pages the hosted views were told to load in this launch (the Work fold check's `web.loads`).
    static var loads = 0
    #endif

    /// A page that focuses a field before his first touch (Univer's grid focuses its hidden input on load,
    /// which raised the keyboard over the sheet in the WebKit test) is blurred.
    static let focusGuard = """
    (() => {
      let touched = false
      addEventListener('touchstart', () => { touched = true }, { capture: true, once: true })
      addEventListener('focusin', (e) => { if (!touched && e.target && e.target.blur) e.target.blur() }, true)
    })()
    """

    /// A Work screen has shown: one view is made ready, off the frame that drew the screen.
    func warm() {
        guard ready == nil, !warming else { return }
        warming = true
        Task {
            try? await Task.sleep(for: .milliseconds(600))
            if ready == nil {
                let view = make()
                view.loadHTMLString("", baseURL: nil)
                ready = view
            }
            warming = false
        }
    }

    /// The ready view, else a new one.
    func take() -> AskingWebView {
        defer { ready = nil }
        return ready ?? make()
    }

    /// A memory warning: the spare goes.
    func drop() { ready = nil }

    /// How long a loaded page has to say it drew before it is shown anyway (a page from before the frame's bridge).
    static let drawnWait = Duration.seconds(2)

    private func make() -> AskingWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.addUserScript(WKUserScript(source: Self.focusGuard, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.websiteDataStore = .nonPersistent()
        let view = AskingWebView(frame: .zero, configuration: config)
        view.allowsBackForwardNavigationGestures = false
        view.isOpaque = false
        view.backgroundColor = .clear
        return view
    }
}

/// The web view: the pool's, loading the ticket's address once there is one. The page's messages come in through
/// two handlers (the frame's and the pass's), only from the ticket's own origin in the main frame.
private struct HostedWebView: UIViewRepresentable {
    let url: URL?
    let frame: HostedFrame
    /// Moves when More's Find is pressed: the system's find bar opens over the page.
    let find: Int
    let onFail: () -> Void
    let onProgress: (Double) -> Void
    let onNote: (HostedNote) -> Void
    let onAsk: ((String) -> Void)?
    let onComment: ((String) -> Void)?

    func makeCoordinator() -> Coordinator {
        let coordinator = Coordinator(frame: frame, onFail: onFail, onProgress: onProgress, onNote: onNote)
        // A Find pressed before this view was made is not this view's to open.
        coordinator.find = find
        return coordinator
    }

    func makeUIView(context: Context) -> AskingWebView {
        let view = HostedWebPool.shared.take()
        view.navigationDelegate = context.coordinator
        context.coordinator.attach(view)
        #if DEBUG
        // The Work fold check: a fold keeps this object, so the instance never changes and the page never loads again.
        LayoutProbe.note("web.instance", String(UInt(bitPattern: ObjectIdentifier(view).hashValue), radix: 16))
        #endif
        update(view, context.coordinator)
        return view
    }

    func updateUIView(_ view: AskingWebView, context: Context) {
        update(view, context.coordinator)
    }

    /// The controller holds its handlers: let them go with the view.
    static func dismantleUIView(_ view: AskingWebView, coordinator: Coordinator) {
        coordinator.detach(view)
    }

    private func update(_ view: AskingWebView, _ coordinator: Coordinator) {
        view.onAsk = onAsk
        view.onComment = onComment
        // The closure of this update: it reads whether the screen is forward now.
        coordinator.onNote = onNote
        if coordinator.find != find {
            coordinator.find = find
            if frame.offers.find { coordinator.presentFind(in: view) }
        }
        guard let url, coordinator.home != url else { return }
        coordinator.home = url
        view.load(URLRequest(url: url))
        #if DEBUG
        HostedWebPool.loads += 1
        LayoutProbe.note("web.loads", String(HostedWebPool.loads))
        #endif
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler, UIFindInteractionDelegate {
        /// The ticket's address: its origin is the one this view may show. Nil until the ticket lands.
        var home: URL?
        var find = 0
        let frame: HostedFrame
        let onFail: () -> Void
        let onProgress: (Double) -> Void
        var onNote: (HostedNote) -> Void
        private var progress: NSKeyValueObservation?
        private var findInteraction: UIFindInteraction?
        private lazy var findSession = HostedFindSession(frame: frame)

        init(frame: HostedFrame, onFail: @escaping () -> Void, onProgress: @escaping (Double) -> Void, onNote: @escaping (HostedNote) -> Void) {
            self.frame = frame
            self.onFail = onFail
            self.onProgress = onProgress
            self.onNote = onNote
        }

        /// The page's messages, its scripts run, its load followed.
        @MainActor func attach(_ view: AskingWebView) {
            let scripts = view.configuration.userContentController
            // Two handlers: the frame's (`tcFrame`, frame.ts) and the page's word of its pass (`tempcodeHosted`, phone.ts).
            for name in [HostedBridge.handler, HostedNote.handler] {
                scripts.removeScriptMessageHandler(forName: name)
                // The controller holds its handler strongly: a weak hop keeps the coordinator free to go.
                scripts.add(WeakMessageHandler(self), name: name)
            }
            frame.evaluate = { [weak view] script in view?.evaluateJavaScript(script, completionHandler: nil) }
            frame.onFound = { [weak self] _ in self?.findInteraction?.updateResultCount() }
            progress = view.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
                let share = view.estimatedProgress
                Task { @MainActor in self?.onProgress(share) }
            }
        }

        @MainActor func detach(_ view: AskingWebView) {
            for name in [HostedBridge.handler, HostedNote.handler] {
                view.configuration.userContentController.removeScriptMessageHandler(forName: name)
            }
            progress = nil
            frame.evaluate = nil
            frame.onFound = nil
        }

        /// Only the ticket's page, in its main frame, speaks to the view: its pass's word (src/hosted/guest/phone.ts)
        /// or the frame's messages (frame.ts).
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, let home, let from = message.frameInfo.request.url, HostedOrigin.same(from, home) else { return }
            if message.name == HostedNote.handler {
                if let note = HostedNote.of(message.body) { MainActor.assumeIsolated { onNote(note) } }
                return
            }
            guard JSONSerialization.isValidJSONObject(message.body),
                  let data = try? JSONSerialization.data(withJSONObject: message.body),
                  let body = try? JSONDecoder().decode(JSONValue.self, from: data) else { return }
            MainActor.assumeIsolated { frame.receive(body) }
        }

        // MARK: Find

        @MainActor func presentFind(in view: AskingWebView) {
            if findInteraction == nil {
                let interaction = UIFindInteraction(sessionDelegate: self)
                view.addInteraction(interaction)
                findInteraction = interaction
            }
            findInteraction?.presentFindNavigator(showingReplace: false)
        }

        func findInteraction(_ interaction: UIFindInteraction, sessionFor view: UIView) -> UIFindSession? { findSession }

        func findInteraction(_ interaction: UIFindInteraction, didEnd session: UIFindSession) {
            MainActor.assumeIsolated { frame.run(.clearFind) }
        }

        // MARK: Navigation

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            // A redirect, or a navigation this view cancelled itself, is not a failure; nor is the blank page
            // the pool's view held before the ticket.
            if (error as NSError).code == NSURLErrorCancelled || home == nil { return }
            onFail()
        }

        /// A page that never says it drew (one from before the frame's bridge) is shown once it has loaded, after
        /// the moment a page with the bridge takes to say so.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard home != nil else { return }
            let frame = frame
            Task { @MainActor in
                try? await Task.sleep(for: HostedWebPool.drawnWait)
                if !frame.drawn { frame.loaded() }
            }
        }

        /// The page was killed (memory): a fresh ticket opens it again.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            if home != nil { onFail() }
        }

        /// The view stays on the ticket's origin (scheme, host and port). A link he taps elsewhere opens
        /// in Safari when it is a web address; anything else, and any navigation he did not tap, goes nowhere.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard action.targetFrame?.isMainFrame != false, let target = action.request.url else { return .allow }
            if target.scheme == "about" { return .allow }
            guard let home else { return .cancel }
            if HostedOrigin.same(target, home) { return .allow }
            if action.navigationType == .linkActivated, HostedOrigin.isWeb(target) {
                await UIApplication.shared.open(target)
            }
            return .cancel
        }
    }
}

/// The script message handler's weak hop: `WKUserContentController` keeps what it is given.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// The system's find bar over the hosted page: the page finds, counts and moves over the bridge, and answers
/// `found`, which tells the bar its count changed.
private final class HostedFindSession: UIFindSession {
    let frame: HostedFrame
    init(frame: HostedFrame) { self.frame = frame }

    override var resultCount: Int { MainActor.assumeIsolated { frame.found?.count ?? 0 } }
    override var highlightedResultIndex: Int { MainActor.assumeIsolated { (frame.found?.at ?? 0) - 1 } }
    override var supportsReplacement: Bool { false }

    override func performSearch(query: String, options: UITextSearchOptions?) {
        MainActor.assumeIsolated { frame.run(.search(query)) }
    }

    override func highlightNextResult(in direction: UITextStorageDirection) {
        MainActor.assumeIsolated { frame.run(direction == .forward ? .next : .previous) }
    }

    override func invalidateFoundResults() {
        MainActor.assumeIsolated { frame.run(.clearFind) }
    }
}

/// The hosted page's origin rule.
enum HostedOrigin {
    static func same(_ a: URL, _ b: URL) -> Bool {
        a.scheme?.lowercased() == b.scheme?.lowercased() && a.host?.lowercased() == b.host?.lowercased() && port(a) == port(b)
    }

    static func isWeb(_ url: URL) -> Bool { ["http", "https"].contains(url.scheme?.lowercased() ?? "") }

    private static func port(_ url: URL) -> Int? {
        url.port ?? (url.scheme?.lowercased() == "https" ? 443 : url.scheme?.lowercased() == "http" ? 80 : nil)
    }
}

/// A web view whose edit menu leads with Ask, then Comment where the item takes comments.
final class AskingWebView: WKWebView {
    var onAsk: ((String) -> Void)?
    var onComment: ((String) -> Void)?

    override func buildMenu(with builder: any UIMenuBuilder) {
        super.buildMenu(with: builder)
        // The edit menu over a selection is the `.context` system's (iOS 16 and later).
        guard builder.system == .context else { return }
        var actions: [UIAction] = []
        // With no thread beside the page there is no Ask.
        if onAsk != nil {
            actions.append(UIAction(title: "Ask", image: UIImage(systemName: "bubble.left")) { [weak self] _ in self?.picked(.ask) })
        }
        if onComment != nil {
            actions.append(UIAction(title: "Comment", image: UIImage(systemName: "text.bubble")) { [weak self] _ in self?.picked(.comment) })
        }
        guard !actions.isEmpty else { return }
        builder.insertChild(UIMenu(options: .displayInline, children: actions), atStartOfMenu: .standardEdit)
    }

    private enum Verb { case ask, comment }

    /// The words selected in the page, when there are any, to Ask or to Comment.
    private func picked(_ verb: Verb) {
        evaluateJavaScript("String(getSelection())") { [weak self] result, _ in
            guard let quote = result as? String, !quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            switch verb {
            case .ask: self?.onAsk?(quote)
            case .comment: self?.onComment?(quote)
            }
        }
    }
}
