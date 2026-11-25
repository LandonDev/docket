import SwiftUI
import TempCodeClient
import TempCodeContract

/// One clash (docs/IOS-DESIGN.md "Work on the phone", ### A clash): a sheet on a phone, the detail on the open Duo
/// (`ClashOpen`). Its title says what is wrong ("Two things at once", "15 minutes short"), then each event with its
/// time, place and job and the ways out it allows, then the drive between them. This Is Fine quiets it until either
/// event changes (operate: it tells no one). Decline and Propose New Time go to other people: his press alone,
/// through the owner's check and the press record (`PressGates`, `PressLedger`), sent at once as the desktop sends.
struct ClashScreen: View {
    @Environment(AppModel.self) private var model
    let environmentId: String
    let clashId: String

    var body: some View {
        if let client = model.registry.client(environmentId) {
            ClashPage(client: client, clashId: clashId)
                .id("\(environmentId)|\(clashId)")
        } else {
            ContentUnavailableView("Clash Not Here", systemImage: "calendar.badge.exclamationmark", description: Text("Its computer is not paired with this iPhone."))
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct ClashPage: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let client: EnvironmentClient
    let clashId: String
    @State private var clash: ClashPhoneRow?
    @State private var read = false
    @State private var readError: String?
    @State private var drive: ClashMiles?
    @State private var step: Step?
    @State private var capsule: Capsule?
    @State private var waiving = false

    private var now: Double { Date().timeIntervalSince1970 * 1000 }

    struct Step: Identifiable, Hashable {
        let way: ClashRules.Way
        let side: ClashSide
        var id: String { "\(way.rawValue)|\(side.eventId)" }
    }

    struct Capsule: Equatable {
        let line: String
        /// The clash This Is Fine was pressed for: Undo takes it back even after the host's push has reloaded the page
        /// without it (a waived pair leaves the range).
        var waived: ClashPhoneRow?
        let id = UUID()
    }

    var body: some View {
        content
            .navigationTitle(clash.map(ClashRules.title) ?? "Clash")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: $step) { step in
                if let clash {
                    ClashAnswerSheet(client: client, clash: clash, step: step) { words in
                        show(Capsule(line: words))
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Group {
                    if let capsule {
                        UndoCapsule(line: capsule.line, identifier: "clash-undo", undo: capsule.waived.map { row in { Task { await unwaive(row) } } })
                    }
                }
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: Motion.travel * 3)))
            }
            .animation(Motion.base, value: capsule?.id)
            .task(id: capsule?.id) {
                guard capsule != nil else { return }
                try? await Task.sleep(for: .seconds(FleetToastCenter.lingerSeconds))
                if !Task.isCancelled { capsule = nil }
            }
            .task(id: client.work.clashesRev) { await load() }
            .refreshable { await load() }
            .accessibilityIdentifier("clash")
    }

