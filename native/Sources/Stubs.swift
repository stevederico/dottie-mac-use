/**
 * Package data dir — standalone by default (~/.dottie-mac-use).
 * Override: DOTTIE_MAC_USE_DATA or DOTTIE_DIR (desktop sets these to ~/.dottie).
 */
import Foundation
import ApplicationServices
import AppKit
import Security

enum AppLogger {
    static func info(_ message: String) { fputs("[mac-use-ax] \(message)\n", stderr) }
    static func warn(_ message: String) { fputs("[mac-use-ax] WARN \(message)\n", stderr) }
    static func error(_ message: String) { fputs("[mac-use-ax] ERROR \(message)\n", stderr) }
}

struct AppPorts {
    static var axServer: Int {
        if let raw = ProcessInfo.processInfo.environment["DOTTIE_AX_PORT"], let n = Int(raw), n > 0 {
            return n
        }
        return 1319
    }
}

struct AppPaths {
    /// Matches JS paths.js: DOTTIE_MAC_USE_DATA → DOTTIE_DIR → ~/.dottie-mac-use
    static var dataDir: URL {
        let env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser
        if let raw = env["DOTTIE_MAC_USE_DATA"], !raw.isEmpty {
            return URL(fileURLWithPath: (raw as NSString).expandingTildeInPath, isDirectory: true)
        }
        if let raw = env["DOTTIE_DIR"], !raw.isEmpty {
            return URL(fileURLWithPath: (raw as NSString).expandingTildeInPath, isDirectory: true)
        }
        return home.appendingPathComponent(".dottie-mac-use")
    }

    static var agentTokenURL: URL {
        dataDir.appendingPathComponent("agent_token")
    }
}

/// AX trust snapshot — CLI uses live AXIsProcessTrusted (no polling).
final class AccessibilityPermissionManager {
    static let shared = AccessibilityPermissionManager()
    var isTrusted: Bool { AXIsProcessTrusted() }
    private init() {}
}

/// No-op — control-mode glow is Face-only when embedded in Dottie.app.
final class ControlModeOverlayManager {
    static let shared = ControlModeOverlayManager()
    func noteControlActivity() {}
    private init() {}
}

/// Mint/read agent_token under package data dir.
final class AgentManager {
    static let shared = AgentManager()
    private let lock = NSLock()
    private init() {}

    @discardableResult
    func ensureAgentToken() -> String {
        lock.lock()
        defer { lock.unlock() }
        let dir = AppPaths.dataDir
        let path = AppPaths.agentTokenURL
        if let existing = try? String(contentsOf: path, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !existing.isEmpty {
            return existing
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let token = bytes.map { String(format: "%02x", $0) }.joined()
        let data = Data(token.utf8)
        let ok = FileManager.default.createFile(
            atPath: path.path, contents: data, attributes: [.posixPermissions: 0o600]
        )
        if !ok {
            AppLogger.error("Failed to write \(path.path) — AX requests will 401")
        } else {
            AppLogger.info("Generated new agent token at \(path.path)")
        }
        return token
    }
}

/// Standalone /web/open — allowlist grok hosts, open in default browser (no Hub WKWebView).
final class HubWebWindowManager {
    static let shared = HubWebWindowManager()
    private init() {}

    static func isAllowedHubURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "https" else { return false }
        guard let host = url.host?.lowercased() else { return false }
        return host == "hub.grok.me" || host.hasSuffix(".grok.me")
    }

    func open(url: URL, title: String?) {
        _ = title
        NSWorkspace.shared.open(url)
    }
}
