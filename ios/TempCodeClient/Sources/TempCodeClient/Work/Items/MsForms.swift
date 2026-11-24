import Foundation
import TempCodeContract

/// A Work workspace's Microsoft forms on the phone (docs/agents/ios-client.md "Microsoft forms"): each opens in Safari,
/// at its response link while it collects, else at the builder made from its id (as the desktop's
/// src/shared/work/msforms.ts `builderOf` makes it). The phone edits nothing of a form.
public enum MsForms {
    /// Forms' own id alphabet (`FORM_ID`): an id that is not one opens nothing.
    private static let idChars = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")

    public static func url(_ row: MsFormPhoneRow) -> URL? {
        if row.state == .collecting, let link = row.link, let url = URL(string: link), url.scheme == "https" { return url }
        guard (20...200).contains(row.formId.count), row.formId.unicodeScalars.allSatisfy(idChars.contains) else { return nil }
        return URL(string: "https://forms.cloud.microsoft/Pages/DesignPageV2.aspx?subpage=design&id=\(row.formId)")
    }

    /// The row's stamp: "Draft", "3 responses", or "Closed, 3 responses".
    public static func stamp(_ row: MsFormPhoneRow) -> String {
        let count = row.count == 1 ? "1 response" : "\(row.count) responses"
        switch row.state {
        case .draft: return "Draft"
        case .collecting: return count
        case .closed: return "Closed, \(count)"
        case .unknown: return count
        }
    }
}