    @ViewBuilder private var content: some View {
        if let clash {
            List {
                // A refresh that failed over a clash on screen: what shows is the last read, said once, with Retry.
                if readError != nil {
                    Section {
                        HStack(spacing: Layout.rowGap) {
                            Text("This clash did not refresh").textStep(.meta, tint: Tint.destructiveText)
                            Spacer(minLength: Layout.rowGap)
                            PillButton("Try Again") { Task { await load() } }
                        }
                    }
                }
                side(clash.a, clash: clash)
                side(clash.b, clash: clash)
                if let line = driveLine(clash) {
                    Section("Drive") { Text(line).textStep(.title) }
                }
                if client.work.may(.clashesWaive) {
                    Section {
                        Button("This Is Fine") { Task { await waive() } }
                            .disabled(waiving)
                            .accessibilityIdentifier("clash-fine")
                    }
                }
            }
            .listStyle(.insetGrouped)
        } else if let readError {
            // The first read failed: nothing is known of the clash, so it is never said to be gone.
            ContentUnavailableView {
                Label("Can’t Read This Clash", systemImage: "calendar.badge.exclamationmark")
            } description: {
                Text(readError)
            } actions: {
                Button("Try Again") { Task { await load() } }
            }
        } else if read {
            ContentUnavailableView("No Longer a Clash", systemImage: "checkmark.circle")
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// One event: its title, when, where and its job; then the ways out it allows, while it is ahead.
    private func side(_ side: ClashSide, clash: ClashPhoneRow) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 2) {
                Text(side.title).textStep(.title, weight: .semibold)
                Text(ClashRules.timeLine(side, calendar: .current)).textStep(.meta)
                if let place = side.location ?? side.place, !place.isEmpty { Text(place).textStep(.meta).lineLimit(2) }
            }
            .accessibilityElement(children: .combine)
            if side.endsAt > now, client.work.may(.clashesAnswer) {
                ForEach(ClashRules.ways(side), id: \.self) { way in
                    Button(way.label) { step = Step(way: way, side: side) }
                        .accessibilityIdentifier("clash-\(way.rawValue)")
                }
            }
        } header: {
            HStack(spacing: Layout.tagGap) {
                Circle().fill(Tint.sector(side.sector)).frame(width: Layout.dotSize, height: Layout.dotSize)
                Text(jobName(side))
            }
        }
    }

    private func driveLine(_ clash: ClashPhoneRow) -> String? {
        ClashRules.driveLine(minutes: clash.minutes, miles: clash.miles, measured: clash.measured)
            ?? drive.flatMap { ClashRules.driveLine(minutes: $0.minutes, miles: $0.miles, measured: $0.measured) }
    }

    private func jobName(_ side: ClashSide) -> String {
        client.workspaces.first { $0.id == side.workspaceId }?.name ?? TodayWords.sectorName(side.sector)
    }

    // MARK: - reads and presses

    private func load() async {
        let range = ClashRules.window(around: nil, now: now, calendar: .current)
        do {
            let list = try await client.work.clashes(from: range.from, to: range.to)
            clash = ClashRules.find(clashId, in: list.clashes, now: now)
            readError = nil
        } catch {
            readError = ActionError.wrap(error).message
        }
        read = true
        await readDrive()
    }

    /// An overlap carries no drive of its own: ask the host for the miles between the two places.
    private func readDrive() async {
        guard let clash, clash.minutes == nil, drive == nil, client.work.may(.clashesMiles),
              let workspaceId = clash.b.workspaceId ?? clash.a.workspaceId,
              clash.a.place != nil || clash.a.location != nil, clash.b.place != nil || clash.b.location != nil else { return }
        drive = try? await client.work.miles(workspaceId: workspaceId, from: clash.a.eventId, to: clash.b.eventId)
    }

    private func waive() async {
        guard let clash else { return }
        waiving = true
        defer { waiving = false }
        do {
            try await client.work.waive(clash, on: true)
            show(Capsule(line: "Marked fine", waived: clash))
        } catch {
            show(Capsule(line: ActionError.wrap(error).message))
        }
    }

    private func unwaive(_ row: ClashPhoneRow) async {
        capsule = nil
        do {
            try await client.work.waive(row, on: false)
            // The pair is back in the range: read it so the page shows the clash again.
            await load()
        } catch {
            show(Capsule(line: "Couldn’t undo"))
        }
    }

    private func show(_ next: Capsule) {
        capsule = next
    }
}

