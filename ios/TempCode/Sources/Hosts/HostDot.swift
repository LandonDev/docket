import SwiftUI
import TempCodeClient

/// The host tone's colours (`HostTone`, the client package's one rule for
/// every dot that means a host's link): the kit's colours, nothing new.
extension HostTone {
    var color: Color {
        switch self {
        case .fresh: Tint.success
        case .stale: Tint.success.opacity(0.5)
        case .busy: Tint.warning
        case .away: Color(.tertiaryLabel)
        case .refused: Tint.destructive
        case .locked: Tint.warning
        case .asleep: Tint.quiet
        case .unreachable: Tint.destructive
        }
    }

    /// The static cue: the Computers row's word (`ConnectionWord`), for accessibility values.
    func label(_ status: EnvironmentStatus, now: Date) -> String {
        ConnectionWord.text(for: status)
    }
}

/// A host's link as a dot. Cross-fades 150 ms between tones after the first
/// paint; never on it. VoiceOver reads the state in words.
struct HostDot: View {
    let status: EnvironmentStatus
    var size: CGFloat = Layout.dotSize
    @State private var painted = false

    private var tone: HostTone { HostTone(status) }

    var body: some View {
        Circle()
            .fill(tone.color)
            .frame(width: size, height: size)
            .animation(painted ? Motion.crossFade : nil, value: tone)
            .task { painted = true }
            .accessibilityLabel(tone.label(status, now: .now))
    }
}

/// The host a thread or agent runs on, as one small monochrome glyph: a
/// laptop for a Mac, a rack for anything else (the box), from the platform
/// the host's hello named and the paired environment remembers. Drawn only
/// when two or more hosts are paired; colour stays for the status dots.
/// VoiceOver reads "On box".
struct HostGlyph: View {
    let environmentId: String
    @Environment(AppModel.self) private var app

    var body: some View {
        if ProjectPairs.showsHost(hostCount: app.registry.ordered.count), let client = app.registry.client(environmentId) {
            MetaGlyph(HostKind(platform: app.registry.platform(environmentId)).symbol, tint: .secondary, label: "On \(client.environment.name)")
        }
    }
}
