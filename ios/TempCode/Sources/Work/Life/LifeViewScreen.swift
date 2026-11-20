import LifeKit
import LifeKitUI
import SwiftUI
import TempCodeClient
import TempCodeContract

/// One of a Work workspace's LifeOS views (milestone 47): LifeKitUI's Mail,
/// Tasks or Agenda, narrowed to the workspace's sector, inside the
/// workspace's `WorkLifeHost`. The screens keep LifeOS's own type ladder
/// (the approved phone-life page); their sheets and Start Thread are this
/// screen's.
struct LifeViewScreen: View {
    enum Kind: String, CaseIterable, Identifiable {
        case mail, tasks, agenda, projects
        var id: String { rawValue }
        var title: String { rawValue.capitalized }
        var symbol: String {
            switch self {
            case .mail: Symbol.mail
            case .tasks: Symbol.tasks
            case .agenda: Symbol.agenda
            case .projects: "folder"
            }
        }
    }

    @Environment(ShellNavigator.self) private var navigator
    @Bindable var host: WorkLifeHost
    let view: Kind

    var body: some View {
        Group {
            switch host.phase {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .unavailable(let words):
                ContentUnavailableView {
                    Label(words, systemImage: view.symbol)
                } actions: {
                    Button("Try Again") { Task { await host.prepare() } }
                }
            case .ready:
                if let store = host.store, let scene = host.scene {
                    screen
                        .foot()
                        .lifeChrome(store: store, scene: scene)
                        .environment(\.lifeSectors, host.sector.map { [$0] } ?? Sector.allCases)
                }
            }
        }
        .navigationTitle(view.title)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $host.sheet) { presented in
            if let store = host.store, let scene = host.scene {
                LifeSheetView(presented.sheet)
                    .sheetPage(facing: presented.side, size: presented.sheet.size)
                    .lifeChrome(store: store, scene: scene)
            }
        }
        .sheet(item: $host.starting) { chip in
            StartThreadSheet(host: host, chip: chip)
        }
        .onChange(of: host.started) {
            guard let session = host.started else { return }
            host.started = nil
            navigator.open(.thread(environmentId: host.client.environment.id, sessionId: session.id, seq: nil))
        }
        .task { await host.prepare() }
        .onAppear { ShownLifeHost.shared.host = host }
        .accessibilityIdentifier("life-\(view.rawValue)")
    }

    @ViewBuilder private var screen: some View {
        switch view {
        case .mail: MailScreen()
        case .tasks: TasksScreen()
        case .agenda: AgendaScreen()
        case .projects:
            // The workspace's sector's projects; a project pushes in the shell's own stack.
            if let sector = host.sector {
                ProjectsList(sector: sector)
                    .projectDestinations()
            } else {
                ContentUnavailableView("No Sector", systemImage: "folder")
            }
        }
    }
}

extension ContextChip: @retroactive Identifiable {
    public var id: String { ChipWords.line(self) }
}

/// Start Thread on a task, a mail or an event: the item as a chip in the box above his words.
/// Nothing runs until he presses Start.
struct StartThreadSheet: View {
    @Environment(\.dismiss) private var dismiss
    let host: WorkLifeHost
    let chip: ContextChip
    @State private var text = ""
    @State private var saving = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ItemChip(chip: chip)
                        .listRowSeparator(.hidden)
                    TextField("What should it do?", text: $text, axis: .vertical)
                        .lineLimit(3...12)
                        .focused($focused)
                        .accessibilityIdentifier("start-thread-text")
                } footer: {
                    if let error { Text(error).foregroundStyle(Tint.destructiveText) }
                }
            }
            .navigationTitle("New Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Start") { Task { await start() } }
                            .accessibilityIdentifier("start-thread-start")
                    }
                }
            }
            .onAppear {
                focused = true
                #if DEBUG
                // The work set: `TC_TEST_ACTION=start-thread` writes the words and presses Start.
                if TestHooks.action == "start-thread", TestHooks.once("start-thread") {
                    text = "Draft a reply that confirms the hold"
                    Task {
                        try? await Task.sleep(for: .seconds(3))
                        await start()
                    }
                }
                #endif
            }
        }
        .tcSheet(.form)
    }

    private func start() async {
        saving = true
        defer { saving = false }
        do {
            let session = try await host.client.work.startThread(workspaceId: host.workspaceId, about: chip, text: text.trimmingCharacters(in: .whitespacesAndNewlines))
            dismiss()
            host.started = session
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}

/// An item chip in a composer box: 28 pt, radius 8, the fill, the kind's glyph and its label.
struct ItemChip: View {
    let chip: ContextChip
    var onRemove: (() -> Void)?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: Self.symbol(chip.kind))
                .foregroundStyle(.secondary)
                .imageScale(.small)
            Text(chip.label)
                .textStep(.meta)
                .lineLimit(1)
            if let onRemove {
                Button("Remove", systemImage: "xmark", action: onRemove)
                    .labelStyle(.iconOnly)
                    .imageScale(.small)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 28)
        .background(Surface.fill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("item-chip")
    }

    static func symbol(_ kind: ContextChip.Kind) -> String {
        switch kind {
        case .task: Symbol.tasks
        case .mail: Symbol.mail
        case .event: Symbol.agenda
        case .project: "briefcase"
        case .person: "person"
        case .doc: "doc.text"
        case .item: "square.stack"
        case .held: "tray.and.arrow.up"
        case .routine: "clock"
        case .card: "rectangle.split.3x1"
        case .selection, .unknown: "text.quote"
        }
    }
}
