import AVFoundation
import SwiftUI
import TempCodeClient
import UIKit
import VisionKit

/// What the document camera gave: the file the host keeps and the pages the reader reads.
struct ReceiptScan {
    let file: Data
    let mime: String
    let pages: [Data]
}

/// VisionKit's document camera: it finds the page's edges and flattens it.
/// Cancel or a failure ends it with nothing.
struct ReceiptScanner: UIViewControllerRepresentable {
    let done: (ReceiptScan?) -> Void

    /// False on the simulator: the DEBUG build then takes the made-up scan (`ReceiptFixture`).
    static var isSupported: Bool { VNDocumentCameraViewController.isSupported }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let camera = VNDocumentCameraViewController()
        camera.delegate = context.coordinator
        return camera
    }

    func updateUIViewController(_ camera: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let done: (ReceiptScan?) -> Void

        init(done: @escaping (ReceiptScan?) -> Void) {
            self.done = done
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            done(ReceiptPacking.pack((0..<scan.pageCount).map { scan.imageOfPage(at: $0) }))
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            done(nil)
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: any Error) {
            done(nil)
        }
    }
}

/// The scan as the host takes it (docs/agents/work-money.md): one page is a
/// JPEG, its long edge 2000 px, re-encoded at falling quality until it fits
/// one 2 MiB part; several pages are one PDF, each page drawn at the same
/// bound. Every page is redrawn upright first, so the reader sees it as read.
enum ReceiptPacking {
    static let longEdge: CGFloat = 2000
    /// US Letter in points: every page of a PDF is fitted into it.
    static let pdfBound = CGRect(x: 0, y: 0, width: 612, height: 792)
    static let qualities: [CGFloat] = [0.8, 0.7, 0.6, 0.5, 0.4, 0.3]

    static func pack(_ images: [UIImage]) -> ReceiptScan? {
        let pages = images.compactMap { jpeg(upright($0)) }
        guard let first = pages.first else { return nil }
        if pages.count == 1 { return ReceiptScan(file: first, mime: "image/jpeg", pages: pages) }
        return ReceiptScan(file: pdf(pages), mime: "application/pdf", pages: pages)
    }

    /// Redrawn at one pixel a point, its long edge at most 2000 px, orientation baked in.
    static func upright(_ image: UIImage) -> UIImage {
        let size = image.size
        let scale = min(1, longEdge / max(size.width, size.height, 1))
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
    }

    /// The first quality that fits one part; the smallest when none does.
    static func jpeg(_ image: UIImage) -> Data? {
        var smallest: Data?
        for quality in qualities {
            guard let data = image.jpegData(compressionQuality: quality) else { continue }
            if data.count <= ReceiptParts.maxBytes { return data }
            smallest = data
        }
        return smallest
    }

    /// One page per picture, each fitted into the same bound and centred.
    static func pdf(_ pages: [Data]) -> Data {
        UIGraphicsPDFRenderer(bounds: pdfBound).pdfData { context in
            for page in pages {
                guard let image = UIImage(data: page) else { continue }
                context.beginPage()
                image.draw(in: AVMakeRect(aspectRatio: image.size, insideRect: pdfBound))
            }
        }
    }
}
