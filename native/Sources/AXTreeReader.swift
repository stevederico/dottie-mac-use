//
//  AXTreeReader.swift
//  Dottie
//
//  Created by Steve Derico on 3/18/26.
//
//  Reads the macOS accessibility tree via AXUIElement C APIs.
//  Provides app listing, tree traversal with sequential refs (@e1, @e2...),
//  and focused element queries. Stores refs in AXSnapshotStore for action execution.
//

import Foundation
import ApplicationServices
import AppKit

// MARK: - Interactive Roles

/// AX roles considered interactive — assigned refs when `interactiveOnly` filtering is enabled.
private let interactiveRoles: Set<String> = [
    "AXButton", "AXTextField", "AXTextArea", "AXCheckBox",
    "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXSlider",
    "AXLink", "AXMenuItem", "AXTab", "AXDisclosureTriangle"
]

// MARK: - AX Snapshot Store

/// One element captured during a tree read. `frame`/`pid` added for coordinate-click escalation.
struct AXElementRecord {
    let ref: String
    let element: AXUIElement
    let role: String        // short role, lowercased (e.g. "button"), same as today
    let name: String        // displayName (title || description), same as today
    let frame: CGRect       // captured at read time via AXTreeReader.axFrame(element) ?? .null
    let pid: pid_t          // owning app pid, captured at read time
}

/// A named, immutable capture of one tree read for one bundleId.
struct AXSnapshot {
    let id: String              // minted snapshotId, e.g. "snap-42"
    let bundleId: String
    let createdAt: Date
    let seq: Int                // monotonic mint order — total order for LRU tie-breaking
    let elements: [AXElementRecord]
}

/// Result of a snapshot lookup. Distinguishes stale-vs-missing so callers can branch:
/// an expired snapshot surfaces `snapshot_expired` to the model, a missing one is a hard miss.
enum AXSnapshotLookup {
    case found(AXElementRecord, snapshotId: String)  // snapshotId = the snapshot actually used (resolved/latest)
    case snapshotExpired                              // a snapshotId was supplied (or latest existed) but TTL elapsed / evicted
    case notFound                                     // no such snapshot AND no fallback, OR ref absent in a live snapshot
}

/// Thread-safe singleton snapshot store. Replaces AXRefMap.
/// Mutated from NWListener handler threads — guarded by a single NSLock (same as AXRefMap).
final class AXSnapshotStore {
    static let shared = AXSnapshotStore()
    private init() {}

    private let lock = NSLock()
    private var counter: Int = 0                       // monotonic snapshotId source
    private var snapshots: [String: AXSnapshot] = [:]  // snapshotId -> snapshot
    private var latestBySpace: [String: String] = [:]  // bundleId -> latest snapshotId

    static let ttlSeconds: TimeInterval = 300          // 5 min, unchanged from AXRefMap
    static let maxSnapshotsPerBundle: Int = 8          // LRU cap, PER bundleId

    /// Mints a new snapshot, stores it, updates latest pointer for bundleId, enforces LRU.
    /// Returns the minted snapshotId. Called by readTree after traversal.
    ///
    /// LRU is scoped PER bundleId, not globally: ax_wait_for re-reads the tree every ~150ms
    /// (≈20 mints per call), so a global cap would let waiting on one app evict another app's
    /// still-valid snapshots, expiring refs that the old single-entry-per-bundle AXRefMap kept
    /// alive for the full TTL. Per-bundle capping restores that "one+ live capture per app for
    /// the full TTL" guarantee — reading/waiting on app B never touches app A's snapshots.
    func create(bundleId: String, elements: [AXElementRecord]) -> String {
        lock.lock()
        defer { lock.unlock() }

        // Monotonic id — no Date()/random, never reused within a process lifetime.
        counter += 1
        let id = "snap-\(counter)"
        snapshots[id] = AXSnapshot(id: id, bundleId: bundleId, createdAt: Date(), seq: counter, elements: elements)
        latestBySpace[bundleId] = id // newest wins

        // LRU within this bundleId only. Tie-break on `seq` (strictly monotonic) so a
        // burst of same-instant createdAt mints (waitFor) evicts deterministically.
        var ownIds = snapshots.values.filter { $0.bundleId == bundleId }
        while ownIds.count > AXSnapshotStore.maxSnapshotsPerBundle {
            guard let oldest = ownIds.min(by: { $0.seq < $1.seq }) else { break }
            snapshots.removeValue(forKey: oldest.id)
            // `latestBySpace[bundleId]` is the just-minted id, never the evicted oldest.
            ownIds.removeAll { $0.id == oldest.id }
        }

        return id
    }

