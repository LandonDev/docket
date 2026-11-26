import SwiftUI
import TempCodeClient
import TempCodeContract

/// Every computer this phone is signed in to: name, connection dot and its
/// state, each row pushing its detail. Adding one is a
/// sheet; signing in again and forgetting are on the detail, and also a
/// swipe and a long press here.
struct HostsView: View {
    /// The detail stack: rows push `HostDetailRoute` onto it, and so does the
    /// proof's hook, so the detail is one screen however it is reached.
    @Environment(ShellNavigator.self) private var navigator
    @Environment(AppModel.self) private var model
    @State private var adding = false
    @State private var pairingAgain: PairedEnvironment?
    @State private var forgetting: PairedEnvironment?
    /// DEBUG: the proof's hooks fire once, not again when Computers reappears after Back.
    @State private var hooksFired = false

    var body: some View {
        // The computers; each one relayed through another sits under it (the hook below), never listed twice.
        let clients = model.registry.ordered.filter { !$0.environment.isRelayed }
        List {
            Section {
                ForEach(clients, id: \.environment.id) { client in
                    NavigationLink(value: HostDetailRoute(environmentId: client.environment.id)) {
                        HostRow(client: client)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        // No destructive role here: a destructive swipe action slides the row
                        // out at once, and this one only asks.
                        Button("Forget", systemImage: "trash") { forgetting = client.environment }
                            .tint(Tint.destructive)
                        Button("Sign In Again", systemImage: "key") { pairingAgain = client.environment }
                            .tint(Tint.warning)
                    }
                    .contextMenu {
                        Button("Sign In Again", systemImage: "key") { pairingAgain = client.environment }
                        Button("Forget", systemImage: "trash", role: .destructive) { forgetting = client.environment }
                    }
                    .accessibilityIdentifier("environment-row")
                    // Thread 29: the computers reached through this one (the Mac through the box).
                    ForEach(model.registry.relayed(via: client.environment.id), id: \.environment.id) { relayed in
                        NavigationLink(value: HostDetailRoute(environmentId: relayed.environment.id)) {
                            RelayedHostRow(client: relayed, carrierName: client.environment.name)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if clients.isEmpty {
                ContentUnavailableView {
                    Label("No Computers", systemImage: "desktopcomputer")
                } description: {
                    Text("Sign this phone in to a computer to see its threads here.")
                } actions: {
                    Button("Add a Computer") { adding = true }
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .navigationTitle("Computers")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Add a Computer", systemImage: "plus") { adding = true }
            }
        }
        .sheet(isPresented: $adding) { AddEnvironmentSheet() }
        .sheet(item: $pairingAgain) { AddEnvironmentSheet(replacing: $0) }
        .forgetHostDialog(host: $forgetting) { id in
            await forgetHost(id, registry: model.registry)
        }
        .onAppear {
            #if DEBUG
            guard !hooksFired else { return }
            hooksFired = true
            if TestHooks.sheet == "pair" || TestHooks.sheet == "pair-error" { adding = true }
            if TestHooks.open == "host", let first = clients.first {
                // The same push a row's tap makes.
                navigator.detailStack.append(HostDetailRoute(environmentId: first.environment.id))
            }
            #endif
        }
    }
}

/// A computer's detail, pushed from its row.
struct HostDetailRoute: Hashable {
    let environmentId: String
}

/// A computer: the dot, its name, and its state in a word or two under it;
/// how far it runs behind trailing when it does. Its address and id are on
/// its detail (the council's round 1: no raw id or address on the list).
struct HostRow: View {
    let client: EnvironmentClient

    var body: some View {
        let status = client.status
        let line = second(status)
        HStack(spacing: Layout.rowGap) {
            ConnectionDot(status: status, relay: client.relayState)
                .frame(width: Layout.markWidth)
                // The second line says the state; the dot's label would say it again.
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(client.environment.name)
                    .lineLimit(1)
                // The meta step's footnote; destructive only when the state
                // waits on the person, else the step's own secondary.
                ZStack(alignment: .leading) {
                    Text(line)
                        .font(TextStep.meta.font)
                        .foregroundStyle(HostFix.waitsOnUser(status) ? AnyShapeStyle(Tint.destructive) : AnyShapeStyle(HierarchicalShapeStyle.secondary))
                        .lineLimit(1)
                        .id(line)
                        .swapTransition()
                }
            }
            .layoutPriority(1)
            Spacer(minLength: Layout.rowGap)
            DriftMark(client: client)
        }
        .padding(.vertical, 2)
        .animation(Motion.crossFade, value: line)
        .accessibilityElement(children: .combine)
    }

    /// The state in its short word, "Connected" too: the address and the id are the detail's, never the list's.
    private func second(_ status: EnvironmentStatus) -> String {
        ConnectionWord.text(for: status)
    }
}

/// One computer in full: its state and the action that fixes it, what it is
/// doing (thread 21's sections), what this phone's key may do there, its
/// facts, then Sign In Again and Forget.
struct HostDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let environmentId: String
    @State private var pairingAgain: PairedEnvironment?
    @State private var forgetting: PairedEnvironment?
    @State private var name = ""

    var body: some View {
        let client = model.registry.client(environmentId)
        Group {
            if let client, client.environment.isRelayed, let carrier = model.registry.carrier(of: client.environment.id) {
                // Thread 29: a relayed computer's detail borrows its carrier's key and has no fix of its own.
                RelayedHostDetailView(client: client, carrier: carrier.environment)
            } else if let client {
                detail(client)
            } else {
                // Forgotten while on screen: the list behind is already without it.
                Color.clear.onAppear { dismiss() }
            }
        }
        .navigationTitle(client?.environment.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        // iOS 27 sometimes drops the title of a pushed destination whose body swaps
        // views; the principal item draws it either way (the title stays for the back button).
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(client?.environment.name ?? "")
                    .font(.headline)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
            }
            // A title has no vertical form: the Duo's rail never stands it up.
            .horizontalOnly()
        }
    }

    @ViewBuilder
    private func detail(_ client: EnvironmentClient) -> some View {
        let environment = client.environment
        let status = client.status
        let push = model.registry.push
        List {
            // 1. Status: the state, the one action that fixes it, and why.
            Section {
                HStack(spacing: Layout.rowGap) {
                    ConnectionDot(status: status, relay: client.relayState)
                        .frame(width: Layout.markWidth)
                        .accessibilityHidden(true)
                    ConnectionStatusText(name: environment.name, status: status)
                        .lineLimit(2)
                    Spacer(minLength: Layout.rowGap)
                    if status.transport == .connecting {
                        ProgressView()
                            .controlSize(.small)
                            .transition(.opacity)
                    }
                }
                .animation(Motion.crossFade, value: status.transport)
                .accessibilityIdentifier("host-status")
                if let fix = HostFix.fix(for: status) {
                    Button(fix.title) {
                        switch fix {
                        case .retry:
                            Task { await client.retry() }
                        case .pairAgain:
                            pairingAgain = environment
                        }
                    }
                }
            } footer: {
                if let explanation = HostFix.explanation(for: status) {
                    Text(explanation)
                }
            }

            // 2. Activity: what the computer is doing (Shell/Hosts/, thread 21).
            HostActivitySections(client: client)

            // 3. This phone may: the four levels of the desktop's "It may", said of whom (the council's round 3), the key's own checked, then the setup rights a key
            // holds beside its level.
            Section {
                let level = KeyRights.of(environment.caps)
                ForEach(KeyRights.allCases, id: \.self) { rights in
                    rightsRow(title: rights.title(computer: environment.name), detail: rights.detail(computer: environment.name), held: rights == level)
                }
                ForEach(Capability.extras(holding: environment.caps), id: \.rawValue) { capability in
                    rightsRow(title: capability.title, detail: capability.detail, held: true)
                }
            } header: {
                Text("This phone may")
            } footer: {
                Text("What \u{201C}\(environment.keyName)\u{201D} may do on \(environment.name). To change it, sign in again with a new link.")
            }

            // 4. Computer: its facts.
            Section {
                LabeledContent("Name") {
                    TextField("Name", text: $name)
                        .multilineTextAlignment(.trailing)
                        .submitLabel(.done)
                        .onSubmit { rename(environment) }
                }
                LabeledContent("Address", value: environment.host)
                LabeledContent("ID") {
                    Text(environment.id)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                // Older computers send no build; the row shows only when the hello carried one.
                if let build = status.lastHello?.build {
                    LabeledContent("Version") {
                        Text(HostBuildLine.text(build))
                            .monospacedDigit()
                    }
                }
                if let hello = status.lastHello {
                    LabeledContent("Contract", value: "\(hello.contract)")
                }
                LabeledContent("Notifications", value: HostPushWord.text(enabled: push.enabled, failure: push.failures[environment.id], status: push.statuses[environment.id]))
                LabeledContent("Signed In", value: Date(timeIntervalSince1970: environment.addedAt / 1000), format: .dateTime.day().month().year())
            } header: {
                Text("Computer")
            } footer: {
                Text("The name is this phone's own for it.")
            }

            // 5. Sign In Again and Forget.
            Section {
                Button("Sign In Again") { pairingAgain = environment }
                    .accessibilityIdentifier("pair-again")
                Button("Forget This Computer", role: .destructive) { forgetting = environment }
                    .accessibilityIdentifier("forget-host")
            }
        }
        .listStyle(.insetGrouped)
        .background { ActivityPollers(client: client) } // the Activity sections' loops, outlive any row (Shell/Hosts)
        .scrollDismissesKeyboard(.interactively)
        .sheet(item: $pairingAgain) { AddEnvironmentSheet(replacing: $0) }
        .forgetHostDialog(host: $forgetting) { id in
            await forgetHost(id, registry: model.registry)
        }
        .onAppear { name = environment.name }
        .onDisappear { rename(environment) }
    }

    /// One level of "This phone may", or a setup right: its words, dim when the key does not hold it, and a check when it does.
    private func rightsRow(title: String, detail: String, held: Bool) -> some View {
        HStack(spacing: Layout.rowGap) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .foregroundStyle(held ? Color.primary : Color.secondary)
                Text(detail)
                    .font(TextStep.meta.font)
                    .foregroundStyle(held ? AnyShapeStyle(HierarchicalShapeStyle.secondary) : AnyShapeStyle(HierarchicalShapeStyle.tertiary))
            }
            Spacer(minLength: Layout.rowGap)
            Image(systemName: "checkmark")
                .font(.body.weight(.semibold))
                .foregroundStyle(.tint)
                .opacity(held ? 1 : 0)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(held ? .isSelected : [])
    }

    /// This phone's name for the computer; an emptied field gives it its own name back.
    private func rename(_ environment: PairedEnvironment) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed != environment.name else { return }
        model.registry.rename(environment.id, to: trimmed)
    }
}

/// The detail's status row: the connection in the desktop's sentence
/// (`ConnectionSentence`), its countdown ticking each second with rolling
/// digits while there is one.
struct ConnectionStatusText: View {
    let name: String
    let status: EnvironmentStatus

