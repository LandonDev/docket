import PhotosUI
import SwiftUI
import TempCodeClient
import UniformTypeIdentifiers
import UIKit

/// Capture's few lengths (docs/IOS-DESIGN.md "Work on the phone").
private enum CaptureMetrics {
    /// The hold control: a thumb's width, so the press lands without aiming.
    static let button: CGFloat = 72
    /// Held, it grows past the thumb, so its edge shows around it.
    static let heldScale: CGFloat = 1.12
    static let labelGap: CGFloat = 8
    static let barPadding = EdgeInsets(top: 12, leading: Layout.textEdge, bottom: 12, trailing: Layout.textEdge)
    static let lines = 4...12
    /// A photo's picture in its row.
    static let thumb: CGFloat = 36
}

/// Capture (docs/agents/work-capture.md "The phone"): one sheet for a thought typed or said, a receipt, a
/// photo or a file. The words file through the first host with Work on whose LifeOS answers, as his own
/// quick add; a photo or a file is queued for the job's own folder through Save to TempCode's queue. Nothing
/// is sent to anyone, and a thread starts only when he turns Start Thread on and presses Save. The draft is
/// kept when the sheet closes or nothing can file it.
struct CaptureSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let mode: CaptureMode
    @Bindable var note: VoiceNote
    let openThread: (_ environmentId: String, _ sessionId: String) -> Void
    @State private var picks: [SharePick] = []
    @State private var photos: [PhotosPickerItem] = []
    @State private var importing = false
    /// Picks still being copied in from Photos or Files.
    @State private var reading = 0
    /// Picks that would not copy in: told in the footer, never a hold on Save.
    @State private var unread: [String] = []
    /// Picks the last Save could not queue: they stay in the sheet, and only they stop that Save before the note.
    @State private var unqueued: Set<SharePick.ID> = []
    /// The job he chose for the files (`ShareTargets.Target.id`); nil follows the note's sector.
    @State private var job: String?
    @State private var targets: [ShareTargets.Target] = []
    @State private var saving = false
    @State private var queued: String?
    /// Why the files could not be picked, or queued, at all.
    @State private var filesError: String?
    @State private var landed = 0
    @FocusState private var typing: Bool

    private var clients: [EnvironmentClient] { model.registry.ordered }
    /// Only a host whose key may file one (`work.capture.file`, operate).
    private var hosts: [any CaptureHost] { clients.filter { $0.work.isOn && $0.work.may(.captureFile) }.map { $0.work } }
    private var receipts: Bool { ReceiptFlow.available && clients.contains { $0.work.isOn && $0.work.may(.moneyReceive) } }
    private var target: ShareTargets.Target? { CaptureRules.job(picked: job, sector: note.sector, targets: targets) }
    private var draft: CaptureRules.Draft {
        CaptureRules.Draft(hasWords: note.hasWords, files: picks.count, job: target?.id, busy: saving || note.saving || note.dictation.isBusy || reading > 0)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Note", text: $note.text, axis: .vertical)
                        .lineLimit(CaptureMetrics.lines)
                        .focused($typing)
                        .disabled(note.dictation.isBusy || note.saving)
                        .accessibilityIdentifier("capture-text")
                }
                Section {
                    Picker("Job", selection: Binding(get: { note.sector }, set: { note.pick($0) })) {
                        Label { Text("Unsorted") } icon: { SectorDot(sector: nil) }
                            .tag(String?.none)
                        ForEach(Sectors.all, id: \.key) { sector in
                            Label { Text(sector.name) } icon: { SectorDot(sector: sector.key) }
                                .tag(String?.some(sector.key))
                        }
                    }
                    .accessibilityIdentifier("capture-sector")
                    Toggle("Start Thread", isOn: $note.start)
                } footer: {
                    if let error = note.error { Text(error).foregroundStyle(Tint.destructiveText) }
                }
                if !picks.isEmpty || reading > 0 || queued != nil || !unread.isEmpty || filesError != nil {
                    filesSection
                }
                Section {
                    if receipts {
                        Button("Scan Receipt", systemImage: "doc.viewfinder") { CaptureDesk.shared.scanReceipt() }
                            .accessibilityIdentifier("capture-receipt")
                    }
                    if !targets.isEmpty {
                        PhotosPicker(selection: $photos, matching: .images, photoLibrary: .shared()) {
                            Label("Add Photos", systemImage: "photo.on.rectangle")
                        }
                        .accessibilityIdentifier("capture-photos")
                        Button("Add Files", systemImage: "doc") { importing = true }
                            .accessibilityIdentifier("capture-files")
                    }
                }
                .disabled(saving)
                // In the form's flow, under the rows, never floating over them: at a large text size the Job row stays
                // whole and the button scrolls with the rest.
                Section {
                    HoldToTalk(dictation: note.dictation, press: note.press, release: note.release)
                        .padding(CaptureMetrics.barPadding)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            .navigationTitle("Capture")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving || note.saving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(CaptureRules.plan(draft) == nil)
                            .accessibilityIdentifier("capture-save")
                    }
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                // A picker that failed says so in the files' footer, as a file that would not copy does.
                switch result {
                case .success(let urls):
                    filesError = nil
                    take(urls)
                case .failure:
                    filesError = "Could not read the files you picked."
                }
            }
            .onChange(of: photos) { _, items in
                guard !items.isEmpty else { return }
                photos = []
                take(items)
            }
            .task {
                targets = ShareBridge.targets(model.registry, earlier: ShareInbox.groupRoot().map { ShareTargets.read(root: $0) } ?? ShareTargets()).ordered
                // "Capture" opens ready to type; "Voice Note" leaves the keyboard down so the hold is under the thumb.
                if mode == .typed { typing = true }
                await note.find(hosts)
            }
        }
        .tcSheet(.editor)
        // A swipe down mid-take would end it; a draft survives a close either way.
        .interactiveDismissDisabled(note.dictation.isBusy || saving)
        .sensoryFeedback(.success, trigger: landed)
        .onDisappear { note.dictation.cancel() }
    }

    /// The photos and files he added, the job they go to, and what became of them.
    private var filesSection: some View {
        Section {
            ForEach(picks) { pick in
                PickRow(pick: pick)
                    .swipeActions { Button("Remove", systemImage: "minus.circle", role: .destructive) { picks.removeAll { $0.id == pick.id } } }
            }
            if reading > 0 {
                ProgressView().frame(maxWidth: .infinity)
            }
            if !picks.isEmpty, targets.count > 1 {
                Picker("Job", selection: Binding(get: { target?.id }, set: { job = $0 })) {
                    ForEach(targets) { target in
                        Label { Text(target.workspace.name) } icon: { SectorDot(sector: target.workspace.sector) }
                            .tag(String?.some(target.id))
                    }
                }
                .accessibilityIdentifier("capture-job")
            }
        } footer: {
            if let filesError {
                Text(filesError).foregroundStyle(Tint.destructiveText)
            } else if let line = CaptureRules.failedLine(unpicked: unread, unqueued: picks.filter { unqueued.contains($0.id) }.map(\.name), files: picks.count) {
                Text(line).foregroundStyle(Tint.destructiveText)
            } else if let queued {
                Text(queued)
            } else if !picks.isEmpty, targets.count == 1, let target {
                Text("To \(target.workspace.name).")
            }
        }
    }

    // MARK: Picks

    private func take(_ urls: [URL]) {
        for url in urls {
            reading += 1
            Task {
                defer { reading -= 1 }
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                if let copy = PickedFile.copy(url) {
                    picks.append(SharePick(url: copy, name: url.lastPathComponent, size: PickedFile.size(copy), kind: .file, thumbnail: nil))
                    // Picked again and copied: its earlier failure is over.
                    if let failed = unread.firstIndex(of: url.lastPathComponent) { unread.remove(at: failed) }
                } else {
                    unread.append(url.lastPathComponent)
                }
            }
        }
    }

    private func take(_ items: [PhotosPickerItem]) {
        for item in items {
            reading += 1
            Task {
                defer { reading -= 1 }
                if let file = try? await item.loadTransferable(type: PickedFile.self) {
                    picks.append(SharePick(url: file.url, name: file.url.lastPathComponent, size: PickedFile.size(file.url), kind: .photo, thumbnail: SharePickThumbnail.of(file.url)))
                } else {
                    unread.append("a photo")
                }
            }
        }
    }

    // MARK: Save

    /// Files first (into the durable queue, then sent by the app's drain), then the words. A note that fails
    /// keeps the sheet up with its reason; the files already queued go either way and leave the sheet.
    private func save() async {
        guard let plan = CaptureRules.plan(draft) else { return }
        saving = true
        defer { saving = false }
        if plan.files, let target {
            guard let root = ShareInbox.groupRoot() else {
                filesError = "This phone could not keep the files."
                return
            }
            let inbox = ShareInbox(root: root)
            let destination = target.destination(.top(name: target.workspace.folderName))
            var kept: [SharePick.ID] = []
            for (index, pick) in picks.enumerated() {
                let name = ShareSummary.name(pick.name, kind: pick.kind, at: Date().addingTimeInterval(Double(index)))
                if (try? inbox.add(pick.url, to: destination, name: name)) != nil { kept.append(pick.id) }
            }
            if !kept.isEmpty {
                var known = ShareTargets.read(root: root)
                known.used(hostId: target.host.id, workspaceId: target.workspace.id, folder: destination.folder, at: Date().timeIntervalSince1970 * 1000)
                try? known.write(root: root)
                queued = CaptureRules.queuedLine(kept.count, job: target.workspace.name)
                landed += 1
                let registry = model.registry
                Task { await ShareBridge.drain(registry) }
            }
            // Only this press's queue failures hold the note back; a pick that failed earlier stays in the footer.
            unqueued = Set(picks.map(\.id)).subtracting(kept)
            picks.removeAll { kept.contains($0.id) }
            guard unqueued.isEmpty else { return }
        }
        guard plan.note else {
            dismiss()
            return
        }
        guard let filed = await note.save(hosts) else { return }
        landed += 1
        // A thread that did not start: the sheet stays so the line can be read.
        guard note.error == nil else { return }
        dismiss()
        if let thread = filed.threadId, let host = note.hostId { openThread(host, thread) }
    }
}

