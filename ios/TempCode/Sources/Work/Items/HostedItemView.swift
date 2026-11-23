import SwiftUI
import TempCodeClient
import TempCodeContract
import WebKit

/// A LifeOS document or sheet in the hosted editor (milestone 47): a ticket
/// from the host that serves LifeOS's documents (`work.guests.ticket`, good
/// once within two minutes) opens `/w/open` signed in as him, full width.
/// The page draws its own loading and its own review; the system's edit
/// menu on a selection leads with Ask.
struct HostedItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let source: Methods.WorkGuestsTicket.Params.Source
    let ask: ((ContextChip) -> Void)?
    @State private var url: URL?
    @State private var failed = false
    @State private var round = 0

    var body: some View {
        Group {
            if failed {
                ContentUnavailableView {
                    Label("This page cannot be reached right now", systemImage: "wifi.exclamationmark")
                } description: {
                    Text("\(client.environment.name) did not answer.")
                } actions: {
                    Button("Try Again") { failed = false; url = nil; round += 1 }
                }
            } else if let url {
                HostedWebView(url: url, onFail: { failed = true }, onAsk: ask.map { ask in { (quote: String) in ask(ChipWords.selection(in: item, quote: quote)) } })
                    .ignoresSafeArea(.container, edges: .bottom)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: round) {
            do {
                let address = try await client.work.canvas.ticket(source, title: item.title)
                guard let parsed = URL(string: address) else { failed = true; return }
                url = parsed
            } catch {
                failed = true
            }
        }
        .accessibilityIdentifier("hosted-item")
    }
}

/// The web view. A page that focuses a field before his first touch (Univer's grid focuses its hidden
/// input on load, which raised the keyboard over the sheet in the WebKit test) is blurred.
private struct HostedWebView: UIViewRepresentable {
    let url: URL
    let onFail: () -> Void
    let onAsk: ((String) -> Void)?

    static let focusGuard = """
    (() => {
      let touched = false
      addEventListener('touchstart', () => { touched = true }, { capture: true, once: true })
      addEventListener('focusin', (e) => { if (!touched && e.target && e.target.blur) e.target.blur() }, true)
    })()
    """

    func makeCoordinator() -> Coordinator { Coordinator(home: url, onFail: onFail) }

    func makeUIView(context: Context) -> AskingWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.addUserScript(WKUserScript(source: Self.focusGuard, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.websiteDataStore = .nonPersistent()
        let view = AskingWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.onAsk = onAsk
        view.allowsBackForwardNavigationGestures = false
        view.isOpaque = false
        view.backgroundColor = .clear
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: AskingWebView, context: Context) {
        view.onAsk = onAsk
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        /// The ticket's address: its origin is the one this view may show.
        let home: URL
        let onFail: () -> Void
        init(home: URL, onFail: @escaping () -> Void) {
            self.home = home
            self.onFail = onFail
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            // A redirect, or a navigation this view cancelled itself, is not a failure.
            if (error as NSError).code == NSURLErrorCancelled { return }
            onFail()
        }

        /// The page was killed (memory): a fresh ticket opens it again.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            onFail()
        }

        /// The view stays on the ticket's origin (scheme, host and port). A link he taps elsewhere opens
        /// in Safari when it is a web address; anything else, and any navigation he did not tap, goes nowhere.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard action.targetFrame?.isMainFrame != false, let target = action.request.url else { return .allow }
            if target.scheme == "about" || HostedOrigin.same(target, home) { return .allow }
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

/// A web view whose edit menu leads with Ask.
final class AskingWebView: WKWebView {
    var onAsk: ((String) -> Void)?

    override func buildMenu(with builder: any UIMenuBuilder) {
        super.buildMenu(with: builder)
        // The edit menu over a selection is the `.context` system's (iOS 16 and later); with no thread beside it, no Ask.
        guard builder.system == .context, onAsk != nil else { return }
        let ask = UIAction(title: "Ask", image: UIImage(systemName: "bubble.left")) { [weak self] _ in
            self?.evaluateJavaScript("String(getSelection())") { result, _ in
                guard let quote = result as? String, !quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                self?.onAsk?(quote)
            }
        }
        builder.insertChild(UIMenu(options: .displayInline, children: [ask]), atStartOfMenu: .standardEdit)
    }
}
