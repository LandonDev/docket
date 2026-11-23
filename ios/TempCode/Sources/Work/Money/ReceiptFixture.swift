#if DEBUG
import Foundation
import TempCodeClient
import UIKit

/// The simulator's stand-in for the document camera (it has none): a
/// made-up receipt drawn as a flat white page, every word invented. The proof
/// (`TC_TEST_SHEET=receipt`) opens the sheet on it, and a press of Receipt
/// on the simulator takes it in the camera's place.
enum ReceiptFixture {
    static let lines: [(text: String, size: CGFloat, weight: UIFont.Weight)] = [
        ("BLUE HERON COFFEE", 64, .bold),
        ("214 Lakeview Ave", 36, .regular),
        ("11/21/2026  08:42", 36, .regular),
        ("", 36, .regular),
        ("Oat latte            5.25", 40, .regular),
        ("Blueberry scone      4.50", 40, .regular),
        ("Subtotal             9.75", 40, .regular),
        ("Tax                  0.68", 40, .regular),
        ("TOTAL               10.43", 52, .bold),
        ("", 36, .regular),
        ("Thank you", 36, .regular)
    ]
    static let page = CGSize(width: 1000, height: 1400)

    static var scan: ReceiptScan? { ReceiptPacking.pack([image]) }

    /// `TC_TEST_ACTION=receipt-save[:<sector>]`: once the hosts and the parser
    /// have answered, the sheet's Save is pressed (on that sector's job when a
    /// host keeps one), and Documents/receipt-report.json says what went and
    /// what the host answered. scripts/ios-sim-proof-local.ts reads the host back.
    static func saveForProof(_ receipt: Receipt, hosts: [any MoneyHost], saved: () -> Void) async {
        guard let action = TestHooks.action, action == "receipt-save" || action.hasPrefix("receipt-save:"), TestHooks.once("receipt-save") else { return }
        if let want = action.split(separator: ":").dropFirst().first.map(String.init), receipt.sectors.contains(want) {
            receipt.pick(sector: want)
            await receipt.read(hosts)
        }
        var report: [String: String] = ["amount": receipt.amount, "date": receipt.date ?? "", "seller": receipt.seller, "category": receipt.category ?? "", "sector": receipt.sector ?? "", "key": receipt.current?.key ?? ""]
        let answer = await receipt.save(hosts)
        report["state"] = answer?.state.rawValue ?? ""
        report["error"] = receipt.error ?? ""
        report["pending"] = String(receipt.pending)
        if answer != nil { saved() }
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? JSONEncoder().encode(report) else { return }
        try? data.write(to: documents.appending(path: "receipt-report.json"), options: .atomic)
    }

    static var image: UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: page, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: page))
            var y: CGFloat = 120
            for line in lines {
                let font = UIFont.monospacedSystemFont(ofSize: line.size, weight: line.weight)
                (line.text as NSString).draw(at: CGPoint(x: 90, y: y), withAttributes: [.font: font, .foregroundColor: UIColor.black])
                y += line.size * 1.9
            }
        }
    }
}
#endif
