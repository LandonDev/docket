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
    let ask: (ContextChip) -> Void
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
                HostedWebView(url: url, onFail: { failed = true }, onAsk: { quote in ask(ChipWords.selection(in: item, quote: quote)) })
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
    let onAsk: (String) -> Void

    static let focusGuard = """
    (() => {
      let touched = false
      addEventListener('touchstart', () => { touched = true }, { capture: true, once: true })
      addEventListener('focusin', (e) => { if (!touched && e.target && e.target.blur) e.target.blur() }, true)
    })()
    """

    func makeCoordinator() -> Coordinator { Coordinator(onFail: onFail) }

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
        let onFail: () -> Void
        init(onFail: @escaping () -> Void) { self.onFail = onFail }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            onFail()
        }

        /// The ticket's page and what it loads stay in the view; any other link opens in Safari.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard action.navigationType == .linkActivated, let target = action.request.url else { return .allow }
            if target.host == webView.url?.host { return .allow }
            await UIApplication.shared.open(target)
            return .cancel
        }
    }
}

/// A web view whose edit menu leads with Ask.
final class AskingWebView: WKWebView {
    var onAsk: ((String) -> Void)?

    override func buildMenu(with builder: any UIMenuBuilder) {
        super.buildMenu(with: builder)
        // The edit menu over a selection is the `.context` system's (iOS 16 and later).
        guard builder.system == .context else { return }
        let ask = UIAction(title: "Ask", image: UIImage(systemName: "bubble.left")) { [weak self] _ in
            self?.evaluateJavaScript("String(getSelection())") { result, _ in
                guard let quote = result as? String, !quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                self?.onAsk?(quote)
            }
        }
        builder.insertChild(UIMenu(options: .displayInline, children: [ask]), atStartOfMenu: .standardEdit)
    }
}
