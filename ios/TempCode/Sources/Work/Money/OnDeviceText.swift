import Foundation
import ImageIO
import TempCodeClient
import Vision

/// The phone's reader for a receipt: Vision's accurate text recognizer, run
/// on the phone (it has no network recognizer), with language correction off
/// so a total or a date reads as printed. Each observation gives its top
/// candidate and its box as left, top, right, bottom in the page's own
/// pixels with the origin at the top left; a later page stands below the
/// pages before it, so one list reads top to bottom.
final class OnDeviceText: TextSource {
    func lines(of pages: [Data]) async throws -> [ReceiptTextLine] {
        // Recognition takes a second or more a page: off the main thread.
        try await withCheckedThrowingContinuation { done in
            DispatchQueue.global(qos: .userInitiated).async {
                do { done.resume(returning: try Self.read(pages)) } catch { done.resume(throwing: error) }
            }
        }
    }

    nonisolated private static func read(_ pages: [Data]) throws -> [ReceiptTextLine] {
        var lines: [ReceiptTextLine] = []
        var top = 0.0
        for page in pages {
            guard let source = CGImageSourceCreateWithData(page as CFData, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { continue }
            let width = Double(image.width)
            let height = Double(image.height)
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            // The pages are drawn upright (ReceiptPacking), so the pixels are the page as read.
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
            for observation in request.results ?? [] {
                guard let best = observation.topCandidates(1).first else { continue }
                lines.append(ReceiptTextLine(text: best.string, box: box(observation.boundingBox, width: width, height: height, top: top), score: Double(best.confidence)))
            }
            top += height
        }
        return lines
    }

    /// Vision's normalized box (origin at the bottom left) in the page's pixels, origin at the top left.
    nonisolated static func box(_ normalized: CGRect, width: Double, height: Double, top: Double) -> [Double] {
        [
            Double(normalized.minX) * width,
            top + (1 - Double(normalized.maxY)) * height,
            Double(normalized.maxX) * width,
            top + (1 - Double(normalized.minY)) * height
        ]
    }
}
