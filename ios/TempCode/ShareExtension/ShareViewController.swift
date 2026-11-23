import SwiftUI
import TempCodeClient
import UIKit
import UniformTypeIdentifiers

/// Save to TempCode, the share extension's one screen (docs/agents/work-phone-files.md "Save to
/// TempCode"). It copies what was shared into its own temporary folder while the other app still lends
/// it, shows the sheet, and on Save queues the files in the App Group and sends them itself with the
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
            let picks = await SharePicks.load(extensionContext?.inputItems ?? [])
            spinner.removeFromSuperview()
            show(picks)
        }
    }

    private func show(_ picks: [SharePick]) {
        guard let root = ShareInbox.groupRoot(), !picks.isEmpty else { return finish(saved: false) }
        let model = ShareSheetModel(inbox: ShareInbox(root: root), root: root, keys: ShareKeys.group, picks: picks)
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
    static func load(_ items: [Any]) async -> [SharePick] {
        let folder = FileManager.default.temporaryDirectory.appending(path: "share-\(UUID().uuidString)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var picks: [SharePick] = []
        for provider in items.compactMap({ $0 as? NSExtensionItem }).flatMap({ $0.attachments ?? [] }) {
            if let pick = await copy(provider, into: folder, number: picks.count + 1) { picks.append(pick) }
        }
        return picks
    }

    private static func copy(_ provider: NSItemProvider, into folder: URL, number: Int) async -> SharePick? {
        let kind: ShareSummary.Kind = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) ? .video : provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) ? .photo : .file
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