    /// Resolve a ref within a snapshot.
    /// - snapshotId == nil  → use latest snapshot for bundleId (back-compat path).
    /// - snapshotId != nil  → use that exact snapshot; must also match bundleId.
    /// TTL is evaluated against the resolved snapshot's createdAt.
    func lookup(snapshotId: String?, bundleId: String, ref: String) -> AXSnapshotLookup {
        lock.lock()
        defer { lock.unlock() }

        switch resolveLocked(snapshotId: snapshotId, bundleId: bundleId) {
        case .expired: return .snapshotExpired
        case .missing: return .notFound
        case .live(let snap):
            guard let match = snap.elements.first(where: { $0.ref == ref }) else { return .notFound }
            return .found(match, snapshotId: snap.id)
        }
    }

    /// Resolve a ref by name (and optional role) within a snapshot, for click-by-name.
    /// Same snapshotId/latest resolution + TTL as lookup. Matching semantics in §A.7.
    /// .found carries the FIRST matching record. .notFound if a live snapshot exists but
    /// nothing matched (caller then decides whether to re-read — see §B rung 0).
    func findRef(snapshotId: String?, bundleId: String, role: String?, name: String) -> AXSnapshotLookup {
        lock.lock()
        defer { lock.unlock() }

        switch resolveLocked(snapshotId: snapshotId, bundleId: bundleId) {
        case .expired: return .snapshotExpired
        case .missing: return .notFound
        case .live(let snap):
            // First (lowest @eN) record matching name substring + optional role substring.
            guard let match = snap.elements.first(where: { record in
                if let r = role, !record.role.lowercased().contains(r.lowercased()) { return false }
                return record.name.lowercased().contains(name.lowercased())
            }) else { return .notFound }
            return .found(match, snapshotId: snap.id)
        }
    }

    /// Read-only copy of the latest snapshot's records for a bundleId (waitFor uses this).
    /// Empty array if none / expired. Does NOT mutate beyond an optional TTL eviction.
    func latestElements(bundleId: String) -> [AXElementRecord] {
        lock.lock()
        defer { lock.unlock() }
        if case .live(let snap) = resolveLocked(snapshotId: nil, bundleId: bundleId) {
            return snap.elements
        }
        return []
    }

    /// Drops all snapshots for a bundleId (and any latest pointer). Replaces AXRefMap.invalidate.
    func invalidate(bundleId: String) {
        lock.lock()
        defer { lock.unlock() }
        let ids = snapshots.filter { $0.value.bundleId == bundleId }.map { $0.key }
        for id in ids { snapshots.removeValue(forKey: id) }
        latestBySpace.removeValue(forKey: bundleId)
    }

    // MARK: - Private (must be called with `lock` held)

    /// Outcome of resolving a snapshotId/bundleId pair, distinguishing a live snapshot from
    /// the stale (`expired`) vs never-existed (`missing`) cases the public lookup enum mirrors.
    private enum Resolution {
        case live(AXSnapshot)
        case expired
        case missing
    }

    /// Resolves a snapshot for a snapshotId/bundleId pair, applying TTL eviction.
    /// - explicit snapshotId that no longer resolves (gone or TTL-expired) → `.expired`
    ///   (eviction is treated identically to TTL expiry — the model gets snapshot_expired).
    /// - nil snapshotId: `.live` if a fresh latest snapshot exists; `.expired` if the latest
    ///   snapshot just aged out (pointer existed); `.missing` if no snapshot ever existed.
    private func resolveLocked(snapshotId: String?, bundleId: String) -> Resolution {
        if let sid = snapshotId {
            guard let snap = snapshots[sid], snap.bundleId == bundleId else { return .expired }
            if Date().timeIntervalSince(snap.createdAt) > AXSnapshotStore.ttlSeconds {
                evictLocked(id: sid, bundleId: bundleId)
                return .expired
            }
            return .live(snap)
        }

        guard let latestId = latestBySpace[bundleId], let snap = snapshots[latestId] else {
            // A dangling latest pointer (evicted snapshot) counts as expired, not missing.
            return latestBySpace[bundleId] != nil ? .expired : .missing
        }
        if Date().timeIntervalSince(snap.createdAt) > AXSnapshotStore.ttlSeconds {
            evictLocked(id: latestId, bundleId: bundleId)
            return .expired
        }
        return .live(snap)
    }

