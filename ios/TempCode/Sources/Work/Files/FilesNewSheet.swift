import PhotosUI
import SwiftUI
import TempCodeClient
import TempCodeContract
import UniformTypeIdentifiers

/// New in the folder shown (docs/IOS-DESIGN.md "Files"): a Document, a Sheet or a Folder under the name he
/// types (the kind's "Untitled …" when he types none), one made from the job's templates with its fields filled
/// (M5b, `work.templates.make` into this folder), and Upload from Photos or Files into the same folder.
/// Each part shows only where the place does it; what the host refuses shows its sentence under the field.
struct FilesNewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: EnvironmentClient
    let workspaceId: String
    let place: FilePlace
    let at: FolderRef
    @State private var kind: Methods.WorkFilesMake.Params.Kind = .document
    @State private var name = ""
    @State private var making = false
    @State private var error: String?
    @State private var photo: PhotosPickerItem?
    @State private var importing = false
    /// The job's shelf, read once the sheet opens (nil: reading or not offered).
    @State private var templates: [TemplatePhone]?

    private var files: FilesHost { client.work.files }
    private var canMake: Bool { FilesRules.offers(place, .make, caps: files.caps) }
    private var canUpload: Bool { FilesRules.offers(place, .upload, caps: files.caps) }

    static func offers(_ place: FilePlace, caps: FilesRules.Caps) -> Bool {
        FilesRules.offers(place, .make, caps: caps) || FilesRules.offers(place, .upload, caps: caps)
    }

    var body: some View {
        NavigationStack {
            Form {
                if canMake {
                    Section {
                        Picker("Kind", selection: $kind) {
                            Text("Document").tag(Methods.WorkFilesMake.Params.Kind.document)
                            Text("Sheet").tag(Methods.WorkFilesMake.Params.Kind.sheet)
                            Text("Folder").tag(Methods.WorkFilesMake.Params.Kind.folder)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("files-new-kind")
                        TextField(FilesRules.untitled(kind), text: $name)
                            .submitLabel(.done)
                            .onSubmit { Task { await make() } }
                            .accessibilityIdentifier("files-new-name")
                    } footer: {
                        if let error { Text(error).foregroundStyle(Tint.destructiveText) }
                    }
                }
                if canMake, let templates, !templates.isEmpty {
                    Section("From a Template") {
                        ForEach(templates, id: \.id) { template in
                            NavigationLink {
                                TemplateFillView(work: client.work, workspaceId: workspaceId, at: at, template: template) { made in
                                    FleetToastCenter.shared.post(note: TemplateFill.madeWords(made))
                                    dismiss()
                                }
                            } label: {
                                Label(template.name, systemImage: TemplateFill.glyph(template.kind))
                            }
                            .accessibilityIdentifier("files-new-template")
                        }
                    }
                }
                if canUpload {
                    Section("Upload") {
                        PhotosPicker(selection: $photo, matching: .any(of: [.images, .videos])) {
                            Label("From Photos", systemImage: "photo.on.rectangle")
                        }
                        .accessibilityIdentifier("files-upload-photos")
                        Button { importing = true } label: {
                            Label("From Files", systemImage: "folder")
                        }
                        .accessibilityIdentifier("files-upload-files")
                    }
                }
            }
            .navigationTitle("New")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                if canMake {
                    ToolbarItem(placement: .confirmationAction) {
                        if making {
                            ProgressView()
                        } else {
                            Button("Create") { Task { await make() } }
                                .accessibilityIdentifier("files-new-create")
                        }
                    }
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item]) { result in
                guard case .success(let url) = result else { return }
                guard let copy = try? FilesNewSheet.copy(url) else { return error = "That file did not open." }
                upload(removing: copy) { try .file(copy) }
            }
            .onChange(of: photo) {
                guard let photo else { return }
                upload {
                    guard let data = try await photo.loadTransferable(type: Data.self) else { throw ActionError.refused(message: "The photo did not load.", forbidden: false) }
                    return .data(data, name: FilesNewSheet.photoName(photo.supportedContentTypes.first))
                }
            }
        }
        .tcSheet(.form)
        .task {
            guard canMake, client.work.may(.templatesList), client.work.may(.templatesMake) else { return }
            templates = try? await client.work.templates(workspaceId)
        }
    }

    private func make() async {
        let typed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty, let problem = FilesRules.nameProblem(typed) { return error = problem }
        making = true
        defer { making = false }
        do {
            try await files.make(workspaceId, in: at, kind: kind, name: typed.isEmpty ? nil : typed)
            dismiss()
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }

    /// The sheet goes at once; the upload's row in the folder shows its progress, or why it failed.
    /// `removing`: the app's own copy of a picked file, which goes once the upload ends either way.
    private func upload(removing copy: URL? = nil, _ source: @escaping @MainActor () async throws -> UploadSource) {
        let files = files
        let workspaceId = workspaceId
        let at = at
        dismiss()
        Task {
            defer { if let copy { OriginalFiles.remove(copy) } }
            // A failure stays on the upload's row with its reason; a source that never loaded has no row to stay on.
            do { try await files.upload(workspaceId, into: at, try await source()) } catch {}
        }
    }

    /// A file picked in Files, copied while the app may open it, so the upload's later reads need no grant.
    private static func copy(_ url: URL) throws -> URL {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let copy = try OriginalFiles.place(for: url.lastPathComponent)
        try FileManager.default.copyItem(at: url, to: copy)
        return copy
    }

    /// Photos gives no name: the camera's own form, with the picked type's extension.
    private static func photoName(_ type: UTType?, now: Date = .now) -> String {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "yyyyMMdd_HHmmss"
        return "IMG_\(format.string(from: now)).\(type?.preferredFilenameExtension ?? "jpg")"
    }
}

/// A template's fields, filled before it is made into the folder (`work.templates.make`): one field a name the
/// template asks for, each left empty stays in the file as written; Date, Name and Job fill themselves.
private struct TemplateFillView: View {
    let work: WorkHost
    let workspaceId: String
    let at: FolderRef
    let template: TemplatePhone
    let made: (Methods.WorkTemplatesMake.Output) -> Void
    @State private var values: [String: String] = [:]
    @State private var making = false
    @State private var error: String?
    @FocusState private var focus: String?

    var body: some View {
        Form {
            if !template.fields.isEmpty {
                Section {
                    ForEach(Array(template.fields.enumerated()), id: \.element) { index, field in
                        TextField(field, text: Binding(get: { values[field] ?? "" }, set: { values[field] = $0 }))
                            .focused($focus, equals: field)
                            .submitLabel(index == template.fields.count - 1 ? .done : .next)
                            .onSubmit {
                                if index + 1 < template.fields.count { focus = template.fields[index + 1] } else { Task { await make() } }
                            }
                            .accessibilityIdentifier("template-field")
                    }
                } footer: {
                    if let error { Text(error).foregroundStyle(Tint.destructiveText) }
                }
            } else if let error {
                Section { Text(error).foregroundStyle(Tint.destructiveText) }
            }
        }
        .navigationTitle(template.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if making {
                    ProgressView()
                } else {
                    Button("Make") { Task { await make() } }
                        .accessibilityIdentifier("template-make")
                }
            }
        }
        .onAppear { focus = template.fields.first }
    }

    private func make() async {
        guard !making else { return }
        making = true
        defer { making = false }
        do {
            made(try await work.makeFromTemplate(workspaceId, template: template, into: at, values: values))
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}
