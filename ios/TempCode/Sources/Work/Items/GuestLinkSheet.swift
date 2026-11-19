import SwiftUI
import TempCodeClient
import TempCodeContract

/// Make a Guest Link from a document's or sheet's More (milestone 47): For,
/// Can (View, Comment, Edit) and Ends, then the address once, with Copy and
/// Share. The host keeps only its hash.
struct GuestLinkSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: EnvironmentClient
    let source: Methods.WorkGuestsCreate.Params.Source
    let title: String
    @State private var draft = GuestLinkDraft()
    @State private var made: String?
    @State private var saving = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                if let made {
                    GuestAddressSection(address: made)
                } else {
                    Section {
                        TextField("For", text: $draft.name)
                            .textContentType(.name)
                            .focused($focused)
                            .accessibilityIdentifier("guest-name")
                        Picker("Can", selection: $draft.role) {
                            ForEach(GuestLinkDraft.Role.allCases, id: \.self) { Text($0.title).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        DatePicker("Ends", selection: $draft.ends, in: GuestLinkDraft.range(), displayedComponents: .date)
                    } footer: {
                        if let error { Text(error).foregroundStyle(Tint.destructiveText) }
                    }
                }
            }
            .navigationTitle(made == nil ? "Guest Link" : title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if made == nil {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        if saving {
                            ProgressView()
                        } else {
                            Button("Create") { Task { await create() } }
                                .disabled(!draft.canCreate())
                                .accessibilityIdentifier("guest-create")
                        }
                    }
                } else {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
            }
            .onAppear { focused = true }
        }
        .tcSheet(.form)
    }

    private func create() async {
        saving = true
        defer { saving = false }
        do {
            made = try await client.work.canvas.makeGuestLink(draft, source: source, title: title).url
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}

/// The address once, with Copy and Share: the end of Make a Guest Link and of
/// Settings → Work's New Address. The host keeps only its hash.
struct GuestAddressSection: View {
    let address: String
    var footer = "This address shows once."

    var body: some View {
        Section {
            Text(address).font(.callout.monospaced()).textSelection(.enabled).accessibilityIdentifier("guest-url")
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = address }
            if let url = URL(string: address) { ShareLink("Share", item: url) }
        } footer: {
            Text(footer)
        }
    }
}

/// New Address on a live link (Settings → Work): the new address itself, once.
struct NewAddressSheet: View {
    @Environment(\.dismiss) private var dismiss
    let address: String

    var body: some View {
        NavigationStack {
            Form {
                GuestAddressSection(address: address, footer: "This address shows once. The one before opens nothing now.")
            }
            .navigationTitle("New Address")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .tcSheet(.form)
        .accessibilityIdentifier("guest-new-address")
    }
}
