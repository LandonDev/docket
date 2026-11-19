import SwiftUI
import TempCodeClient
import TempCodeContract

/// A Work workspace's house rules (rules.html, on the phone; milestone 39's
/// wire): what the host's reading of his edits proposes, each with the edits
/// it was drawn from, then the rules in order, each one line with its switch.
/// A rule opens to reword it; swipe deletes it; Edit reorders. Only a key
/// that may approve changes anything; the rest read.
struct HouseRulesScreen: View {
    @Environment(AppModel.self) private var model
    let environmentId: String
    let workspaceId: String
    @State private var page: Methods.WorkRulesList.Output?
    @State private var error: String?
    @State private var editing: RuleEdit?

    private var client: EnvironmentClient? { model.registry.client(environmentId) }
    private var canWrite: Bool { client?.work.canApprove == true }

    var body: some View {
        Group {
            if let page, let client {
                list(page, client: client)
            } else if let error {
                ContentUnavailableView("Can’t Read House Rules", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .navigationTitle("House Rules")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if canWrite, page != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button("Add Rule", systemImage: "plus") { editing = RuleEdit(rule: nil, proposal: nil) }
                        .accessibilityIdentifier("rules-add")
                }
                if page?.rules.isEmpty == false {
                    ToolbarItem(placement: .secondaryAction) { EditButton() }
                }
            }
        }
        .sheet(item: $editing) { edit in
            if let client { RuleEditSheet(client: client, workspaceId: workspaceId, edit: edit) }
        }
        .task(id: client?.work.rulesRev[workspaceId] ?? 0) { await load() }
        .accessibilityIdentifier("house-rules")
    }

