//
//  MacUseService.swift — dottie-mac-use-ax CLI (standalone)
//  HTTP server (NWListener :1319). Auth via ~/.dottie/agent_token.
//
import Foundation
import Network
import CoreGraphics

// MARK: - MacUse Service

/// Standalone AX HTTP server on :1319.
class MacUseService {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "com.example.dottie.mac-use")

    /// Creates the NWListener on the AX port. Call `start()` to begin accepting connections.
    /// - Throws: If the NWListener cannot be created on the specified port.
    init() throws {
        let params = NWParameters.tcp
        // Bind exclusively to localhost (IPv4 loopback). This prevents any
        // non-local process (or remote machine) from reaching the AX service.
        // requiredLocalEndpoint is the supported way to restrict the listening address.
        let port = NWEndpoint.Port(rawValue: UInt16(AppPorts.axServer))!
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
        // Port comes from requiredLocalEndpoint above; passing it again via `on:`
        // makes NWListener reject the params with EINVAL (NWError 22). Use one or
        // the other — not both. (Regressed in 1a26317; broke AX/1319 entirely.)
        listener = try NWListener(using: params)
    }

    /// Begins listening for incoming TCP connections on the AX port.
    func start() {
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                AppLogger.info("MacUseService listening on port \(AppPorts.axServer)")
            case .failed(let error):
                // Almost always :1319 held by another Dottie process (second
                // instance, or a stale one on relaunch). Nothing to fix in code;
                // warn keeps it in the log without an error.thrown row.
                AppLogger.warn("MacUseService listener failed (port \(AppPorts.axServer) busy?): \(error)")
                self?.listener.cancel()
            case .cancelled:
                AppLogger.info("MacUseService listener cancelled")
            default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }

        listener.start(queue: queue)
    }

    /// Cancels the NWListener, closing all active connections.
    func stop() {
        listener.cancel()
    }

    // MARK: - Auth

    /// Reads the agent token fresh from ~/.dottie/agent_token on every call.
    /// We do NOT cache: AgentManager.regenerateAgentToken() can rewrite the file at
    /// any time, and a cached value would 401 every request until the next relaunch.
    /// AX requests are human/agent-paced, so a tiny file read per request is negligible.
    /// - Returns: The trimmed token, or nil if the file is missing/unreadable.
    private func currentAuthToken() -> String? {
        let tokenPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(AppPaths.agentTokenPath).path
        return try? String(contentsOfFile: tokenPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Validates the Authorization header against a fresh read of the agent token.
    /// - Parameter header: The raw Authorization header value (e.g., "Bearer abc123").
    /// - Returns: True only if the token matches. Returns false (deny) if the token file is missing/empty.
    private func isAuthorized(_ header: String?) -> Bool {
        Self.tokenMatches(header: header, expected: currentAuthToken())
    }

    /// Pure Bearer-token comparison — no disk, no instance state, fully testable.
    /// `expected` is the value `currentAuthToken()` would return (nil/empty = token file
    /// missing/unreadable → deny-by-default).
    /// - Returns: True only if `header` is `"Bearer <expected>"` with a non-empty `expected`.
    static func tokenMatches(header: String?, expected: String?) -> Bool {
        guard let expected = expected, !expected.isEmpty else { return false }
        guard let header = header else { return false }
        let prefix = "Bearer "
        guard header.hasPrefix(prefix) else { return false }
        return String(header.dropFirst(prefix.count)) == expected
    }

    /// Validates a Host header value as a loopback address on the AX port.
    /// Accepts `localhost`, `127.0.0.1`, and `[::1]`/`::1` (case-insensitive), with an
    /// optional port that, if present, must equal the AX port. Bracketed IPv6 is unwrapped.
    /// - Parameter host: The raw Host header value (e.g. "localhost:1319", "127.0.0.1", "[::1]:1319").
    /// - Returns: True if the host is a permitted loopback address.
    static func isLoopbackHost(_ host: String) -> Bool {
        var name = host
        var port: String? = nil

        if name.hasPrefix("[") {
            // Bracketed IPv6, optionally with a port: "[::1]" or "[::1]:1319".
            guard let close = name.firstIndex(of: "]") else { return false }
            let inner = String(name[name.index(after: name.startIndex)..<close])
            let afterClose = name[name.index(after: close)...]
            if afterClose.hasPrefix(":") {
                port = String(afterClose.dropFirst())
            } else if !afterClose.isEmpty {
                // Garbage after the bracket (not a port) — reject.
                return false
            }
            name = inner
        } else if let colon = name.lastIndex(of: ":") {
            // host:port — split on the (single) colon. Bare IPv6 without brackets has
            // multiple colons and no port, so only treat this as a port when there's
            // exactly one colon in the whole value.
            if name.filter({ $0 == ":" }).count == 1 {
                port = String(name[name.index(after: colon)...])
                name = String(name[name.startIndex..<colon])
            }
        }

        let allowedHosts: Set<String> = ["127.0.0.1", "::1", "localhost"]
        guard allowedHosts.contains(name.lowercased()) else { return false }
        return port == nil || port == String(AppPorts.axServer)
    }

    /// Runs the per-request Host + bearer gate in the exact order route() enforces it.
    /// Returns the rejection response to send (and stop) on the first failing check, or
    /// nil if the request is permitted to proceed. Ordering matches route() precisely:
    ///   1. Missing Host           → (400, missing_host_header) — HTTP/1.1 requires Host.
    ///   2. Host but !loopback      → (403, host_not_allowed)    — defense-in-depth Host gate.
    ///   /health is Host-gated above but auth-exempt, so it returns nil here (the LLM-visible
    ///   accessibility state stays loopback-only, but health needs no bearer token).
    ///   3. Bad/missing bearer      → (401, Unauthorized)        — all other endpoints.
    /// Note: parseHTTPRequest lowercases all header keys, so the lookups are case-insensitive.
    private func gateRejection(for request: HTTPRequest) -> (status: Int, body: String)? {
        // Reads the token fresh from disk (currentAuthToken) and delegates to the pure
        // decision below — production callers always hit this instance method.
        Self.gateRejection(path: request.path,
                           host: request.headers["host"],
                           authorization: request.headers["authorization"],
                           expectedToken: currentAuthToken())
    }

    /// Pure Host + bearer gate decision — no disk, no instance state, fully testable.
    /// `expectedToken` is the value `currentAuthToken()` would return. Ordering matches
    /// route() precisely:
    ///   1. Missing Host           → (400, missing_host_header) — HTTP/1.1 requires Host.
    ///   2. Host but !loopback      → (403, host_not_allowed)    — defense-in-depth Host gate.
    ///   /health is Host-gated above but auth-exempt, so it returns nil here (the LLM-visible
    ///   accessibility state stays loopback-only, but health needs no bearer token).
    ///   3. Bad/missing bearer      → (401, Unauthorized)        — all other endpoints.
    static func gateRejection(path: String, host: String?, authorization: String?, expectedToken: String?) -> (status: Int, body: String)? {
        // Enforce localhost-only at the application layer (defense in depth). The listener
        // is already bound to 127.0.0.1, but we also validate the Host header to match the
        // hardening done for the 1317 WS Origin allowlist in 5.13.5. This runs BEFORE the
        // /health exemption so the health endpoint (which leaks Accessibility state) is only
        // reachable from a loopback caller — /health stays auth-exempt, but not Host-exempt.
        if let host = host {
            if !isLoopbackHost(host) {
                return (403, "{\"error\":\"host_not_allowed\"}")
            }
        } else {
            // HTTP/1.1 requires Host. Treat missing as a protocol violation.
            return (400, "{\"error\":\"missing_host_header\"}")
        }

        // Health endpoint is exempt from auth (but not from the Host check above).
        if path == "/health" {
            return nil
        }

        // Auth check for all other endpoints.
        guard tokenMatches(header: authorization, expected: expectedToken) else {
            return (401, "{\"error\":\"Unauthorized\"}")
        }

        return nil
    }

    // MARK: - Connection Handling

    /// Hard cap on a buffered request. /ax/fill values and /ax/wait_for queries can be
    /// large, so this is well above the previous single-read 64KB. Anything bigger is
    /// rejected by truncating to the cap (the request will fail to parse/route cleanly).
    private static let maxRequestBytes = 1_048_576

    /// Accepts a new TCP connection, reads the full HTTP request, routes it, and sends the response.
    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        // Accumulate bytes across TCP segments. A single receive() can return a partial
        // request — the header block split across segments, or a body larger than one
        // segment — so we keep reading until we have the full headers (CRLFCRLF) and
        // then the full Content-Length body, before parsing + routing exactly once.
        receiveRequest(connection, buffer: Data())
    }

    /// Recursively reads from the connection, appending to `buffer`, until the complete
    /// HTTP request is available (or the connection closes / the cap is hit), then routes once.
    private func receiveRequest(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else {
                connection.cancel()
                return
            }

            if let error = error {
                // Peer reset / incomplete read is normal TCP, not a fault.
                // error.thrown here was a field row on 2026.8.28.
                AppLogger.warn("MacUseService connection read error: \(error)")
                connection.cancel()
                return
            }

            var buffer = buffer
            if let data = data { buffer.append(data) }

            // CRLFCRLF header terminator: <CR><LF><CR><LF>.
            let crlfcrlf = Data([0x0D, 0x0A, 0x0D, 0x0A])

            // Keep reading until we've seen the header terminator, unless the peer
            // already closed (isComplete) or we hit the byte cap — in those cases we
            // route with whatever we have (parse will fail gracefully if incomplete).
            if let headerEnd = buffer.range(of: crlfcrlf) {
                let bodyStart = headerEnd.upperBound
                let bodyBytes = buffer.count - bodyStart
                let contentLength = self.contentLength(fromHeaderBlock: buffer.subdata(in: buffer.startIndex..<headerEnd.lowerBound))
                // Need more body? Keep receiving until we have it (or the stream ends / cap hit).
                if bodyBytes < contentLength, !isComplete, buffer.count < MacUseService.maxRequestBytes {
                    self.receiveRequest(connection, buffer: buffer)
                    return
                }
            } else if !isComplete, buffer.count < MacUseService.maxRequestBytes {
                // No full header block yet — keep reading.
                self.receiveRequest(connection, buffer: buffer)
                return
            }

            guard let raw = String(data: buffer, encoding: .utf8) else {
                self.sendResponse(connection, status: 400, body: "{\"error\":\"Bad request\"}", contentType: "application/json")
                return
            }

            let parsed = self.parseHTTPRequest(raw)
            self.route(parsed, connection: connection)
        }
    }

    /// Extracts the Content-Length value (bytes) from a raw header block. Returns 0 if absent.
    private func contentLength(fromHeaderBlock block: Data) -> Int {
        guard let text = String(data: block, encoding: .utf8) else { return 0 }
        for line in text.components(separatedBy: "\r\n") {
            if let colon = line.firstIndex(of: ":") {
                let key = String(line[line.startIndex..<colon]).trimmingCharacters(in: .whitespaces).lowercased()
                if key == "content-length" {
                    let val = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
                    return Int(val) ?? 0
                }
            }
        }
        return 0
    }

    // MARK: - HTTP Parsing

    /// Parsed HTTP request components.
    private struct HTTPRequest {
        let method: String
        let path: String
        let query: [String: String]
        let headers: [String: String]
        let body: String?
    }

    /// Parses a raw HTTP request string into method, path, query params, headers, and body.
    /// - Parameter raw: The raw HTTP request text.
    /// - Returns: A parsed `HTTPRequest` struct.
    private func parseHTTPRequest(_ raw: String) -> HTTPRequest {
        let sections = raw.components(separatedBy: "\r\n\r\n")
        let headerSection = sections[0]
        // Rejoin everything after the first blank line: a JSON body can legally contain
        // its own "\r\n\r\n" (e.g. a multi-line string value), so taking only sections[1]
        // would silently truncate the body. Rejoining with the same separator is lossless.
        let body = sections.count > 1 ? sections.dropFirst().joined(separator: "\r\n\r\n") : nil

        let lines = headerSection.components(separatedBy: "\r\n")
        let requestLine = lines.first ?? ""
        let parts = requestLine.split(separator: " ", maxSplits: 2)

        let method = parts.count > 0 ? String(parts[0]) : "GET"
        let fullPath = parts.count > 1 ? String(parts[1]) : "/"

        // Split path and query string
        var path = fullPath
        var query: [String: String] = [:]

        if let qIndex = fullPath.firstIndex(of: "?") {
            path = String(fullPath[fullPath.startIndex..<qIndex])
            let queryString = String(fullPath[fullPath.index(after: qIndex)...])
            for pair in queryString.split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1)
                if kv.count == 2 {
                    let key = String(kv[0]).removingPercentEncoding ?? String(kv[0])
                    let val = String(kv[1]).removingPercentEncoding ?? String(kv[1])
                    query[key] = val
                } else if kv.count == 1 {
                    query[String(kv[0])] = ""
                }
            }
        }

        // Parse headers
        var headers: [String: String] = [:]
        for i in 1..<lines.count {
            if let colonIndex = lines[i].firstIndex(of: ":") {
                let key = String(lines[i][lines[i].startIndex..<colonIndex]).trimmingCharacters(in: .whitespaces).lowercased()
                let val = String(lines[i][lines[i].index(after: colonIndex)...]).trimmingCharacters(in: .whitespaces)
                headers[key] = val
            }
        }

        return HTTPRequest(method: method, path: path, query: query, headers: headers, body: body)
    }

    // MARK: - Routing

    /// Routes a parsed HTTP request to the appropriate handler and sends the response.
    /// - Parameters:
    ///   - request: The parsed HTTP request.
    ///   - connection: The NWConnection to send the response on.
    private func route(_ request: HTTPRequest, connection: NWConnection) {
        // Per-request Host + bearer gate (defense in depth). gateRejection() runs the same
        // checks in the same order as before — Host first (incl. for /health), then bearer
        // for everything except /health — and returns the rejection to send, or nil to proceed.
        if let rej = gateRejection(for: request) {
            sendResponse(connection, status: rej.status, body: rej.body, contentType: "application/json")
            return
        }

        // Health endpoint is exempt from auth; exposes permission and version so callers
        // can fail fast when Accessibility is off instead of seeing cryptic AXError 0 responses.
        if request.path == "/health" {
            let trusted = AccessibilityPermissionManager.shared.isTrusted
            let body = "{\"status\":\"ok\",\"accessibilityPermission\":\(trusted),\"axVersion\":1}"
            sendResponse(connection, status: 200, body: body, contentType: "application/json")
            return
        }

        // EventKit-backed calendar endpoints don't need AX. Handle them before
        // the Accessibility pre-flight so they work even when AX isn't granted.
        if request.path.hasPrefix("/calendar/") {
            handleCalendarRoute(request, connection: connection)
            return
        }

        // Grok Hub WebView host — borderless WKWebView for hub.grok.me / *.grok.me.
        // No Accessibility required (pure AppKit + WebKit).
        if request.path.hasPrefix("/web/") {
            handleWebRoute(request, connection: connection)
            return
        }

        // Permission pre-flight. AXUIElement calls silently fail with AXError 0 when
        // the process isn't trusted; catch that here and return a clear, actionable error.
        guard AccessibilityPermissionManager.shared.isTrusted else {
            let body = "{\"error\":\"accessibility_denied\",\"message\":\"Grant Accessibility permission in System Settings → Privacy & Security → Accessibility.\"}"
            sendResponse(connection, status: 403, body: body, contentType: "application/json")
            return
        }

        // Every authorized /ax/* request is part of a computer-use control loop
        // (reads included — inspecting the screen precedes acting on it), so light
        // the control-mode glow. /health and /calendar returned above.
        ControlModeOverlayManager.shared.noteControlActivity()

        switch (request.method, request.path) {
        case ("GET", "/ax/apps"):
            let result = AXTreeReader.listApps()
            sendResponse(connection, status: 200, body: result)

        case ("GET", "/ax/tree"):
            let bundleId = request.query["bundleId"] ?? ""
            let depth = Int(request.query["depth"] ?? "6") ?? 6
            let interactive = (request.query["interactive"] ?? request.query["interactiveOnly"] ?? "false") == "true"
            let max = Int(request.query["max"] ?? request.query["maxElements"] ?? "500") ?? 500
            let windowIndex = request.query["windowIndex"].flatMap { Int($0) }

            guard !bundleId.isEmpty else {
                sendResponse(connection, status: 400, body: "{\"error\":\"bundleId query param required\"}", contentType: "application/json")
                return
            }

            let result = AXTreeReader.readTree(bundleId: bundleId, depth: depth, interactiveOnly: interactive, maxElements: max, windowIndex: windowIndex)
            sendResponse(connection, status: 200, body: result)

        case ("GET", "/ax/focused"):
            let result = AXTreeReader.focusedElement()
            sendResponse(connection, status: 200, body: result)

        case ("POST", "/ax/click"):
            let params = parseJSONBody(request.body)
            let bundleId = params["bundleId"] as? String ?? ""
            let ref = (params["ref"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            // Trim before the empty check so a whitespace-only name (" ") is rejected by the
            // one-of guard rather than resolving the first element containing a space.
            let name = (params["name"] as? String)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .flatMap { $0.isEmpty ? nil : $0 }
            let role = params["role"] as? String
            let mode = params["mode"] as? String ?? "background"
            let snapshotId = params["snapshotId"] as? String
            let confirmed = params["confirmed"] as? Bool ?? false

            guard !bundleId.isEmpty else {
                sendResponse(connection, status: 400, body: "{\"error\":\"bundleId required\"}", contentType: "application/json"); return
            }
            // exactly one of ref|name
            guard (ref != nil) != (name != nil) else {
                sendResponse(connection, status: 400, body: "{\"error\":\"exactly one of ref or name required\"}", contentType: "application/json"); return
            }
            guard mode == "background" || mode == "foreground" else {
                sendResponse(connection, status: 400, body: "{\"error\":\"mode must be background or foreground\"}", contentType: "application/json"); return
            }
            let result = AXActionExecutor.click(bundleId: bundleId, ref: ref, name: name, role: role, mode: mode, snapshotId: snapshotId, confirmed: confirmed)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        case ("POST", "/ax/click_at"):
            let params = parseJSONBody(request.body)
            // Require x and y to be present, finite NSNumbers. A missing/null coordinate
            // deserializes to NSNull (not NSNumber) and must 400 rather than coerce to 0 —
            // a silent (0,0) click is worse than an error (finding #4).
            guard let xNum = params["x"] as? NSNumber, xNum.doubleValue.isFinite,
                  let yNum = params["y"] as? NSNumber, yNum.doubleValue.isFinite else {
                sendResponse(connection, status: 400, body: "{\"error\":\"non-finite coordinate\"}", contentType: "application/json")
                return
            }
            let x = xNum.doubleValue
            let y = yNum.doubleValue
            let imageW = (params["imageWidth"] as? NSNumber)?.doubleValue ?? 0
            let imageH = (params["imageHeight"] as? NSNumber)?.doubleValue ?? 0
            let bundleId = params["bundleId"] as? String
            let clickCount = (params["clickCount"] as? NSNumber)?.intValue ?? 1
            let displayId = (params["displayId"] as? NSNumber)?.uint32Value
            let strict = params["strict"] as? Bool ?? false

            let result = AXActionExecutor.clickAtPoint(xImage: x, yImage: y, imageW: imageW, imageH: imageH, bundleId: bundleId, clickCount: clickCount, displayId: displayId, strict: strict)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        case ("POST", "/ax/window_info"):
            // Largest layer-0 window bounds (global points) for an app, so the JS side can
            // convert vision box_2d (0-1000 normalized) into a global click point without a
            // separate `swift window_info.swift` subprocess (finding #13).
            let params = parseJSONBody(request.body)
            let bundleId = params["bundleId"] as? String
            let appName = params["appName"] as? String
            let result = AXActionExecutor.windowInfo(bundleId: bundleId, appName: appName)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        case ("GET", "/ax/can_capture"):
            // Screen-recording preflight so callers can fail fast when capture is denied
            // instead of receiving a blank/black frame (finding #12).
            let granted = CGPreflightScreenCaptureAccess()
            sendResponse(connection, status: 200, body: "{\"granted\":\(granted)}", contentType: "application/json")

        case ("POST", "/ax/fill"):
            let params = parseJSONBody(request.body)
            let bundleId = params["bundleId"] as? String ?? ""
            let ref = (params["ref"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            // Trim before the empty check so a whitespace-only name (" ") is rejected by
            // the one-of guard rather than resolving the first element containing a space.
            let name = (params["name"] as? String)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .flatMap { $0.isEmpty ? nil : $0 }
            let role = params["role"] as? String
            let value = params["value"] as? String ?? ""
            let strict = params["strict"] as? Bool ?? false
            let snapshotId = params["snapshotId"] as? String

            guard !bundleId.isEmpty else {
                sendResponse(connection, status: 400, body: "{\"error\":\"bundleId required\"}", contentType: "application/json"); return
            }
            // exactly one of ref|name
            guard (ref != nil) != (name != nil) else {
                sendResponse(connection, status: 400, body: "{\"error\":\"exactly one of ref or name required\"}", contentType: "application/json"); return
            }

            let result = AXActionExecutor.fill(bundleId: bundleId, ref: ref, name: name, role: role, value: value, strict: strict, snapshotId: snapshotId)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        case ("POST", "/ax/press"):
            let params = parseJSONBody(request.body)
            let bundleId = params["bundleId"] as? String ?? ""
            let shortcut = params["shortcut"] as? String ?? ""
            let confirmed = params["confirmed"] as? Bool ?? false
            let strict = params["strict"] as? Bool ?? false

            guard !bundleId.isEmpty, !shortcut.isEmpty else {
                sendResponse(connection, status: 400, body: "{\"error\":\"bundleId and shortcut required\"}", contentType: "application/json")
                return
            }

            let result = AXActionExecutor.press(bundleId: bundleId, shortcut: shortcut, confirmed: confirmed, strict: strict)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        case ("POST", "/ax/menu"):
            let params = parseJSONBody(request.body)
            let bundleId = params["bundleId"] as? String ?? ""
            let menuPath = params["menuPath"] as? String ?? ""
            let confirmed = params["confirmed"] as? Bool ?? false
            let strict = params["strict"] as? Bool ?? false

            guard !bundleId.isEmpty, !menuPath.isEmpty else {
                sendResponse(connection, status: 400, body: "{\"error\":\"bundleId and menuPath required\"}", contentType: "application/json")
                return
            }

            let result = AXActionExecutor.menu(bundleId: bundleId, menuPath: menuPath, confirmed: confirmed, strict: strict)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        case ("POST", "/ax/scroll"):
            let params = parseJSONBody(request.body)
            let bundleId = params["bundleId"] as? String ?? ""
            let ref = params["ref"] as? String ?? ""
            let direction = params["direction"] as? String ?? ""
            let amount = params["amount"] as? Int ?? 3
            let strict = params["strict"] as? Bool ?? false
            let snapshotId = params["snapshotId"] as? String

            guard !bundleId.isEmpty, !ref.isEmpty, !direction.isEmpty else {
                sendResponse(connection, status: 400, body: "{\"error\":\"bundleId, ref, direction required\"}", contentType: "application/json")
                return
            }
            let result = AXActionExecutor.scroll(bundleId: bundleId, ref: ref, direction: direction, amount: amount, strict: strict, snapshotId: snapshotId)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        case ("POST", "/ax/read"):
            let params = parseJSONBody(request.body)
            let bundleId = params["bundleId"] as? String ?? ""
            let ref = params["ref"] as? String ?? ""
            let snapshotId = params["snapshotId"] as? String

            guard !bundleId.isEmpty, !ref.isEmpty else {
                sendResponse(connection, status: 400, body: "{\"error\":\"bundleId and ref required\"}", contentType: "application/json")
                return
            }
            let result = AXActionExecutor.read(bundleId: bundleId, ref: ref, snapshotId: snapshotId)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        case ("POST", "/ax/set_value"):
            let params = parseJSONBody(request.body)
            let bundleId = params["bundleId"] as? String ?? ""
            let ref = params["ref"] as? String ?? ""
            let strict = params["strict"] as? Bool ?? false
            let snapshotId = params["snapshotId"] as? String
            guard let value = params["value"] else {
                sendResponse(connection, status: 400, body: "{\"error\":\"value required\"}", contentType: "application/json")
                return
            }
            guard !bundleId.isEmpty, !ref.isEmpty else {
                sendResponse(connection, status: 400, body: "{\"error\":\"bundleId and ref required\"}", contentType: "application/json")
                return
            }
            let result = AXActionExecutor.setValue(bundleId: bundleId, ref: ref, value: value, strict: strict, snapshotId: snapshotId)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        case ("POST", "/ax/select"):
            let params = parseJSONBody(request.body)
            let bundleId = params["bundleId"] as? String ?? ""
            let ref = params["ref"] as? String ?? ""
            let strict = params["strict"] as? Bool ?? false
            let snapshotId = params["snapshotId"] as? String
            guard !bundleId.isEmpty, !ref.isEmpty else {
                sendResponse(connection, status: 400, body: "{\"error\":\"bundleId and ref required\"}", contentType: "application/json")
                return
            }
            let result = AXActionExecutor.select(bundleId: bundleId, ref: ref, strict: strict, snapshotId: snapshotId)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        case ("POST", "/ax/show_menu"):
            let params = parseJSONBody(request.body)
            let bundleId = params["bundleId"] as? String ?? ""
            let ref = params["ref"] as? String ?? ""
            let strict = params["strict"] as? Bool ?? false
            let snapshotId = params["snapshotId"] as? String
            guard !bundleId.isEmpty, !ref.isEmpty else {
                sendResponse(connection, status: 400, body: "{\"error\":\"bundleId and ref required\"}", contentType: "application/json")
                return
            }
            let result = AXActionExecutor.showMenu(bundleId: bundleId, ref: ref, strict: strict, snapshotId: snapshotId)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        case ("POST", "/ax/wait_for"):
            let params = parseJSONBody(request.body)
            let bundleId = params["bundleId"] as? String ?? ""
            let query = (params["query"] as? [String: Any]) ?? [:]
            let timeoutMs = params["timeoutMs"] as? Int ?? 3000
            guard !bundleId.isEmpty else {
                sendResponse(connection, status: 400, body: "{\"error\":\"bundleId required\"}", contentType: "application/json")
                return
            }
            let result = AXTreeReader.waitFor(bundleId: bundleId, query: query, timeoutMs: timeoutMs)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        // Raw input primitives. Coordinates are global points (top-left origin) — no
        // image scaling / displayId here; that's the vision path's job via /ax/click_at.
        // All follow the /ax/click_at precedent: present-but-non-finite coords 400
        // instead of coercing to 0 (finding #4).
        case ("POST", "/ax/mouse_move"):
            let params = parseJSONBody(request.body)
            // Absolute (x+y) or relative (dx and/or dy). Validation lives in
            // moveTarget so the 400 and the executor can't disagree about what
            // counts as a usable request.
            let result = AXActionExecutor.mouseMove(
                x: (params["x"] as? NSNumber)?.doubleValue,
                y: (params["y"] as? NSNumber)?.doubleValue,
                dx: (params["dx"] as? NSNumber)?.doubleValue,
                dy: (params["dy"] as? NSNumber)?.doubleValue
            )
            let status = result.contains("\"error\"") ? 400 : 200
            sendResponse(connection, status: status, body: result, contentType: "application/json")

        case ("POST", "/ax/mouse_click"):
            let params = parseJSONBody(request.body)
            // x/y are optional as a pair (omitted = click at the current cursor position),
            // but a present-yet-invalid value must 400, not silently fall back.
            var x: Double? = nil
            var y: Double? = nil
            if params["x"] != nil || params["y"] != nil {
                guard let xNum = params["x"] as? NSNumber, xNum.doubleValue.isFinite,
                      let yNum = params["y"] as? NSNumber, yNum.doubleValue.isFinite else {
                    sendResponse(connection, status: 400, body: "{\"error\":\"non-finite coordinate\"}", contentType: "application/json")
                    return
                }
                x = xNum.doubleValue
                y = yNum.doubleValue
            }
            let button = params["button"] as? String ?? "left"
            let clickCount = (params["clickCount"] as? NSNumber)?.intValue ?? 1
            let result = AXActionExecutor.mouseClick(x: x, y: y, button: button, clickCount: clickCount)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        case ("POST", "/ax/mouse_drag"):
            let params = parseJSONBody(request.body)
            guard let fx = params["fromX"] as? NSNumber, fx.doubleValue.isFinite,
                  let fy = params["fromY"] as? NSNumber, fy.doubleValue.isFinite,
                  let tx = params["toX"] as? NSNumber, tx.doubleValue.isFinite,
                  let ty = params["toY"] as? NSNumber, ty.doubleValue.isFinite else {
                sendResponse(connection, status: 400, body: "{\"error\":\"non-finite coordinate\"}", contentType: "application/json")
                return
            }
            let result = AXActionExecutor.mouseDrag(fromX: fx.doubleValue, fromY: fy.doubleValue, toX: tx.doubleValue, toY: ty.doubleValue)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        case ("POST", "/ax/keyboard_type"):
            let params = parseJSONBody(request.body)
            let text = params["text"] as? String ?? ""
            guard !text.isEmpty else {
                sendResponse(connection, status: 400, body: "{\"error\":\"text required\"}", contentType: "application/json")
                return
            }
            let result = AXActionExecutor.keyboardType(text)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        case ("POST", "/ax/key_event"):
            let params = parseJSONBody(request.body)
            let key = params["key"] as? String ?? ""
            let modifiers = (params["modifiers"] as? [String]) ?? []
            let direction = params["direction"] as? String ?? "press"
            let confirmed = params["confirmed"] as? Bool ?? false
            guard !key.isEmpty else {
                sendResponse(connection, status: 400, body: "{\"error\":\"key required\"}", contentType: "application/json")
                return
            }
            guard direction == "down" || direction == "up" || direction == "press" else {
                sendResponse(connection, status: 400, body: "{\"error\":\"direction must be down, up, or press\"}", contentType: "application/json")
                return
            }
            let result = AXActionExecutor.keyEvent(key: key, modifiers: modifiers, direction: direction, confirmed: confirmed)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        default:
            sendResponse(connection, status: 404, body: "{\"error\":\"Not found\"}", contentType: "application/json")
        }
    }

    // MARK: - Calendar Routing

    /// EventKit-backed calendar endpoints. Bypasses the Accessibility pre-flight
    /// since calendar reads use `NSCalendarsUsageDescription`, not AX.
    private func handleCalendarRoute(_ request: HTTPRequest, connection: NWConnection) {
        if !CalendarReader.isAuthorized {
            _ = CalendarReader.requestAccessSync()
        }

        switch (request.method, request.path) {
        case ("GET", "/calendar/list"):
            let days = Int(request.query["days"] ?? "7") ?? 7
            let calendarName = request.query["calendar"]
            let result = CalendarReader.listEvents(days: days, calendarName: calendarName)
            sendResponse(connection, status: 200, body: result, contentType: "application/json")

        default:
            sendResponse(connection, status: 404, body: "{\"error\":\"Not found\"}", contentType: "application/json")
        }
    }

    // MARK: - Web (Grok Hub) Routing

    /// Opens a borderless WKWebView for hub.grok.me / *.grok.me apps.
    /// Called by the gateway `hub_open` tool. Auth is already enforced by `gateRejection`.
    private func handleWebRoute(_ request: HTTPRequest, connection: NWConnection) {
        switch (request.method, request.path) {
        case ("POST", "/web/open"):
            let params = parseJSONBody(request.body)
            let urlString = (params["url"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let title = (params["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !urlString.isEmpty, let url = URL(string: urlString) else {
                sendResponse(connection, status: 400, body: "{\"error\":\"url required\"}", contentType: "application/json")
                return
            }
            guard HubWebWindowManager.isAllowedHubURL(url) else {
                sendResponse(
                    connection,
                    status: 400,
                    body: "{\"error\":\"url_not_allowed\",\"message\":\"Only hub.grok.me and *.grok.me URLs can open in the Hub WebView.\"}",
                    contentType: "application/json"
                )
                return
            }
            HubWebWindowManager.shared.open(url: url, title: title.flatMap { $0.isEmpty ? nil : $0 })
            let safeTitle = (title?.isEmpty == false ? title! : (url.host ?? "Grok Hub"))
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
            let safeURL = url.absoluteString
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
            sendResponse(
                connection,
                status: 200,
                body: "{\"ok\":true,\"url\":\"\(safeURL)\",\"title\":\"\(safeTitle)\"}",
                contentType: "application/json"
            )

        default:
            sendResponse(connection, status: 404, body: "{\"error\":\"Not found\"}", contentType: "application/json")
        }
    }

    // MARK: - Response

    /// Sends an HTTP response with the given status code, body, and content type.
    /// - Parameters:
    ///   - connection: The NWConnection to write to.
    ///   - status: The HTTP status code (e.g., 200, 404).
    ///   - body: The response body string.
    ///   - contentType: The Content-Type header value (defaults to "text/plain").
    private func sendResponse(_ connection: NWConnection, status: Int, body: String, contentType: String = "text/plain") {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 400: statusText = "Bad Request"
        case 401: statusText = "Unauthorized"
        case 403: statusText = "Forbidden"
        case 404: statusText = "Not Found"
        case 500: statusText = "Internal Server Error"
        default: statusText = "Unknown"
        }

        let bodyData = body.data(using: .utf8) ?? Data()
        let response = "HTTP/1.1 \(status) \(statusText)\r\nContent-Type: \(contentType)\r\nContent-Length: \(bodyData.count)\r\nConnection: close\r\n\r\n"

        var full = response.data(using: .utf8) ?? Data()
        full.append(bodyData)

        connection.send(content: full, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    // MARK: - Helpers

    /// Parses a JSON string body into a dictionary. Returns empty dict on failure.
    /// - Parameter body: The raw JSON string from the HTTP request body.
    /// - Returns: A dictionary of parsed key-value pairs.
    private func parseJSONBody(_ body: String?) -> [String: Any] {
        guard let body = body,
              let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return json
    }
}
