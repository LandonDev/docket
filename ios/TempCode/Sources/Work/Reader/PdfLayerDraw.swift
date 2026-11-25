import PDFKit
import TempCodeClient
import TempCodeContract
import UIKit

/// Draws what the host keeps over a PDF onto PDFKit's pages (docs/IOS-DESIGN.md "A file on the phone"): each of his
/// highlights a neutral wash of the paper's ink per line, with the note glyph at its first line when it has a note;
/// a form's values in its own widgets, made read only so a tap opens the field's sheet rather than typing into a copy
/// that goes nowhere; a field with no widget (one an agent placed on a flat form) as words in its box; an agent's
/// value that waits on the added tint. Every view takes the reader's earlier marks off first. The bytes are never
/// changed: what leaves is the host's export.
@MainActor
enum PdfLayerDraw {
    /// Tints on paper keep their light values in both appearances: the page is white in dark too.
    private static let wash = UIColor(white: 0, alpha: 0.14)
    private static let added = UIColor.systemGreen.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)).withAlphaComponent(0.22)
    private static let ink = UIColor.label.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))

    static func apply(_ layer: PdfPhoneView, to view: PDFView) {
        guard let document = view.document else { return }
        let marks = layer.marks ?? []
        let fields = layer.fields ?? []
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { continue }
            for old in page.annotations where PdfLayerName.ours(old.userName) { page.removeAnnotation(old) }
            let box = page.bounds(for: .cropBox)
            for mark in marks where mark.page == index + 1 { draw(mark, on: page, box: box) }
            var widgets = Set<String>()
            for widget in page.annotations where widget.type == "Widget" {
                guard let name = widget.fieldName, let field = PdfFields.field(named: name, in: fields) else { continue }
                widgets.insert(name)
                fill(widget, with: field)
                if field.state == .proposed { tint(widget.bounds, key: field.key, on: page) }
            }
            for field in fields where field.page == index + 1 && !widgets.contains(field.key) {
                guard let rect = PdfBox.rect(field.bbox, page: box) else { continue }
                if field.state == .proposed { tint(rect, key: field.key, on: page) }
                overlay(field, in: rect, on: page)
            }
        }
    }

    private static func draw(_ mark: PdfMarkPhone, on page: PDFPage, box: CGRect) {
        let lines = mark.quads.compactMap { PdfBox.rect($0, page: box) }
        for line in lines {
            let wash = PDFAnnotation(bounds: line, forType: .highlight, withProperties: nil)
            wash.color = Self.wash
            wash.userName = PdfLayerName.mark(mark.id)
            page.addAnnotation(wash)
        }
        guard let note = mark.note, !note.isEmpty, let first = lines.first else { return }
        // The note's glyph sits at the first line's end, its own height.
        let side = first.height
        let glyph = PDFAnnotation(bounds: CGRect(x: first.maxX, y: first.minY, width: side, height: side), forType: .text, withProperties: nil)
        glyph.iconType = .comment
        glyph.color = ink
        glyph.contents = note
        glyph.userName = PdfLayerName.mark(mark.id)
        page.addAnnotation(glyph)
    }

    /// The file's own widget shows the value the copy will carry, and takes no typing.
    private static func fill(_ widget: PDFAnnotation, with field: PdfFieldPhone) {
        let shown = PdfFields.shown(field)
        if field.type == "checkbox" {
            widget.buttonWidgetState = shown == nil ? .offState : .onState
        } else {
            widget.widgetStringValue = shown ?? ""
        }
        widget.isReadOnly = true
    }

    /// A field with no widget: its words in its box, in the paper's ink; empty, it is still there to tap.
    private static func overlay(_ field: PdfFieldPhone, in rect: CGRect, on page: PDFPage) {
        let words = PDFAnnotation(bounds: rect, forType: .freeText, withProperties: nil)
        words.contents = PdfFields.shown(field) ?? ""
        words.font = UIFont.systemFont(ofSize: max(rect.height * 0.62, 1))
        words.fontColor = ink
        words.color = .clear
        let border = PDFBorder()
        border.lineWidth = 0
        words.border = border
        words.userName = PdfLayerName.field(field.key)
        page.addAnnotation(words)
    }

    /// An agent's value waits: the added tint over its box until he takes or drops it.
    private static func tint(_ rect: CGRect, key: String, on page: PDFPage) {
        let tint = PDFAnnotation(bounds: rect, forType: .square, withProperties: nil)
        tint.color = .clear
        tint.interiorColor = added
        let border = PDFBorder()
        border.lineWidth = 0
        tint.border = border
        tint.userName = PdfLayerName.field(key)
        page.addAnnotation(tint)
    }
}
