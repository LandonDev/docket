import Foundation

/// One input record of a `drive` stream (NSL1 type 3, `InputEvent` in src/shared/video/nsl1.ts): a key by its HID
/// usage, the pointer as shares of the picture, a button, the wheel in whole notches, or release-all. Each carries the
/// buttons and modifiers held as it is sent.
public struct InputRecord: Equatable, Sendable {
    public enum Kind: UInt8, Sendable {
        case keyDown = 1, keyUp, pointerMove, buttonDown, buttonUp, wheel, releaseAll
    }

    public var kind: Kind
    /// the key, the button (1 left, 2 middle, 3 right), or the wheel's axis (1 horizontal)
    public var code: UInt16 = 0
    /// the wheel's delta, a multiple of 120
    public var value: Int32 = 0
    public var x: Double = 0
    public var y: Double = 0
    public var buttons: UInt16 = 0
    public var modifiers: UInt16 = 0

    public static func key(_ down: Bool, _ code: UInt16, modifiers: UInt16 = 0, buttons: UInt16 = 0) -> InputRecord {
        InputRecord(kind: down ? .keyDown : .keyUp, code: code, buttons: buttons, modifiers: modifiers)
    }

    public static func move(_ x: Double, _ y: Double, buttons: UInt16 = 0) -> InputRecord {
        InputRecord(kind: .pointerMove, x: x, y: y, buttons: buttons)
    }

    public static func button(_ down: Bool, _ button: UInt16, _ x: Double, _ y: Double, buttons: UInt16) -> InputRecord {
        InputRecord(kind: down ? .buttonDown : .buttonUp, code: button, x: x, y: y, buttons: buttons)
    }

    public static func wheel(horizontal: Bool, delta: Int32, _ x: Double, _ y: Double, buttons: UInt16 = 0) -> InputRecord {
        InputRecord(kind: .wheel, code: horizontal ? 1 : 0, value: delta, x: x, y: y, buttons: buttons)
    }

    public static let releaseAll = InputRecord(kind: .releaseAll)
}

extension NSL1 {
    static let inputType: UInt8 = 3
    public static let inputSize = 16

    /// One input message for a stream's socket, numbered with the generation the last frame said; the sequence is
    /// zero there (`encodeInput`).
    public static func encodeInput(_ record: InputRecord, generation: UInt32) -> Data {
        var out = header(type: inputType, generation: generation, sequence: 0, size: inputSize)
        let share = { (v: Double) in UInt16((min(1, max(0, v)) * 65_535).rounded()) }
        let pointer = [.pointerMove, .buttonDown, .buttonUp, .wheel].contains(record.kind)
        var b = [UInt8](repeating: 0, count: inputSize)
        b[0] = record.kind.rawValue
        put16(&b, 2, record.code)
        put32(&b, 4, UInt32(bitPattern: record.value))
        if pointer {
            put16(&b, 8, share(record.x))
            put16(&b, 10, share(record.y))
        }
        if record.kind != .releaseAll {
            put16(&b, 12, record.buttons)
            put16(&b, 14, record.modifiers)
        }
        out.append(contentsOf: b)
        return out
    }

    private static func put16(_ b: inout [UInt8], _ at: Int, _ v: UInt16) {
        b[at] = UInt8(v >> 8)
        b[at + 1] = UInt8(v & 0xFF)
    }

    private static func put32(_ b: inout [UInt8], _ at: Int, _ v: UInt32) {
        for i in 0..<4 { b[at + i] = UInt8(v >> (24 - 8 * UInt32(i)) & 0xFF) }
    }
}

/// His touches and keys on the phone's full screen, as the records a `drive` stream takes (docs/agents/live-video.md
/// "Driving", the desktop's `VideoInput` in src/renderer/src/lib/video/videoInput.ts). A tap is a click, a drag moves
/// with the left button down, two fingers scroll in whole notches, a long press is a right click. What a US keyboard
/// has goes as key records by its place on that keyboard (HID usage codes, `HID_KEYS`), with Shift where the character
/// needs it; any other character goes to `paste`, the source's own typing (`video.paste`). Points are shares of the
/// picture, 0 to 1.
public final class PhoneDriving {
    /// How far two fingers move for one wheel notch, in points.
    public static let pointsPerNotch: Double = 24

    public static let enter: UInt16 = 40
    public static let backspace: UInt16 = 42
    public static let tab: UInt16 = 43
    public static let shiftLeft: UInt16 = 225
    static let shiftBit: UInt16 = 1 << 1

    private let send: (InputRecord) -> Void
    private let paste: (String) -> Void
    private var buttons: UInt16 = 0
    private var remainder = (x: 0.0, y: 0.0)

    /// `send` writes one record to the stream; `paste` hands text to the source's own typing.
    public init(send: @escaping (InputRecord) -> Void, paste: @escaping (String) -> Void) {
        self.send = send
        self.paste = paste
    }

    /// A click of the left button where he tapped.
    public func tap(_ x: Double, _ y: Double) { click(1, x, y) }

    /// A long press: a click of the right button where he held.
    public func longPress(_ x: Double, _ y: Double) { click(3, x, y) }

