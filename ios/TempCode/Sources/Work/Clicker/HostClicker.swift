import SwiftUI
import TempCodeClient
import TempCodeContract

/// The clicker on a host's running show (docs/agents/work-slides.md "The clicker"): its model reads the show and
/// sends each press through `ShowLink`, and the `work.slides.show` push for that show moves it here too. Shown as a
/// cover from the Work list's "Showing on" row and from a deck's More.
struct HostClicker: View {
    let client: EnvironmentClient
    let onDone: () -> Void
    @State private var link: ShowLink
    @State private var model: ClickerModel

    init(client: EnvironmentClient, itemId: String? = nil, onDone: @escaping () -> Void) {
        self.client = client
        self.onDone = onDone
        let link = ShowLink(host: client.work, itemId: itemId)
        _link = State(initialValue: link)
        _model = State(initialValue: ClickerModel(wire: link.wire))
    }

    var body: some View {
        NavigationStack {
            ClickerScreen(model: model, onDone: onDone)
        }
        // Another device stepped the show, or it ended: the push for this show moves the count here.
        .onChange(of: client.work.showsRev) {
            guard let pushed = client.work.showPushed, link.owns(pushed.showId) else { return }
            model.apply(pushed.live.flatMap { ClickerShow($0) })
        }
    }
}

/// "Showing on MacBook" at the Work list's foot while a show runs on one of his computers: a tap opens the clicker.
struct ShowingRow: View {
    let client: EnvironmentClient
    let live: ShowLive
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(ShowRows.title(computer: client.environment.name))
                    Text(ShowRows.detail(live))
                        .textStep(.meta)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .lineLimit(1)
                }
            } icon: {
                Image(systemName: "av.remote")
            }
        }
        .accessibilityIdentifier("showing-row")
        .fullScreenCover(isPresented: $open) {
            HostClicker(client: client, itemId: live.itemId) { open = false }
        }
    }
}