    var body: some View {
        if ConnectionSentence.ticks(status) {
            Tick(every: 1) { tick in
                let text = ConnectionSentence.text(name: name, status: status, now: tick)
                Text(text)
                    .numeric(text)
            }
        } else {
            Text(ConnectionSentence.text(name: name, status: status, now: .now))
        }
    }
}

/// Forgetting is confirmed: a confirmation dialog naming the computer, with
/// the destructive action and what it means. Shared by the list and the
/// detail; `forget` is the package's `forgetHost`, which unregisters push on
/// the computer first.
private struct ForgetHostDialog: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var host: PairedEnvironment?
    let forget: (String) async -> Void

    func body(content: Content) -> some View {
        content.confirmationDialog(
            host.map { "Forget \u{201C}\($0.name)\u{201D}?" } ?? "Forget this computer?",
            isPresented: Binding(get: { host != nil }, set: { if !$0 { host = nil } }),
            titleVisibility: .visible,
            presenting: host
        ) { environment in
            Button("Forget", role: .destructive) {
                Task { await forget(environment.id) }
            }
        } message: { environment in
            // Thread 29: the computers relayed through this one go with it, by name.
            Text(forgetCopy(carrier: environment.name, relayed: model.registry.relayed(via: environment.id).map(\.environment.name)))
        }
    }
}

extension View {
    func forgetHostDialog(host: Binding<PairedEnvironment?>, forget: @escaping (String) async -> Void) -> some View {
        modifier(ForgetHostDialog(host: host, forget: forget))
    }
}
