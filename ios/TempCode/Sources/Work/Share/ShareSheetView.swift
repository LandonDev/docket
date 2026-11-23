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
                if model.ordered.isEmpty {
                    ContentUnavailableView("No Work Workspace", systemImage: "folder", description: Text("Turn Work on in TempCode and make a workspace. Then you can save files into it from here."))
                } else {
                    form
                }
            }
            .navigationTitle("Save to TempCode")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                        .disabled(model.phase == .saved)
                }
                ToolbarItem(placement: .confirmationAction) { confirm }
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
                try? await Task.sleep(for: .milliseconds(700))
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
                        ShareRefusedRow(item: item) { Task { await model.retry(item) } }
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
                if case .refused(let words) = model.phase { Text(words).foregroundStyle(Tint.destructiveText) }
            }
            Section {
                ForEach(model.ordered) { target in
                    Button { model.choose(target) } label: {
                        HStack(spacing: Layout.rowGap) {
                            SectorDot(sector: target.workspace.sector)
                                .frame(width: Layout.glyphWidth)
                            VStack(alignment: .leading, spacing: 2) {
                                // The label ink as a colour: `.primary` is hierarchical, and inside a Button it is the tint.
                                Text(target.workspace.name).foregroundStyle(Color.primary)
                                if model.severalHosts { Text(target.host.name).textStep(.meta) }
                            }
                            Spacer(minLength: 8)
                            if target.id == model.target?.id {
                                Image(systemName: "checkmark")
                                    .fontWeight(.semibold)
                                    .foregroundStyle(.tint)
                                    .accessibilityHidden(true)
                            }
                        }
                        .contentShape(Rectangle())
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
                        Label(folder.name, systemImage: "folder")
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

    /// Save in its own place: the word, then a bar that follows the bytes, then a check.
    @ViewBuilder
    private var confirm: some View {
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

/// A file an earlier save left refused: its name, the host's words, Try Again. The share sheet leads with
/// these, and so does the workspace's Files screen in the app (Work/ShareRefused.swift).
struct ShareRefusedRow: View {
    let item: ShareItem
    /// The file is on its way again: a spinner stands where Try Again was.
    var trying = false
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).lineLimit(1)
                Text(item.words ?? "The host did not take it.").textStep(.meta, tint: Tint.destructiveText)
            }
            Spacer(minLength: 8)
            if trying {
                ProgressView()
            } else {
                Button("Try Again", action: retry)
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
                    NavigationLink(value: child) { Label(child.name, systemImage: "folder") }
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
