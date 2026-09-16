//
//  CalendarReader.swift
//  Dottie
//
//  EventKit-based reader exposed through MacUseService's HTTP listener (port 1319).
//  Replaces the legacy `tell application "Calendar"` AppleScript path that hung
//  for 1+ minute on accounts with many calendars and required AppleEvents
//  Automation TCC. EventKit reads from the local SQLite calendar store,
//  authorized by `NSCalendarsUsageDescription`, and returns in milliseconds.
//

import Foundation
import EventKit

enum CalendarReader {
    /// Single shared EKEventStore so we don't recreate the SQLite handle per request.
    static let store = EKEventStore()

    /// True if EventKit access is currently granted. Doesn't trigger the prompt —
    /// `requestAccess` does that, fired from the calling endpoint.
    static var isAuthorized: Bool {
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(macOS 14.0, *) {
            return status == .fullAccess || status == .authorized
        }
        return status == .authorized
    }

    /// Request EventKit access (fires the macOS prompt on first call).
    /// Synchronous wrapper for use inside the MacUseService dispatch queue.
    static func requestAccessSync() -> Bool {
        if isAuthorized { return true }
        let semaphore = DispatchSemaphore(value: 0)
        var granted = false
        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents { ok, _ in
                granted = ok
                semaphore.signal()
            }
        } else {
            store.requestAccess(to: .event) { ok, _ in
                granted = ok
                semaphore.signal()
            }
        }
        semaphore.wait()
        return granted
    }

    /// List events in the next N days. Returns a JSON string ready to ship over
    /// the HTTP response. Fields match what `tools/scheduling.js:calendar_list`
    /// wraps in its `_ui` envelope.
    static func listEvents(days: Int, calendarName: String?) -> String {
        guard isAuthorized else {
            return "{\"error\":\"calendar_denied\",\"message\":\"Grant Calendar access in System Settings → Privacy & Security → Calendars.\"}"
        }

        let start = Date()
        let end = Date(timeIntervalSinceNow: TimeInterval(days) * 86400)
        let allCalendars = store.calendars(for: .event)

        let targetCalendars: [EKCalendar]?
        if let name = calendarName, !name.isEmpty {
            let filtered = allCalendars.filter { $0.title.caseInsensitiveCompare(name) == .orderedSame }
            if filtered.isEmpty {
                let available = allCalendars.map { $0.title }
                let availableJSON = (try? JSONSerialization.data(withJSONObject: available)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
                return "{\"error\":\"calendar_not_found\",\"available\":\(availableJSON)}"
            }
            targetCalendars = filtered
        } else {
            targetCalendars = nil // means all calendars
        }

        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: targetCalendars)
        let events = store.events(matching: predicate)

        let isoFormatter: ISO8601DateFormatter = {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime]
            return f
        }()

        let payload: [String: Any] = [
            "events": events.map { evt -> [String: Any] in
                [
                    "title": evt.title ?? "",
                    "startDate": isoFormatter.string(from: evt.startDate),
                    "endDate": isoFormatter.string(from: evt.endDate),
                    "calendar": evt.calendar?.title ?? "",
                    "location": evt.location ?? "",
                    "isAllDay": evt.isAllDay,
                ]
            },
            "calendarsAvailable": allCalendars.map { $0.title },
            "rangeDays": days,
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else {
            return "{\"error\":\"serialization_failed\"}"
        }
        return json
    }
}
