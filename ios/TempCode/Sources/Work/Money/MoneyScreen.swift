import SwiftUI
import TempCodeClient
import TempCodeContract
import UIKit

/// A job's Money (docs/IOS-DESIGN.md "Work on the phone", ### Money), from the job's page and Today's Owed rows: what
/// waits for his accept, what is owed, the span's figures and its newest rows, from one `work.money.read`. Accept,
/// Discard and Paid write the job's own ledger (operate) and tell no one; entries, invoices, trips and export stay
/// on the desktop. The rules and words are `MoneyPage` (the client package).
struct MoneyScreen: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    @State private var span = MoneyPage.Span.now(.month, at: .now, zone: .current)
    @State private var read: MoneyReadPhone?
    /// The span `read` is of: while it is not the one picked, the span's section draws its bones, never the old
    /// span's sums under the new span's name.
    @State private var readSpan: MoneyPage.Span?
    @State private var failure: String?
    @State private var loading = false
    @State private var confirming: MoneyReadPhone.ToConfirm?
    @State private var paying: String?
    @State private var capsule: MoneyCapsule?
    @State private var done = 0

    private var work: WorkHost { client.work }
    private var today: String { MoneyPage.today(.now, zone: .current) }

    var body: some View {
        content
            .navigationTitle("Money")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .primaryAction) { spanMenu } }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Group {
                    if let capsule {
                        UndoCapsule(line: capsule.line, identifier: "money-undo", undo: capsule.undo.map { id in { Task { await undrop(id) } } })
                    }
                }
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: Motion.travel * 3)))
            }
            .animation(Motion.base, value: capsule?.id)
            .task(id: capsule?.id) {
                guard capsule != nil else { return }
                try? await Task.sleep(for: .seconds(FleetToastCenter.lingerSeconds))
                if !Task.isCancelled { capsule = nil }
            }
            .sheet(item: $confirming) { item in
                MoneyAcceptSheet(work: work, item: item, categories: read?.categories ?? []) { heard in
                    Task { await landed(heard, filed: true) }
                }
            }
            .sensoryFeedback(.impact(weight: .light), trigger: done)
            // Read again on its push (a receipt arrived or was filed elsewhere), on a new span, and by pull.
            .task(id: "\(work.moneyRev[workspace.id] ?? 0)|\(span.from)|\(span.kind.rawValue)") { await load() }
            .refreshable { await load() }
            .accessibilityIdentifier("money")
    }

    @ViewBuilder private var content: some View {
        let shown = read.map(MoneyPage.shown)
        // The span's state first: a picked span that failed says so, never "No Money Yet" from the span before it.
        switch MoneyPage.pageState(shown, spanRead: readSpan == span, failed: failure != nil) {
        case .list:
            if let read, let shown { list(read, shown) }
        case .empty:
            ContentUnavailableView("No Money Yet", systemImage: "dollarsign.circle", description: Text("A receipt you scan for \(workspace.name) waits here."))
        case .failed:
            ContentUnavailableView {
                Label("Can’t Read Money", systemImage: "dollarsign.circle")
            } description: {
                Text(failure ?? "")
            } actions: {
                Button("Try Again") { Task { await load() } }
            }
        case .bones:
            List { MoneyBones() }
                .listStyle(.plain)
        }
    }

    private func list(_ read: MoneyReadPhone, _ shown: MoneyPage.Shown) -> some View {
        List {
            if let failure, readSpan == span {
                Section { MoneyLine(words: failure, tint: Tint.destructiveText, retry: { await load() }) }
            }
            ForEach(shown.problems, id: \.self) { line in
                MoneyLine(words: line, tint: Tint.destructiveText)
            }
            if !shown.waiting.isEmpty {
                Section {
                    ForEach(shown.waiting, id: \.id) { waitingRow($0) }
                } header: {
                    SectionHeader("To Confirm").listRowInsets(EdgeInsets())
                }
            }
            owedSection("Owed to You", shown.owedToHim)
            owedSection("You Owe", shown.heOwes)
            Section {
                if readSpan != span {
                    // The picked span is still being read, or its read failed: its own line, never the old figures.
                    if let failure {
                        MoneyLine(words: failure, tint: Tint.destructiveText, retry: { await load() })
                    } else {
                        MoneyBones()
                    }
                } else {
                    MoneyFigures(sums: read.sums)
                    ForEach(shown.recent, id: \.row) { entryRow($0) }
                    if read.rows.isEmpty {
                        MoneyLine(words: "Nothing in \(span.label)")
                    } else if shown.more > 0 {
                        MoneyLine(words: "\(shown.more) more in the ledger")
                    }
                }
            } header: {
                SectionHeader(span.label).listRowInsets(EdgeInsets())
            }
        }
        .listStyle(.plain)
        .animation(reduceMotion ? nil : Motion.rowLeave, value: shown.waiting.map(\.id) + shown.owedToHim.map(\.sig) + shown.heOwes.map(\.sig))
    }

    // MARK: - rows

    private func waitingRow(_ item: MoneyReadPhone.ToConfirm) -> some View {
        let reading = item.state == .reading
        let may = work.may(.moneyAccept)
        return MoneyRow(
            glyph: "doc.text.viewfinder",
            title: reading ? "Reading" : MoneyPage.waitingName(item),
            detail: reading ? nil : item.fields.date.map { MoneyPage.shortDay($0, today: today) },
            amount: reading ? nil : item.fields.amount.map(MoneyPage.money),
            busy: reading,
            open: reading || !may ? nil : { confirming = item }
        )
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if !reading, work.may(.moneyDrop) {
                Button("Discard", role: .destructive) { Task { await drop(item) } }
            }
        }
        .contextMenu {
            if !reading, may { Button("Review", systemImage: "checkmark.circle") { confirming = item } }
            if !reading, work.may(.moneyDrop) { Button("Discard", systemImage: "trash", role: .destructive) { Task { await drop(item) } } }
        }
        .accessibilityIdentifier("money-waiting")
    }

    @ViewBuilder
    private func owedSection(_ title: String, _ rows: [MoneyReadPhone.Owed]) -> some View {
        if !rows.isEmpty {
            Section {
                ForEach(rows, id: \.sig) { owedRow($0) }
            } header: {
                SectionHeader(title).listRowInsets(EdgeInsets())
            }
        }
    }

    private func owedRow(_ row: MoneyReadPhone.Owed) -> some View {
        let words = MoneyPage.owedWords(who: row.who, what: row.what, reimburse: row.reimburse)
        // One status covers both sides of a row with money both ways: it is settled in the sheet, not here.
        let canPay = !row.both && work.may(.moneyPaid)
        let key = "\(row.row):\(row.way.rawValue)"
        return MoneyRow(
            title: words.lead,
            detail: [words.after, MoneyPage.sinceWords(row.since, today: today)].compactMap { $0 }.joined(separator: ", "),
            amount: MoneyPage.money(row.amount),
            busy: paying == key
        )
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if canPay {
                Button("Paid") { Task { await pay(row, key: key) } }.tint(Tint.success)
            }
        }
        .contextMenu {
            if canPay { Button("Paid", systemImage: "checkmark") { Task { await pay(row, key: key) } } }
        }
        .accessibilityActions {
            if canPay { Button("Paid") { Task { await pay(row, key: key) } } }
        }
        .accessibilityIdentifier("money-owed")
    }

    private func entryRow(_ row: MoneyReadPhone.Row) -> some View {
        let title = row.who.isEmpty ? (row.what.isEmpty ? "Entry" : row.what) : row.who
        let detail = [row.date.map { MoneyPage.shortDay($0, today: today) }, row.category.isEmpty ? nil : row.category, MoneyPage.openWord(row.status)].compactMap { $0 }.joined(separator: ", ")
        return MoneyRow(title: title, detail: detail.isEmpty ? nil : detail, amount: MoneyPage.rowMoney(in: row.in, out: row.out), positive: MoneyPage.moneyIn(row))
            .accessibilityIdentifier("money-entry")
    }

    /// Month or year, and a step either way: the span the figures and rows are of.
    private var spanMenu: some View {
        Menu {
            Picker("Span", selection: Binding(get: { span.kind }, set: { span = MoneyPage.Span.now($0, at: .now, zone: .current) })) {
                Text("Month").tag(MoneyPage.Span.Kind.month)
                Text("Year").tag(MoneyPage.Span.Kind.year)
            }
            Section {
                Button("Previous", systemImage: "chevron.left") { span = span.step(-1) }
                Button("Next", systemImage: "chevron.right") { span = span.step(1) }
            }
        } label: {
            Label("Span", systemImage: "calendar")
        }
        .accessibilityIdentifier("money-span")
    }

    // MARK: - reads and writes

    private func load() async {
        guard work.may(.moneyRead) else { return }
        loading = true
        defer { loading = false }
        let asked = span
        // A failure of the span he left is not said in the new one's place.
        if readSpan != asked { failure = nil }
        do {
            let answer = try await work.moneyRead(workspaceId: workspace.id, from: asked.from, to: asked.to)
            // A read for a span he has since left lands nowhere.
            guard asked == span else { return }
            read = answer
            readSpan = asked
            failure = nil
        } catch {
            guard asked == span else { return }
            // What showed stays; the line says the read failed, in Work's words, never the host's raw text.
            failure = WorkErrorWords.readFailure(ActionError.wrap(error).message, host: client.environment.name)
        }
    }

    private func drop(_ item: MoneyReadPhone.ToConfirm) async {
        do {
            let dropped = try await work.moneyDrop(id: item.id)
            capsule = dropped
                ? MoneyCapsule(line: "Discarded \(MoneyPage.waitingName(item))", undo: item.id)
                : MoneyCapsule(line: "\(MoneyPage.waitingName(item)) was already filed", undo: nil)
            done += 1
        } catch {
            capsule = MoneyCapsule(line: ActionError.wrap(error).message, undo: nil)
        }
        await load()
    }

    private func undrop(_ id: String) async {
        capsule = nil
        do {
            _ = try await work.moneyDrop(id: id, undo: true)
        } catch {
            capsule = MoneyCapsule(line: "Couldn’t undo", undo: nil)
        }
        await load()
    }

    private func pay(_ row: MoneyReadPhone.Owed, key: String) async {
        paying = key
        defer { paying = nil }
        do {
            await landed(MoneyPage.heard(try await work.moneyPaid(workspaceId: workspace.id, row: row)), filed: false)
        } catch {
            capsule = MoneyCapsule(line: ActionError.wrap(error).message, undo: nil)
        }
    }

    /// What a write's answer says, in one capsule, then the page as the ledger is now.
    private func landed(_ heard: MoneyPage.Heard, filed: Bool) async {
        switch heard {
        case .written:
            capsule = MoneyCapsule(line: filed ? "Filed in the ledger" : "Marked paid", undo: nil)
            done += 1
        case .suggested:
            capsule = MoneyCapsule(line: MoneyPage.suggestedWords, undo: nil)
            done += 1
        case .changed:
            capsule = MoneyCapsule(line: MoneyPage.changedWords, undo: nil)
        }
        await load()
    }
}

