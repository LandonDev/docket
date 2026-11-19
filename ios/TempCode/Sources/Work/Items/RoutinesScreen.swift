import SwiftUI
import TempCodeClient
import TempCodeContract

/// A Work workspace's routines and watches (milestone 47, the phone-canvas
/// page): two bands, each row its name with the trigger in plain words under
/// it and when it next runs as the stamp; a watch carries the watching dot,
/// a paused one the pause glyph. Swipe to Pause or Resume.
struct RoutinesScreen: View {
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    @State private var rows: [RoutinePhoneRow]?
    @State private var error: String?

    var body: some View {
        Group {
            if let rows {
                let bands = RoutineBands.bands(rows)
                if bands.routines.isEmpty, bands.watches.isEmpty {
                    ContentUnavailableView("No Routines", systemImage: "clock.arrow.circlepath")
                } else {
                    List {
                        band("Routines", bands.routines)
                        band("Watches", bands.watches)
                    }
                    .listStyle(.plain)
                }
            } else if let error {
                ContentUnavailableView("Can’t Read Routines", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Routines")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: client.work.canvas.routinesRev[workspace.id] ?? 0) { await load() }
        .accessibilityIdentifier("routines")
    }

    @ViewBuilder private func band(_ title: String, _ rows: [RoutinePhoneRow]) -> some View {
        if !rows.isEmpty {
            Section {
                ForEach(rows, id: \.id) { row in
                    RoutineRowView(row: row)
                        .swipeActions(edge: .trailing) {
                            if !row.ended, client.work.canApprove {
                                Button(row.enabled ? "Pause" : "Resume", systemImage: row.enabled ? "pause" : "play") { Task { await pause(row) } }
                                    .tint(row.enabled ? Tint.warning : Tint.info)
                            }
                        }
                }
            } header: {
                Text(title).textStep(.meta, weight: .semibold)
            }
        }
    }

    private func load() async {
        do {
            rows = try await client.work.canvas.routines(workspace.id)
            error = nil
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }

    private func pause(_ row: RoutinePhoneRow) async {
        do {
            let changed = try await client.work.canvas.pause(row, row.enabled)
            rows = rows?.map { $0.id == changed.id ? changed : $0 }
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}

private struct RoutineRowView: View {
    let row: RoutinePhoneRow

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if !row.enabled, !row.ended {
                        Image(systemName: "pause.fill").imageScale(.small).foregroundStyle(.secondary)
                    } else if row.kind == .watch, !row.ended {
                        Circle().fill(Tint.info).frame(width: 7, height: 7).accessibilityLabel("Watching")
                    }
                    Text(row.name).textStep(.title)
                }
                Text(row.words).textStep(.meta).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 8)
            Text(RoutineBands.stamp(row)).textStep(.stamp).foregroundStyle(.secondary).monospacedDigit()
        }
        .opacity(row.ended ? 0.5 : 1)
        .frame(minHeight: Layout.rowHeight)
        .accessibilityElement(children: .combine)
    }
}
