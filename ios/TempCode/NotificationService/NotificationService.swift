import UserNotifications

/// The notification service extension: every alert the host sends is
/// `mutable-content`, and this adds one thing before it shows: the host's
/// name after the subtitle ("temp-code on box"), when the phone pairs with
/// two or more hosts (`HostDirectory`, the App Group's defaults the app keeps
/// current, which also hold the name he gave each host). With
/// one host, or no name on the notice, the content is delivered untouched.
/// Nothing else is read, fetched or changed.
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        guard let mutable = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        content = mutable
        Self.addHost(to: mutable, hosts: HostDirectory.names())
        contentHandler(mutable)
    }

    /// The system's deadline: deliver what there is.
    override func serviceExtensionTimeWillExpire() {
        if let handler, let content { handler(content) }
    }

    /// "temp-code on box": the host joins the subtitle only when several hosts are paired and the notice names one.
    static func addHost(to content: UNMutableNotificationContent, hosts: [String: String]) {
        guard let tc = content.userInfo["tc"] as? [AnyHashable: Any],
              let subtitle = HostDirectory.subtitle(content.subtitle, tc: tc, hosts: hosts) else { return }
        content.subtitle = subtitle
    }
}