struct MoneyCapsule: Equatable {
    let line: String
    /// The waiting receipt Undo puts back.
    let undo: String?
    let id = UUID()
}

/// One line of the page: a glyph or nothing in the mark slot, the title and one line under it, the amount trailing
/// in tabular figures. A spinner stands in the mark slot while its thing works.
struct MoneyRow: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    var glyph: String?
    let title: String
    var detail: String?
    var amount: String?
    /// Money in: the amount in the success ink, as the desktop's "+".
    var positive = false
    var busy = false
    var open: (() -> Void)?

    var body: some View {
        Group {
            if let open {
                Button(action: open) { content }.buttonStyle(.pressable)
            } else {
                content
            }
        }
        .listRowInsets(Layout.rowInsets)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(open == nil ? [] : .isButton)
    }

    private var content: some View {
        HStack(alignment: .center, spacing: Layout.rowGap) {
            Group {
                if busy {
                    ProgressView().controlSize(.small)
                } else if let glyph {
                    Image(systemName: glyph).font(TextStep.title.font).foregroundStyle(.secondary)
                }
            }
            .frame(width: Layout.glyphWidth + Layout.markWidth)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).textStep(.title).lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                if let detail, !detail.isEmpty { Text(detail).textStep(.meta).lineLimit(typeSize.isAccessibilitySize ? 2 : 1) }
                // At accessibility sizes the amount goes under the words, as the span's sums stack.
                if typeSize.isAccessibilitySize, let amount { amountText(amount) }
            }
            if !typeSize.isAccessibilitySize {
                Spacer(minLength: Layout.rowGap)
                if let amount { amountText(amount) }
            }
        }
        .padding(.vertical, Layout.rowVertical)
        .frame(minHeight: Layout.rowHeight + 8)
        .contentShape(Rectangle())
    }

    private func amountText(_ amount: String) -> some View {
        Text(amount)
            .textStep(.title, tint: positive ? Tint.successText : nil)
            .monospacedDigit()
            .lineLimit(1)
    }
}

