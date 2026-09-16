// System-wide media key simulation - controls ANY app's playback
// Uses NSEvent to simulate physical media key presses
import AppKit
import Foundation

let NX_KEYTYPE_PLAY: Int = 16
let NX_KEYTYPE_NEXT: Int = 17
let NX_KEYTYPE_PREVIOUS: Int = 18

func pressMediaKey(_ key: Int) {
    for down in [true, false] {
        let flags = down ? 0xa00 : 0xb00
        guard let event = NSEvent.otherEvent(
            with: .systemDefined,
            location: .zero,
            modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(flags)),
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            subtype: 8,
            data1: (key << 16) | flags,
            data2: -1
        ) else { continue }
        event.cgEvent?.post(tap: .cghidEventTap)
        usleep(50000)
    }
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("Usage: swift mediakeys.swift [play|next|prev]")
    exit(1)
}

switch args[1] {
case "play":
    pressMediaKey(NX_KEYTYPE_PLAY)
    print("Toggled play/pause")
case "next":
    pressMediaKey(NX_KEYTYPE_NEXT)
    print("Skipped to next track")
case "prev":
    pressMediaKey(NX_KEYTYPE_PREVIOUS)
    print("Skipped to previous track")
default:
    print("Unknown command: \(args[1]). Use: play, next, prev")
    exit(1)
}
