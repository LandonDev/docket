import LifeKit
import SwiftUI
import TempCodeClient
import TempCodeContract
import UIKit

/// One conversation, in the detail (docs/IOS-DESIGN.md "Work on the phone", ### Messages): its messages oldest to
/// newest, opening at the foot, read on the job's own LifeOS session and marked read as it opens; his reply in the
/// house's composer at the foot. Send goes through the host by his press alone (`MessagesPresses`: no link refused at
/// once, the owner's check, five seconds with Undo, one attempt key); where nothing here can send the button is
/// Copy, with LifeOS's reason above. A thread's draft shows above the box: a held one opens its Outbox item, a
/// copy-only one is copied. A message's file opens in the reader.
struct ChatScreen: View {
    @Environment(AppModel.self) private var model
    let environmentId: String
    let workspaceId: String
    let chatId: String

    var body: some View {
        if let client = model.registry.client(environmentId),
           let host = MessagesReads.host(environmentId: environmentId, workspaceId: workspaceId, registry: model.registry) {
            ChatConversation(client: client, host: host, workspaceId: workspaceId, chatId: chatId)
                .id("\(environmentId)|\(workspaceId)|\(chatId)")
        } else {
            ContentUnavailableView("Conversation Not Here", systemImage: WorkPlace.messages.glyph, description: Text("Its computer is not paired with this iPhone."))
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct ChatConversation: View {
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL
    let client: EnvironmentClient
    let host: WorkLifeHost
    let workspaceId: String
    let chatId: String
    @State private var draft = ComposerDraft()
    @FocusState private var focused: Bool
    /// The thread's copy-only drafts for this conversation (`work.messages.drafts`).
    @State private var copies: [ChatDraft] = []
    /// Marked read once this visit; a later message from someone else while it is open marks it again.
    @State private var readUpTo: Double = 0
    /// Why a press here did not start (no link, the check cancelled), or an Undo, Retry or file that failed.
    @State private var line: String?
    @State private var opening: String?
    @State private var asked: Set<String> = []
    /// Messages whose files LifeOS was asked for and the ask failed: their rows stop spinning and ask again on a tap.
    @State private var askFailed: Set<String> = []
    /// Which lost Try Agains wait for a fresh read of the rows (`RetryReadBack`).
    private let desks = MessagesDesks.shared

    private var key: String { MessagesDesks.key(environmentId: client.environment.id, workspaceId: workspaceId, chatId: chatId) }

    var body: some View {
        let store = host.store
        let detailQuery = store.map { MessagesReads.detail($0, chatId: chatId) }
        let pageQuery = store.map { MessagesReads.messages($0, chatId: chatId) }
        let detail = Self.detail(detailQuery, chatId: chatId)
        let messages = Self.messages(pageQuery, chatId: chatId)
        content(messages: messages, page: pageQuery)
            .safeAreaInset(edge: .bottom, spacing: 0) { foot(detail: detail) }
            .navigationTitle(detail?.chat.name ?? WorkPlace.messages.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let detail {
                    ToolbarItem(placement: .principal) { title(detail.chat) }
                    ToolbarItem(placement: .primaryAction) { menu(detail, store: store) }
                }
            }
            .holdingChats(store, keys: [detailQuery?.key, pageQuery?.query.key].compactMap { $0 })
            .task(id: ObjectIdentifier(host)) { await host.prepare() } // a fresh session from a parent redraw is asked for too
            .task(id: client.work.messagesRev[workspaceId] ?? 0) { await readCopies() }
            .onChange(of: detail?.chat, initial: true) { _, chat in markRead(chat, store: store) }
            // A Retry whose answer was lost is read back by LifeOS's own row once the host is linked again.
            // Each lost Try Again of this conversation, once the host is linked: the rows are read again and that read,
            // landed, settles it, whether or not it changed anything (`RetryReadBack`).
            .task(id: RetryAsk(ids: checkingRetries(), linked: client.work.linked)) {
                await settleRetries(page: pageQuery)
            }
            .onChange(of: desks.desk(key).field, initial: true) { _, field in
                if draft.text != field { draft.seed(field) }
            }
            .onAppear {
                draft.onEdit = { [draft, key, desks] in desks.update(key) { $0.type(draft.text) } }
            }
            .accessibilityIdentifier("chat")
    }

    // MARK: - the messages

    @ViewBuilder
    private func content(messages: [ChatMessage], page: PagedQuery<ChatMessage>?) -> some View {
        let oldestFirst = Array(messages.reversed())
        if messages.isEmpty, Self.failed(page) {
            ContentUnavailableView {
                Label("Couldn’t Load", systemImage: WorkPlace.messages.glyph)
            } description: {
                Text("LifeOS did not answer.")
            } actions: {
                PillButton("Try Again") { page?.retryNow() }
            }
        } else if messages.isEmpty, Self.loading(host: host, page: page) {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if messages.isEmpty, case .unavailable(let why) = host.phase {
            // LifeOS out of reach is not an empty conversation: say why.
            ContentUnavailableView {
                Label("Couldn’t Load", systemImage: WorkPlace.messages.glyph)
            } description: {
                Text(why)
            } actions: {
                // Try Again only for silence: a sign-in, a connect or an ended access asks nothing again (the shared rule).
                if host.down?.isSilence == true { PillButton("Try Again") { Task { await host.prepare() } } }
            }
        } else if messages.isEmpty {
            ContentUnavailableView("No Messages Yet", systemImage: WorkPlace.messages.glyph)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Layout.rowGap) {
                    if page?.isLoadingMore == true { ProgressView().frame(maxWidth: .infinity) }
                    ForEach(Array(oldestFirst.enumerated()), id: \.element.id) { index, message in
                        ChatMessageView(
                            message: message,
                            head: Self.startsRun(oldestFirst, at: index),
                            reply: { ReplyLine.of(message.reply, press: retryState(message.reply)) },
                            canUndo: client.work.may(.messagesUndo),
                            canRetry: client.work.may(.messagesRetry),
                            opening: opening,
                            canOpen: client.work.may(.canvasOpen),
                            undo: { id in Task { await undo(outboxId: id) } },
                            retry: { id in Task { await retry(outboxId: id) } },
                            open: { file in Task { await open(file, in: message) } },
                            fetchFailed: askFailed.contains(message.id),
                            fetchAgain: { askFiles(message, again: true) }
                        )
                        .onAppear {
                            if index == 0 { page?.loadMore() }
                            askFiles(message)
                        }
                    }
                }
                .padding(.horizontal, Layout.textEdge)
                .padding(.vertical, Layout.rowGap)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
        }
    }

    /// A run starts at the first message, at a new writer, or after five minutes' gap (the desktop's `RUN_GAP_MS`).
    private static func startsRun(_ oldestFirst: [ChatMessage], at index: Int) -> Bool {
        guard index > 0 else { return true }
        let before = oldestFirst[index - 1], here = oldestFirst[index]
        return before.who != here.who || here.sentAt - before.sentAt > 5 * 60_000
    }

    private func title(_ chat: ChatRow) -> some View {
        VStack(spacing: 0) {
            Text(chat.name)
                .textStep(.title, weight: .semibold)
                .lineLimit(1)
            // The stamp's size in the secondary ink: the tertiary step measures 1.7:1 in light (IOS-DESIGN "Inks").
            Text(MessagesRules.chatFact(chat))
                .textStep(.stamp, tint: Color(.secondaryLabel))
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    private func menu(_ detail: ChatDetail, store: LifeStore?) -> some View {
        Menu {
            if let store {
                Button("Mark Unread", systemImage: "envelope.badge") {
                    Task { try? await MessagesReads.markUnread(store, chatId: chatId) }
                }
            }
            if let link = (detail.link ?? detail.chat.link).flatMap(URL.init(string:)) {
                Button("Open in \(MessagesRules.app(detail.chat.source))", systemImage: "arrow.up.forward.app") { openURL(link) }
            }
        } label: {
            Label("More", systemImage: "ellipsis.circle")
        }
    }

    // MARK: - the foot

    @ViewBuilder
    private func foot(detail: ChatDetail?) -> some View {
        let desk = desks.desk(key)
        let way = detail.map { ReplyWay.of($0.chat.source, route: $0.route) }
        let threadDraft = ChatThreadDraft.of(chatId: chatId, held: client.work.items, copies: copies)
        VStack(alignment: .leading, spacing: ComposerMetrics.rowGap) {
            if let counting = MessagesPresses.shared.counting(key) {
                UndoCapsule(line: counting.line, identifier: "messages-undo") { MessagesPresses.shared.undo() }
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: Motion.travel * 3)))
            }
            if let threadDraft { ThreadDraftLine(draft: threadDraft, copyOnly: way != .send, copy: { copy(threadDraft) }, openHeld: openHeld) }
            if case .copy(let why?)? = way { QuietLine(symbol: "info.circle", text: why) }
            if let words = line ?? desk.line ?? recordLine(desk) {
                // A press still being checked (the record's line after a relaunch) is not a failure: the quiet ink.
                let checking = line == nil && desk.line == nil && desk.out == nil
                    && client.work.presses.state(host: client.environment.id, ref: ChatPress.ref(workspaceId: workspaceId, chatId: chatId)) == .checking
                HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
                    QuietLine(symbol: desk.aside.isEmpty && !checking ? "exclamationmark.circle" : "questionmark.circle", text: words, tint: desk.aside.isEmpty && desk.out == nil && !checking ? Tint.destructiveText : Color(.secondaryLabel))
                    Spacer(minLength: 0)
                    if !desk.aside.isEmpty {
                        PillButton("Use Words") { desks.update(key) { $0.useWords() } }
                    }
                }
                .transition(.opacity)
            }
            TCGlassContainer {
                ComposerBox(placeholder: placeholder(detail, way: way), draft: draft, focused: $focused, blocked: blocked(way), canAttach: false, onAttach: {}) {
                    button(way: way, desk: desk, detail: detail)
                }
            }
        }
        .padding(.horizontal, ComposerBar.edge)
        .padding(.vertical, Layout.rowVertical)
        .background(alignment: .top) { BottomEdgeFade() }
        .animation(Motion.base, value: MessagesPresses.shared.counting(key)?.id)
        // On screen while shown: a reply put back here is said here alone (`MessagesPresses.tellOff`).
        .task(id: key) { await MessagesPresses.shared.shown(key) }
        .animation(Motion.crossFade, value: line ?? desk.line ?? recordLine(desk))
        .sensoryFeedback(.impact(weight: .light), trigger: desk.out?.attempt) { _, new in new != nil }
    }

    private func placeholder(_ detail: ChatDetail?, way: ReplyWay?) -> String {
        guard let chat = detail?.chat else { return "Reply" }
        return way == .send ? "Reply to \(chat.name)" : "Write a reply to copy"
    }

    /// The key cannot send here: the reason stands where the placeholder was, and nothing sends.
    private func blocked(_ way: ReplyWay?) -> String? {
        guard way == .send, !client.work.may(.messagesSend) else { return nil }
        return "This iPhone’s key can’t send here"
    }

    @ViewBuilder
    private func button(way: ReplyWay?, desk: ReplyDesk, detail: ChatDetail?) -> some View {
        switch way {
        case .copy?:
            ChatCopyButton(enabled: draft.hasContent) {
                UIPasteboard.general.string = draft.trimmed
                line = nil
                draft.clear()
                desks.update(key) { $0.type("") }
            }
        case .send?, nil:
            ComposerButton(
                intent: .send,
                enabled: way == .send && desk.canSend && draft.hasContent,
                offersQueue: false,
                holding: .constant(false),
                reduced: reduceMotion,
                busy: desk.out?.phase == .sending,
                onTap: { send(detail) },
                onQueue: {}
            )
            .keyboardShortcut(.return, modifiers: .command)
        }
    }

    // MARK: - presses

    private func send(_ detail: ChatDetail?) {
        guard let chat = detail?.chat else { return }
        desks.update(key) { $0.type(draft.text) }
        Task {
            line = await MessagesPresses.shared.send(key: key, client: client, workspaceId: workspaceId, chatId: chatId, chatName: chat.name)
        }
    }

    /// LifeOS's Undo inside its own undo time: the words come back into the field.
    private func undo(outboxId: String) async {
        do {
            let words = try await client.work.undoReply(workspaceId: workspaceId, chatId: chatId, outboxId: outboxId)
            desks.update(key) { $0.takeBack(words) }
            line = nil
        } catch {
            line = Self.words(error, prefix: "Not taken back")
        }
    }

    /// Retry of a failed reply: outward, so the owner's check first, then the ledger by LifeOS's outbox row. While
    /// it is out or its answer was lost, the row says so and offers no second Retry.
    private func retry(outboxId: String) async {
        let key = PressGates.key(client.environment, revoked: client.work.keyRevoked)
        if let refused = await PressGates.shared.pass(client, .messagesRetry, ref: ChatPress.ref(workspaceId: workspaceId, chatId: chatId), rev: outboxId, reason: "Send it again") {
            line = refused
            return
        }
        let ref = ChatPress.retryRef(workspaceId: workspaceId, chatId: chatId, outboxId: outboxId)
        do {
            try await client.work.retryReply(workspaceId: workspaceId, chatId: chatId, outboxId: outboxId, key: key)
            line = nil
        } catch {
            // Lost on its way, or one already out: the row says Checking… until LifeOS's row is read.
            if error is PressLedger.Unknown || client.work.presses.busy(host: client.environment.id, ref: ref) { return line = nil }
            line = Self.words(error, prefix: "Not sent")
        }
    }

    /// A Send of his here the press record still holds while no desk does (a relaunch since): "Checking…".
    private func recordLine(_ desk: ReplyDesk) -> String? {
        guard desk.out == nil else { return nil }
        return client.work.presses.state(host: client.environment.id, ref: ChatPress.ref(workspaceId: workspaceId, chatId: chatId))?.line
    }

    /// His Retry of a failed reply, while it is out or unread.
    private func retryState(_ reply: ChatReplyState?) -> PressState? {
        guard let reply else { return nil }
        return client.work.presses.state(host: client.environment.id, ref: ChatPress.retryRef(workspaceId: workspaceId, chatId: chatId, outboxId: reply.outboxId))
    }

    /// This conversation's Try Agains whose answer was lost (Checking, none waiting on a socket), by outbox id: from
    /// the press record, so one whose row left the page is read back too.
    private func checkingRetries() -> [String] {
        let prefix = ChatPress.retryRef(workspaceId: workspaceId, chatId: chatId, outboxId: "")
        return client.work.presses.pending.presses
            .filter { $0.host == client.environment.id && $0.kind == .chatRetry && $0.ref.hasPrefix(prefix) }
            .filter { client.work.presses.state(host: $0.host, ref: $0.ref) == .checking }
            .map { String($0.ref.dropFirst(prefix.count)) }
            .sorted()
    }

    /// Rows held from before the press never settle it: the rows are read again (`retryNow`), the read is awaited
    /// (LifeKit drops an equal value, so nothing else would say it landed), and the rows as they then stand settle each.
    private func settleRetries(page: PagedQuery<ChatMessage>?) async {
        let asked = Set(checkingRetries())
        guard client.work.linked, !asked.isEmpty, let page else { return }
        page.retryNow()
        await page.query.pendingSeed?.value
        guard !Task.isCancelled, !page.hasFailed, client.work.linked else { return }
        let rows = Self.messages(page, chatId: chatId).compactMap(\.reply)
        for (outboxId, truth) in RetryReadBack.truths(asked: asked, rows: rows) {
            client.work.settleRetry(workspaceId: workspaceId, chatId: chatId, outboxId: outboxId, truth: truth)
        }
    }

    private func copy(_ threadDraft: ChatThreadDraft) {
        UIPasteboard.general.string = threadDraft.text
        // A copy-only draft has done its work once copied: it leaves the conversation.
        guard case .copy(let draft) = threadDraft, client.work.may(.messagesDropDraft) else { return }
        Task {
            try? await client.work.dropChatDraft(workspaceId: workspaceId, id: draft.id)
            copies.removeAll { $0.id == draft.id }
        }
    }

    private func openHeld(_ item: OutboxItem) {
        navigator.open(.outboxItem(environmentId: client.environment.id, ref: OutboxModel.key(item.ref)))
    }

    private func readCopies() async {
        guard client.work.may(.messagesDrafts) else { return }
        if let drafts = try? await client.work.chatDrafts(workspaceId: workspaceId, chatId: chatId) { copies = drafts }
    }

    /// Opening marks it read in LifeOS when it is unread or someone wrote since he last saw it; once a message.
    private func markRead(_ chat: ChatRow?, store: LifeStore?) {
        guard let chat, let store, MessagesRules.wantsRead(chat), (chat.lastInAt ?? chat.lastAt) > readUpTo else { return }
        #if DEBUG
        if MessagesFixtures.on { return }
        #endif
        readUpTo = chat.lastInAt ?? chat.lastAt
        Task { try? await MessagesReads.markRead(store, chatId: chat.id) }
    }

    /// LifeOS fetches a message's files only once asked: each message with files still listed asks once.
    private func askFiles(_ message: ChatMessage, again: Bool = false) {
        guard let store = host.store, message.files.contains(where: { $0.status == .listed || again && $0.status == .wanted }) else { return }
        guard again || !asked.contains(message.id) else { return }
        asked.insert(message.id)
        askFailed.remove(message.id)
        Task {
            // A failed ask leaves the files listed: their rows say so and offer the ask again, never a spinner for ever.
            do { try await MessagesReads.requestFiles(store, messageId: message.id) } catch { askFailed.insert(message.id) }
        }
    }

    /// A stored file a reader kind shows: seated in the job's Messages pane on its host, then opened on its own page.
    private func open(_ file: ChatFile, in message: ChatMessage) async {
        guard let kind = ChatFiles.canvasKind(name: file.name, contentType: file.contentType), file.status == .stored, opening == nil else { return }
        opening = file.id
        defer { opening = nil }
        do {
            let item = try await client.work.openChatFile(workspaceId: workspaceId, chatId: chatId, messageId: message.id, file: file, kind: kind)
            navigator.open(.file(environmentId: client.environment.id, item: item, sessionId: nil))
        } catch {
            line = Self.words(error, prefix: "Couldn’t open \(file.name)")
        }
    }

    private static func words(_ error: any Error, prefix: String) -> String {
        "\(prefix): \(ActionError.wrap(error).message)"
    }

    // MARK: - reads

    private static func detail(_ query: LiveQuery<ChatDetail?>?, chatId: String) -> ChatDetail? {
        #if DEBUG
        if MessagesFixtures.on { return MessagesFixtures.detail(chatId) }
        #endif
        return query?.value ?? nil
    }

    private static func messages(_ page: PagedQuery<ChatMessage>?, chatId: String) -> [ChatMessage] {
        #if DEBUG
        if MessagesFixtures.on { return MessagesFixtures.messages(chatId) }
        #endif
        return page?.rows ?? []
    }

    private static func loading(host: WorkLifeHost, page: PagedQuery<ChatMessage>?) -> Bool {
        if case .unavailable = host.phase { return false }
        return page == nil || page?.isLoading == true
    }

    private static func failed(_ page: PagedQuery<ChatMessage>?) -> Bool {
        #if DEBUG
        if MessagesFixtures.on { return false }
        #endif
        return page?.hasFailed == true
    }
}

/// One message: at a run's start the writer ("You" for his own) and the time; what a Slack reply answers; the words
/// less the file names a reader folded into them; its files; and, for his own reply, LifeOS's state of it.
private struct ChatMessageView: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let message: ChatMessage
    let head: Bool
    let reply: () -> ReplyLine?
    let canUndo: Bool
    let canRetry: Bool
    let opening: String?
    let canOpen: Bool
    let undo: (String) -> Void
    let retry: (String) -> Void
    let open: (ChatFile) -> Void
    /// LifeOS was asked for this message's files and the ask failed.
    var fetchFailed = false
    var fetchAgain: () -> Void = {}

