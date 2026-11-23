import SwiftUI
import TempCodeClient
import TempCodeContract

/// Comment on the words he picked in a document (docs/IOS-DESIGN.md "A file on the phone"): the quote,
/// a field, Cancel and Post. A post the host refuses keeps his words and says why under the field.
struct CommentSheet: View {
    @Environment(\.dismiss) private var dismiss
    let comments: WorkComments
    let quote: String
    @State private var text = ""
    @State private var posting = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var words: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(quote)
                        .textStep(.meta)
                        .lineLimit(4)
                        .accessibilityLabel("On: \(quote)")
                    TextField("Comment", text: $text, axis: .vertical)
                        .lineLimit(2...8)
                        .focused($focused)
                        .onChange(of: text) { error = nil }
                        .accessibilityIdentifier("comment-text")
                } footer: {
                    if let error { Text(error).foregroundStyle(Tint.destructiveText) }
                }
            }
            .navigationTitle("Comment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if posting {
                        ProgressView()
                    } else {
                        Button("Post") { Task { await post() } }
                            .disabled(words.isEmpty)
                            .accessibilityIdentifier("comment-post")
                    }
                }
            }
            .onAppear { focused = true }
        }
        .tcSheet(.field)
    }

    private func post() async {
        posting = true
        defer { posting = false }
        do {
            try await comments.post(body: words, quote: quote)
            dismiss()
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}

/// A document's comments: open threads first, then resolved; a reply field in the bottom bar; swipe to
/// resolve. A tap on a thread turns the field to that thread; with none picked it starts a new one.
struct CommentsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let comments: WorkComments
    let canWrite: Bool
    @State private var replyingTo: CommentThread?
    @State private var text = ""
    @State private var sending = false
    @State private var error: String?
    @State private var sentCount = 0
    @FocusState private var focused: Bool

    private var words: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            List {
                if comments.open.isEmpty, comments.resolved.isEmpty {
                    // A small list's empty state is one quiet line, not a whole-screen view.
                    Text(comments.failure ?? "No comments")
                        .textStep(.meta)
                        .listRowSeparator(.hidden)
                        .accessibilityIdentifier("comments-empty")
                }
                ForEach(comments.open) { thread in row(thread) }
                if !comments.resolved.isEmpty {
                    Section {
                        ForEach(comments.resolved) { thread in row(thread) }
                    } header: {
                        SectionHeader("Resolved")
                            .listRowInsets(EdgeInsets())
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle("Comments")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .tcBottomBar { if canWrite { bar } }
            .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
        }
        .tcSheet(.document)
        .accessibilityIdentifier("comments-sheet")
        #if DEBUG
        // The reader's set (`TC_TEST_ACTION=comment-post:<words>`): the words typed and sent, three seconds after the list shows.
        .task {
            guard let action = TestHooks.action, action.hasPrefix("comment-post:") else { return }
            try? await Task.sleep(for: .seconds(3))
            text = String(action.dropFirst("comment-post:".count))
            await send()
        }
        #endif
    }

    private func row(_ thread: CommentThread) -> some View {
        Button {
            guard canWrite, !thread.resolved else { return }
            replyingTo = thread
            focused = true
        } label: {
            CommentThreadRow(thread: thread)
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing) {
            if canWrite {
                Button(thread.resolved ? "Reopen" : "Resolve", systemImage: thread.resolved ? "arrow.uturn.backward" : "checkmark") {
                    Task { await resolve(thread) }
                }
                .tint(thread.resolved ? Tint.quiet : Tint.success)
            }
        }
        .accessibilityIdentifier("comment-thread")
    }

    private var bar: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let replyingTo {
                HStack(spacing: 6) {
                    Text("Replying to \(replyingTo.comments.first?.author ?? "this thread")")
                        .textStep(.meta)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Button("Stop Replying", systemImage: "xmark") { self.replyingTo = nil }
                        .labelStyle(.iconOnly)
                        .imageScale(.small)
                        .foregroundStyle(.secondary)
                        .frame(minWidth: Layout.rowHeight, minHeight: Layout.rowHeight)
                        .contentShape(Rectangle())
                }
                .padding(.leading, 12)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(replyingTo == nil ? "Add a comment" : "Reply", text: $text, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...4)
                    .focused($focused)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .frame(minHeight: 36)
                    .background(Surface.chrome, in: RoundedRectangle.fieldCorner)
                    .hairlineBorder(RoundedRectangle.fieldCorner)
                    // The field's last line sits level with the send mark beside it.
                    .padding(.bottom, 4)
                    .onChange(of: text) { error = nil }
                    .accessibilityIdentifier("comments-field")
                Button { Task { await send() } } label: {
                    ZStack {
                        Circle()
                            .fill(Color(.label))
                            .opacity(words.isEmpty || sending ? 0.3 : 1)
                        Image(systemName: "arrow.up")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(Color(.systemBackground))
                    }
                    .frame(width: 28, height: 28)
                    // The mark stays 28 pt; the hit area reaches 44 pt around it.
                    .frame(width: Layout.rowHeight, height: Layout.rowHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.pressable)
                .disabled(words.isEmpty || sending)
                .animation(Motion.crossFade, value: words.isEmpty)
                .accessibilityLabel(replyingTo == nil ? "Post" : "Reply")
                .accessibilityIdentifier("comments-send")
            }
            if let error {
                Text(error)
                    .textStep(.meta, tint: Tint.destructiveText)
                    .padding(.horizontal, 12)
                    .transition(.opacity)
            }
        }
        // The send mark's edge, not its hit area, lines up with the field's inset.
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .padding(.top, 6)
        .padding(.bottom, 4)
        .animation(Motion.crossFade, value: error)
    }

    /// His words stay in the field until the host has them.
    private func send() async {
        sending = true
        defer { sending = false }
        do {
            if let replyingTo { try await comments.reply(to: replyingTo.id, body: words) } else { try await comments.post(body: words, quote: nil) }
            text = ""
            replyingTo = nil
            sentCount += 1
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }

    private func resolve(_ thread: CommentThread) async {
        do {
            try await comments.resolve(thread.id, !thread.resolved)
            if replyingTo?.id == thread.id { replyingTo = nil }
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}

/// One thread: the words it was left on, then each comment (who and when on one line, the words under it),
/// the replies set in by the text edge and nothing else.
private struct CommentThreadRow: View {
    let thread: CommentThread

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let quote = thread.quote, !quote.isEmpty {
                Text("“\(quote)”")
                    .textStep(.meta)
                    .lineLimit(3)
            }
            ForEach(Array(thread.comments.enumerated()), id: \.element.id) { index, comment in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(comment.author).textStep(.title, weight: .semibold).lineLimit(1)
                        AgoText(Int(comment.at), step: .meta)
                    }
                    Text(comment.body).textStep(.title)
                }
                .padding(.leading, index == 0 ? 0 : Layout.indent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}
