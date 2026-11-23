import SwiftUI
import TempCodeClient

/// Home's way to a receipt: a press opens the document camera at once and
/// its scan opens `ReceiptSheet`; a receipt that still waits (a Save that
/// failed earlier) opens the sheet on it instead. The `Receipt` is made at the
/// first press and kept, so its drafts outlive the sheet.
@MainActor @Observable
final class ReceiptFlow {
    /// The phone's receipts wait here until a host answers each.
    static var folder: URL { URL.applicationSupportDirectory.appending(path: "Receipts", directoryHint: .isDirectory) }

    /// A phone with a document camera; the simulator only in a DEBUG build, on the made-up scan.
    static var available: Bool {
        #if DEBUG
        true
        #else
        ReceiptScanner.isSupported
        #endif
    }

    /// The camera, or where there is none (the simulator, DEBUG) the made-up scan at once.
    static func scan(camera: Binding<Bool>, take: (ReceiptScan) -> Void) {
        if ReceiptScanner.isSupported {
            camera.wrappedValue = true
            return
        }
        #if DEBUG
        if let scan = ReceiptFixture.scan { take(scan) }
        #endif
    }

    private(set) var receipt: Receipt?
    /// The receipt queue the sheet shows.
    var shown: Receipt?
    var scanning = false

    private var made: Receipt {
        if let receipt { return receipt }
        let receipt = Receipt(source: OnDeviceText(), folder: Self.folder)
        self.receipt = receipt
        return receipt
    }

    func press() {
        let receipt = made
        // A scan this phone could not write is still held: its sheet says so and tries again.
        if receipt.unkept != nil {
            shown = receipt
        } else if receipt.pending > 0 {
            receipt.showOldest()
            shown = receipt
        } else {
            Self.scan(camera: Binding(get: { self.scanning }, set: { self.scanning = $0 }), take: took)
        }
    }

    /// The sheet opens either way: on the kept scan, or on the line that says it could not be kept.
    func took(_ scan: ReceiptScan) {
        let receipt = made
        _ = try? receipt.add(file: scan.file, mime: scan.mime, pages: scan.pages)
        shown = receipt
    }

    #if DEBUG
    /// `TC_TEST_SHEET=receipt`: the sheet on the receipt that waits, else on the made-up scan.
    func openForProof() {
        let receipt = made
        if receipt.pending > 0 {
            receipt.showOldest()
            shown = receipt
        } else if let scan = ReceiptFixture.scan {
            took(scan)
        }
    }
    #endif
}

extension View {
    /// Home's camera and sheet for receipts.
    func receiptFlow(_ flow: ReceiptFlow) -> some View {
        modifier(ReceiptFlowPresenter(flow: flow))
    }

    /// The document camera over everything, the system's own full-screen
    /// view; a scan is handed over once it has closed.
    func receiptCamera(isPresented: Binding<Bool>, take: @escaping (ReceiptScan) -> Void) -> some View {
        modifier(ReceiptCamera(isPresented: isPresented, take: take))
    }
}

private struct ReceiptFlowPresenter: ViewModifier {
    @Bindable var flow: ReceiptFlow

    func body(content: Content) -> some View {
        content
            .receiptCamera(isPresented: $flow.scanning, take: flow.took)
            .sheet(item: $flow.shown) { ReceiptSheet(receipt: $0) }
    }
}

private struct ReceiptCamera: ViewModifier {
    @Binding var isPresented: Bool
    let take: (ReceiptScan) -> Void
    @State private var taken: ReceiptScan?

    func body(content: Content) -> some View {
        content.fullScreenCover(isPresented: $isPresented, onDismiss: {
            guard let scan = taken else { return }
            taken = nil
            take(scan)
        }) {
            ReceiptScanner { scan in
                taken = scan
                isPresented = false
            }
            .ignoresSafeArea()
        }
    }
}
