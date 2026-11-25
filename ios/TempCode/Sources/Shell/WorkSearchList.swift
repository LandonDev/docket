import SwiftUI
import TempCodeClient
import TempCodeContract

/// The Search tab's Work scope (docs/IOS-DESIGN.md "Search"): the rows
/// `WorkSearchRun` makes of every Work host's answers, under kind headings in
/// the desktop's order. A row whose thing has a place on the phone opens it
/// there and tells the hit's host, for Recent; a kind with no phone place is
/// shown and is not a button. Nothing here animates on a keystroke.
struct WorkSearchRows: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    let run: WorkSearchRun
    let rows: [WorkSearchModel.Row]
    /// Rows of more than one job stand together, so each says its job.
    let mixed: Bool
    /// "All mail for …": the search held to one kind.
    let narrow: (String) -> Void
    /// The file being seated in its job's Files pane, by its key: its row's spinner.
    @Binding var opening: String?
    @Binding var failure: String?

    var body: some View {
        ForEach(rows) { row in
            switch row {
            case .heading(_, let label):
                SectionHeader(label) { EmptyView() }
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
            case .hit(_, let hit, let host):
                hitRow(hit, host: host)
                    .listRowInsets(Layout.rowInsets)
            case .all(_, let kind, let label):
                Button { narrow(kind) } label: {
                    Text(label)
                        .textStep(.meta, weight: .semibold, tint: Color.accentColor)
                        .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.pressable)
                .listRowInsets(Layout.rowInsets)
            case .widen:
                // The phone's Work scope is never held to one job, so it never offers to widen.
                EmptyView()
            case .note(_, let text, let cause):
                if cause {
                    FootRow(text: text)
                        .listRowInsets(Layout.rowInsets)
                        .listRowSeparator(.hidden)
                }
            }
        }
    }

    @ViewBuilder
    private func hitRow(_ hit: WorkSearchHit, host: String) -> some View {
        let client = model.registry.client(host)
        let place = mixed ? client?.workPlace(hit.workspaceId) : nil
        let label = WorkHitRow(hit: hit, query: run.model.text, place: place, opening: opening == hit.key)
        if let target = WorkSearchTarget.of(hit, environmentId: host), let client {
            Button { open(target, hit: hit, client: client) } label: { label }
                .buttonStyle(.pressable)
                .disabled(opening != nil)
                .separatorAtTextEdge(WorkHitRow.textEdge)
        } else {
            label.separatorAtTextEdge(WorkHitRow.textEdge)
        }
    }

    /// Opens the hit in its place and tells its host, never waited on. A file is seated first, its row's spinner
    /// standing while the host makes the item; the host's own words if it cannot.
    private func open(_ target: WorkSearchTarget, hit: WorkSearchHit, client: EnvironmentClient) {
        Task { await client.work.searchOpened(hit) }
        switch target {
        case .route(let route):
            navigator.open(route)
        case .file(let environmentId, let workspaceId, let ref, let name, let key):
            opening = hit.key
            Task {
                defer { opening = nil }
                do {
                    let item = try await client.work.openFound(workspaceId: workspaceId, ref: ref, name: name, key: key)
                    client.work.canvas.warmTicket(item)
                    navigator.open(.file(environmentId: environmentId, item: item, sessionId: nil))
                } catch {
                    failure = ActionError.wrap(error).message
                }
            }
        }
    }
}

/// One found thing: its kind's glyph, its title, its one fact (the matched words in weight, else the host's
/// muted fact), and its job when several stand together. VoiceOver reads the job first.
struct WorkHitRow: View {
    let hit: WorkSearchHit
    let query: String
    let place: (name: String, sector: String?)?
    let opening: Bool
    @ScaledMetric(relativeTo: .subheadline) private var glyph = Layout.glyphWidth
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Where the title starts: the glyph column and its gap. The separator starts here.
    static let textEdge = Layout.glyphWidth + Layout.rowGap

    private var fact: String? { hit.snippet ?? hit.detail }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            Image(systemName: Self.glyph(hit.kind))
                .font(TextStep.meta.font.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: glyph)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(hit.title.isEmpty ? "Untitled" : hit.title)
                    .textStep(.title)
                    .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                if let fact, !fact.isEmpty {
                    Text(MatchEmphasis.attributed(fact, matches: MatchRanges.ranges(in: fact, query: query), step: .meta))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            Spacer(minLength: 8)
            if opening {
                ProgressView().controlSize(.small)
            } else if let place {
                HStack(spacing: Layout.tagGap) {
                    SectorDot(sector: place.sector)
                    Text(place.name).textStep(.stamp).lineLimit(1)
                }
                .layoutPriority(-1)
            }
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([place?.name, hit.title, fact].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
        .accessibilityValue(opening ? "Opening" : "")
    }

    /// One SF Symbol a kind, the same as the place it opens in where there is one.
    static func glyph(_ kind: String) -> String {
        switch kind {
        case "person": "person.crop.circle"
        case "mail": "envelope"
        case "message": "bubble.left"
        case "chat": "bubble.left.and.bubble.right"
        case "task", "card": "checkmark.circle"
        case "event": "calendar"
        case "file": "doc"
        case "doc": "doc.text"
        case "project": "square.stack"
        case "thread": "text.bubble"
        case "held": WorkGlyph.outbox
        case "routine": "clock.arrow.circlepath"
        case "money", "receipt": "dollarsign.circle"
        case "msform": "list.bullet.rectangle"
        default: "square.on.square"
        }
    }
}
