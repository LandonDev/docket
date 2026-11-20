import SwiftUI
import TempCodeClient
import UIKit

/// The voice note's few lengths (docs/IOS-DESIGN.md "Work on the phone").
private enum CaptureMetrics {
    /// The hold control: a thumb's width, so the press lands without aiming.
    static let button: CGFloat = 72
    /// Held, it grows past the thumb, so its edge shows around it.
    static let heldScale: CGFloat = 1.12
    static let labelGap: CGFloat = 8
    static let barPadding = EdgeInsets(top: 12, leading: Layout.textEdge, bottom: 12, trailing: Layout.textEdge)
    static let lines = 4...12
}

/// A voice note, from Home's microphone (docs/agents/work-capture.md "The
/// phone"): hold to talk, the words transcribed on the phone, a sector, Save.
/// It files through the first host with Work on whose LifeOS answers; the
/// draft is kept when the sheet closes or nothing can file it.
struct VoiceNoteSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss
    @Bindable var note: VoiceNote
    @State private var saved = 0

    private var hosts: [any CaptureHost] { model.registry.ordered.filter(\.work.isOn).map { $0.work } }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Note", text: $note.text, axis: .vertical)
                        .lineLimit(CaptureMetrics.lines)
                        .disabled(note.dictation.isBusy || note.saving)
                        .accessibilityIdentifier("voice-note-text")
                }
                Section {
                    Picker("Sector", selection: Binding(get: { note.sector }, set: { note.pick($0) })) {
                        Label { Text("Unsorted") } icon: { SectorDot(sector: nil) }
                            .tag(String?.none)
                        ForEach(Sectors.all, id: \.key) { sector in
                            Label { Text(sector.name) } icon: { SectorDot(sector: sector.key) }
                                .tag(String?.some(sector.key))
                        }
                    }
                    .accessibilityIdentifier("voice-note-sector")
                    Toggle("Start Thread", isOn: $note.start)
                } footer: {
                    if let error = note.error { Text(error).foregroundStyle(Tint.destructiveText) }
                }
            }
            .tcBottomBar {
                HoldToTalk(dictation: note.dictation, press: note.press, release: note.release)
                    .padding(CaptureMetrics.barPadding)
            }
            .navigationTitle("Voice Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if note.saving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(!note.canSave)
                            .accessibilityIdentifier("voice-note-save")
                    }
                }
            }
            .task { await note.find(hosts) }
        }
        .tcSheet(.form)
        // A swipe down mid-take would end it; the draft survives a close either way.
        .interactiveDismissDisabled(note.dictation.isBusy)
        .sensoryFeedback(.impact(weight: .light), trigger: saved)
        .onDisappear { note.dictation.cancel() }
    }

    private func save() async {
        guard let filed = await note.save(hosts) else { return }
        saved += 1
        // A thread that did not start: the sheet stays so the line can be read.
        guard note.error == nil else { return }
        dismiss()
        if let thread = filed.threadId, let host = note.hostId {
            navigator.open(.thread(environmentId: host, sessionId: thread, seq: nil))
        }
    }
}

/// The hold control and the one line under it. A press grows the circle at
/// once (the press is deliberate, so it eases out on the layout spring); the
/// microphone opening turns it red and starts the clock; the release snaps
/// back on `fast`. Under Reduce Motion the press dims instead of growing.
/// VoiceOver activates it once to start and again to stop.
private struct HoldToTalk: View {
    let dictation: Dictation
    let press: @MainActor () -> Void
    let release: @MainActor () -> Void
    @GestureState private var held = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var listening: Bool { dictation.phase == .listening }

    var body: some View {
        VStack(spacing: CaptureMetrics.labelGap) {
            ZStack {
                Circle().fill(listening ? Tint.destructive : Surface.fill)
                Image(systemName: "mic.fill")
                    .font(.title2)
                    .foregroundStyle(listening ? Color.white : Color.primary)
            }
            .frame(width: CaptureMetrics.button, height: CaptureMetrics.button)
            .scaleEffect(held && !reduceMotion ? CaptureMetrics.heldScale : 1)
            .opacity(held && reduceMotion ? Motion.pressDim : 1)
            .animation(held ? Motion.layout : Motion.fast, value: held)
            .animation(Motion.crossFade, value: listening)
            .contentShape(Circle())
            .gesture(DragGesture(minimumDistance: 0).updating($held) { _, state, _ in state = true })
            .onChange(of: held) { _, down in down ? press() : release() }
            .accessibilityElement()
            .accessibilityLabel(dictation.isBusy ? "Stop" : "Talk")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { dictation.isBusy ? release() : press() }
            .accessibilityIdentifier("voice-note-hold")
            line
                .frame(minHeight: Layout.rowHeight, alignment: .top)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .sensoryFeedback(.impact(weight: .light), trigger: listening) { _, now in now }
    }

    @ViewBuilder
    private var line: some View {
        switch dictation.phase {
        case .idle, .preparing:
            Text("Hold to Talk").textStep(.meta)
        case .listening:
            if let since = dictation.since { ElapsedText(since: since, step: .meta) }
        case .finishing:
            ProgressView().controlSize(.small)
        case .refused(.denied):
            VStack(spacing: CaptureMetrics.labelGap) {
                Text("Allow the microphone and speech recognition in Settings.").textStep(.meta)
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                .font(TextStep.meta.font.weight(.semibold))
            }
        case .refused:
            Text("This iPhone can’t transcribe speech on its own.").textStep(.meta)
        case .failed(let reason):
            Text(reason).textStep(.meta, tint: Tint.destructiveText)
        }
    }
}