/// A photo or file he added: its picture or glyph, its name, its size.
private struct PickRow: View {
    let pick: SharePick

    var body: some View {
        HStack(spacing: Layout.rowGap) {
            if let thumbnail = pick.thumbnail {
                Image(uiImage: thumbnail)
                    .resizable()
                    .scaledToFill()
                    .frame(width: CaptureMetrics.thumb, height: CaptureMetrics.thumb)
                    .clipShape(.rect(cornerRadius: Radius.row))
            } else {
                Image(systemName: "doc")
                    .foregroundStyle(.secondary)
                    .frame(width: CaptureMetrics.thumb)
            }
            Text(pick.name).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            Text(FilesRules.size(Int64(pick.size))).textStep(.stamp)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A photo from the library, or a file from Files, copied into a folder of its own while the other app lends
/// it, so the queue reads it after the picker has gone.
nonisolated struct PickedFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            guard let url = copy(received.file) else { throw CocoaError(.fileReadUnknown) }
            return PickedFile(url: url)
        }
    }

    static func copy(_ file: URL) -> URL? {
        let folder = FileManager.default.temporaryDirectory.appending(path: "capture-\(UUID().uuidString)", directoryHint: .isDirectory)
        let url = folder.appending(path: file.lastPathComponent)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: file, to: url)
            return url
        } catch {
            return nil
        }
    }

    static func size(_ url: URL) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.intValue ?? 0
    }
}