    /// Removes a snapshot and clears the latest pointer if it pointed at it. Lock must be held.
    private func evictLocked(id: String, bundleId: String) {
        snapshots.removeValue(forKey: id)
        if latestBySpace[bundleId] == id {
            latestBySpace.removeValue(forKey: bundleId)
        }
    }
}

// MARK: - AX Tree Reader

/// Static methods for reading the macOS accessibility tree.
/// All AX calls use the C API: AXUIElementCreateApplication, AXUIElementCopyAttributeValue, etc.
struct AXTreeReader {

    // MARK: - List Apps

    /// Lists all visible (regular activation policy) running applications with window counts.
    /// - Returns: One line per app: "AppName - com.bundle.id [pid] N windows", sorted alphabetically, capped at 50.
    static func listApps() -> String {
        let apps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .sorted { ($0.localizedName ?? "") < ($1.localizedName ?? "") }
            .prefix(50)

        var lines: [String] = []
        for app in apps {
            let name = app.localizedName ?? "Unknown"
            let bundle = app.bundleIdentifier ?? "unknown"
            let pid = app.processIdentifier

            // Count windows via AX
            let axApp = AXUIElementCreateApplication(pid)
            var windowCount = 0
            if let windows = axValue(axApp, kAXWindowsAttribute as String) as? [AXUIElement] {
                windowCount = windows.count
            }

            lines.append("\(name) - \(bundle) [\(pid)] \(windowCount) windows")
        }

        return lines.joined(separator: "\n")
    }

    // MARK: - Read Tree