/// The span's three figures in one row, each its label over its sum, stacked at accessibility sizes so no sum is
/// cut; what is owed is said by its own sections.
private struct MoneyFigures: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let sums: MoneyReadPhone.Sums

    var body: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: Layout.rowGap)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: Layout.rowGap * 3))
        layout {
            figure("In", sums.in)
            figure("Out", sums.out)
            figure("Net", sums.net)
            if !stacked { Spacer(minLength: 0) }
        }
        .padding(.vertical, Layout.rowVertical)
        .listRowInsets(Layout.rowInsets)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("money-figures")
    }

    private func figure(_ label: String, _ cents: Double) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).textStep(.meta)
            Text(MoneyPage.money(cents)).textStep(.title, weight: .semibold).monospacedDigit()
        }
    }
}

/// One quiet line: an empty span, the rows past the cut, a fault of the books, a read that failed with Retry.
private struct MoneyLine: View {
    let words: String
    var tint: Color?
    var retry: (() async -> Void)?

    // The failed-read row of every Work place: the words wrap whole, Try Again beside them (under them at
    // accessibility sizes) with a spinner while it reads.
    var body: some View {
        FailedRead(words: words, retry: retry, identifier: "money-line", tint: tint)
    }
}

/// The first read's shape, redacted: the figures and three rows, never a centred spinner.
private struct MoneyBones: View {
    var body: some View {
        Group {
            MoneyFigures(sums: MoneyReadPhone.Sums(in: 0, out: 0, net: 0, owedToHim: 0, heOwes: 0))
            ForEach(0..<3, id: \.self) { _ in MoneyRow(title: "Placeholder seller", detail: "Nov 20, Travel", amount: "$00.00") }
        }
        .redacted(reason: .placeholder)
        .accessibilityLabel("Loading money")
    }
}

