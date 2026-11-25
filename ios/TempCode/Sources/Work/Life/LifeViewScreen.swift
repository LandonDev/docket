import LifeKit
import LifeKitUI
import SwiftUI
import TempCodeClient
import TempCodeContract

/// One of a Work workspace's LifeOS views (milestone 47): LifeKitUI's Mail,
/// Tasks or Agenda, narrowed to the workspace's sector, inside the
/// workspace's `WorkLifeHost`; or one of the Work tab's places for every job
/// (`LifePlaceScreen`), inside the every-job host. The screens keep LifeOS's own type ladder
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
    @Environment(\.shellPose) private var pose
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
                        .environment(\.lifeSectors, host.sectors)
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
        .sheet(item: $host.asking) { draft in
            StartThreadSheet(host: host, chip: draft.chip, ask: draft)
        }
        .onChange(of: host.started) {
            guard let session = host.started else { return }
            host.started = nil
            navigator.open(.thread(environmentId: host.client.environment.id, sessionId: session.id, seq: nil))
        }
        // A nudge's thread, or the chat Ask found beside a mail.
        .onChange(of: host.opening) {
            guard let id = host.opening else { return }
            host.opening = nil
            navigator.open(.thread(environmentId: host.client.environment.id, sessionId: id, seq: nil))
        }
        // A project's document or sheet, in the hosted editor (M5b).
        .onChange(of: host.openingDocument) {
            guard let item = host.openingDocument else { return }
            host.openingDocument = nil
            // Pushed over the project's page in the detail, so Back returns to it.
            navigator.detailStack.append(Route.file(environmentId: host.client.environment.id, item: item, sessionId: nil))
        }
        .toolbar {
            if view == .mail, host.phase == .ready {
                // On the open Duo, Mail's two pages share one bar, and its own items already fill the trailing edge:
                // a fifth there is folded by the system into a second "…". Waiting On sits by the title instead.
                ToolbarItem(placement: pose.isSplit ? .topBarLeading : .primaryAction) {
                    Button("Waiting On", systemImage: host.waitingOn ? "hourglass.circle.fill" : Symbol.waiting) {
                        host.waitingOn.toggle()
                    }
                    .accessibilityAddTraits(host.waitingOn ? .isSelected : [])
                    .accessibilityIdentifier("mail-waiting-on")
                }
            }
        }
        // Agenda's clash lines and leave times, read again when the host's clashes move.
        .task(id: view == .agenda ? host.client.work.clashesRev : -1) {
            if view == .agenda { await host.loadMarks() }
        }
        .task { await host.prepare() }
        .onAppear { ShownLifeHost.shared.host = host }
        .accessibilityIdentifier("life-\(view.rawValue)")
    }

    @ViewBuilder private var screen: some View {
        switch view {
        case .mail:
            // Waiting on: mail he sent that no one answered, with Nudge and Dismiss (LifeKitUI's own screen).
            if host.waitingOn { MailWaitingScreen() } else { MailScreen() }
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
    /// Ask on a mail: the first send makes the chat beside it (`mailAdopt`), else an ordinary thread.
    var ask: AskDraft?
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
                    TextField(ask == nil ? "What should it do?" : "Ask about this mail", text: $text, axis: .vertical)
                        .lineLimit(3...12)
                        .focused($focused)
                        .accessibilityIdentifier("start-thread-text")
                } footer: {
                    if let error { Text(error).foregroundStyle(Tint.destructiveText) }
                }
            }
            .navigationTitle(ask == nil ? "New Thread" : "Ask")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button(ask == nil ? "Start" : "Ask") { Task { await start() } }
                            .disabled(ask != nil && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
            let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let session: SessionMeta
            if let ask {
                session = try await host.client.work.startMailChat(workspaceId: ask.workspaceId, mailThreadId: ask.mailThreadId, about: chip, text: words)
            } else {
                guard let workspaceId = host.startIn else { return }
                session = try await host.client.work.startThread(workspaceId: workspaceId, about: chip, text: words)
            }
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
    /// The chip's height grows with the text, from the strip's chip at the default size.
    @ScaledMetric(relativeTo: .footnote) private var height = StripMetrics.chip
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: Self.symbol(chip.kind))
                .foregroundStyle(.secondary)
                .imageScale(.small)
            Text(chip.label)
                .textStep(.meta)
                .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            if let onRemove {
                // The × reaches 44 pt around it without making the chip taller.
                Button("Remove", systemImage: "xmark", action: onRemove)
                    .labelStyle(.iconOnly)
                    .imageScale(.small)
                    .foregroundStyle(.secondary)
                    // The hit shape reaches 44 pt around the glyph; the layout keeps the glyph's own size, so the ×
                    // never overlaps the label at large sizes.
                    .contentShape(Rectangle().inset(by: -(Layout.rowHeight - StripMetrics.glyph) / 2))
            }
        }
        .padding(.horizontal, 8)
        .frame(minHeight: height)
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
        case .file: "doc"
        case .msform: "list.bullet.rectangle"
        case .item: "square.stack"
        case .held: "tray.and.arrow.up"
        case .routine: "clock"
        case .card: "rectangle.split.3x1"
        case .chat: "bubble.left.and.bubble.right"
        case .selection, .unknown: "text.quote"
        }
    }
}
