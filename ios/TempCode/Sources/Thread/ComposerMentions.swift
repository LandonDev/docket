import CoreTransferable
import SwiftUI
import TempCodeClient
import TempCodeContract
import UniformTypeIdentifiers

/// A Work thread's things in its composer (All of Work on the iPhone M4a; docs/IOS-DESIGN.md "The composer's `@`"):
/// the `@` list over the box (`MentionPanel`), the chips waiting for the send (`ComposerChipRow`), a row's chip
/// dragged in (`ChipDrag`), and the chips a sent message carried (`SentChipRow`). The rules are the client
/// package's Work/Mentions/Mentions.swift.

/// A row dragged as the chip it would be (`Transferable` over the mention hit's source): an Outbox item, a person, or
/// a Files row, whose `FileDrag` carries its chip beside what a folder's Move reads. Decoded from any JSON with a
/// `chip`, so a file row dropped on the box gives its chip and a folder row ignores it.
nonisolated struct ChipDrag: Codable, Transferable, Sendable {
    let chip: ContextChip

    init(_ chip: ContextChip) {
        self.chip = chip
    }

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .json)
    }
}

/// A row that drags as its chip, with the chip itself as the picture under the finger; no chip, no drag.
struct ChipDragSource: ViewModifier {
    let chip: ContextChip?

    func body(content: Content) -> some View {
        if let chip {
            content.draggable(ChipDrag(chip)) { ItemChip(chip: chip) }
        } else {
            content
        }
    }
}

/// The chips waiting in a thread's box, over the field: each its glyph and name with a remove, in one row that
/// scrolls sideways past the width. Reads its own thread's box alone, so a chip added elsewhere draws nothing here.
struct ComposerChipRow: View {
    let box: ChipBox
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: StripMetrics.chipGap * 3) {
                ForEach(Array(box.chips.enumerated()), id: \.offset) { index, chip in
                    ItemChip(chip: chip) { remove(index) }
                        .accessibilityLabel("\(ChipWords.noun(chip.kind).capitalizedFirst), \(chip.label)")
                        .accessibilityAction(named: "Remove") { remove(index) }
                        .transition(Motion.appear(reduced: reduceMotion))
                }
            }
        }
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
        .animation(reduceMotion ? Motion.crossFade : Motion.rowAppear, value: box.chips.count)
        .accessibilityIdentifier("composer-chips")
        #if DEBUG
        // The Work fold cycle holds the box's chips through every fold.
        .onChange(of: box.chips.count, initial: true) { LayoutProbe.note("work.chips", String(box.chips.count)) }
        #endif
    }

    private func remove(_ index: Int) {
        box.remove(at: index)
    }
}

/// What a Work thread's `@` offers, over the box while the box ends on `@words`: the host's rows (the thing's glyph,
/// its name, a quiet fact and time), Loading… before the first answer, the one quiet line for what could not be
/// searched, No Matches when nothing does. A tap puts the chip in the box and takes the `@words` out. It reads the
/// draft's `mention` alone, so a key typed after the `@` runs this body and the field's, nothing else; it appears and
/// leaves with no motion, since a key opens and closes it.
struct MentionPanel: View {
    let draft: ComposerDraft
    let ask: MentionAsk
    let pick: (ContextChip) -> Void
    /// Four rows and a half show, so a longer answer is seen to scroll.
    private static let rowsShown: CGFloat = 4.5

    var body: some View {
        if let query = draft.mention {
            let rows = ask.rows(for: query)
            VStack(alignment: .leading, spacing: 0) {
                if ask.loading {
                    HStack(spacing: Layout.rowGap) {
                        ProgressView().controlSize(.small)
                        Text("Loading…").textStep(.meta)
                    }
                    .padding(.horizontal, Layout.textEdge)
                    .frame(minHeight: Layout.rowHeight, alignment: .leading)
                } else {
                    if !rows.isEmpty {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(rows, id: \.self) { hit in
                                    MentionRow(hit: hit) { pick(hit.chip) }
                                }
                            }
                        }
                        .scrollBounceBehavior(.basedOnSize)
                        .frame(maxHeight: Layout.rowHeight * Self.rowsShown)
                        .fixedSize(horizontal: false, vertical: rows.count < Int(Self.rowsShown))
                    } else if ask.answered == query, ask.note == nil {
                        Text("No Matches")
                            .textStep(.meta)
                            .padding(.horizontal, Layout.textEdge)
                            .frame(minHeight: Layout.rowHeight, alignment: .leading)
                    }
                    if let note = ask.note {
                        QuietLine(symbol: "exclamationmark.circle", text: note)
                            .padding(.horizontal, Layout.textEdge)
                            .padding(.vertical, Layout.rowVertical)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, Layout.rowVertical)
            .tcGlass(in: RoundedRectangle.corner(Radius.field))
            .accessibilityIdentifier("mention-panel")
            // Keyed on the words: a new key cancels the ask before it, and the first ask goes at once.
            .task(id: query) { await ask.ask(query) }
        }
    }
}

/// One `@` row: the thing's glyph, its name, and its quiet fact and time on a second line. VoiceOver reads the kind
/// first, then the name and the fact.
private struct MentionRow: View {
    let hit: MentionHit
    let action: () -> Void
    @ScaledMetric(relativeTo: .subheadline) private var glyph = Layout.glyphWidth

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
                Image(systemName: ItemChip.symbol(hit.chip.kind))
                    .foregroundStyle(.secondary)
                    .frame(width: glyph)
                VStack(alignment: .leading, spacing: 0) {
                    Text(hit.chip.label)
                        .textStep(.title)
                        .lineLimit(2)
                    if let detail = MentionWords.detail(hit) {
                        Text(detail)
                            .textStep(.meta)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Layout.textEdge)
            .padding(.vertical, Layout.rowVertical)
            .frame(minHeight: Layout.rowHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(ChipWords.noun(hit.chip.kind).capitalizedFirst), \(hit.chip.label)")
        .accessibilityValue(MentionWords.detail(hit) ?? "")
        .accessibilityAddTraits(.isButton)
    }
}

/// The chips a sent message carried, over his words in the bubble: each its glyph and name, as the box showed it.
struct SentChipRow: View {
    let chips: [SentChips.Chip]

    var body: some View {
        FlowLayout(spacing: StripMetrics.chipGap * 3, lineSpacing: StripMetrics.chipGap * 3) {
            ForEach(Array(chips.enumerated()), id: \.offset) { _, chip in
                HStack(spacing: StripMetrics.chipGap * 3) {
                    Image(systemName: ItemChip.symbol(chip.kind))
                        .imageScale(.small)
                        .foregroundStyle(.secondary)
                    Text(chip.label)
                        .textStep(.meta, tint: .primary)
                        .lineLimit(1)
                }
                .padding(.horizontal, StripMetrics.shelfPadding)
                .frame(minHeight: StripMetrics.chip)
                .background(Surface.fill, in: RoundedRectangle.corner(Radius.row))
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(chip.noun.capitalizedFirst), \(chip.label)")
            }
        }
        .accessibilityIdentifier("sent-chips")
    }
}

extension String {
    /// "held act" → "Held act", for a spoken kind.
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