    private func list(_ page: Methods.WorkRulesList.Output, client: EnvironmentClient) -> some View {
        let proposals = page.proposals.filter { $0.state == .open || $0.state == .later }
        return List {
            if !proposals.isEmpty {
                Section("Proposed") {
                    ForEach(proposals, id: \.id) { proposal in
                        ProposalRow(proposal: proposal, canWrite: canWrite,
                                    add: { editing = RuleEdit(rule: nil, proposal: proposal) },
                                    decide: { to in Task { await decide(proposal, to: to, client: client) } })
                    }
                }
            }
            Section {
                ForEach(page.rules, id: \.id) { rule in
                    Toggle(isOn: Binding(get: { rule.on }, set: { on in Task { await run(client) { try await client.work.editRule(rule.id, on: on) } } })) {
                        Button { editing = RuleEdit(rule: rule, proposal: nil) } label: {
                            Text(rule.text)
                                .font(.body)
                                .foregroundStyle(rule.on ? .primary : .secondary)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .buttonStyle(.pressable)
                        .disabled(!canWrite)
                    }
                    .disabled(!canWrite)
                }
                .onDelete(perform: canWrite ? { offsets in
                    let ids = offsets.map { page.rules[$0].id }
                    Task { for id in ids { await run(client) { try await client.work.removeRule(id) } } }
                } : nil)
                .onMove(perform: canWrite ? { from, to in
                    var ids = page.rules.map(\.id)
                    ids.move(fromOffsets: from, toOffset: to)
                    self.page = .init(rules: ids.compactMap { id in page.rules.first { $0.id == id } }, proposals: page.proposals)
                    Task { await run(client) { try await client.work.orderRules(workspaceId, ids: ids) } }
                } : nil)
            } header: {
                if !proposals.isEmpty { Text("Rules") }
            } footer: {
                if page.rules.isEmpty { Text("No house rules yet. A rule is one line every thread here follows.") }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func load() async {
        guard let client else { error = "This workspace is not on a paired host."; return }
        do {
            page = try await client.work.rules(workspaceId)
            error = nil
        } catch {
            if page == nil { self.error = ActionError.wrap(error).message }
        }
    }

    private func decide(_ proposal: RuleProposal, to: Methods.WorkRulesDecide.Params.To, client: EnvironmentClient) async {
        await run(client) { try await client.work.decide(proposal.id, to: to) }
    }

    /// One write, then the page as the host holds it (the push brings it too; this is the reader's own).
    private func run(_ client: EnvironmentClient, _ write: () async throws -> Void) async {
        do {
            try await write()
        } catch {
            FleetToastCenter.shared.post(message: ActionError.wrap(error).message)
        }
        await load()
    }
}

/// A rule to write: a new one, one from a proposal, or a rewording.
struct RuleEdit: Identifiable {
    var rule: HouseRule?
    var proposal: RuleProposal?
    var id: String { rule?.id ?? proposal?.id ?? "new" }
}

/// A proposal: the sentence a rule would say, what he did again, and the
/// edits behind it (opened in place); Add opens the sentence to adjust, Not
/// now keeps it on this page only, Dismiss never offers it again.
private struct ProposalRow: View {
    let proposal: RuleProposal
    let canWrite: Bool
    let add: () -> Void
    let decide: (Methods.WorkRulesDecide.Params.To) -> Void
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(proposal.text)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                withAnimation(Motion.expand) { open.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Text(proposal.edits.count == 1 ? "From 1 edit" : "From \(proposal.edits.count) edits")
                    Image(systemName: "chevron.right")
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .imageScale(.small)
                }
                .textStep(.meta)
            }
            .buttonStyle(.pressable)
            if open {
                ForEach(proposal.edits, id: \.draftId) { edit in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(edit.to) · \(edit.subject) · \(HeldTime.of(edit.sentAt))")
                            .textStep(.meta)
                            .lineLimit(1)
                        diff(edit.ops.map { (kind: $0.op.rawValue, text: $0.text) })
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 4)
                }
            }
            if canWrite {
                HStack(spacing: 8) {
                    Button("Add Rule…", action: add)
                        .buttonBorderShape(.capsule)
                        .tcGlassButton()
                    if proposal.state == .open {
                        Button("Not Now") { decide(.later) }
                            .buttonBorderShape(.capsule)
                            .tcGlassButton()
                    }
                    Spacer(minLength: 0)
                    Button("Dismiss", role: .destructive) { decide(.dismissed) }
                        .foregroundStyle(.secondary)
                        .buttonStyle(.pressable)
                }
                .font(.footnote.weight(.medium))
                .padding(.top, 4)
            }
        }
        .padding(.vertical, 4)
    }

    /// The edit as one paragraph: what he took out struck through, what he put in underlined.
    private func diff(_ ops: [(kind: String, text: String)]) -> Text {
        ops.reduce(Text("")) { line, op in
            switch op.kind {
            case "-": line + Text(op.text).strikethrough().foregroundStyle(Tint.destructiveText)
            case "+": line + Text(op.text).underline().foregroundStyle(Tint.success)
            default: line + Text(op.text).foregroundStyle(.secondary)
            }
        }
    }
}

/// Add or reword a rule: one line, what every thread here is told.
private struct RuleEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: EnvironmentClient
    let workspaceId: String
    let edit: RuleEdit
    @State private var text = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Rule", text: $text, axis: .vertical)
                        .lineLimit(2...6)
                        .accessibilityIdentifier("rule-text")
                } footer: {
                    if let error { Text(error).foregroundStyle(Tint.destructiveText) } else { Text("One line, at most 300 characters.") }
                }
            }
            .navigationTitle(edit.rule == nil ? "Add Rule" : "Edit Rule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button(edit.rule == nil ? "Add" : "Save") { Task { await save() } }
                            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.count > 300)
                    }
                }
            }
            .onAppear { text = edit.rule?.text ?? edit.proposal?.text ?? "" }
        }
        .tcSheet(.form)
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if let rule = edit.rule {
                try await client.work.editRule(rule.id, text: line)
            } else {
                try await client.work.addRule(workspaceId, text: line, proposalId: edit.proposal?.id)
            }
            dismiss()
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}
