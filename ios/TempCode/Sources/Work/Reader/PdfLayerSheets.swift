import Observation
import SwiftUI
import TempCodeClient
import TempCodeContract

/// What is drawn over one PDF (docs/IOS-DESIGN.md "A file on the phone", highlights and fields): the view as the
/// host last answered it, and his presses on it. Every press answers the whole view, which replaces this one; a
/// press the host refuses changes nothing here and keeps its words for the sheet. One press at a time.
@MainActor @Observable
final class PdfLayerModel {
    private(set) var view: PdfPhoneView
    private(set) var busy = false
    /// Bumps with every new view: the viewer draws the layer again on it.
    private(set) var revision = 0
    @ObservationIgnored private let canvas: WorkCanvas
    /// The key may act (`work.pdf.mark` and the rest need operate).
    let acts: Bool

    init(view: PdfPhoneView, canvas: WorkCanvas, acts: Bool) {
        self.view = view
        self.canvas = canvas
        self.acts = acts
    }

    var marks: [PdfMarkPhone] { view.marks ?? [] }
    var fields: [PdfFieldPhone] { view.fields ?? [] }
    var waiting: [PdfFieldPhone] { PdfFields.waiting(fields) }

    func mark(page: Int, quads: [[Double]], text: String, note: String? = nil) async throws {
        try await run { try await self.canvas.mark(self.view.itemId, page: page, quads: quads, text: text, note: note) }
    }

    func unmark(_ markId: String) async throws {
        try await run { try await self.canvas.unmark(self.view.itemId, markId: markId) }
    }

    /// A highlight's note changed: the host keeps a mark as made, so the new one is laid first and the old one taken
    /// after, and a failure between the two leaves the words highlighted twice rather than not at all.
    func renote(_ mark: PdfMarkPhone, note: String?) async throws {
        try await run {
            _ = try await self.canvas.mark(self.view.itemId, page: mark.page, quads: mark.quads, text: mark.text, note: note)
            return try await self.canvas.unmark(self.view.itemId, markId: mark.id)
        }
    }

    func set(_ field: PdfFieldPhone, to value: Methods.WorkPdfSetField.Params.Value?) async throws {
        try await run { try await self.canvas.setField(self.view.itemId, key: field.key, value: value) }
    }

    /// Takes or drops the agent's values he sees: these keys, never the host's "all".
    func review(_ keys: [String], accept: Bool) async throws {
        guard !keys.isEmpty else { return }
        try await run { try await self.canvas.reviewFields(self.view.itemId, keys: keys, accept: accept) }
    }

    private func run(_ press: @escaping () async throws -> PdfPhoneView) async throws {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        let next = try await press()
        view = next
        revision += 1
    }
}

typealias PdfLayerPick = PdfLayerName.Pick

/// A highlight: the words in quotation marks, his note, Save and Remove Highlight. A key that may only read sees
/// the words and the note.
struct PdfMarkSheet: View {
    @Environment(\.dismiss) private var dismiss
    let layer: PdfLayerModel
    let mark: PdfMarkPhone
    @State private var note: String
    @State private var error: String?
    @FocusState private var focused: Bool

    init(layer: PdfLayerModel, mark: PdfMarkPhone) {
        self.layer = layer
        self.mark = mark
        _note = State(initialValue: mark.note ?? "")
    }

