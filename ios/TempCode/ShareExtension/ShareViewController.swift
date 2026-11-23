import SwiftUI
import TempCodeClient
import UIKit
import UniformTypeIdentifiers

/// Save to TempCode, the share extension's one screen (docs/agents/work-phone-files.md "Save to
/// TempCode"). It copies what was shared into its own temporary folder while the other app still lends
/// it, shows the sheet (with the names of what it could not copy), and on Save queues the files in the App Group and sends them itself with the
/// copy of the host's key the app left in the group's keychain. What it cannot send, the app sends when
/// it next comes forward. It raises no notice: the sheet says how the save went.
final class ShareViewController: UIViewController {
    private var model: ShareSheetModel?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimating()
        view.addSubview(spinner)
        NSLayoutConstraint.activate([spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        Task {
            let loaded = await SharePicks.load(extensionContext?.inputItems ?? [])
            spinner.removeFromSuperview()
            show(loaded)
        }
    }

    /// The sheet, also when nothing could be read: it says so, and Done closes it.
    private func show(_ loaded: SharePicks.Loaded) {
        guard let root = ShareInbox.groupRoot(), !loaded.picks.isEmpty || !loaded.unread.isEmpty else { return finish(saved: false) }
        let model = ShareSheetModel(inbox: ShareInbox(root: root), root: root, keys: ShareKeys.group, picks: loaded.picks, unread: loaded.unread)
        self.model = model
        let sheet = ShareSheetView(model: model, cancel: { [weak self] in self?.finish(saved: false) }, done: { [weak self] in self?.finish(saved: true) })
        let host = UIHostingController(rootView: sheet)
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        host.didMove(toParent: self)
    }

    private func finish(saved: Bool) {
        model?.finish()
        if saved {
            extensionContext?.completeRequest(returningItems: nil)
        } else {
            extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
        }
    }
}

/// What the other app shared, copied where the sheet can read it: a provider's file is lent only for
/// the length of its callback.
enum SharePicks {
    /// A result for every attachment: its copy, or its name when it could not be copied.
    struct Loaded {
        var picks: [SharePick] = []
        var unread: [String] = []
    }

    static func load(_ items: [Any]) async -> Loaded {
        let folder = FileManager.default.temporaryDirectory.appending(path: "share-\(UUID().uuidString)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var loaded = Loaded()
        for (index, provider) in items.compactMap({ $0 as? NSExtensionItem }).flatMap({ $0.attachments ?? [] }).enumerated() {
            let kind = kindOf(provider)
            if let pick = await copy(provider, kind: kind, into: folder, number: index + 1) {
                loaded.picks.append(pick)
            } else {
                loaded.unread.append(ShareSummary.name(provider.suggestedName, kind: kind, at: Date()))
            }
        }
        return loaded
    }

    private static func kindOf(_ provider: NSItemProvider) -> ShareSummary.Kind {
        provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) ? .video : provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) ? .photo : .file
    }

    private static func copy(_ provider: NSItemProvider, kind: ShareSummary.Kind, into folder: URL, number: Int) async -> SharePick? {
        let type = kind == .video ? UTType.movie : kind == .photo ? UTType.image : UTType.item
        guard provider.hasItemConformingToTypeIdentifier(type.identifier) else { return nil }
        let suggested = provider.suggestedName
        let copied: URL? = await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url else { return continuation.resume(returning: nil) }
                // Each copy in a folder of its own, under the file's own name: two files may share one.
                let own = folder.appending(path: "\(number)", directoryHint: .isDirectory)
                try? FileManager.default.createDirectory(at: own, withIntermediateDirectories: true)
                let target = own.appending(path: url.lastPathComponent)
                do {
                    try FileManager.default.copyItem(at: url, to: target)
                    continuation.resume(returning: target)
                } catch {
                    continuation.resume(returning: nil)
                }
            }
        }
        guard let copied else { return nil }
        let size = (try? copied.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        // The file's own name with its extension; a provider's suggested name often has none.
        let name = suggested.map { $0.contains(".") || copied.pathExtension.isEmpty ? $0 : "\($0).\(copied.pathExtension)" } ?? copied.lastPathComponent
        return SharePick(url: copied, name: ShareSummary.name(name, kind: kind, at: Date()), size: size, kind: kind, thumbnail: kind == .photo ? SharePickThumbnail.of(copied) : nil)
    }
}
