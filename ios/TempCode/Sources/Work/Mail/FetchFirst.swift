import SwiftUI
import TempCodeClient
import TempCodeContract

/// A mail's file, or a chat's, comes onto its host before its kind can read it (docs/agents/work-mail.md
/// "Attachments"): `work.canvas.fetch` streams it from LifeOS's store into the item's own folder there, and the
/// `work.canvas.fetch` push says how much has come. Until then the reader's own loading shape stands in, with
/// the share once the store says the size; a refusal is the host's words with Try Again.
struct FetchFirst<Content: View>: View {
    let client: EnvironmentClient
    let item: CanvasItem
    @ViewBuilder let content: () -> Content

    private enum Phase: Equatable { case fetching, ready, failed(String) }
    @State private var phase: Phase = .fetching

    var body: some View {
        Group {
            switch phase {
            case .fetching:
                ReaderLoading(progress: client.work.canvas.fetching[item.id] ?? nil, words: "Coming from LifeOS")
            case .ready:
                content()
            case .failed(let words):
                ContentUnavailableView {
                    Label(ReaderVerbs.title(of: item), systemImage: "exclamationmark.triangle")
                } description: {
                    Text(words)
                } actions: {
                    Button("Try Again") { Task { await fetch() } }
                }
            }
        }
        .task(id: item.id) { await fetch() }
    }

    private func fetch() async {
        // A key that may not read his mail's files is told so, not refused by the host.
        guard client.work.may(.canvasFetch) else { return phase = .failed("This iPhone’s key can’t read mail files.") }
        phase = .fetching
        do {
            try await client.work.canvas.fetch(item)
            phase = .ready
        } catch {
            phase = .failed(ActionError.wrap(error).message)
        }
    }
}
