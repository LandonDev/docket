import SwiftUI
import TempCodeClient
import TempCodeContract

/// Save to TempCode (docs/IOS-DESIGN.md "Save to TempCode"): what he shared, the Work workspace it goes
/// to and the folder in it, then Save. The share extension shows it as its whole sheet; the app compiles
/// it too, for its proofs. It uses the tokens alone, since an extension links none of the app's screens.
struct ShareSheetView: View {
    @Bindable var model: ShareSheetModel
    let cancel: () -> Void
    let done: () -> Void
    @State private var path: [ShareFolder] = []
    @State private var saved = 0

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if model.picks.isEmpty {
                    ContentUnavailableView("Nothing to Save", systemImage: "doc", description: Text(model.unreadWords ?? ""))
                } else if model.ordered.isEmpty {
                    ContentUnavailableView("No Work Workspace", systemImage: "folder", description: Text("Turn Work on in TempCode and make a workspace."))
                } else {
                    form
                }
            }
            .navigationTitle("Save to TempCode")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Once Save is pressed the files are in the queue and the app sends what is left: Done alone closes.
                if model.phase == .picking && !model.picks.isEmpty {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
                }
                if model.picks.isEmpty || !model.ordered.isEmpty {
                    ToolbarItem(placement: .confirmationAction) { confirm }
                }
            }
            .navigationDestination(for: ShareFolder.self) { folder in
                ShareFolderList(model: model, folder: folder, path: $path)
            }
        }
        .sensoryFeedback(.success, trigger: saved)
        .onChange(of: model.phase) { _, phase in
            guard phase == .saved else { return }
            saved += 1
            // The check is read, then the sheet closes itself.
            Task {
                try? await Task.sleep(for: ShareMetrics.closeWait)
                done()
            }
        }
        .accessibilityIdentifier("share-sheet")
    }

    private var form: some View {
        List {
            if !model.earlier.isEmpty {
                Section {
                    ForEach(model.earlier) { item in
                        ShareRefusedRow(item: item, trying: model.trying.contains(item.id), retry: { Task { await model.retry(item) } }, discard: { model.discard(item) })
                            .swipeActions(edge: .trailing) {
                                Button("Discard", systemImage: "trash", role: .destructive) { model.discard(item) }
                            }
                    }
                } header: {
                    Text("Not saved")
                }
            }
            Section {
                what
            } footer: {
                let unread = model.unreadWords
                let refused = refusedWords
                if unread != nil || refused != nil {
                    VStack(alignment: .leading, spacing: 2) {
                        if let unread { Text(unread) }
                        if let refused { Text(refused).foregroundStyle(Tint.destructiveText) }
                    }
                }
            }
            Section {
                ForEach(model.ordered) { target in
                    Button { model.choose(target) } label: {
                        ShareWorkspaceRow(target: target, showsHost: model.severalHosts, checked: target.id == model.target?.id)
                    }
                    .accessibilityAddTraits(target.id == model.target?.id ? .isSelected : [])
                    .accessibilityIdentifier("share-workspace")
                }
            } header: {
                Text("Workspace")
            } footer: {
                if case .waiting(let words) = model.phase { Text(words) }
            }
            if let folder = model.folder, let target = model.target {
                Section {
                    NavigationLink(value: ShareFolder.top(name: target.workspace.folderName)) {
                        FolderLabel(name: folder.name)
                    }
                    .accessibilityIdentifier("share-folder")
                } header: {
                    Text("Folder")
                }
            }
        }
        .listStyle(.insetGrouped)
        .disabled(model.phase != .picking && model.earlier.isEmpty)
    }

    private var refusedWords: String? {
        if case .refused(let words) = model.phase { return words }
        return nil
    }

    /// One file: its picture or glyph, its name as a field, its size. Several: how many, and their pictures.
    @ViewBuilder
    private var what: some View {
        if let pick = model.picks.first, model.picks.count == 1 {
            HStack(spacing: 12) {
                PickMark(pick: pick)
                VStack(alignment: .leading, spacing: 2) {
                    TextField("Name", text: $model.name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("share-name")
                    Text(Int64(pick.size), format: .byteCount(style: .file)).textStep(.meta).monospacedDigit()
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text(ShareSummary.title(model.picks.map(\.kind)))
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.picks) { PickMark(pick: $0) }
                    }
                }
            }
        }
    }

    /// Save in its own place: the word, then a bar that follows the bytes, then a check. Done alone when
    /// nothing shared could be read.
    @ViewBuilder
    private var confirm: some View {
        if model.picks.isEmpty {
            Button("Done", action: done)
                .fontWeight(.semibold)
                .accessibilityIdentifier("share-done")
        } else {
            phaseConfirm
        }
    }

    @ViewBuilder
    private var phaseConfirm: some View {
        switch model.phase {
        case .picking:
            Button("Save") { Task { await model.save() } }
                .fontWeight(.semibold)
                .disabled(!model.canSave)
                .accessibilityIdentifier("share-save")
        case .saving(let share):
            ProgressView(value: share)
                .progressViewStyle(.linear)
                .frame(width: ShareMetrics.bar)
                .accessibilityLabel("Saving")
                .accessibilityIdentifier("share-progress")
        case .saved:
            Image(systemName: "checkmark")
                .fontWeight(.semibold)
                .foregroundStyle(.tint)
                .transition(.scale(scale: 0.25).combined(with: .opacity))
                .accessibilityLabel("Saved")
                .accessibilityIdentifier("share-saved")
        case .waiting, .refused:
            Button("Done", action: done)
                .fontWeight(.semibold)
                .accessibilityIdentifier("share-done")
        }
    }
}

