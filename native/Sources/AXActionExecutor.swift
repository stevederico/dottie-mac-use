//
//  AXActionExecutor.swift
//  Dottie
//
//  Created by Steve Derico on 3/18/26.
//
//  Executes accessibility actions (click, fill, press, menu) on AXUIElements
//  resolved from AXSnapshotStore records. Detects destructive actions and returns
//  confirmation_dialog UI when confirmation is needed.
//

import Foundation
import ApplicationServices
import AppKit

/// Executes AX actions against elements resolved from the AXSnapshotStore.
/// All methods are static. Destructive actions require explicit `confirmed: true`.
struct AXActionExecutor {

    // MARK: - Destructive Detection

    /// Keywords in element names/titles that indicate a destructive action.
    /// Matched by word-boundary (`\b<keyword>\b`, case-insensitive) so "clear cache"
    /// doesn't false-positive on "clear" vs "clear" itself does.
    /// Multi-word entries (e.g. "log out", "sign out") match the phrase verbatim.
    private static let destructiveNames: [String] = [
        // Obvious destructive — losing data, closing apps
        "delete", "remove", "clear", "trash", "erase", "close", "quit",
        "discard", "empty", "shut down", "log out", "logout", "sign out",
        "signout", "reset", "permanent", "wipe", "forget", "leave",
        // Semantic destructive — actions with real-world consequences
        "send", "submit", "buy", "purchase", "checkout", "pay",
        "post", "publish", "overwrite", "replace", "archive"
    ]

    /// Keyboard shortcuts considered destructive.
    private static let destructiveShortcuts: Set<String> = [
        "cmd+delete", "cmd+shift+delete", "cmd+q", "cmd+shift+q", "cmd+w"
    ]

