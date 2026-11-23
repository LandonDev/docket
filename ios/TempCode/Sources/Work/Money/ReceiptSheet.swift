import CoreGraphics
import SwiftUI
import TempCodeClient
import UIKit

/// A receipt, from Home's `doc.viewfinder` (docs/IOS-DESIGN.md "The
/// receipt"): the scan's picture beside Amount, then Date and Seller, then
/// Category and Job, and Save. The fields fill when a host's parser answers;
/// he can type over any of them first. Cancel and a failed Save keep the
/// draft on the phone; only a host's answer removes it.
struct ReceiptSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Bindable var receipt: Receipt
    @State private var saved = 0
    @State private var scanning = false
    @State private var discarding = false

    private var hosts: [any MoneyHost] { model.registry.ordered.filter(\.work.isOn).map { $0.work } }

    private var title: String {
        guard receipt.pending > 1, let position = receipt.position else { return "Receipt" }
        return "Receipt \(position) of \(receipt.pending)"
    }

    var body: some View {
        NavigationStack {
            Form {
                if let draft = receipt.current {
                    Section {
                        HStack(spacing: Layout.rowGap) {
                            ReceiptPicture(draft: draft, receipt: receipt)
                            TextField("Amount", text: $receipt.amount)
                                .keyboardType(.decimalPad)
                                .foregroundStyle(receipt.amountValid ? Color.primary : Tint.destructiveText)
                                .accessibilityIdentifier("receipt-amount")
                        }
                        date
                        TextField("Seller", text: $receipt.seller)
                            .textInputAutocapitalization(.words)
                            .accessibilityIdentifier("receipt-seller")
                    }
                    Section {
                        Picker("Category", selection: $receipt.category) {
                            Text("None").tag(String?.none)
                            ForEach(receipt.categories, id: \.self) { Text($0).tag(String?.some($0)) }
                        }
                        .accessibilityIdentifier("receipt-category")
                        job
                    } footer: {
                        if let error = receipt.error { Text(error).foregroundStyle(Tint.destructiveText) }
                    }
                    Section {
                        Button("Scan Another", systemImage: "doc.viewfinder") { ReceiptFlow.scan(camera: $scanning, take: add) }
                        Button("Discard Receipt", systemImage: "trash", role: .destructive) { discarding = true }
                    }
                }
            }
            .disabled(receipt.saving)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if receipt.saving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(!receipt.canSave)
                            .accessibilityIdentifier("receipt-save")
                    }
                }
            }
            .confirmationDialog("Discard this receipt?", isPresented: $discarding, titleVisibility: .visible) {
                Button("Discard Receipt", role: .destructive) {
                    receipt.discard()
                    if receipt.pending == 0 { dismiss() }
                }
            }
            .task(id: receipt.current?.key) {
                await receipt.find(hosts)
                await receipt.read(hosts)
                #if DEBUG
                await ReceiptFixture.saveForProof(receipt, hosts: hosts) { landed() }
                #endif
            }
        }
        .tcSheet(.editor)
        .interactiveDismissDisabled(receipt.saving)
        .sensoryFeedback(.impact(weight: .light), trigger: saved)
        .receiptCamera(isPresented: $scanning, take: add)
    }

    /// The date as read or picked, never after today; none until either.
    @ViewBuilder
    private var date: some View {
        if let day = receipt.date.flatMap(ReceiptDay.date) {
            DatePicker("Date", selection: Binding(get: { day }, set: { receipt.date = ReceiptDay.string($0) }), in: ...Date.now, displayedComponents: .date)
                .accessibilityIdentifier("receipt-date")
        } else {
            Button("Add Date") { receipt.date = ReceiptDay.string(.now) }
                .accessibilityIdentifier("receipt-date")
        }
    }

    /// The sectors some host keeps a job in, the last one used first; a spinner while the hosts are asked.
    @ViewBuilder
    private var job: some View {
        if receipt.sectors.isEmpty {
            LabeledContent("Job") {
                if receipt.finding { ProgressView() }
            }
        } else {
            Picker("Job", selection: Binding(get: { receipt.sector ?? "" }, set: { receipt.pick($0) })) {
                ForEach(receipt.sectors, id: \.self) { key in
                    Label { Text(receipt.jobName(key) ?? Sectors.name(key)) } icon: { SectorDot(sector: key) }
                        .tag(key)
                }
            }
            .accessibilityIdentifier("receipt-job")
        }
    }

    private func add(_ scan: ReceiptScan) {
        _ = try? receipt.add(file: scan.file, mime: scan.mime, pages: scan.pages)
    }

    private func save() async {
        guard await receipt.save(hosts) != nil else { return }
        landed()
    }

    /// The host has it: the light impact, and the sheet closes unless another waits.
    private func landed() {
        saved += 1
        // Another waits: the sheet goes on to it.
        if receipt.pending == 0 { dismiss() }
    }
}

/// The scan as the photos strip draws a photo: 56 pt at the row radius with a
/// 10 % outline in the scheme's ink, the fill step until it is drawn. A PDF
/// shows its first page.
private struct ReceiptPicture: View {
    let draft: ReceiptDraft
    let receipt: Receipt
    @State private var image: UIImage?
    @Environment(\.colorScheme) private var scheme

    private var size: CGFloat { PhotoUpload.thumbnailPoints }
    private var outline: Color { (scheme == .dark ? Color.white : Color.black).opacity(0.1) }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Surface.fill
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle.rowCorner)
        .hairlineBorder(RoundedRectangle.rowCorner, color: outline)
        .accessibilityLabel("Scan")
        .task(id: draft.key) { image = await thumbnail() }
    }

    private func thumbnail() async -> UIImage? {
        let side = size * 3
        if let page = receipt.pictures(draft).first ?? (draft.mime == "image/jpeg" ? receipt.scan(draft) : nil) {
            return await UIImage(data: page)?.byPreparingThumbnail(ofSize: CGSize(width: side, height: side))
        }
        guard let data = receipt.scan(draft), let provider = CGDataProvider(data: data as CFData),
              let first = CGPDFDocument(provider)?.page(at: 1) else { return nil }
        let box = first.getBoxRect(.mediaBox)
        let scale = side / max(box.width, box.height, 1)
        let target = CGSize(width: box.width * scale, height: box.height * scale)
        return UIGraphicsImageRenderer(size: target).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: target))
            context.cgContext.translateBy(x: 0, y: target.height)
            context.cgContext.scaleBy(x: scale, y: -scale)
            context.cgContext.drawPDFPage(first)
        }
    }
}

/// The wire's day (YYYY-MM-DD) in the phone's own calendar.
enum ReceiptDay {
    private static let format: DateFormatter = {
        let format = DateFormatter()
        format.calendar = Calendar(identifier: .gregorian)
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "yyyy-MM-dd"
        return format
    }()

    static func date(_ day: String) -> Date? { format.date(from: day) }
    static func string(_ date: Date) -> String { format.string(from: date) }
}

extension Sectors {
    static func name(_ key: String) -> String { all.first { $0.key == key }?.name ?? key.capitalized }
}

/// The sheet shows one receipt queue, by its identity.
extension Receipt: @retroactive Identifiable {}
