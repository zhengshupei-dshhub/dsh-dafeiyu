import AppKit
import Foundation
import UserNotifications

/// 点击系统通知时把 DSH 唤到前台。
///
/// 背景：helper 通过 UNUserNotificationCenter 发「任务完成 / 等待审批 / 任务出错」通知，
/// 但之前没有设置 delegate，用户点通知没有任何反应。
/// 桌面端注册了 `dsh://open` 方案，点击即唤起 DSH 并回到当前会话；
/// 若系统里没有注册该方案（比如只装了 WebUI），退化为打开配置的 WebUI 地址。
final class NotificationLink: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationLink()

    /// WebUI 兜底地址，由 main.swift 在启动时注入。
    var fallbackURL: URL?

    func install() {
        UNUserNotificationCenter.current().delegate = self
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        DispatchQueue.main.async { [weak self] in
            self?.openDSH()
            completionHandler()
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    private func openDSH() {
        if let url = URL(string: "dsh://open"), NSWorkspace.shared.open(url) {
            return
        }
        if let fallback = fallbackURL {
            NSWorkspace.shared.open(fallback)
        }
    }
}