    /// Key name to CGKeyCode mapping for common keys.
    private static let keyCodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
        "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
        "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
        "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
        "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
        "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49,
        "`": 50, "delete": 51, "escape": 53,
        "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101,
        "f11": 103, "f13": 105, "f14": 107, "f10": 109, "f12": 111,
        "f15": 113, "f4": 118, "f2": 120, "f1": 122,
        "left": 123, "right": 124, "down": 125, "up": 126
    ]

    /// Per-keyword allowlist of trailing nouns that neutralize the keyword's destructive
    /// meaning. e.g. "Clear Cache" and "Clear History" are common safe operations even
    /// though "Clear" alone is destructive. Applied only when the benign word immediately
    /// follows the keyword (separated by whitespace/punctuation).
    private static let benignFollowers: [String: Set<String>] = [
        "clear": ["cache", "history", "form", "field", "fields", "search", "filter", "filters", "selection", "cookies"]
    ]

    /// Checks if a name contains any destructive keywords via word-boundary match.
    /// "Clear cache" won't false-positive on "clear" (it would with the old substring match),
    /// but "Clear" and "Clear all" both match. Phrases like "log out" match verbatim.
    /// Keyword list for AX action classification.
    /// - Parameter name: The element name or title to check.
    /// - Returns: True if the name contains a destructive keyword at a word boundary.
    static func isDestructiveName(_ name: String) -> Bool {
        let lower = name.lowercased()
        for keyword in destructiveNames {
            // Word boundaries aren't reliable with NSRegularExpression for phrases that
            // contain spaces, so fall back to a small state machine: keyword must be
            // surrounded by either string boundaries or non-alphanumeric chars.
            guard matchesWordBoundary(haystack: lower, needle: keyword) else { continue }
            if let safeWords = benignFollowers[keyword], followedByBenignWord(haystack: lower, needle: keyword, safeWords: safeWords) {
                continue
            }
            return true
        }
        return false
    }

    /// Returns true when the needle is immediately followed (after whitespace/punctuation)
    /// by one of the safe trailing words. Used to neutralize keywords like "clear" in
    /// contexts like "Clear Cache" / "Clear History" where the action is non-destructive.
    private static func followedByBenignWord(haystack: String, needle: String, safeWords: Set<String>) -> Bool {
        guard let range = haystack.range(of: needle) else { return false }
        var idx = range.upperBound
        while idx < haystack.endIndex, !haystack[idx].isLetter, !haystack[idx].isNumber {
            idx = haystack.index(after: idx)
        }
        guard idx < haystack.endIndex else { return false }
        var wordEnd = idx
        while wordEnd < haystack.endIndex, haystack[wordEnd].isLetter || haystack[wordEnd].isNumber {
            wordEnd = haystack.index(after: wordEnd)
        }
        let word = String(haystack[idx..<wordEnd])
        return safeWords.contains(word)
    }

    /// Returns true when `needle` occurs in `haystack` surrounded by word boundaries
    /// (start/end of string or non-alphanumeric chars). Both inputs must be lowercased.
    private static func matchesWordBoundary(haystack: String, needle: String) -> Bool {
        guard !needle.isEmpty else { return false }
        var searchStart = haystack.startIndex
        while let range = haystack.range(of: needle, range: searchStart..<haystack.endIndex) {
            let beforeOK: Bool = {
                guard range.lowerBound > haystack.startIndex else { return true }
                let prev = haystack[haystack.index(before: range.lowerBound)]
                return !prev.isLetter && !prev.isNumber
            }()
            let afterOK: Bool = {
                guard range.upperBound < haystack.endIndex else { return true }
                let next = haystack[range.upperBound]
                return !next.isLetter && !next.isNumber
            }()
            if beforeOK && afterOK { return true }
            searchStart = haystack.index(after: range.lowerBound)
        }
        return false
    }

    /// Builds a `_ui` confirmation_dialog JSON response for destructive actions.
    /// - Parameters:
    ///   - action: The action verb (e.g., "Click", "Press").
    ///   - target: The target description (e.g., button name, shortcut string).
    ///   - toolName: The tool name for the confirm action callback.
    ///   - input: The original input dict, merged with `confirmed: true` for the confirm action.
    /// - Returns: A JSON string containing the confirmation dialog UI envelope.
    private static func confirmationResponse(action: String, target: String, toolName: String, input: [String: Any]) -> String {
        var confirmInput = input
        confirmInput["confirmed"] = true
        let id = "ax_\(toolName)_\(Int(Date().timeIntervalSince1970 * 1000))"

        let envelope: [String: Any] = [
            "_ui": [
                "component": "confirmation_dialog",
                "version": 1,
                "id": id,
                "data": [
                    "title": "Confirm \(action)",
                    "message": "\(action) \"\(target)\"? This looks like a destructive action.",
                    "destructive": true
                ],
                "actions": [
                    [
                        "id": "confirm",
                        "label": action,
                        "style": "destructive",
                        "tool": toolName,
                        "input": confirmInput
                    ],
                    [
                        "id": "cancel",
                        "label": "Cancel"
                    ]
                ],
                "fallback": "Confirm \(action) on \(target)?"
            ]
        ]
        return jsonResult(envelope)
    }

    // MARK: - JSON helper

    /// Serializes a dictionary to a compact JSON string via `JSONSerialization`,
    /// so element names/values are correctly escaped instead of hand-spliced into
    /// JSON literals. Falls back to a minimal escaped `{"error":...}` string only if
    /// serialization fails (e.g. a non-JSON value slipped into the dict).
    private static func jsonResult(_ obj: [String: Any]) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: obj),
           let json = String(data: data, encoding: .utf8) {
            return json
        }
        let escaped = "failed to serialize result"
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "{\"error\":\"\(escaped)\"}"
    }

    // MARK: - Click

    /// Resolves a target element by ref OR name from the snapshot store. Shared by
    /// `click` and `fill`. Exactly one of ref|name must be non-nil (validated upstream).
    /// ref lookups do NOT auto-re-read — refs are snapshot-scoped and a re-read would
    /// renumber them. Name lookups try the resolved/latest snapshot first, then a single
    /// rung-0 re-read against a fresh latest snapshot when nothing matched.
    static func resolveElement(bundleId: String, ref: String?, name: String?, role: String?, snapshotId: String?) -> AXSnapshotLookup {
        if let ref = ref {
            return AXSnapshotStore.shared.lookup(snapshotId: snapshotId, bundleId: bundleId, ref: ref)
        }
        var nameLookup = AXSnapshotStore.shared.findRef(snapshotId: snapshotId, bundleId: bundleId, role: role, name: name!)
        if case .notFound = nameLookup {
            _ = AXTreeReader.readTree(bundleId: bundleId, depth: 8, interactiveOnly: false, maxElements: 1000, windowIndex: nil)
            nameLookup = AXSnapshotStore.shared.findRef(snapshotId: nil, bundleId: bundleId, role: role, name: name!)
        }
        return nameLookup
    }

    /// Clicks a UI element resolved by ref OR name from a tree snapshot, escalating
    /// from an AX press to a coordinate click at the element's stored frame center.
    /// Destructive clicks (based on element name) require `confirmed: true`.
    /// - Parameters:
    ///   - bundleId: The target app's bundle identifier.
    ///   - ref: The element ref (e.g., "@e3") from a prior tree read. Exactly one of
    ///     ref|name is non-nil (validated upstream in MacUseService).
    ///   - name: The element's visible label, resolved via the snapshot store's findRef.
    ///   - role: Optional role disambiguator applied to a name resolution.
    ///   - mode: "background" (default, no focus steal) or "foreground" (force activate).
    ///     Replaces the old `strict:` flag — old strict:true ≡ background, strict:false ≡ foreground.
    ///   - snapshotId: Bind to a specific tree read; nil → latest snapshot for bundleId.
    ///   - confirmed: Whether the user has confirmed a destructive action.
    /// - Returns: Success message, typed error, or confirmation dialog JSON.
    static func click(
        bundleId: String,
        ref: String?,
        name: String?,
        role: String?,
        mode: String,
        snapshotId: String?,
        confirmed: Bool
    ) -> String {
        let lookup = resolveElement(bundleId: bundleId, ref: ref, name: name, role: role, snapshotId: snapshotId)

        let record: AXElementRecord
        let usedSnapshotId: String
        switch lookup {
        case .snapshotExpired:
            // Eviction is treated identically to TTL expiry; echo the supplied id (or null).
            if let snapshotId = snapshotId {
                return jsonResult(["error": "snapshot_expired", "snapshotId": snapshotId])
            }
            return jsonResult(["error": "snapshot_expired", "snapshotId": NSNull()])
        case .notFound:
            // Route through jsonResult so model/caller-controlled name/bundleId are escaped
            // (a label like `Click "Save"` would otherwise produce malformed JSON). The text
            // is byte-identical to the hand-spliced form for clean @eN/bundleId inputs.
            if let ref = ref {
                return jsonResult(["error": "Ref \(ref) not found. Run ax_tree for \(bundleId) first."])
            }
            let roleClause = role.map { " with role \"\($0)\"" } ?? ""
            return jsonResult(["error": "No element matching name \"\(name!)\"\(roleClause) in \(bundleId). Run ax_tree first."])
        case let .found(rec, usedId):
            record = rec
            usedSnapshotId = usedId
        }

        // Destructive check — echo the resolving identity so the confirm re-call hits the
        // same element. Only one of ref|name goes in the echo dict.
        if !confirmed && isDestructiveName(record.name) {
            // Pin the confirm re-call to the snapshot that was ACTUALLY resolved
            // (usedSnapshotId), not the supplied snapshotId — which may be nil (latest)
            // or stale-but-rung-0-refreshed. Echoing usedSnapshotId guarantees a stale
            // confirm surfaces snapshot_expired instead of clicking a renumbered element.
            var echo: [String: Any]
            if let ref = ref {
                echo = ["bundleId": bundleId, "ref": ref, "mode": mode, "snapshotId": usedSnapshotId]
            } else {
                echo = ["bundleId": bundleId, "name": name!, "mode": mode, "snapshotId": usedSnapshotId]
                if let role = role { echo["role"] = role }
            }
            return confirmationResponse(
                action: "Click",
                target: record.name,
                toolName: "ax_click",
                input: echo
            )
        }

        // Identity for error/log messages: `@eN` ref or `name "<name>"`.
        let ident = ref ?? "name \"\(name!)\""

        // Rung 1 — AX press. Activate only in foreground mode (quiet-first default).
        if mode == "foreground" {
            activateApp(bundleId: bundleId)
        }
        let r = AXUIElementPerformAction(record.element, kAXPressAction as CFString)
        if r == .success {
            AppLogger.info("AX click: \(record.role) \"\(record.name)\" in \(bundleId)")
            // `method` is the structured delivery flag the gateway reads (axMethodFlag):
            // "ax" = the intended mechanism succeeded; a degraded coordinate fallback
            // instead sets method:"coordinate" + fallback:true so the gateway reports ax:false.
            return jsonResult(["result": "Clicked \(record.role) \"\(record.name)\"", "method": "ax"])
        }
        // Expected rung-1 miss → rung-2 coordinate path (not a hard fail).
        AppLogger.warn("AX click failed on \(ident): AXError \(r.rawValue), escalating to coordinate click")

        // Rung 2 — coordinate click at the stored frame center (never re-walk the tree).
        let frame = record.frame
        let frameUsable = !frame.isNull && frame.width > 0 && frame.height > 0
        if frameUsable {
            // frame is in AX screen space = global points (top-left origin) — the same
            // space clickAtPoint expects when imageW==0. background ⇒ strict (no activate).
            let coordResult = AXActionExecutor.clickAtPoint(
                xImage: frame.midX, yImage: frame.midY,
                imageW: 0, imageH: 0,
                bundleId: bundleId, clickCount: 1, displayId: nil,
                strict: (mode == "background"))
            if let data = coordResult.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               obj["error"] == nil,
               (obj["method"] as? String) == "coordinate",
               let resultString = obj["result"] as? String {
                // Re-wrap to mark this as a rung-2 escalation (a direct /ax/click_at call
                // keeps method:"coordinate" with NO fallback flag — the disambiguator above).
                return jsonResult(["result": resultString, "method": "coordinate", "fallback": true])
            }
            // coordinate path returned an error → fall through to the final error.
            // jsonResult escapes `ident` (which embeds the model-controlled name on the name path).
            return jsonResult(["error": "Click failed on \(ident): AX press AXError \(r.rawValue); coordinate fallback failed"])
        }

        // No usable frame — cannot coordinate-click.
        return jsonResult(["error": "Click failed on \(ident): AX press AXError \(r.rawValue); coordinate fallback unavailable (no element frame)"])
    }

    // MARK: - Input primitive helpers (pure, unit-tested)

    /// Parses modifier names ("cmd", "shift", "opt"/"alt", "ctrl" + long forms) into
    /// CGEventFlags. Returns nil if any name is unknown.
    static func parseModifiers(_ names: [String]) -> CGEventFlags? {
        var flags = CGEventFlags()
        for mod in names {
            switch mod.lowercased() {
            case "cmd", "command": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "opt", "alt", "option": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            default: return nil
            }
        }
        return flags
    }

    /// Maps a mouse button name to its CGEvent types. Returns nil on unknown names.
    static func mouseButtonSpec(_ button: String) -> (down: CGEventType, up: CGEventType, drag: CGEventType, cgButton: CGMouseButton)? {
        switch button.lowercased() {
        case "left": return (.leftMouseDown, .leftMouseUp, .leftMouseDragged, .left)
        case "right": return (.rightMouseDown, .rightMouseUp, .rightMouseDragged, .right)
        case "middle": return (.otherMouseDown, .otherMouseUp, .otherMouseDragged, .center)
        default: return nil
        }
    }

    /// Linear interpolation from → to, endpoints inclusive. `steps` is clamped to ≥ 2.
    static func dragPoints(from: CGPoint, to: CGPoint, steps: Int) -> [CGPoint] {
        let n = max(2, steps)
        return (0..<n).map { i in
            let t = Double(i) / Double(n - 1)
            return CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        }
    }

    /// Canonical "cmd+shift+q"-form chord string for the destructive-shortcut gate.
    /// Modifiers normalize to short names and sort in fixed cmd/shift/opt/ctrl order so
    /// caller-supplied ordering can't dodge the `destructiveShortcuts` set.
    static func chordString(key: String, modifiers: [String]) -> String {
        let order = ["cmd": 0, "shift": 1, "opt": 2, "ctrl": 3]
        let canonical = modifiers.map { m -> String in
            switch m.lowercased() {
            case "command": return "cmd"
            case "alt", "option": return "opt"
            case "control": return "ctrl"
            default: return m.lowercased()
            }
        }.sorted { (order[$0] ?? 4) < (order[$1] ?? 4) }
        return (canonical + [key.lowercased()]).joined(separator: "+")
    }

    /// Converts screenshot-pixel coordinates to global points against the given display
    /// bounds. imageW == 0 ⇒ inputs are already global points (scale 1, origin offset
    /// preserved — a no-op for the main display). Returns nil on non-finite input/output.
    static func scaledPoint(xImage: Double, yImage: Double, imageW: Double, imageH: Double, bounds: CGRect) -> CGPoint? {
        guard xImage.isFinite, yImage.isFinite else { return nil }
        let scaleX = imageW > 0 ? bounds.width / imageW : 1.0
        let scaleY = imageH > 0 ? bounds.height / imageH : 1.0
        let px = bounds.origin.x + xImage * scaleX
        let py = bounds.origin.y + yImage * scaleY
        guard px.isFinite, py.isFinite else { return nil }
        return CGPoint(x: px, y: py)
    }

    // MARK: - Coordinate click

    /// Clicks at a screen coordinate, for apps (Chromium/CEF like Spotify) whose
    /// AX tree is too thin for ref-based clicks. Coordinates arrive in the pixel
    /// space of a full-main-display screencapture; we convert to global points by
    /// scaling against the main display's point bounds (handles Retina/scaled
    /// displays without the caller needing to know the backing scale factor).
    ///
    /// Posts a real HID-level click via `.cghidEventTap` rather than `postToPid`:
    /// CEF apps ignore synthetic per-process mouse events, so we activate the
    /// target app first (to bring it under the cursor) and then issue a genuine
    /// system click at the point.
    /// - Parameters:
    ///   - xImage/yImage: click location in screenshot pixels.
    ///   - imageW/imageH: pixel dimensions of that screenshot (0 = already points).
    ///   - bundleId: app to activate before clicking (optional).
    ///   - clickCount: 1 for single click, 2 for double-click (Spotify song rows
    ///     play on double-click).
    ///   - displayId: the CGDirectDisplayID the screenshot was taken of, used to
    ///     un-scale image pixels against THAT display's bounds. Defaults to the main
    ///     display so a capture of a secondary display maps to the right origin (#3/#5).
    ///   - strict: When true, skip activating the target app (and its settle delay);
    ///     the HID click still fires against whatever app is currently frontmost.
    ///   - button: "left" (default), "right", or "middle".
    static func clickAtPoint(xImage: Double, yImage: Double, imageW: Double, imageH: Double, bundleId: String?, clickCount: Int, displayId: CGDirectDisplayID? = nil, strict: Bool = false, button: String = "left") -> String {
        // Reject non-finite input up front — a coerced (NaN→0) coordinate would silently
        // click the wrong place; better to error than misfire (finding #4/#5).
        let bounds = CGDisplayBounds(displayId ?? CGMainDisplayID()) // points, top-left origin
        // imageW == 0 → coordinates are already global points; no scaling (both JS callers
        // rely on this path). imageW > 0 → un-scale image pixels against the display bounds.
        guard let point = scaledPoint(xImage: xImage, yImage: yImage, imageW: imageW, imageH: imageH, bounds: bounds) else {
            return "{\"error\":\"non-finite coordinate\"}"
        }
        guard let spec = mouseButtonSpec(button) else {
            return "{\"error\":\"Unknown button: \(button). Supported: left, right, middle\"}"
        }

        if !strict, let bid = bundleId, !bid.isEmpty {
            activateApp(bundleId: bid)
            usleep(250000) // 250ms for the app to come frontmost under the cursor
        }

        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            return "{\"error\":\"Failed to create CGEventSource\"}"
        }

        let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
        move?.post(tap: .cghidEventTap)
        usleep(40000)

        let clicks = max(1, min(2, clickCount))
        for n in 1...clicks {
            let down = CGEvent(mouseEventSource: source, mouseType: spec.down, mouseCursorPosition: point, mouseButton: spec.cgButton)
            let up = CGEvent(mouseEventSource: source, mouseType: spec.up, mouseCursorPosition: point, mouseButton: spec.cgButton)
            // clickState distinguishes a double-click from two singles.
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            up?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            down?.post(tap: .cghidEventTap)
            usleep(40000)
            up?.post(tap: .cghidEventTap)
            usleep(30000)
        }

        AppLogger.info("AX clickAtPoint: \(button) (\(Int(point.x)),\(Int(point.y))) x\(clicks) on \(bundleId ?? "frontmost")")
        let label = button == "left" ? "Clicked" : "\(button.capitalized)-clicked"
        return jsonResult(["result": "\(label) at (\(Int(point.x)),\(Int(point.y))) x\(clicks)", "method": "coordinate"])
    }

    // MARK: - Raw input primitives (HID-level, frontmost-targeted)
    //
    // These post via .cghidEventTap by design: raw coordinates are inherently "whatever
    // is under the point", CEF/Chromium apps ignore per-process synthetic events, and a
    // real HID click focuses the target so subsequent HID typing lands correctly.
    // pid-targeted delivery (background typing into a specific app) stays the job of
    // press/fill via postToPid.

    /// Current cursor position in global points, top-left origin.
    ///
    /// `CGEvent(source: nil)?.location` rather than `NSEvent.mouseLocation`: the
    /// latter is bottom-left origin and would need flipping against whichever
    /// display the cursor is on, which is exactly the arithmetic that makes
    /// multi-monitor coordinate bugs.
    static func currentMouseLocation() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }

    /// Resolve a move target from absolute (x/y) or relative (dx/dy) input.
    ///
    /// Relative motion exists for voice: "move left a bit" is the natural way to
    /// drive a cursor by speech, and it is unanswerable with absolute coordinates
    /// alone because nothing tells the model where the cursor currently is.
    /// Pure so the clamping is testable without posting real HID events.
    ///
    /// - Returns: nil when the inputs are non-finite or neither pair was supplied.
    static func moveTarget(x: Double?, y: Double?, dx: Double?, dy: Double?, from: CGPoint, bounds: CGRect) -> CGPoint? {
        let target: CGPoint
        if let x, let y {
            guard x.isFinite, y.isFinite else { return nil }
            target = CGPoint(x: x, y: y)
        } else if dx != nil || dy != nil {
            let ddx = dx ?? 0, ddy = dy ?? 0
            guard ddx.isFinite, ddy.isFinite else { return nil }
            target = CGPoint(x: from.x + ddx, y: from.y + ddy)
        } else {
            return nil
        }
        // Clamp: a relative nudge past the edge should park at the edge, not
        // silently no-op or throw the cursor onto a display that isn't there.
        // maxX/maxY are exclusive, so step one point inside.
        return CGPoint(
            x: min(max(target.x, bounds.minX), bounds.maxX - 1),
            y: min(max(target.y, bounds.minY), bounds.maxY - 1)
        )
    }

    /// Moves the cursor, absolutely (x/y) or relative to where it is now (dx/dy).
    /// The result includes the main display's point size and the resulting
    /// position so a model can aim at "top-right" without a screenshot.
    static func mouseMove(x: Double?, y: Double?, dx: Double? = nil, dy: Double? = nil) -> String {
        let b = CGDisplayBounds(CGMainDisplayID())
        guard let point = moveTarget(x: x, y: y, dx: dx, dy: dy, from: currentMouseLocation(), bounds: b) else {
            return "{\"error\":\"give either x and y, or dx and/or dy, as finite numbers\"}"
        }
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            return "{\"error\":\"Failed to create CGEventSource\"}"
        }
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        AppLogger.info("AX mouseMove: (\(Int(point.x)),\(Int(point.y)))")
        return jsonResult(["result": "Moved cursor to (\(Int(point.x)),\(Int(point.y)))", "method": "coordinate",
                           "position": ["x": Int(point.x), "y": Int(point.y)],
                           "display": ["w": Int(b.width), "h": Int(b.height)]])
    }

    /// Clicks at a global-point coordinate — or at the current cursor position when
    /// x/y are nil (the voice flow "move cursor there, then right-click").
    static func mouseClick(x: Double?, y: Double?, button: String = "left", clickCount: Int = 1) -> String {
        let point: CGPoint
        if let x = x, let y = y {
            point = CGPoint(x: x, y: y)
        } else if let loc = CGEvent(source: nil)?.location {
            point = loc
        } else {
            return "{\"error\":\"Could not read current cursor position\"}"
        }
        guard point.x.isFinite, point.y.isFinite else { return "{\"error\":\"non-finite coordinate\"}" }
        // Delegate to clickAtPoint in points space (imageW 0), strict (no activation) —
        // a raw-coordinate click targets whatever is under the point.
        return clickAtPoint(xImage: point.x, yImage: point.y, imageW: 0, imageH: 0,
                            bundleId: nil, clickCount: clickCount, displayId: nil, strict: true, button: button)
    }

    /// Left-button drag between two global-point coordinates: down at start, 16
    /// interpolated drag events, up at the end (~350ms total — the 50ms post-down
    /// settle lets apps register the drag threshold before movement starts).
    static func mouseDrag(fromX: Double, fromY: Double, toX: Double, toY: Double) -> String {
        guard fromX.isFinite, fromY.isFinite, toX.isFinite, toY.isFinite else {
            return "{\"error\":\"non-finite coordinate\"}"
        }
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            return "{\"error\":\"Failed to create CGEventSource\"}"
        }
        let from = CGPoint(x: fromX, y: fromY)
        let to = CGPoint(x: toX, y: toY)

        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(40000)
        let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)
        down?.setIntegerValueField(.mouseEventClickState, value: 1)
        down?.post(tap: .cghidEventTap)
        usleep(50000)
        for p in dragPoints(from: from, to: to, steps: 16) {
            CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
            usleep(15000)
        }
        usleep(50000)
        CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)?.post(tap: .cghidEventTap)

        AppLogger.info("AX mouseDrag: (\(Int(fromX)),\(Int(fromY))) → (\(Int(toX)),\(Int(toY)))")
        return jsonResult(["result": "Dragged from (\(Int(fromX)),\(Int(fromY))) to (\(Int(toX)),\(Int(toY)))", "method": "coordinate"])
    }

    /// Types text into whatever app currently has keyboard focus (HID-level unicode
    /// injection — no modifier support; chords are key_event/press territory).
    static func keyboardType(_ text: String) -> String {
        guard !text.isEmpty else { return "{\"error\":\"text required\"}" }
        typeString(text, pid: nil)
        AppLogger.info("AX keyboardType: \(text.count) chars to focused app")
        return jsonResult(["result": "Typed \(text.count) character\(text.count == 1 ? "" : "s") into the focused app", "method": "keystroke"])
    }

    /// Adjusts display brightness via HID media keys (144 up / 145 down).
    static func brightnessAdjust(direction: String, steps: Int) -> String {
        let dir = direction.lowercased()
        guard dir == "up" || dir == "down" else {
            return "{\"error\":\"direction must be up or down\"}"
        }
        let keyCode: CGKeyCode = dir == "up" ? 144 : 145
        let clamped = max(1, min(16, steps))
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            return "{\"error\":\"Failed to create CGEventSource\"}"
        }
        for _ in 0..<clamped {
            guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
                  let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
                return "{\"error\":\"Failed to create brightness key event\"}"
            }
            keyDown.post(tap: .cghidEventTap)
            usleep(30000)
            keyUp.post(tap: .cghidEventTap)
            usleep(50000)
        }
        AppLogger.info("AX brightnessAdjust: \(dir) × \(clamped)")
        return jsonResult(["result": "Brightness \(dir) by \(clamped) step\(clamped == 1 ? "" : "s")", "method": "keystroke"])
    }

    /// Sends a raw key event to the focused app: direction "press" (down+up, default),
    /// or "down"/"up" for held keys. Destructive chords (cmd+q etc.) gate on `down`
    /// and `press` — gating only `press` would let a held-cmd + tapped-q slip through.
    static func keyEvent(key: String, modifiers: [String] = [], direction: String = "press", confirmed: Bool = false) -> String {
        let keyName = key.lowercased()
        guard let keyCode = keyCodes[keyName] else {
            return "{\"error\":\"Unknown key: \(keyName). Supported: a-z, 0-9, return, tab, space, delete, escape, arrow keys, f1-f15\"}"
        }
        guard let flags = parseModifiers(modifiers) else {
            return "{\"error\":\"Unknown modifier. Supported: cmd, shift, opt/alt, ctrl\"}"
        }
        let chord = chordString(key: keyName, modifiers: modifiers)
        if (direction == "down" || direction == "press"), !confirmed, destructiveShortcuts.contains(chord) {
            return confirmationResponse(
                action: "Press",
                target: chord,
                toolName: "key_event",
                input: ["key": key, "modifiers": modifiers, "direction": direction]
            )
        }
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            return "{\"error\":\"Failed to create CGEventSource\"}"
        }
        func post(_ down: Bool) -> Bool {
            guard let e = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: down) else { return false }
            e.flags = flags
            e.post(tap: .cghidEventTap)
            return true
        }
        let ok: Bool
        switch direction {
        case "down": ok = post(true)
        case "up": ok = post(false)
        case "press":
            ok = post(true)
            usleep(50000)
            _ = post(false)
        default:
            return "{\"error\":\"direction must be down, up, or press\"}"
        }
        guard ok else { return "{\"error\":\"Failed to create key event\"}" }
        AppLogger.info("AX keyEvent: \(chord) \(direction) to focused app")
        return jsonResult(["result": "Key \(chord) \(direction) sent to the focused app", "method": "keystroke"])
    }

    // MARK: - Fill

    /// Sets the value of a text field/area resolved by ref OR name (mirrors `click`'s
    /// targeting, including the rung-0 re-read on a name miss). Falls back to keystroke
    /// typing if AX value setting fails.
    /// - Parameters:
    ///   - bundleId: The target app's bundle identifier.
    ///   - ref: The element ref from a prior tree read. Exactly one of ref|name is
    ///     non-nil (validated upstream in MacUseService).
    ///   - name: The element's visible label, resolved via the snapshot store's findRef.
    ///   - role: Optional role disambiguator applied to a name resolution.
    ///   - value: The text value to set.
    ///   - strict: When true, skip activating the target app and the keystroke-fallback
    ///     settle delays; the pid is resolved without bringing the app frontmost.
    /// - Returns: Success or error message.
    static func fill(bundleId: String, ref: String?, name: String? = nil, role: String? = nil, value: String, strict: Bool = false, snapshotId: String? = nil) -> String {
        let entry: AXElementRecord
        switch resolveElement(bundleId: bundleId, ref: ref, name: name, role: role, snapshotId: snapshotId) {
        case .found(let e, _): entry = e
        case .snapshotExpired: return "{\"error\":\"snapshot_expired\"}"
        case .notFound:
            if let ref = ref {
                return "{\"error\":\"Ref \(ref) not found. Run ax_tree for \(bundleId) first.\"}"
            }
            let roleClause = role.map { " with role \"\($0)\"" } ?? ""
            return jsonResult(["error": "No element matching name \"\(name!)\"\(roleClause) in \(bundleId). Run ax_tree first."])
        }
        // Identity for error messages: `@eN` ref or `name "<name>"`.
        let ident = ref ?? "name \"\(name!)\""

        // strict resolves the pid without activating (no frontmost change); otherwise
        // activateApp activates and returns the pid as before.
        let pidOpt = strict ? AXTreeReader.findApp(bundleId: bundleId)?.processIdentifier : activateApp(bundleId: bundleId)
        guard let pid = pidOpt else {
            return "{\"error\":\"App \(bundleId) not found\"}"
        }

        // Try direct value setting first
        let setResult = AXUIElementSetAttributeValue(entry.element, kAXValueAttribute as CFString, value as CFTypeRef)
        if setResult == .success {
            AppLogger.info("AX fill: set \(entry.role) \"\(entry.name)\" to \"\(value)\" in \(bundleId)")
            return jsonResult(["result": "Set \(entry.role) \"\(entry.name)\" to \"\(value)\"", "method": "ax"])
        }

        // Fallback: focus element and type via CGEvents
        AppLogger.info("AX fill: direct set failed (AXError \(setResult.rawValue)), falling back to keystroke typing")
        let focusResult = AXUIElementSetAttributeValue(entry.element, kAXFocusedAttribute as CFString, true as CFTypeRef)
        if focusResult != .success {
            // jsonResult escapes `ident` (embeds the model-controlled name on the name path).
            return jsonResult(["error": "Cannot focus \(ident) for typing: AXError \(focusResult.rawValue)"])
        }

        if !strict { usleep(100000) } // 100ms for focus to settle
        typeString(value, pid: pid)

        // Verify the keystrokes actually landed. typeString posts CGEvents and ignores
        // all failures, so without this read-back the tool would report success even when
        // focus landed on the wrong element, the field is read-only, or the app dropped
        // the events — leaving the agent to proceed on an empty/unchanged field.
        if !strict { usleep(50000) } // 50ms for the app to commit the typed text before reading it back
        let currentValue = (AXTreeReader.axValue(entry.element, kAXValueAttribute as String) as? String) ?? ""
        guard currentValue.contains(value) else {
            AppLogger.error("AX fill (keystroke): typed value not present in \(entry.role) \"\(entry.name)\" (read back \"\(currentValue)\")")
            return jsonResult(["error": "Keystroke fill could not be verified on \(ident): field value did not contain the typed text. The element may be read-only or did not accept focus."])
        }

        AppLogger.info("AX fill (keystroke): typed into \(entry.role) \"\(entry.name)\" in \(bundleId)")
        // Degraded path: direct AX value-set failed and we typed via CGEvents. Surface
        // it structurally so the gateway reports ax:false instead of silently claiming a
        // clean AX fill — the caller can choose to re-verify a keystroke-typed field.
        return jsonResult(["result": "Set \(entry.role) \"\(entry.name)\" to \"\(value)\"", "method": "keystroke", "fallback": true])
    }

    // MARK: - Press

    /// Sends a keyboard shortcut to an app. Parses "cmd+shift+s" format.
    /// Destructive shortcuts require `confirmed: true`.
    /// - Parameters:
    ///   - bundleId: The target app's bundle identifier.
    ///   - shortcut: The shortcut string (e.g., "cmd+c", "cmd+shift+s").
    ///   - confirmed: Whether the user has confirmed a destructive shortcut.
    ///   - strict: When true, skip activating the target app and its settle delay;
    ///     the pid is resolved without bringing the app frontmost (postToPid targets it).
    /// - Returns: Success message, error message, or confirmation dialog JSON.
    static func press(bundleId: String, shortcut: String, confirmed: Bool = false, strict: Bool = false) -> String {
        let normalized = shortcut.lowercased()

        // Destructive check
        if !confirmed && destructiveShortcuts.contains(normalized) {
            return confirmationResponse(
                action: "Press",
                target: shortcut,
                toolName: "ax_press",
                input: ["bundleId": bundleId, "shortcut": shortcut]
            )
        }

        // Parse shortcut: split by "+", last part is key, rest are modifiers
        let parts = normalized.split(separator: "+").map { String($0) }
        guard parts.count >= 1 else {
            return "{\"error\":\"Invalid shortcut format: \(shortcut)\"}"
        }

        let keyName = parts.last!
        let modifierNames = Array(parts.dropLast())

        guard let keyCode = keyCodes[keyName] else {
            return "{\"error\":\"Unknown key: \(keyName). Supported: a-z, 0-9, return, tab, space, delete, escape, arrow keys, f1-f15\"}"
        }

        guard let flags = parseModifiers(modifierNames) else {
            return "{\"error\":\"Unknown modifier in \(shortcut). Supported: cmd, shift, opt/alt, ctrl\"}"
        }

        // strict resolves the pid without activating (no frontmost change); postToPid
        // delivers the keystroke to that pid regardless of frontmost, so this is safe.
        let pidOpt = strict ? AXTreeReader.findApp(bundleId: bundleId)?.processIdentifier : activateApp(bundleId: bundleId)
        guard let pid = pidOpt else {
            return "{\"error\":\"App \(bundleId) not found\"}"
        }
        if !strict { usleep(100000) } // 100ms best-effort for the app to settle; postToPid does not require it

        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            return "{\"error\":\"Failed to create CGEventSource\"}"
        }

        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true) else {
            return "{\"error\":\"Failed to create keyDown event\"}"
        }
        keyDown.flags = flags

        guard let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
            return "{\"error\":\"Failed to create keyUp event\"}"
        }
        keyUp.flags = flags

        // postToPid delivers to the target process's event queue regardless of
        // frontmost. .cghidEventTap routes to whichever app currently has focus,
        // which is why the previous implementation silently sent keystrokes to
        // the terminal / IDE that invoked the agent.
        keyDown.postToPid(pid)
        usleep(50000) // 50ms delay
        keyUp.postToPid(pid)

        let appName = AXTreeReader.findApp(bundleId: bundleId)?.localizedName ?? bundleId
        AppLogger.info("AX press: \(shortcut) in \(appName) (pid=\(pid))")
        return jsonResult(["result": "Pressed \(shortcut) in \(appName)", "method": "ax"])
    }

    // MARK: - Menu

    /// Navigates and activates a menu item by path (e.g., "File > Save As...").
    /// Destructive menu items require `confirmed: true`.
    /// - Parameters:
    ///   - bundleId: The target app's bundle identifier.
    ///   - menuPath: The menu path separated by ">" (e.g., "File > Close").
    ///   - confirmed: Whether the user has confirmed a destructive menu action.
    ///   - strict: When true, skip activating the target app (and its settle delay);
    ///     menu-bar traversal via AX works without the app being frontmost.
    /// - Returns: Success message, error message, or confirmation dialog JSON.
    static func menu(bundleId: String, menuPath: String, confirmed: Bool = false, strict: Bool = false) -> String {
        let components = menuPath.split(separator: ">").map { $0.trimmingCharacters(in: .whitespaces) }
        guard components.count >= 2 else {
            return "{\"error\":\"menuPath must have at least 2 components (e.g., \\\"File > Save\\\")\"}"
        }

        // Destructive check on last component
        if !confirmed && isDestructiveName(components.last!) {
            return confirmationResponse(
                action: "Menu",
                target: menuPath,
                toolName: "ax_menu",
                input: ["bundleId": bundleId, "menuPath": menuPath]
            )
        }

        guard let app = AXTreeReader.findApp(bundleId: bundleId) else {
            return "{\"error\":\"No running app with bundleId \(bundleId)\"}"
        }

        if !strict {
            activateApp(bundleId: bundleId)
            usleep(100000) // 100ms for activation
        }

        let axApp = AXUIElementCreateApplication(app.processIdentifier)

        // Get menu bar
        guard let menuBar = AXTreeReader.axValue(axApp, kAXMenuBarAttribute as String) as! AXUIElement? else {
            return "{\"error\":\"Cannot access menu bar for \(bundleId)\"}"
        }

        // Walk menu bar items to find the top-level menu
        guard let menuBarItems = AXTreeReader.axValue(menuBar, kAXChildrenAttribute as String) as? [AXUIElement] else {
            return "{\"error\":\"Cannot read menu bar items\"}"
        }

        // Find top-level menu bar item matching first component
        var currentItem: AXUIElement?
        for item in menuBarItems {
            let title = (AXTreeReader.axValue(item, kAXTitleAttribute as String) as? String) ?? ""
            if title == components[0] {
                currentItem = item
                break
            }
        }

        guard var menuItem = currentItem else {
            return "{\"error\":\"Menu \\\"\(components[0])\\\" not found in menu bar\"}"
        }

        // Walk remaining path components through submenus
        for i in 1..<components.count {
            // Get the menu's children (menu items inside the menu bar item or submenu)
            guard let children = AXTreeReader.axValue(menuItem, kAXChildrenAttribute as String) as? [AXUIElement] else {
                return "{\"error\":\"Cannot open menu \\\"\(components[i-1])\\\"\"}"
            }

            // Menu bar items have a single child (the menu), which has the actual menu items
            var searchItems = children
            if children.count == 1 {
                if let innerChildren = AXTreeReader.axValue(children[0], kAXChildrenAttribute as String) as? [AXUIElement] {
                    searchItems = innerChildren
                }
            }

            var found = false
            for child in searchItems {
                let title = (AXTreeReader.axValue(child, kAXTitleAttribute as String) as? String) ?? ""
                if title == components[i] {
                    menuItem = child
                    found = true
                    break
                }
            }

            if !found {
                return "{\"error\":\"Menu item \\\"\(components[i])\\\" not found in \\\"\(components[i-1])\\\"\"}"
            }
        }

        // Perform press action on the final menu item
        let result = AXUIElementPerformAction(menuItem, kAXPressAction as CFString)
        let appName = app.localizedName ?? bundleId

        if result == .success {
            AppLogger.info("AX menu: \(menuPath) in \(appName)")
            return jsonResult(["result": "Selected menu: \(menuPath) in \(appName)", "method": "ax"])
        } else {
            AppLogger.error("AX menu action failed: AXError \(result.rawValue)")
            return "{\"error\":\"Menu action failed: AXError \(result.rawValue)\"}"
        }
    }

    // MARK: - Scroll

    /// Scrolls a scrollable AX element. Tries `kAXScrollAction` via the element's
    /// AXScrollArea ancestor when available, and falls back to a CGEvent scroll-wheel
    /// posted at the element's frame center. `direction` is one of up/down/left/right;
    /// `amount` is the number of wheel lines (default 3).
    /// When `strict` is true, skip activating the target app; scroll events are posted
    /// to the resolved pid via postToPid, so no frontmost change is needed.
    static func scroll(bundleId: String, ref: String, direction: String, amount: Int, strict: Bool = false, snapshotId: String? = nil) -> String {
        let entry: AXElementRecord
        switch AXSnapshotStore.shared.lookup(snapshotId: snapshotId, bundleId: bundleId, ref: ref) {
        case .found(let e, _): entry = e
        case .snapshotExpired: return "{\"error\":\"snapshot_expired\"}"
        case .notFound: return "{\"error\":\"Ref \(ref) not found. Run ax_tree for \(bundleId) first.\"}"
        }
        let dir = direction.lowercased()
        guard ["up", "down", "left", "right"].contains(dir) else {
            return "{\"error\":\"Invalid direction '\(direction)'. Use up|down|left|right.\"}"
        }

        // strict resolves the pid without activating (no frontmost change); otherwise
        // activateApp activates and returns the pid as before.
        let pidOpt = strict ? AXTreeReader.findApp(bundleId: bundleId)?.processIdentifier : activateApp(bundleId: bundleId)
        guard let pid = pidOpt else {
            return "{\"error\":\"App \(bundleId) not found\"}"
        }

        // CGEvent scroll wheel targeted at the element's on-screen frame.
        // Sign convention: +y scrolls up (content down), -y scrolls down (content up).
        guard let frame = axFrame(entry.element) else {
            return "{\"error\":\"Element \(ref) has no frame; cannot scroll.\"}"
        }
        let centerX = Int32(frame.midX)
        let centerY = Int32(frame.midY)

        // Move cursor to element so scroll targets the right scroll view.
        // postToPid routes the mouse-move into the target process; without it
        // the event lands in whichever app is currently frontmost.
        if let moveSource = CGEventSource(stateID: .combinedSessionState),
           let moveEvent = CGEvent(mouseEventSource: moveSource,
                                    mouseType: .mouseMoved,
                                    mouseCursorPosition: CGPoint(x: Int(centerX), y: Int(centerY)),
                                    mouseButton: .left) {
            moveEvent.postToPid(pid)
            usleep(30000) // 30ms for mouse-over to register
        }

        let lines = max(1, amount)
        var yDelta: Int32 = 0
        var xDelta: Int32 = 0
        switch dir {
        case "up":    yDelta =  Int32(lines)
        case "down":  yDelta = -Int32(lines)
        case "left":  xDelta =  Int32(lines)
        case "right": xDelta = -Int32(lines)
        default: break
        }

        guard let src = CGEventSource(stateID: .combinedSessionState),
              let event = CGEvent(scrollWheelEvent2Source: src,
                                  units: .line,
                                  wheelCount: 2,
                                  wheel1: yDelta,
                                  wheel2: xDelta,
                                  wheel3: 0) else {
            return "{\"error\":\"Failed to create scroll event.\"}"
        }
        event.postToPid(pid)

        AppLogger.info("AX scroll: \(dir) \(lines) on \(entry.role) \"\(entry.name)\" in \(bundleId)")
        return jsonResult(["result": "Scrolled \(dir) \(lines) on \(entry.role) \"\(entry.name)\"", "method": "ax"])
    }

    // MARK: - Read

    /// Reads current attributes of a single AX element by ref. Used for cheap state
    /// inspection without reparsing the full tree (e.g. action verification).
    static func read(bundleId: String, ref: String, snapshotId: String? = nil) -> String {
        let entry: AXElementRecord
        switch AXSnapshotStore.shared.lookup(snapshotId: snapshotId, bundleId: bundleId, ref: ref) {
        case .found(let e, _): entry = e
        case .snapshotExpired: return "{\"error\":\"snapshot_expired\"}"
        case .notFound: return "{\"error\":\"Ref \(ref) not found. Run ax_tree for \(bundleId) first.\"}"
        }
        let el = entry.element
        let role = (AXTreeReader.axValue(el, kAXRoleAttribute as String) as? String) ?? entry.role
        let title = (AXTreeReader.axValue(el, kAXTitleAttribute as String) as? String) ?? ""
        let desc = (AXTreeReader.axValue(el, kAXDescriptionAttribute as String) as? String) ?? ""
        let rawValue = AXTreeReader.axValue(el, kAXValueAttribute as String)
        let help = (AXTreeReader.axValue(el, kAXHelpAttribute as String) as? String) ?? ""
        let enabled = (AXTreeReader.axValue(el, kAXEnabledAttribute as String) as? Bool) ?? true
        let focused = (AXTreeReader.axValue(el, kAXFocusedAttribute as String) as? Bool) ?? false
        let selected = (AXTreeReader.axValue(el, kAXSelectedAttribute as String) as? Bool) ?? false

        let name = !title.isEmpty ? title : desc
        let valueStr: String = rawValue.map { "\($0)" } ?? ""

        let payload: [String: Any] = [
            "role": role,
            "name": name,
            "value": valueStr,
            "help": help,
            "enabled": enabled,
            "focused": focused,
            "selected": selected
        ]
        if let data = try? JSONSerialization.data(withJSONObject: ["result": payload]),
           let json = String(data: data, encoding: .utf8) {
            return json
        }
        return "{\"error\":\"Failed to serialize read result\"}"
    }

    // MARK: - Set Value

    /// Sets `kAXValueAttribute` directly — for sliders (number), checkboxes/switches
    /// (bool → 1/0), and segmented controls. Distinct from `fill`, which is text-only
    /// with a CGEvent typing fallback.
    /// When `strict` is true, skip activating the target app; the AX value set works
    /// without the app being frontmost.
    static func setValue(bundleId: String, ref: String, value: Any, strict: Bool = false, snapshotId: String? = nil) -> String {
        let entry: AXElementRecord
        switch AXSnapshotStore.shared.lookup(snapshotId: snapshotId, bundleId: bundleId, ref: ref) {
        case .found(let e, _): entry = e
        case .snapshotExpired: return "{\"error\":\"snapshot_expired\"}"
        case .notFound: return "{\"error\":\"Ref \(ref) not found. Run ax_tree for \(bundleId) first.\"}"
        }
        if !strict {
            activateApp(bundleId: bundleId)
        }

        // Coerce JSON types into the CFTypeRef the AX API expects.
        let cf: CFTypeRef
        if let b = value as? Bool {
            cf = NSNumber(value: b ? 1 : 0)
        } else if let n = value as? NSNumber {
            cf = n
        } else if let d = value as? Double {
            cf = NSNumber(value: d)
        } else if let i = value as? Int {
            cf = NSNumber(value: i)
        } else if let s = value as? String {
            cf = s as CFTypeRef
        } else {
            return "{\"error\":\"Unsupported value type for ax_set_value.\"}"
        }

        let result = AXUIElementSetAttributeValue(entry.element, kAXValueAttribute as CFString, cf)
        if result == .success {
            AppLogger.info("AX set_value: \(entry.role) \"\(entry.name)\" ← \(value) in \(bundleId)")
            return jsonResult(["result": "Set \(entry.role) \"\(entry.name)\" value", "method": "ax"])
        }
        AppLogger.error("AX set_value failed: AXError \(result.rawValue)")
        return "{\"error\":\"Set value failed on \(ref): AXError \(result.rawValue)\"}"
    }

    // MARK: - Select

    /// Marks an element as selected (`kAXSelectedAttribute = true`). Use for tabs, list
    /// rows, and popup items where `AXPress` is a no-op but the app watches selection.
    /// When `strict` is true, skip activating the target app; the AX selection set works
    /// without the app being frontmost.
    static func select(bundleId: String, ref: String, strict: Bool = false, snapshotId: String? = nil) -> String {
        let entry: AXElementRecord
        switch AXSnapshotStore.shared.lookup(snapshotId: snapshotId, bundleId: bundleId, ref: ref) {
        case .found(let e, _): entry = e
        case .snapshotExpired: return "{\"error\":\"snapshot_expired\"}"
        case .notFound: return "{\"error\":\"Ref \(ref) not found. Run ax_tree for \(bundleId) first.\"}"
        }
        if !strict {
            activateApp(bundleId: bundleId)
        }
        let result = AXUIElementSetAttributeValue(entry.element, kAXSelectedAttribute as CFString, true as CFTypeRef)
        if result == .success {
            AppLogger.info("AX select: \(entry.role) \"\(entry.name)\" in \(bundleId)")
            return jsonResult(["result": "Selected \(entry.role) \"\(entry.name)\"", "method": "ax"])
        }
        return "{\"error\":\"Select failed on \(ref): AXError \(result.rawValue)\"}"
    }

    // MARK: - Show Menu

    /// Performs `kAXShowMenuAction` — the AX equivalent of a right-click / context menu.
    /// When `strict` is true, skip activating the target app; the AX show-menu action
    /// works without the app being frontmost.
    static func showMenu(bundleId: String, ref: String, strict: Bool = false, snapshotId: String? = nil) -> String {
        let entry: AXElementRecord
        switch AXSnapshotStore.shared.lookup(snapshotId: snapshotId, bundleId: bundleId, ref: ref) {
        case .found(let e, _): entry = e
        case .snapshotExpired: return "{\"error\":\"snapshot_expired\"}"
        case .notFound: return "{\"error\":\"Ref \(ref) not found. Run ax_tree for \(bundleId) first.\"}"
        }
        if !strict {
            activateApp(bundleId: bundleId)
        }
        let result = AXUIElementPerformAction(entry.element, kAXShowMenuAction as CFString)
        if result == .success {
            AppLogger.info("AX show_menu: \(entry.role) \"\(entry.name)\" in \(bundleId)")
            return jsonResult(["result": "Showed context menu on \(entry.role) \"\(entry.name)\"", "method": "ax"])
        }
        return "{\"error\":\"Show menu failed on \(ref): AXError \(result.rawValue)\"}"
    }

    // MARK: - Frame helper

    /// Reads an element's on-screen frame (CGRect). Prefers AXFrame when the element
    /// publishes it; falls back to AXPosition + AXSize (the common pair on most controls).
    /// Non-private so AXTreeReader.readTree can capture frames at read time (§A.4).
    static func axFrame(_ element: AXUIElement) -> CGRect? {
        // AXFrame isn't exposed as a named constant in every SDK slice, so use the
        // string literal directly — macOS treats it as "AXFrame" either way.
        var raw: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, "AXFrame" as CFString, &raw) == .success,
           let value = raw {
            var rect = CGRect.zero
            if AXValueGetValue(value as! AXValue, .cgRect, &rect) {
                return rect
            }
        }
        var posRaw: CFTypeRef?
        var sizeRaw: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRaw) == .success,
           AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRaw) == .success,
           let pv = posRaw, let sv = sizeRaw {
            var pos = CGPoint.zero
            var size = CGSize.zero
            if AXValueGetValue(pv as! AXValue, .cgPoint, &pos),
               AXValueGetValue(sv as! AXValue, .cgSize, &size) {
                return CGRect(origin: pos, size: size)
            }
        }
        return nil
    }

    // MARK: - Window Info

    /// Returns the largest layer-0 window of a target app as JSON in GLOBAL POINTS
    /// (top-left origin, the same space as CGEvent): {"id":..,"x":..,"y":..,"w":..,"h":..}.
    /// Replaces the standalone `swift window_info.swift` subprocess (finding #13) so the
    /// JS side can convert a vision box_2d (0-1000 normalized) into a global click point
    /// with no interpreter launch. Target resolution, per the shared HTTP contract:
    ///   - bundleId present → resolve running pids for that bundle id, match kCGWindowOwnerPID.
    ///   - else appName present → match kCGWindowOwnerName == appName.
    ///   - else → use NSWorkspace.frontmostApplication's pid.
    /// Skips non-normal windows (layer != 0) and tiny helpers (w*h < 200*200).
    /// - Returns: window bounds JSON, or {"error":"no window for <app>"} when none match.
    static func windowInfo(bundleId: String?, appName: String?) -> String {
        // Resolve the target into either a set of pids (bundleId / frontmost) or an owner name.
        var targetPids: Set<pid_t>? = nil
        var targetOwnerName: String? = nil
        var label: String

        if let bid = bundleId, !bid.isEmpty {
            let pids = NSRunningApplication.runningApplications(withBundleIdentifier: bid)
                .map { $0.processIdentifier }
            targetPids = Set(pids)
            label = bid
        } else if let name = appName, !name.isEmpty {
            targetOwnerName = name
            label = name
        } else if let front = NSWorkspace.shared.frontmostApplication {
            targetPids = [front.processIdentifier]
            label = front.localizedName ?? front.bundleIdentifier ?? "frontmost"
        } else {
            return "{\"error\":\"no window for frontmost\"}"
        }

        guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
            return "{\"error\":\"no window for \(label)\"}"
        }

        var best: (id: Int, x: Double, y: Double, w: Double, h: Double)? = nil
        for win in list {
            // Restrict to the target app.
            if let pids = targetPids {
                let owner = (win[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1
                guard pids.contains(owner) else { continue }
            } else if let ownerName = targetOwnerName {
                let owner = (win[kCGWindowOwnerName as String] as? String) ?? ""
                guard owner == ownerName else { continue }
            }

            // layer 0 = normal app windows (skip menubar/overlay helpers).
            let layer = (win[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
            if layer != 0 { continue }

            guard let id = (win[kCGWindowNumber as String] as? NSNumber)?.intValue,
                  let b = win[kCGWindowBounds as String] as? [String: Any] else { continue }
            let x = (b["X"] as? NSNumber)?.doubleValue ?? 0
            let y = (b["Y"] as? NSNumber)?.doubleValue ?? 0
            let w = (b["Width"] as? NSNumber)?.doubleValue ?? 0
            let h = (b["Height"] as? NSNumber)?.doubleValue ?? 0
            if w * h < 200 * 200 { continue } // skip tiny helper windows
            if best == nil || w * h > best!.w * best!.h { best = (id, x, y, w, h) }
        }

        if let b = best {
            return "{\"id\":\(b.id),\"x\":\(b.x),\"y\":\(b.y),\"w\":\(b.w),\"h\":\(b.h)}"
        }
        return "{\"error\":\"no window for \(label)\"}"
    }

    // MARK: - Helpers

    /// Activates an app by bundleId and returns its PID. The activate() call is
    /// hygiene — on macOS 14+ `.activateIgnoringOtherApps` is documented as a
    /// no-op, so CGEvent callers MUST target the returned PID via `postToPid`
    /// rather than assuming activation made the app frontmost. Returning the
    /// PID avoids a double AXTreeReader.findApp lookup at every callsite.
    @discardableResult
    private static func activateApp(bundleId: String) -> pid_t? {
        guard let app = AXTreeReader.findApp(bundleId: bundleId) else { return nil }
        app.activate()
        return app.processIdentifier
    }

    /// Types a string character by character using CGEvents. With a non-nil `pid`,
    /// events target that process's queue — load-bearing for fill's fallback, where
    /// HID posting would send keystrokes to whatever app is frontmost (usually the
    /// terminal that invoked the agent). With nil (keyboard_type primitive), events
    /// post to `.cghidEventTap` and land in the focused app by design.
    private static func typeString(_ text: String, pid: pid_t?) {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            AppLogger.error("AX typeString: failed to create CGEventSource")
            return
        }

        for char in text {
            let str = String(char)
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true) else { continue }
            let utf16 = Array(str.utf16)
            event.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            guard let upEvent = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { continue }
            if let pid = pid {
                event.postToPid(pid)
                upEvent.postToPid(pid)
            } else {
                event.post(tap: .cghidEventTap)
                upEvent.post(tap: .cghidEventTap)
            }

            usleep(3000) // 3ms between keystrokes (was 10ms: a 500-char insert was ~5s of pure delay)
        }
    }
}