/// His answer to one event: a decline with an optional note, or a proposed time (filled with the first time the
/// drive allows). Send asks the owner's check, then goes once through the press record; a reply that never came
/// says so and keeps Send off.
private struct ClashAnswerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: EnvironmentClient
    let clash: ClashPhoneRow
    let step: ClashPage.Step
    let sent: (String) -> Void
    @State private var note = ""
    @State private var start = Date()
    @State private var end = Date()
    @State private var sending = false
    @State private var line: String?
    @State private var lost = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(step.side.title).textStep(.title, weight: .semibold)
                    Text(ClashRules.timeLine(step.side, calendar: .current)).textStep(.meta)
                } footer: {
                    Text(step.way.words)
                }
                if step.way == .propose {
                    Section("New Time") {
                        DatePicker("Starts", selection: $start)
                        DatePicker("Ends", selection: $end, in: start...)
                    }
                }
                Section {
                    TextField(step.way == .decline ? "Note to the organizer" : "Note", text: $note, axis: .vertical)
                        .lineLimit(2...6)
                } footer: {
                    if let line { Text(line).foregroundStyle(Tint.destructiveText) }
                }
            }
            .navigationTitle(step.way.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if sending {
                        ProgressView()
                    } else {
                        Button(step.way == .decline ? "Decline" : "Send") { Task { await send() } }
                            .disabled(lost)
                            .accessibilityIdentifier("clash-send")
                    }
                }
            }
            .onAppear {
                let offer = ClashRules.freeAfter(clash, eventId: step.side.eventId, now: Date().timeIntervalSince1970 * 1000, calendar: .current)
                start = Date(timeIntervalSince1970: offer.start / 1000)
                end = Date(timeIntervalSince1970: offer.end / 1000)
            }
        }
        .tcSheet(.form)
        .interactiveDismissDisabled(sending)
    }

    private func send() async {
        let from = start.timeIntervalSince1970 * 1000, to = end.timeIntervalSince1970 * 1000
        if step.way == .propose, let problem = ClashRules.timeProblem(start: from, end: to, now: Date().timeIntervalSince1970 * 1000) {
            line = problem
            return
        }
        let reason = step.way == .decline ? "Decline \(step.side.title)" : "Propose a new time for \(step.side.title)"
        // The key the owner's check passes for, carried to where the request leaves and the socket releases it.
        let key = PressGates.key(client.environment, revoked: client.work.keyRevoked)
        if let refused = await PressGates.shared.pass(client, .clashesAnswer, ref: ClashPress.ref(clash.id), rev: ClashPress.rev(clash), reason: reason) {
            line = refused
            return
        }
        sending = true
        defer { sending = false }
        do {
            _ = try await client.work.answer(clash, eventId: step.side.eventId, way: step.way, comment: note,
                                             start: step.way == .propose ? from : nil, end: step.way == .propose ? to : nil, key: key)
            sent(step.way.done(step.side.title))
            dismiss()
        } catch is PressLedger.Unknown {
            lost = true
            line = "The host did not confirm the send. Check the calendar before trying again."
        } catch {
            line = ActionError.wrap(error).message
        }
    }
}

/// Where a clash opens: the detail on the open Duo, a sheet on a phone (`ClashCenter`, drawn by `clashSheet()` on
/// the screens that open one).
@MainActor
enum ClashOpen {
    static func open(environmentId: String, clashId: String, pose: ShellPose, navigator: ShellNavigator) {
        if pose.isSplit {
            navigator.open(.clash(environmentId: environmentId, clashId: clashId))
        } else {
            ClashCenter.shared.target = ClashTarget(environmentId: environmentId, clashId: clashId)
        }
    }
}

struct ClashTarget: Identifiable, Hashable {
    let environmentId: String
    let clashId: String
    var id: String { "\(environmentId)|\(clashId)" }
}

@MainActor @Observable
final class ClashCenter {
    static let shared = ClashCenter()
    var target: ClashTarget?
}

private struct ClashSheetHost: ViewModifier {
    @Bindable var center = ClashCenter.shared

    func body(content: Content) -> some View {
        content.sheet(item: $center.target) { target in
            NavigationStack {
                ClashScreen(environmentId: target.environmentId, clashId: target.clashId)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Done") { center.target = nil } }
                    }
            }
            .presentationDetents([.medium, .large])
        }
    }
}

extension View {
    /// Draws the clash sheet a press on this screen asks for (a phone; the open Duo opens the detail).
    func clashSheet() -> some View {
        modifier(ClashSheetHost())
    }
}