    /// Performs a DFS traversal of an app's accessibility tree, assigning sequential refs (@e1, @e2...).
    /// Mints a snapshot in `AXSnapshotStore.shared` for later action execution. The minted
    /// snapshotId is surfaced as the first output line (`snapshot: snap-N`) so the model can
    /// echo it back to bind an action to this exact read.
    /// - Parameters:
    ///   - bundleId: The target app's bundle identifier.
    ///   - depth: Maximum traversal depth (default 6).
    ///   - interactiveOnly: When true, only interactive roles get refs (structure still shown for context).
    ///   - maxElements: Maximum number of elements to visit before truncating (default 500).
    ///   - windowIndex: Which window to traverse. `nil` traverses all windows (current behavior);
    ///     a non-nil value picks the Nth window from `kAXWindowsAttribute` (0 = front window).
    /// - Returns: Indented text representation of the AX tree, or an error message if the app isn't found.
    static func readTree(bundleId: String, depth: Int = 6, interactiveOnly: Bool = false, maxElements: Int = 500, windowIndex: Int? = nil) -> String {
        guard let app = findApp(bundleId: bundleId) else {
            return "Error: No running app with bundleId \(bundleId)"
        }

        let appName = app.localizedName ?? "Unknown"
        let pid = app.processIdentifier
        let axApp = AXUIElementCreateApplication(pid)

        var refCounter = 0
        var elementCount = 0
        var truncatedCount = 0
        var refEntries: [AXElementRecord] = []
        // Line 1 is the snapshot header (filled in after traversal); line 2 is the app banner.
        var lines: [String] = ["", "[\(appName) - \(bundleId)]"]

        func traverse(_ element: AXUIElement, currentDepth: Int, indent: Int) {
            guard currentDepth > 0 else { return }
            guard elementCount < maxElements else {
                truncatedCount += 1
                return
            }

            elementCount += 1

            let role = (axValue(element, kAXRoleAttribute as String) as? String) ?? "unknown"
            let title = (axValue(element, kAXTitleAttribute as String) as? String)
            let desc = (axValue(element, kAXDescriptionAttribute as String) as? String)
            let value = axValue(element, kAXValueAttribute as String)
            let focused = (axValue(element, kAXFocusedAttribute as String) as? Bool) ?? false
            let enabled = axValue(element, kAXEnabledAttribute as String) as? Bool
            let selected = (axValue(element, kAXSelectedAttribute as String) as? Bool) ?? false

            // Display name: prefer title, fall back to description
            let displayName = (title?.isEmpty == false ? title : desc) ?? ""
            let shortRole = role.hasPrefix("AX") ? String(role.dropFirst(2)).lowercased() : role.lowercased()

            // Decide if this element gets a ref
            let isInteractive = interactiveRoles.contains(role)
            let assignRef = !interactiveOnly || isInteractive

            var refLabel = ""
            if assignRef {
                refCounter += 1
                refLabel = "@e\(refCounter)"
                refEntries.append(AXElementRecord(
                    ref: refLabel, element: element, role: shortRole, name: displayName,
                    frame: AXActionExecutor.axFrame(element) ?? .null, pid: pid))
            }

            // Build display line
            let prefix = String(repeating: "  ", count: indent)
            var line = prefix
            if !refLabel.isEmpty {
                line += "\(refLabel) "
            }
            line += shortRole
            if !displayName.isEmpty {
                line += " \"\(displayName)\""
            }

            // Value — show for text fields, truncate long values
            if let val = value {
                let valStr = "\(val)"
                if !valStr.isEmpty && valStr != displayName {
                    let truncated = valStr.count > 80 ? String(valStr.prefix(80)) + "..." : valStr
                    line += " value=\"\(truncated)\""
                }
            }

            // Flags
            if focused { line += " [focused]" }
            if enabled == false { line += " [disabled]" }
            if selected { line += " [selected]" }

            lines.append(line)

            // Traverse children
            var childDepth = currentDepth - 1
            if role == "AXWebArea" {
                childDepth = min(childDepth, 3)
            }

            if let children = axValue(element, kAXChildrenAttribute as String) as? [AXUIElement] {
                for child in children {
                    traverse(child, currentDepth: childDepth, indent: indent + 1)
                }
            }
        }

        // Start traversal from windows
        if let windows = axValue(axApp, kAXWindowsAttribute as String) as? [AXUIElement] {
            if let idx = windowIndex {
                guard idx >= 0 && idx < windows.count else {
                    return "Error: windowIndex \(idx) out of range (app has \(windows.count) windows)"
                }
                traverse(windows[idx], currentDepth: depth, indent: 0)
            } else {
                for window in windows {
                    traverse(window, currentDepth: depth, indent: 0)
                }
            }
        }

        // Mint a snapshot for action execution and surface its id on line 1. The
        // `snapshot: ` prefix is a frozen wire token parsed by ax.js.
        let snapshotId = AXSnapshotStore.shared.create(bundleId: bundleId, elements: refEntries)
        lines[0] = "snapshot: \(snapshotId)"

        if truncatedCount > 0 {
            lines.append("[... truncated, \(truncatedCount) more elements]")
        }

        return lines.joined(separator: "\n")
    }

    // MARK: - Focused Element

    /// Returns information about the currently focused UI element, including its ancestry path.
    /// - Returns: App name, focused element details with ref, and parent path from root.
    static func focusedElement() -> String {
        let systemWide = AXUIElementCreateSystemWide()

        // Get focused application element
        guard let focusedApp = axValue(systemWide, kAXFocusedApplicationAttribute as String) else {
            return "Error: No focused application"
        }

        // Get focused UI element
        guard let focusedEl = axValue(focusedApp as! AXUIElement, kAXFocusedUIElementAttribute as String) else {
            return "Error: No focused element"
        }

        let element = focusedEl as! AXUIElement
        let frontApp = NSWorkspace.shared.frontmostApplication
        let appName = frontApp?.localizedName ?? "Unknown"
        let bundleId = frontApp?.bundleIdentifier ?? "unknown"

        let role = (axValue(element, kAXRoleAttribute as String) as? String) ?? "unknown"
        let title = (axValue(element, kAXTitleAttribute as String) as? String)
        let desc = (axValue(element, kAXDescriptionAttribute as String) as? String)
        let value = axValue(element, kAXValueAttribute as String)
        let displayName = (title?.isEmpty == false ? title : desc) ?? ""
        let shortRole = role.hasPrefix("AX") ? String(role.dropFirst(2)).lowercased() : role.lowercased()

        // Store as a single-element snapshot. Text output below is unchanged (no header).
        let refEntries = [AXElementRecord(
            ref: "@e1", element: element, role: shortRole, name: displayName,
            frame: AXActionExecutor.axFrame(element) ?? .null,
            pid: frontApp?.processIdentifier ?? 0)]
        _ = AXSnapshotStore.shared.create(bundleId: bundleId, elements: refEntries)

        // Build value string
        var valuePart = ""
        if let val = value {
            let valStr = "\(val)"
            if !valStr.isEmpty {
                let truncated = valStr.count > 80 ? String(valStr.prefix(80)) + "..." : valStr
                valuePart = " value=\"\(truncated)\""
            }
        }

        // Walk parent path
        var path: [String] = []
        var current: AXUIElement? = element
        while let parent = axValue(current!, kAXParentAttribute as String) as! AXUIElement? {
            let parentRole = (axValue(parent, kAXRoleAttribute as String) as? String) ?? "unknown"
            let parentShort = parentRole.hasPrefix("AX") ? String(parentRole.dropFirst(2)).lowercased() : parentRole.lowercased()
            if parentShort == "application" { break }
            path.insert(parentShort, at: 0)
            current = parent
        }

        path.append(shortRole)

        var result = "\(appName) - \(bundleId)\n"
        result += "Focused: @e1 \(shortRole)"
        if !displayName.isEmpty { result += " \"\(displayName)\"" }
        result += valuePart
        result += "\n  Path: \(path.joined(separator: " > "))"

        return result
    }

