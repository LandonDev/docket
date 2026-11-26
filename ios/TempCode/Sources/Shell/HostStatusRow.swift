import SwiftUI
import TempCodeClient

/// One notice at the top of Home for a host that is not plainly connected:
/// its name, what is happening, and the one action that helps (Retry, or
/// Sign In Again when the key was refused). Its words are the computer's
/// page's (`ConnectionStatusText`, `ConnectionSentence`). A field on the chrome step with the
/// capsule inside it; never a blank screen. `trailing` is a sibling's mark
/// (the deploy drift), between the words and the pill.
struct HostStatusRow: View {
    let client: EnvironmentClient
    var trailing: AnyView?
    let pairAgain: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let status = client.status
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 10) {
                    words(status)
                    HStack(spacing: 12) {
                        trailing
                        action(status)
                    }
                }
            } else {
                HStack(alignment: .center, spacing: 12) {
                    words(status)
                    Spacer(minLength: 8)
                    trailing
                    action(status)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
        .background(Surface.chrome, in: RoundedRectangle.fieldCorner)
        .accessibilityElement(children: .contain)
    }

    private func words(_ status: EnvironmentStatus) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            Circle()
                .fill(HostTone(status).color)
                .frame(width: Layout.dotSize, height: Layout.dotSize)
                .frame(width: Layout.markWidth)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            VStack(alignment: .leading, spacing: 1) {
                Text(client.environment.name)
                    .textStep(.meta, weight: .semibold)
                    .lineLimit(1)
                ConnectionStatusText(name: client.environment.name, status: status)
                    .textStep(.meta)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func action(_ status: EnvironmentStatus) -> some View {
        if !RelayWords.showsRetry(for: client) {
            // Thread 29: a lane the box holds has no Retry; the box retries the link.
            EmptyView()
        } else if status.transport == .unauthorized {
            PillButton(HostFix.pairAgain.title, action: pairAgain)
        } else {
            PillButton("Retry") { Task { await client.retry() } }
        }
    }
}