/// His accept of one waiting receipt: its picture, then the fields as read, his to change; Accept files it into the
/// job's ledger (`work.money.accept`) and stays off until an amount and a day are there.
private struct MoneyAcceptSheet: View {
    @Environment(\.dismiss) private var dismiss
    let work: WorkHost
    let item: MoneyReadPhone.ToConfirm
    let categories: [String]
    let accepted: (MoneyPage.Heard) -> Void
    /// The receipt's picture is drawn from a copy no longer than this on either side: enough to read, far less to hold.
    private static let pictureSide: CGFloat = 1200
    private static let pictureSize = CGSize(width: pictureSide, height: pictureSide)
    @State private var amount = ""
    @State private var date: String?
    @State private var who = ""
    @State private var what = ""
    @State private var category: String?
    @State private var way = MoneyAcceptFields.Way.out
    @State private var picture: UIImage?
    /// The picture did not come: its slot goes, and the fields stand alone.
    @State private var pictureFailed = false
    @State private var saving = false
    @State private var problem: String?

    private var fields: MoneyAcceptFields? {
        MoneyPage.acceptFields(amount: ReceiptAmount.cents(amount), date: date, who: who, what: what, category: category ?? "", way: way)
    }

    var body: some View {
        NavigationStack {
            Form {
                if item.picture, !pictureFailed {
                    Section {
                        ZStack {
                            Surface.fill
                            if let picture {
                                Image(uiImage: picture).resizable().scaledToFit()
                            } else {
                                ProgressView()
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: Layout.rowHeight * 5)
                        .clipShape(RoundedRectangle.rowCorner)
                        .accessibilityLabel("Receipt")
                        .listRowInsets(Layout.rowInsets)
                    }
                }
                Section {
                    HStack(spacing: 0) {
                        Text("$").foregroundStyle(.secondary).accessibilityHidden(true)
                        TextField("Amount", text: $amount, prompt: Text("0.00"))
                            .keyboardType(.decimalPad)
                            .foregroundStyle(amount.isEmpty || ReceiptAmount.cents(amount) != nil ? Color.primary : Tint.destructiveText)
                            .accessibilityIdentifier("money-accept-amount")
                    }
                    if let day = date.flatMap(ReceiptDay.date) {
                        DatePicker("Date", selection: Binding(get: { day }, set: { date = ReceiptDay.string($0) }), in: ReceiptDay.first...Date.now, displayedComponents: .date)
                    } else {
                        Button("Add Date") { date = ReceiptDay.string(.now) }
                    }
                    Picker("Money", selection: $way) {
                        Text("Out").tag(MoneyAcceptFields.Way.out)
                        Text("In").tag(MoneyAcceptFields.Way.`in`)
                    }
                    .pickerStyle(.segmented)
                }
                Section {
                    TextField("Who", text: $who).textInputAutocapitalization(.words)
                    TextField("For", text: $what)
                    Picker("Category", selection: $category) {
                        Text("None").tag(String?.none)
                        ForEach(Array(Set(categories + [category].compactMap { $0 })).sorted(), id: \.self) { Text($0).tag(String?.some($0)) }
                    }
                } footer: {
                    if let problem { Text(problem).foregroundStyle(Tint.destructiveText) }
                }
            }
            .disabled(saving)
            .navigationTitle(MoneyPage.waitingName(item))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Accept") { Task { await accept() } }
                            .disabled(fields == nil)
                            .accessibilityIdentifier("money-accept")
                    }
                }
            }
            .task(id: item.id) {
                fill()
                await loadPicture()
            }
        }
        .tcSheet(.editor)
        .interactiveDismissDisabled(saving)
    }

    private func fill() {
        amount = item.fields.amount.map { ReceiptAmount.text(Int($0)) } ?? ""
        date = item.fields.date
        who = item.fields.who ?? ""
        what = item.fields.what ?? ""
        category = item.fields.category
        way = item.fields.way == .`in` ? .`in` : .out
    }

    /// The picture a part at a time, as the host sends it; a spinner while it comes, and a failure (or a key that may
    /// not read it) drops its slot and leaves the fields.
    private func loadPicture() async {
        guard item.picture else { return }
        guard work.may(.moneyPicture) else { return pictureFailed = true }
        var data = Data()
        var part = 0
        var parts = 1
        while part < parts {
            guard let got = try? await work.moneyPicture(id: item.id, part: part), let bytes = Data(base64Encoded: got.dataBase64) else {
                if !Task.isCancelled { withAnimation(Motion.crossFade) { pictureFailed = true } }
                return
            }
            data.append(bytes)
            parts = got.parts
            part += 1
        }
        picture = await UIImage(data: data)?.byPreparingThumbnail(ofSize: Self.pictureSize)
        if picture == nil { withAnimation(Motion.crossFade) { pictureFailed = true } }
    }

    private func accept() async {
        guard let fields else { return }
        saving = true
        defer { saving = false }
        do {
            let heard = MoneyPage.heard(try await work.moneyAccept(id: item.id, fields: fields))
            accepted(heard)
            dismiss()
        } catch {
            problem = ActionError.wrap(error).message
        }
    }
}

/// A waiting receipt is one sheet by its id.
extension MoneyReadPhone.ToConfirm: @retroactive Identifiable {}
