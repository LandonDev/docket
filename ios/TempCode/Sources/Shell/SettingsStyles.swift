import SwiftUI

/// The SwiftUI pieces Settings, Computers and the sign-in sheet share. The
/// words they say (the connection word, the fixes, the build line, the
/// capability titles) are the client package's `Shell/HostPresentation.swift`,
/// where they have tests.

/// A refusal under a field: glyph and one sentence in destructive, footnote
/// size, inside the field's own section so it reads as part of the field.
/// The caller gives it `.rowAppearTransition()`: it arrives with the
/// needs-you row motion (200 ms, 8 pt of travel) and leaves with a 150 ms
/// fade; reduced motion fades both ways.
struct InlineFieldError: View {
    let message: String

    var body: some View {
        Label {
            Text(message)
                .font(.footnote)
        } icon: {
            // The glyph's stroke matches the regular footnote beside it.
            Image(systemName: "exclamationmark.circle")
                .font(.footnote)
        }
        .foregroundStyle(Tint.destructive)
        .accessibilityIdentifier("field-error")
    }
}

/// A section's rows while its first read is out: the rows' own shape,
/// redacted, so the section holds its place instead of arriving late and
/// pushing the screen down (docs/IOS-DESIGN.md "Settings"). `labels` are
/// the words the rows will carry, so the bones are the right length; one
/// "Loading" for VoiceOver stands for all of them.
struct SettingsPlaceholderRows: View {
    let labels: [String]
    /// A trailing switch's shape (Away, Work's switches) in place of a value.
    var toggles = false

    var body: some View {
        ForEach(Array(labels.enumerated()), id: \.offset) { index, label in
            Group {
                if toggles {
                    // The system's own switch, off and still: the row is the shape it will be.
                    Toggle(isOn: .constant(false)) { Text(label) }
                        .disabled(true)
                } else {
                    LabeledContent(label) { Text("Value") }
                }
            }
            .redacted(reason: .placeholder)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: index == 0 ? "Loading" : ""))
            .accessibilityHidden(index > 0)
        }
    }
}
