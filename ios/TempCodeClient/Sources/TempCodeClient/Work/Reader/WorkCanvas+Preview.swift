import Foundation
import TempCodeContract

extension WorkCanvas {
    /// A document's print pages where this host can draw them now, or nil: Page Preview's row is then absent.
    /// A PDF and a deck have no Page Preview: the reader already shows the pages that print (`printPages`).
    public func preview(for item: CanvasItem) -> PagePreviewSource? {
        switch ItemBody.of(item) {
        case .hosted, .unavailable: documentPreview(item)
        default: nil
        }
    }

    /// The pages More's Print sends to the system's print sheet for a PDF or a deck, read at one `rev`.
    public func printPages(for item: CanvasItem) -> PagePreviewSource? {
        switch ItemBody.of(item) {
        case .pdf:
            // A PDF prints as itself.
            return PagePreviewSource(
                open: {
                    let view = try await self.pdf(item.id)
                    return PrintPages(rev: view.rev, size: Int(view.size))
                },
                read: { rev, offset, length in try await self.pdfFrame(item.id, rev: rev, offset: offset, length: length) }
            )
        case .slides:
            // A deck prints as the file's own render, never the proposed one.
            return PagePreviewSource(
                open: {
                    guard let render = try await self.deck(item.id).renders.file else { throw DeckNotDrawn() }
                    return PrintPages(rev: render.rev, size: Int(render.size), pages: render.pages)
                },
                read: { _, offset, length in try await self.deckFrame(item.id, offset: offset, length: length) }
            )
        default:
            return nil
        }
    }

    /// A document's pages: its Word file as the host draws it (`work.formats.preview {format: docx}`), since
    /// the window's own print page needs a window. Only for a key that may act, on a host that has the call;
    /// a host that cannot draw it (no LibreOffice) says so in its own words where the pages would be.
    private func documentPreview(_ item: CanvasItem) -> PagePreviewSource? {
        guard item.kind == .document, ReaderFile.parts(item).comments != nil, can.has(Self.previewMethod), mayAct else { return nil }
        let source = item.source
        return PagePreviewSource(
            open: {
                do {
                    let drawn = try await self.socket.request(Methods.WorkFormatsPreview.self, .init(source: source, itemId: item.id, format: .docx))
                    return PrintPages(rev: drawn.rev, size: Int(drawn.size), pages: drawn.pages)
                } catch {
                    // A host from before Preview: the row goes, and is not offered again this session.
                    if HostCan.saysUnknown(error) { self.can.mark(Self.previewMethod) }
                    throw error
                }
            },
            read: { rev, offset, length in
                let frame = try await self.socket.request(Methods.WorkFormatsPreviewRead.self, .init(source: source, itemId: item.id, rev: rev, offset: offset, length: length))
                return FileBytes(data: frame.data, size: 0, rev: rev)
            }
        )
    }

    static let previewMethod = "work.formats.preview"
}

struct DeckNotDrawn: LocalizedError, CustomStringConvertible {
    var description: String { DeckRender.missingWords(changesWaiting: false) }
    var errorDescription: String? { description }
}