/// The one Capture sheet over every tab, opened through `CaptureDesk` (the bar's `plus`, an App Shortcut), and
/// the receipt camera it hands over to. The voice note and the receipt queue are made at the first open and
/// kept, so a draft outlives the sheet.
struct CaptureSheetHost: ViewModifier {
    @Environment(AppModel.self) private var model
    @Bindable private var desk = CaptureDesk.shared
    @State private var kept = CaptureKept()
    @State private var receipt = ReceiptFlow()
    let openThread: (_ environmentId: String, _ sessionId: String) -> Void

    func body(content: Content) -> some View {
        content
            .sheet(item: $desk.shown, onDismiss: { if desk.closed() { receipt.press() } }) { mode in
                CaptureSheet(mode: mode, note: kept.note, openThread: openThread)
            }
            .receiptFlow(receipt)
            #if DEBUG
            .task(id: model.ready) {
                guard model.ready, let sheet = TestHooks.sheet, ["capture", "voice-note", "receipt"].contains(sheet) else { return }
                try? await Task.sleep(for: .seconds(2))
                switch sheet {
                case "receipt": receipt.openForProof()
                case "voice-note": desk.open(.voice)
                default: desk.open(.typed)
                }
            }
            #endif
    }
}

/// The voice note, made once on first use (it holds the speech recognizer). Not observed: the sheet observes
/// the note itself.
@MainActor private final class CaptureKept {
    private(set) lazy var note = VoiceNote(source: OnDeviceSpeech())
}

/// The bar's `plus` on the Work list and Today: opens Capture ready to type. Drawn only where some host's key
/// may file a note, receive a receipt or take a file (KeyMay): never a press the host refuses.
struct CaptureButton: View {
    var body: some View {
        Button("Capture", systemImage: "plus") { CaptureDesk.shared.open(.typed) }
            .accessibilityIdentifier("capture")
    }

    static func offered(_ clients: [EnvironmentClient]) -> Bool {
        clients.contains { $0.work.isOn && ($0.work.may(.captureFile) || $0.work.may(.moneyReceive) || $0.work.may(.filesUpload)) }
    }
}

/// The hold control and the one line under it. A press grows the circle at
/// once (the press is deliberate, so it eases out on the layout spring); the
/// microphone opening turns it red and starts the clock; the release snaps
/// back on `fast`. Under Reduce Motion the press dims instead of growing.
/// VoiceOver activates it once to start and again to stop.
struct HoldToTalk: View {
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
                    .foregroundStyle(listening ? Tint.onDestructive : Color.primary)
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