    public func dragBegan(_ x: Double, _ y: Double) {
        send(.move(clamp(x), clamp(y), buttons: buttons))
        press(1, true, x, y)
    }

    public func dragMoved(_ x: Double, _ y: Double) {
        send(.move(clamp(x), clamp(y), buttons: buttons))
    }

    public func dragEnded(_ x: Double, _ y: Double) {
        send(.move(clamp(x), clamp(y), buttons: buttons))
        press(1, false, x, y)
    }

    /// Two fingers moved by `dx`, `dy` points over the picture at `x`, `y`. Fingers up scroll the page down, as a
    /// trackpad's natural scrolling does; a part of a notch waits for the next move in the same direction.
    public func scroll(dx: Double, dy: Double, _ x: Double, _ y: Double) {
        for horizontal in [false, true] {
            let notches = -(horizontal ? dx : dy) / Self.pointsPerNotch
            guard notches != 0 else { continue }
            var rest = horizontal ? remainder.x : remainder.y
            if (notches > 0) != (rest > 0), rest != 0 { rest = 0 }
            rest += notches
            let whole = rest.rounded(.towardZero)
            rest -= whole
            if horizontal { remainder.x = rest } else { remainder.y = rest }
            guard whole != 0 else { continue }
            let delta = Int32(max(-1_200, min(1_200, whole * 120)))
            send(.wheel(horizontal: horizontal, delta: delta, clamp(x), clamp(y), buttons: buttons))
        }
    }

    /// What the keyboard typed: each character a US keyboard has as its key, the rest of a run as one paste.
    public func type(_ text: String) {
        var other = ""
        for character in text {
            guard let key = Self.usKey(character) else {
                other.append(character)
                continue
            }
            if !other.isEmpty {
                paste(other)
                other = ""
            }
            if key.shift {
                send(.key(true, Self.shiftLeft, modifiers: Self.shiftBit, buttons: buttons))
                send(.key(true, key.code, modifiers: Self.shiftBit, buttons: buttons))
                send(.key(false, key.code, modifiers: Self.shiftBit, buttons: buttons))
                send(.key(false, Self.shiftLeft, buttons: buttons))
            } else {
                tapKey(key.code)
            }
        }
        if !other.isEmpty { paste(other) }
    }

    /// The keyboard's delete key.
    public func deleteBackward() { tapKey(Self.backspace) }

    /// Everything he holds is let go there: the full screen closed, or he handed back.
    public func release() {
        let had = buttons != 0
        buttons = 0
        remainder = (0, 0)
        if had { send(.releaseAll) }
    }

    private func click(_ button: UInt16, _ x: Double, _ y: Double) {
        send(.move(clamp(x), clamp(y), buttons: buttons))
        press(button, true, x, y)
        press(button, false, x, y)
    }

    /// `buttons` as the desktop keeps it, a bit per DOM button: left 1, middle 2, right 4.
    private func press(_ button: UInt16, _ down: Bool, _ x: Double, _ y: Double) {
        let bit: UInt16 = button == 3 ? 4 : button == 2 ? 2 : 1
        buttons = down ? buttons | bit : buttons & ~bit
        send(.button(down, button, clamp(x), clamp(y), buttons: buttons))
    }

    private func tapKey(_ code: UInt16) {
        send(.key(true, code, buttons: buttons))
        send(.key(false, code, buttons: buttons))
    }

    private func clamp(_ v: Double) -> Double { min(1, max(0, v)) }

    /// The key a US keyboard types `character` with, and whether Shift is held for it; nil for one it has not.
    public static func usKey(_ character: Character) -> (code: UInt16, shift: Bool)? {
        guard character.unicodeScalars.count == 1, let scalar = character.unicodeScalars.first, scalar.isASCII else {
            return character == "\r\n" ? (enter, false) : nil
        }
        let v = scalar.value
        switch v {
        case 0x61...0x7A: return (UInt16(4 + v - 0x61), false)
        case 0x41...0x5A: return (UInt16(4 + v - 0x41), true)
        case 0x31...0x39: return (UInt16(30 + v - 0x31), false)
        case 0x30: return (39, false)
        default: return punctuation[Character(scalar)]
        }
    }

    private static let punctuation: [Character: (code: UInt16, shift: Bool)] = {
        var keys: [Character: (UInt16, Bool)] = ["\n": (enter, false), "\r": (enter, false), "\t": (tab, false), " ": (44, false)]
        // the shifted digit row: 1 to 9, then 0
        for (i, c) in "!@#$%^&*(".enumerated() { keys[c] = (UInt16(30 + i), true) }
        keys[")"] = (39, true)
        // from Minus (45) to Slash (56), each key's own character and its shifted one; 50 is the non-US hash key
        let rows: [(UInt16, Character, Character)] = [
            (45, "-", "_"), (46, "=", "+"), (47, "[", "{"), (48, "]", "}"), (49, "\\", "|"),
            (51, ";", ":"), (52, "'", "\""), (53, "`", "~"), (54, ",", "<"), (55, ".", ">"), (56, "/", "?"),
        ]
        for (code, plain, shifted) in rows {
            keys[plain] = (code, false)
            keys[shifted] = (code, true)
        }
        return keys
    }()
}
