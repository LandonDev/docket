import PDFKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// The reader's own sizes, written once (docs/IOS-DESIGN.md "A file on the phone").
enum ReaderMetrics {
    /// The page stamp's capsule and its distance from the foot.
    static let stamp: CGFloat = 28
    static let stampInset: CGFloat = 12
    /// The deck's filmstrip and the height of one thumbnail in it.
    static let filmstrip: CGFloat = 72
    static let thumbnail: CGFloat = 48
    /// The paper a file's loading draws: a letter page, and a slide.
    static let paperAspect: CGFloat = 8.5 / 11
    static let slideAspect: CGFloat = 16.0 / 9
    /// The loading bar's width inside the paper.
    static let bar: CGFloat = 120
    /// A paper kind's widest column.
    static let measure = TranscriptMetrics.documentColumn
}

/// What the page that hosts a file tells the kind's own view: Find was pressed, and whether the page has
/// Ask in its bar. The kind hands back what Ask should carry (its selection, else its page).
@MainActor @Observable
final class ReaderCommands {
    /// The hosting page has Ask in its bar, so the kind draws none of its own.
    let ownsAsk: Bool
    /// Moves when More's Find is pressed.
    private(set) var find = 0
    /// Ask with what the kind has picked; nil when the kind has nothing finer than the file.
    @ObservationIgnored var ask: (() -> Void)?
    /// Comment on the words he picked in a document; nil where the file takes no comments, and the
    /// hosted page's edit menu then has no Comment.
    var comment: ((String) -> Void)?

    init(ownsAsk: Bool) {
        self.ownsAsk = ownsAsk
    }

    func showFind() { find += 1 }
}

extension EnvironmentValues {
    /// A tap on a page, a slide or a picture, where the page that hosts it hides its bars on one.
    @Entry var readerTap: (() -> Void)? = nil
    /// The bars are hidden: the kind's foot (stamp, filmstrip, notes) goes with them.
    @Entry var readerImmersive = false
    /// What stands in a file's place where its host will not open it in the hosted editor: Files hands in its
    /// Quick Look, so a Word file still shows its pages. nil: the host's words alone.
    @Entry var hostedFallback: AnyView? = nil
}

/// More's rows for an open file (`ReaderVerbs.of`): the thread's Item segment and the reader page show the same.
struct ReaderMoreRows: View {
    let verbs: [ReaderVerb]
    let run: (ReaderVerb) -> Void

    var body: some View {
        ForEach(verbs.filter { $0 != .close }) { row($0) }
        if verbs.contains(.close) {
            Divider()
            row(.close)
        }
    }

    private func row(_ verb: ReaderVerb) -> some View {
        Button(verb.title, systemImage: verb.symbol) { run(verb) }
            .accessibilityIdentifier("reader-\(verb.rawValue)")
    }
}

/// A file on its way: the paper's shape at once, with a bar that follows the bytes read. Once the file's first
/// page or slide is here (`FirstPicture`, M17) it fills the same shape, and the bar moves to the paper's foot.
struct ReaderLoading: View {
    var aspect: CGFloat = ReaderMetrics.paperAspect
    /// 0 to 1 once the host has said the size; nil before that.
    let progress: Double?
    /// "Drawing 5 pages", when the host says what it is doing.
    var words: String?
    /// The first page, drawn while the rest reads.
    var picture: UIImage?

    var body: some View {
        RoundedRectangle.inlineCorner
            .fill(Surface.raised)
            .overlay {
                if let picture {
                    Image(uiImage: picture).resizable().scaledToFit()
                }
            }
            .clipShape(RoundedRectangle.inlineCorner)
            .hairlineBorder(RoundedRectangle.inlineCorner)
            .aspectRatio(aspect, contentMode: .fit)
            .overlay(alignment: picture == nil ? .center : .bottom) {
                VStack(spacing: 8) {
                    ProgressView(value: progress ?? 0)
                        .progressViewStyle(.linear)
                        .frame(width: ReaderMetrics.bar)
                    if let words {
                        Text(words).textStep(.meta).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
                .padding(.bottom, picture == nil ? 0 : ReaderMetrics.stampInset)
            }
            .frame(maxWidth: ReaderMetrics.measure)
            .padding(Layout.textEdge)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Surface.chrome)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(words ?? "Loading")
            .accessibilityValue(progress.map { Text($0, format: .percent.precision(.fractionLength(0))) } ?? Text(""))
            .accessibilityIdentifier("reader-loading")
    }
}

/// The bytes a file's read has brought so far, for its loading bar, and its first page once that is here.
@MainActor @Observable
final class ReadProgress {
    var share: Double?
    var picture: UIImage?

    /// Draws the first picture once, as it lands: a PNG as it is, a slide's one-page PDF at the reader's width.
    func show(_ first: FirstPicture) {
        switch first.kind {
        case .png:
            picture = UIImage(data: first.data)
        case .pdf:
            guard let page = PDFDocument(data: first.data)?.page(at: 0) else { return }
            let box = page.bounds(for: .cropBox)
            let width = CGFloat(FirstPicture.widthMax) / 2
            picture = page.thumbnail(of: CGSize(width: width, height: width * box.height / max(1, box.width)), for: .cropBox)
        }
    }
}

/// "4 of 12" on glass at a page's foot.
struct PageStamp: View {
    let words: String

    var body: some View {
        Text(words)
            .textStep(.meta)
            .monospacedDigit()
            .padding(.horizontal, 12)
            .frame(minHeight: ReaderMetrics.stamp)
            .tcGlass()
            .padding(.bottom, ReaderMetrics.stampInset)
            .accessibilityIdentifier("pdf-page")
    }
}