    var body: some View {
        let words = MessagesRules.fileMarkers(message.text, names: message.files.map(\.name))
        VStack(alignment: .leading, spacing: 2) {
            if head {
                HStack(alignment: .firstTextBaseline, spacing: Layout.tagGap) {
                    Text(message.who.me ? "You" : message.who.name)
                        .textStep(.title, weight: .semibold)
                    Text(TimeFormat.stamp(Int(message.sentAt)))
                        .textStep(.stamp)
                }
            }
            if let answers = message.replyTo {
                Text("\(answers.who): \(MessagesRules.firstWords(answers.text))")
                    .textStep(.meta)
                    .lineLimit(1)
            }
            if !words.isEmpty {
                Text(verbatim: words)
                    .transcriptType(TranscriptType.prose)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(message.files) { file in
                let stuck = fetchFailed && (file.status == .listed || file.status == .wanted)
                ChatFileRow(file: file, opening: opening == file.id, opens: stuck || canOpen && file.status == .stored && ChatFiles.canvasKind(name: file.name, contentType: file.contentType) != nil, fetchFailed: stuck) {
                    if stuck { fetchAgain() } else { open(file) }
                }
            }
            if let state = reply(), let outboxId = message.reply?.outboxId {
                // At accessibility sizes the line reads whole and its press sits under it (the capsule's rule), never
                // two narrow columns beside a large button.
                let large = typeSize.isAccessibilitySize
                let layout = large ? AnyLayout(VStackLayout(alignment: .leading, spacing: Layout.tagGap)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: Layout.tagGap))
                layout {
                    if large {
                        // One text, so the reason runs on from the state's word rather than standing in its own column.
                        (Text(state.words).fontWeight(.medium).foregroundStyle(state.retry ? Tint.destructiveText : Color(.secondaryLabel))
                            + Text(state.reason.map { " \($0)" } ?? "").foregroundStyle(Color(.secondaryLabel)))
                            .textStep(.meta)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(state.words)
                            .textStep(.meta, weight: .medium, tint: state.retry ? Tint.destructiveText : nil)
                        if let reason = state.reason {
                            Text(reason).textStep(.meta).lineLimit(2)
                        }
                        Spacer(minLength: 0)
                    }
                    if state.undo, canUndo { PillButton("Undo") { undo(outboxId) } }
                    if state.retry, canRetry { PillButton("Try Again") { retry(outboxId) } }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// A message's file: its glyph, name and state; a press opens it in the reader when a kind there shows it.
private struct ChatFileRow: View {
    /// The file glyph's column grows with the glyph, as the type does.
    @ScaledMetric(relativeTo: .body) private var glyph = Layout.glyphWidth
    let file: ChatFile
    let opening: Bool
    let opens: Bool
    /// The ask for it failed: no spinner, the words say so, and a tap asks again.
    var fetchFailed = false
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: Layout.rowGap) {
                Group {
                    if opening || !fetchFailed && (file.status == .listed || file.status == .wanted) {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: file.status == .failed || fetchFailed ? "exclamationmark.triangle" : "doc")
                    }
                }
                .frame(width: glyph)
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.name)
                        .textStep(.title, tint: opens ? Color.accentColor : nil)
                        .lineLimit(1)
                    if let note = note {
                        Text(note).textStep(.meta, tint: file.status == .failed || fetchFailed ? Tint.destructiveText : nil).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, Layout.rowVertical)
            .frame(minHeight: Layout.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .disabled(!opens || opening)
        .accessibilityLabel([file.name, note].compactMap { $0 }.joined(separator: ", "))
    }

    private var note: String? {
        if fetchFailed { return "Couldn’t get this file. Tap to ask again." }
        return switch file.status {
        case .failed: file.error?.isEmpty == false ? file.error : "Couldn’t get this file"
        case .listed, .wanted: "Coming from LifeOS"
        case .stored: file.size.map { FilesRules.size(Int64($0)) }
        }
    }
}

/// A thread's draft for this conversation, over the box: its first words and the one press it takes. A held reply
/// opens its Outbox item, where it is sent; where nothing here can send, Copy.
private struct ThreadDraftLine: View {
    let draft: ChatThreadDraft
    /// Nothing here can send: the draft is copied, held or not.
    let copyOnly: Bool
    let copy: () -> Void
    let openHeld: (OutboxItem) -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            QuietLine(symbol: "doc.text", text: "\(who): “\(MessagesRules.firstWords(draft.text))”")
            Spacer(minLength: 0)
            switch draft {
            case .held(let item):
                if copyOnly { PillButton("Copy", action: copy) } else { PillButton("Open") { openHeld(item) } }
            case .copy:
                PillButton("Copy", action: copy)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var who: String {
        switch draft {
        case .held: "A thread’s draft waits in the Outbox"
        case .copy(let draft): draft.thread.map { "Draft from \($0)" } ?? "A thread’s draft"
        }
    }
}

/// Copy where nothing here can send: the composer button's shape, the copy glyph.
private struct ChatCopyButton: View {
    let enabled: Bool
    let action: () -> Void
    @ScaledMetric(relativeTo: .subheadline) private var scaledSide = ComposerMetrics.control
    private var side: CGFloat { ComposerMetrics.side(scaledSide) }

    var body: some View {
        Button(action: action) {
            Image(systemName: "doc.on.doc")
                .font(.subheadline.weight(.semibold))
                .dynamicTypeSize(...ComposerMetrics.glyphCap)
                .foregroundStyle(enabled ? Tint.onAccent : Color(.tertiaryLabel))
                .frame(width: side, height: side)
                .tcGlass(in: Circle(), tint: enabled ? Color.accentColor : nil)
                .padding(ComposerMetrics.hitOutset(side))
                .contentShape(Rectangle())
                .padding(-ComposerMetrics.hitOutset(side))
        }
        .buttonStyle(.pressable)
        .disabled(!enabled)
        .accessibilityLabel("Copy")
    }
}

/// What starts a lost Try Again's read-back: which are Checking, and the host's link.
private struct RetryAsk: Equatable {
    let ids: [String]
    let linked: Bool
}
