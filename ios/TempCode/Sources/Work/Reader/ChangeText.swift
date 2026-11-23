import SwiftUI

/// What went and what came, drawn one way wherever a change shows (the history compare, Review Changes):
/// the words that went struck through in red, the words that came underlined in green. The stroke carries
/// the meaning with the colour, never the colour alone.
enum ChangeText {
    static func removed(_ words: String) -> Text {
        Text(words).strikethrough().foregroundStyle(Tint.destructiveText)
    }

    static func added(_ words: String) -> Text {
        Text(words).underline().foregroundStyle(Tint.successText)
    }
}

/// One change as two lines at most: what was there, then what would be.
struct ChangeLines: View {
    let old: String
    let new: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !old.isEmpty { ChangeText.removed(old) }
            if !new.isEmpty { ChangeText.added(new) }
        }
        .textStep(.title)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(old.isEmpty ? "Adds: \(new)" : new.isEmpty ? "Removes: \(old)" : "Was: \(old). Would be: \(new)")
    }
}
