import Foundation
import Observation
import TempCodeContract

/// One comment thread on a document, as the phone draws it.
public struct CommentThread: Identifiable, Equatable, Sendable {
    public let id: String
    /// The words it was left on, when it was left on words.
    public let quote: String?
    public let resolved: Bool
    /// Oldest first.
    public let comments: [Comment]

    public init(id: String, quote: String?, resolved: Bool, comments: [Comment]) {
        self.id = id
        self.quote = quote
        self.resolved = resolved
        self.comments = comments
    }
}

public struct Comment: Identifiable, Equatable, Sendable {
    public let id: String
    /// The name the host gave its author, else the author's principal as stored.
    public let author: String
    /// Milliseconds since the epoch.
    public let at: Double
    /// Plain words: the editor's blocks read as text.
    public let body: String

    public init(id: String, author: String, at: Double, body: String) {
        self.id = id
        self.author = author
        self.at = at
        self.body = body
    }
}

/// A document's comments on the phone (PF2): its threads as
/// `work.docs.threads` answers them, open ones first, then resolved, each
/// oldest first. Every press goes to the host and reads the threads again.
/// A press the host refuses is thrown and leaves what is held as it was, so
/// the screen keeps his words. A screen reads again when `rev` moves (the
/// `work.docs` push).
@MainActor @Observable
public final class WorkComments {
    public let source: CanvasSource
    public private(set) var open: [CommentThread] = []
    public private(set) var resolved: [CommentThread] = []
    /// `work.docs.threads` answered at least once.
    public private(set) var loaded = false
    /// The host's words for the last read that failed; nil once one succeeds.
    public private(set) var failure: String?
    /// The service's name for the document, once known (DocName).
    private var doc: String?
    /// Counts the reads, so an answer is taken only from the newest.
    @ObservationIgnored private var loads = 0

    @ObservationIgnored private let work: WorkHost

    public init(work: WorkHost, source: CanvasSource) {
        self.work = work
        self.source = source
        doc = DocName.known(source)
    }

    /// Moves with each `work.docs` push for this document.
    public var rev: Int { doc.flatMap { work.docsRev[$0] } ?? 0 }

    public func load() async {
        // A host from before comments on the phone is asked once a socket, and has no row.
        guard work.can.has(Self.method) else { return }
        loads += 1
        let mine = loads
        do {
            if doc == nil { doc = try await DocName.resolve(source, on: work.socket) }
            let answer = try await work.socket.request(Methods.WorkDocsThreads.self, .init(source: source))
            // A read that an earlier, slower one overtakes is dropped: the newest answer stands.
            guard mine == loads else { return }
            let threads = Self.threads(answer)
            open = threads.filter { !$0.resolved }
            resolved = threads.filter(\.resolved)
            loaded = true
            failure = nil
        } catch {
            guard mine == loads else { return }
            if HostCan.saysUnknown(error) { return work.can.mark(Self.method) }
            failure = ActionError.wrap(error).message
        }
    }

    static let method = "work.docs.threads"

    /// A new thread, on `quote` when he chose words.
    public func post(body: String, quote: String?) async throws {
        try await change(.create(.init(body: CommentBody.blocks(body), quote: quote)))
    }

    public func reply(to threadId: String, body: String) async throws {
        try await change(.reply(.init(threadId: threadId, body: CommentBody.blocks(body))))
    }

    public func resolve(_ threadId: String, _ resolved: Bool) async throws {
        try await change(.resolve(.init(threadId: threadId, resolved: resolved)))
    }

    private func change(_ change: Methods.WorkDocsThread.Params.Change) async throws {
        do {
            _ = try await work.socket.request(Methods.WorkDocsThread.self, .init(source: source, change: change))
        } catch {
            throw ActionError.wrap(error)
        }
        await load()
    }

    /// The threads he can read, oldest first: a deleted thread or comment is left out, and a thread with no comment left with it.
    static func threads(_ answer: DocThreadsPhone) -> [CommentThread] {
        answer.rows
            .filter { $0.thread.deletedAt == nil }
            .sorted { $0.thread.createdAt < $1.thread.createdAt }
            .compactMap { row in
                let comments = row.comments
                    .filter { $0.deletedAt == nil }
                    .sorted { $0.createdAt < $1.createdAt }
                    .map { Comment(id: $0.publicId, author: answer.names[$0.authorMemberId] ?? $0.authorMemberId, at: $0.createdAt, body: CommentBody.plain($0.body)) }
                guard !comments.isEmpty else { return nil }
                return CommentThread(id: row.thread.publicId, quote: row.thread.quote, resolved: row.thread.resolved, comments: comments)
            }
    }
}

/// Where the comment field's words go: a thread he replies to, or nil for a new comment.
public enum DraftTarget {
    /// A tap on a thread, or the thread he replies to resolved, asks to move the field to `asked`. An empty
    /// field moves; words in it keep their target, so they never land on another thread or none.
    public static func moved<Target>(_ current: Target?, to asked: Target?, draft: String) -> Target? {
        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? asked : current
    }
}

/// The Work service's name for a document, as the `work.docs` push names it
/// (main/server/work/docs/target.ts): a LifeOS document's own id; any other
/// source (a project note, a .tcdoc, a Google Doc) as `work.docs.open` answers.
enum DocName {
    static func known(_ source: CanvasSource) -> String? {
        guard case .lifeos(let lifeos) = source, lifeos.table == .docs else { return nil }
        return lifeos.id
    }

    static func resolve(_ source: CanvasSource, on socket: TempCodeSocket) async throws -> String {
        if let known = known(source) { return known }
        return try await socket.request(Methods.WorkDocsOpen.self, .init(source: source)).doc
    }
}

/// A comment's body as the shared editor stores it: its blocks as JSON text
/// (main/server/work/docs/tools.ts `commentBody`), a paragraph per run of
/// blank lines.
enum CommentBody {
    static func blocks(_ text: String) -> String {
        let paragraphs = text.split(separator: #/\n{2,}/#, omittingEmptySubsequences: false).map { part -> JSONValue in
            .object(["type": .string("paragraph"), "content": .array([.object(["type": .string("text"), "text": .string(String(part)), "styles": .object([:])])])])
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(JSONValue.array(paragraphs)) else { return text }
        return String(decoding: data, as: UTF8.self)
    }

    /// The words of each block, a blank line between blocks; a body that is not blocks reads as it is.
    static func plain(_ body: String) -> String {
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(body.utf8)), case .array(let blocks) = value else { return body }
        return blocks.map(words).joined(separator: "\n\n")
    }

    /// A block's or an inline node's own text and its content's (a link holds its runs in `content`).
    private static func words(_ node: JSONValue) -> String {
        guard case .object(let fields) = node else { return "" }
        var out = ""
        if case .string(let text)? = fields["text"] { out += text }
        if case .array(let content)? = fields["content"] { out += content.map(words).joined() }
        return out
    }
}
