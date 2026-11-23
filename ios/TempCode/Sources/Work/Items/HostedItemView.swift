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
struct HostedItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let source: Methods.WorkGuestsTicket.Params.Source
    /// nil where no thread stands beside the item: the edit menu has no Ask.
    let ask: ((ContextChip) -> Void)?
    @Environment(ReaderCommands.self) private var commands: ReaderCommands?
    @Environment(\.hostedFallback) private var fallback
    @State private var url: URL?
    @State private var failed = false
    /// A file's host said why it does not open here: its words, and nothing to try again.
    @State private var refusal: String?
    @State private var round = 0

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
                    Button("Try Again") { failed = false; url = nil; round += 1 }
                }
            } else {
                HostedWebView(
                    url: url,
                    onFail: { failed = true },
                    onAsk: ask.map { ask in { (quote: String) in ask(ChipWords.selection(in: item, quote: quote)) } },
                    // Comment is a document's: a sheet keeps no comments.
                    onComment: item.kind == .document ? commands?.comment : nil
                )
                // A page that failed gets a new web view with its new ticket.
                .id(round)
                .ignoresSafeArea(.container, edges: .bottom)
                .overlay { if url == nil { ProgressView() } }
            }
        }
        .task(id: round) {
            do {
                let address = try await client.work.canvas.ticket(for: item, source: source)
                guard let parsed = URL(string: address) else { failed = true; return }
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
        .accessibilityIdentifier("hosted-item")
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

/// The web view: the pool's, loading the ticket's address once there is one.
private struct HostedWebView: UIViewRepresentable {
    let url: URL?
    let onFail: () -> Void
    let onAsk: ((String) -> Void)?
    let onComment: ((String) -> Void)?

    func makeCoordinator() -> Coordinator { Coordinator(onFail: onFail) }

    func makeUIView(context: Context) -> AskingWebView {
        let view = HostedWebPool.shared.take()
        view.navigationDelegate = context.coordinator
        update(view, context.coordinator)
        return view
    }

    func updateUIView(_ view: AskingWebView, context: Context) {
        update(view, context.coordinator)
    }

    private func update(_ view: AskingWebView, _ coordinator: Coordinator) {
        view.onAsk = onAsk
        view.onComment = onComment
        guard let url, coordinator.home != url else { return }
        coordinator.home = url
        view.load(URLRequest(url: url))
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        /// The ticket's address: its origin is the one this view may show. Nil until the ticket lands.
        var home: URL?
        let onFail: () -> Void
        init(onFail: @escaping () -> Void) {
            self.onFail = onFail
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            // A redirect, or a navigation this view cancelled itself, is not a failure; nor is the blank page
            // the pool's view held before the ticket.
            if (error as NSError).code == NSURLErrorCancelled || home == nil { return }
            onFail()
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