    // MARK: - Helpers

    /// Finds a running application by its bundle identifier.
    /// - Parameter bundleId: The target app's bundle identifier.
    /// - Returns: The matching `NSRunningApplication`, or nil if not found.
    static func findApp(bundleId: String) -> NSRunningApplication? {
        return NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == bundleId }
    }

    /// Safely reads an AX attribute value from an element. Returns nil on any error.
    /// - Parameters:
    ///   - element: The AXUIElement to query.
    ///   - attribute: The attribute name (e.g., kAXRoleAttribute).
    /// - Returns: The attribute value as CFTypeRef, or nil if the call failed.
    static func axValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        return result == .success ? value : nil
    }

    // MARK: - Wait For

    /// Polls the app's AX tree until an element matching `query` appears, or `timeoutMs` elapses.
    /// Polling interval is 150ms. Re-reads the tree each tick so a fresh ref map is stored on success,
    /// so callers can immediately act on the returned ref.
    /// - Parameters:
    ///   - bundleId: Target app's bundle identifier.
    ///   - query: Match criteria. `role` is case-insensitive against the short role
    ///     (e.g. "button", "textfield"). `name` is a case-insensitive substring match
    ///     against the element's title/description. At least one of role or name must be set.
    ///   - timeoutMs: Total wait budget in milliseconds (default 3000).
    /// - Returns: JSON `{"result":{"ref":"@eN","role":"...","name":"..."}}` on success,
    ///   or `{"error":"timeout"}` after the budget elapses.
    static func waitFor(bundleId: String, query: [String: Any], timeoutMs: Int = 3000) -> String {
        let roleQ = (query["role"] as? String)?.lowercased()
        let nameQ = (query["name"] as? String)?.lowercased()
        guard roleQ != nil || nameQ != nil else {
            return "{\"error\":\"query requires role or name\"}"
        }

        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
        let interval: UInt32 = 150_000 // 150ms

        while Date() < deadline {
            _ = readTree(bundleId: bundleId, depth: 8, interactiveOnly: false, maxElements: 1000, windowIndex: nil)
            if let match = findRefMatch(bundleId: bundleId, role: roleQ, name: nameQ) {
                return "{\"result\":{\"ref\":\"\(match.ref)\",\"role\":\"\(match.role)\",\"name\":\"\(escapeJSON(match.name))\"}}"
            }
            usleep(interval)
        }
        return "{\"error\":\"timeout\",\"timeoutMs\":\(timeoutMs)}"
    }

    /// Scans the latest snapshot's records for a matching ref. Internal helper for `waitFor`.
    private static func findRefMatch(bundleId: String, role: String?, name: String?) -> (ref: String, role: String, name: String)? {
        return AXSnapshotStore.shared.latestElements(bundleId: bundleId).first { entry in
            if let r = role, !entry.role.lowercased().contains(r) { return false }
            if let n = name, !entry.name.lowercased().contains(n) { return false }
            return true
        }.map { ($0.ref, $0.role, $0.name) }
    }

    private static func escapeJSON(_ s: String) -> String {
        return s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
    }
}