    private var trimmed: String { note.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var changed: Bool { trimmed != (mark.note ?? "") }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("“\(mark.text)”")
                        .textStep(.meta)
                        .lineLimit(4)
                        .accessibilityLabel("Highlighted: \(mark.text)")
                    if layer.acts {
                        TextField("Add a note", text: $note, axis: .vertical)
                            .lineLimit(2...8)
                            .focused($focused)
                            .disabled(layer.busy)
                            .onChange(of: note) { error = nil }
                            .accessibilityIdentifier("pdf-mark-note")
                    } else if let words = mark.note, !words.isEmpty {
                        Text(words)
                    }
                } footer: {
                    if let error { Text(error).foregroundStyle(Tint.destructiveText) }
                }
                if layer.acts {
                    Section {
                        Button("Remove Highlight", role: .destructive) { Task { await remove() } }
                            .disabled(layer.busy)
                            .accessibilityIdentifier("pdf-mark-remove")
                    }
                }
            }
            .navigationTitle("Highlight")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(layer.acts ? "Cancel" : "Done") { dismiss() } }
                if layer.acts {
                    ToolbarItem(placement: .confirmationAction) {
                        if layer.busy {
                            ProgressView()
                        } else {
                            Button("Save") { Task { await save() } }
                                .disabled(!changed)
                                .accessibilityIdentifier("pdf-mark-save")
                        }
                    }
                }
            }
        }
        .tcSheet(.field)
    }

    private func save() async {
        do {
            try await layer.renote(mark, note: trimmed.isEmpty ? nil : trimmed)
            dismiss()
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }

    private func remove() async {
        do {
            try await layer.unmark(mark.id)
            dismiss()
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}

/// A form's field: its label as the title, where the shown value came from, a control for his own value, and while
/// an agent's value waits, Reject and Accept. A signature, and the day he signed, are placed on the computer.
struct PdfFieldSheet: View {
    @Environment(\.dismiss) private var dismiss
    let layer: PdfLayerModel
    let field: PdfFieldPhone
    @State private var text: String
    @State private var error: String?
    @FocusState private var focused: Bool

    init(layer: PdfLayerModel, field: PdfFieldPhone) {
        self.layer = layer
        self.field = field
        _text = State(initialValue: PdfFields.shown(field) ?? "")
    }

    private var fills: Bool { layer.acts && PdfFields.fills(field) }
    private var proposed: Bool { field.state == .proposed }
    private var changed: Bool { text != (PdfFields.shown(field) ?? "") }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    control
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        if let source = PdfFields.source(field) { Text(source) }
                        if !PdfFields.fills(field) { Text("Sign this on your computer.") }
                        if let error { Text(error).foregroundStyle(Tint.destructiveText) }
                    }
                }
            }
            .navigationTitle(field.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(fills ? "Cancel" : "Done") { dismiss() } }
                if fills {
                    ToolbarItem(placement: .confirmationAction) {
                        if layer.busy {
                            ProgressView()
                        } else {
                            Button("Save") { Task { await save() } }
                                .disabled(!changed)
                                .accessibilityIdentifier("pdf-field-save")
                        }
                    }
                }
            }
            // An agent's value waits on his word: Reject, and Accept as the one prominent press.
            .tcBottomBar {
                if proposed, layer.acts {
                    HStack(spacing: 8) {
                        Button("Reject") { Task { await review(accept: false) } }
                            .font(.body.weight(.medium))
                            .padding(.horizontal, 6)
                            .frame(minHeight: Layout.rowHeight)
                            .buttonBorderShape(.capsule)
                            .tcGlassButton()
                            .accessibilityIdentifier("pdf-field-reject")
                        Spacer(minLength: 0)
                        Button("Accept") { Task { await review(accept: true) } }
                            .font(.body.weight(.semibold))
                            .padding(.horizontal, 10)
                            .frame(minHeight: Layout.rowHeight)
                            .buttonBorderShape(.capsule)
                            .tcGlassButton(prominent: true)
                            .accessibilityIdentifier("pdf-field-accept")
                    }
                    .disabled(layer.busy || changed)
                    .padding(.horizontal, Layout.textEdge)
                    .padding(.vertical, 8)
                }
            }
        }
        .tcSheet(.field)
    }

    @ViewBuilder
    private var control: some View {
        switch field.type {
        case "checkbox":
            Toggle(field.label, isOn: Binding(get: { text == PdfFields.checked }, set: { text = $0 ? PdfFields.checked : "" }))
                .disabled(!fills || layer.busy)
        case "choice" where !(field.options ?? []).isEmpty:
            Picker(field.label, selection: $text) {
                Text("None").tag("")
                ForEach(field.options ?? [], id: \.self) { Text($0).tag($0) }
            }
            .disabled(!fills || layer.busy)
        default:
            if fills {
                TextField(field.label, text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .disabled(layer.busy)
                    .onChange(of: text) { error = nil }
                    .accessibilityIdentifier("pdf-field-text")
            } else {
                Text(text.isEmpty ? "Empty" : text).foregroundStyle(text.isEmpty ? .secondary : .primary)
            }
        }
    }

    private func save() async {
        do {
            try await layer.set(field, to: PdfFields.value(text, for: field))
            dismiss()
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }

    private func review(accept: Bool) async {
        do {
            try await layer.review([field.key], accept: accept)
            dismiss()
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}
