/**
 * dottie-mac-use-ax — standalone AX / EventKit HTTP server on :1319.
 * Env: DOTTIE_AX_PORT (default 1319)
 */
import Foundation

@main
enum DottieMacUseAx {
    static func main() {
        _ = AgentManager.shared.ensureAgentToken()
        do {
            let svc = try MacUseService()
            svc.start()
            AppLogger.info("dottie-mac-use-ax listening — Ctrl+C to stop")
            RunLoop.main.run()
        } catch {
            AppLogger.error("Failed to start: \(error.localizedDescription)")
            exit(1)
        }
    }
}