/// The sheet's own sizes.
enum ShareMetrics {
    /// A file's picture or glyph in its row.
    static let mark: CGFloat = 44
    /// Save's progress bar, in the bar item's place.
    static let bar: CGFloat = 56
    /// How long the check shows before the sheet closes itself.
    static let closeWait: Duration = .milliseconds(700)
}

/// A workspace row: its sector's dot, its name, its host's when there are several, and a check on the chosen.
private struct ShareWorkspaceRow: View {
    let target: ShareTargets.Target
    let showsHost: Bool
    let checked: Bool
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        HStack(spacing: Layout.rowGap) {
            SectorDot(sector: target.workspace.sector)
                .frame(width: Layout.glyphWidth)
            VStack(alignment: .leading, spacing: 2) {
                // The label ink as a colour: `.primary` is hierarchical, and inside a Button it is the tint. A
                // colour overrides the list's disabled ink, so the row dims itself with the rest while it saves.
                Text(target.workspace.name).foregroundStyle(isEnabled ? Color.primary : Color.secondary)
                if showsHost { Text(target.host.name).textStep(.meta) }
            }
            Spacer(minLength: 8)
            if checked {
                Image(systemName: "checkmark")
                    .fontWeight(.semibold)
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
    }
}

/// A folder's row: the glyph in the secondary ink, as the Files screen's rows have it.
private struct FolderLabel: View {
    let name: String

    var body: some View {
        Label {
            Text(name)
        } icon: {
            Image(systemName: "folder").foregroundStyle(.secondary)
        }
    }
}

/// A file's picture, or the glyph of what it is.
private struct PickMark: View {
    let pick: SharePick

    var body: some View {
        Group {
            if let thumbnail = pick.thumbnail {
                Image(uiImage: thumbnail).resizable().scaledToFill()
            } else {
                Image(systemName: pick.kind == .video ? "film" : pick.kind == .photo ? "photo" : "doc")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Surface.fill)
            }
        }
        .frame(width: ShareMetrics.mark, height: ShareMetrics.mark)
        .clipShape(RoundedRectangle.rowCorner)
        .accessibilityHidden(true)
    }
}

/// A file an earlier save left refused: its name, the words that say why, Try Again, or Discard when no
/// retry can change the answer. The share sheet leads with these, and so does the workspace's Files screen
/// in the app (Work/ShareRefused.swift).
struct ShareRefusedRow: View {
    let item: ShareItem
    /// The file is on its way again: a spinner stands where Try Again was.
    var trying = false
    let retry: () -> Void
    let discard: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).lineLimit(1)
                Text(item.words ?? "The host did not take it.").textStep(.meta, tint: Tint.destructiveText)
            }
            Spacer(minLength: 8)
            if trying {
                ProgressView()
            } else if item.canRetry {
                Button("Try Again", action: retry)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            } else {
                Button("Discard", role: .destructive, action: discard)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .accessibilityIdentifier("share-earlier")
    }
}

/// One level of the folder picker: the folders inside a folder, read from the host as he goes. A tap on a
/// folder goes into it; Choose takes the folder shown.
private struct ShareFolderList: View {
    let model: ShareSheetModel
    let folder: ShareFolder
    @Binding var path: [ShareFolder]
    @State private var folders: [ShareFolder]?

    var body: some View {
        List {
            if let folders {
                if folders.isEmpty {
                    Text("No folders here").textStep(.meta).listRowSeparator(.hidden)
                }
                ForEach(folders, id: \.self) { child in
                    NavigationLink(value: child) { FolderLabel(name: child.name) }
                }
            } else if let failure = model.folderFailure {
                Text(failure).textStep(.meta).listRowSeparator(.hidden)
            } else {
                // The level is on its way: one row with a spinner, where the folders will be.
                HStack(spacing: Layout.rowGap) {
                    ProgressView()
                    Text("Reading \(folder.name)").textStep(.meta)
                }
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .navigationTitle(folder.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Choose") {
                    model.choose(folder)
                    path = []
                }
                .fontWeight(.semibold)
                .accessibilityIdentifier("share-choose-folder")
            }
        }
        .task { folders = await model.folders(inside: folder) }
        .accessibilityIdentifier("share-folders")
    }
}
