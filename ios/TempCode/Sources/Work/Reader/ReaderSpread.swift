import SwiftUI
import TempCodeClient

/// An open file's two halves on the Duo (`ReaderHalves`): the thing and what goes with it side by side across an
/// upright band, or above and below one lying across on a table; anywhere else `single`, the file's own column.
/// The page he is on survives a fold through the reader's kept place (`ReaderPlaces`), as a rotation does.
struct ReaderSpread<Thing: View, With: View, Single: View>: View {
    /// False: the file has nothing to put beside it (no notes, no comments), so it keeps its column.
    var enabled = true
    @ViewBuilder let thing: Thing
    @ViewBuilder let with: With
    /// The file's one column, given both parts as it lays them out itself.
    @ViewBuilder let single: (Thing, With) -> Single
    @State private var hingeMoves = 0

    var body: some View {
        GeometryReader { proxy in
            let _ = hingeMoves
            let layout = enabled ? ReaderHalves.of(size: proxy.size, division: Duo.divisionBand(proxy)) : nil
            switch layout {
            case .pages(let first, let second), .table(let first, let second):
                ZStack(alignment: .topLeading) {
                    thing
                        .frame(width: first.width, height: first.height)
                        .offset(x: first.minX, y: first.minY)
                    with
                        .frame(width: second.width, height: second.height)
                        .offset(x: second.minX, y: second.minY)
                }
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
                #if DEBUG
                .onAppear { LayoutProbe.note("reader.halves", Self.name(layout)) }
                #endif
            case nil:
                single(thing, with)
                #if DEBUG
                .onAppear { LayoutProbe.note("reader.halves", "single") }
                #endif
            }
        }
        .onDuoHingeChange { hingeMoves += 1 }
    }

    #if DEBUG
    private static func name(_ layout: ReaderHalves.Layout?) -> String {
        switch layout {
        case .pages: "pages"
        case .table: "table"
        case nil: "single"
        }
    }
    #endif
}

/// A document beside its comments (`ReaderHalves`), laid out by one `Layout` so the document never changes its place
/// in the tree: a fold that brings the comments in or takes them away moves the hosted editor's page, never loads it
/// again. Where the file keeps its one column the comments take no room, no touch and no VoiceOver.
struct ReaderBeside<Thing: View, With: View>: View {
    var enabled = true
    @ViewBuilder let thing: Thing
    @ViewBuilder let with: With
    @State private var hingeMoves = 0

    var body: some View {
        GeometryReader { proxy in
            let _ = hingeMoves
            let layout = enabled ? ReaderHalves.of(size: proxy.size, division: Duo.divisionBand(proxy)) : nil
            HalvesLayout(layout: layout) {
                thing
                with
                    .opacity(layout == nil ? 0 : 1)
                    .allowsHitTesting(layout != nil)
                    .accessibilityHidden(layout == nil)
            }
            #if DEBUG
            .onChange(of: layout, initial: true) { _, now in LayoutProbe.note("reader.halves", now == nil ? "single" : "beside") }
            #endif
        }
        .onDuoHingeChange { hingeMoves += 1 }
    }
}

/// Places the thing and what goes with it in the halves, or the thing alone in the whole.
private nonisolated struct HalvesLayout: SwiftUI.Layout {
    let layout: ReaderHalves.Layout?

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        // With nothing to go beside it (no comments yet) the thing is the one subview, and takes the whole.
        guard subviews.count == 2 else {
            subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
            return
        }
        switch layout {
        case .pages(let first, let second), .table(let first, let second):
            place(subviews[0], first, in: bounds)
            place(subviews[1], second, in: bounds)
        case nil:
            subviews[0].place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
            subviews[1].place(at: bounds.origin, proposal: .zero)
        }
    }

    private func place(_ view: LayoutSubview, _ rect: CGRect, in bounds: CGRect) {
        view.place(at: CGPoint(x: bounds.minX + rect.minX, y: bounds.minY + rect.minY), proposal: ProposedViewSize(rect.size))
    }
}
