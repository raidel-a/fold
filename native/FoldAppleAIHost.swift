// Fold native host: Apple Foundation Models over Chrome native messaging.
//
// Chrome native messaging framing on arm64: a 4-byte little-endian length prefix
// followed by a UTF-8 JSON payload, in both directions.
//
// Request:  { "id": "1", "systemPrompt": "...", "prompt": "...", "maxTokens": 4096 }
// Response: { "id": "1", "ok": true, "content": "...", "inputTokens": 0, "outputTokens": 0 }
//           { "id": "1", "ok": false, "error": "..." }

import AppKit
import Foundation
import FoundationModels

// MARK: - Wire codec

enum Wire {
    private static let fd = FileHandle.standardInput.fileDescriptor
    private static let out = FileHandle.standardOutput

    /// Blocking read of exactly one framed JSON message. Returns nil on EOF or framing error.
    static func readMessage() -> [String: Any]? {
        guard let length = readExactly(4) else { return nil }
        let byteCount = length.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian }
        guard byteCount > 0, byteCount < 64 * 1024 * 1024,
              let payload = readExactly(Int(byteCount)) else { return nil }
        return try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
    }

    static func write(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        var framed = Data(capacity: data.count + 4)
        withUnsafeBytes(of: UInt32(data.count).littleEndian) { framed.append(contentsOf: $0) }
        framed.append(data)
        out.write(framed)
    }

    /// Returns nil once stdin reaches EOF. Loops on partial reads.
    private static func readExactly(_ count: Int) -> Data? {
        var buffer = Data(capacity: count)
        while buffer.count < count {
            var chunk = [UInt8](repeating: 0, count: count - buffer.count)
            let n = chunk.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if n == 0 { return buffer.count == count ? buffer : nil }
            if n < 0 {
                if errno == EINTR { continue }
                return nil
            }
            buffer.append(contentsOf: chunk[0..<n])
        }
        return buffer
    }
}

// MARK: - Model

enum HostError: LocalizedError {
    case unavailable(String)
    case generation(String)

    var errorDescription: String? {
        switch self {
        case .unavailable(let why): return "Apple on-device model unavailable: \(why)"
        case .generation(let why): return "Generation failed: \(why)"
        }
    }
}

enum AppleModel {
    /// Phrases availability failures so a user can act on them.
    static func explain(_ reason: SystemLanguageModel.Availability.UnavailableReason) -> String {
        switch reason {
        case .deviceNotEligible:
            return "this Mac does not support Apple Intelligence (M1 or newer required)"
        case .appleIntelligenceNotEnabled:
            return "Apple Intelligence is off. Turn it on in System Settings > Apple Intelligence."
        case .modelNotReady:
            return "the model is still downloading or preparing. Retry in a minute."
        default:
            return "\(reason)"
        }
    }

    static func complete(systemPrompt: String, prompt: String, maxTokens: Int) async throws -> (String, Int, Int) {
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            break
        case .unavailable(let reason):
            throw HostError.unavailable(explain(reason))
        }

        let trimmedSystem = String(systemPrompt.prefix(20_000))
        let trimmedPrompt = String(prompt.prefix(60_000))
        let session = LanguageModelSession(instructions: trimmedSystem.isEmpty ? nil : trimmedSystem)

        let content: String
        do {
            content = try await session.respond(
                to: trimmedPrompt,
                options: GenerationOptions(maximumResponseTokens: max(256, maxTokens))
            ).content
        } catch {
            throw HostError.generation(error.localizedDescription)
        }

        // Foundation Models exposes real token counts, so skip Fold's char/4 estimate.
        let promptTokens = (try? await model.tokenCount(for: trimmedPrompt)) ?? 0
        let systemTokens = trimmedSystem.isEmpty
            ? 0
            : ((try? await model.tokenCount(for: Instructions(trimmedSystem))) ?? 0)
        let outputTokens = (try? await model.tokenCount(for: content)) ?? 0

        return (content, promptTokens + systemTokens, outputTokens)
    }
}

// MARK: - Theme

/// Hands the browser macOS's own accent color and appearance, so the extension
/// can tint itself the way the rest of the system does instead of hardcoding a
/// brand color.
enum Theme {
    /// Below this saturation an accent reads as "disabled" rather than "chosen".
    /// Picking Multicolor in System Settings yields graphite, and tinting a whole
    /// interface with it looks broken, so fall back to the system blue.
    private static let minimumSaturation: CGFloat = 0.18

    static func current() -> [String: Any] {
        let isDark = isCurrentAppearanceDark()
        let raw = NSColor.controlAccentColor
        let useFallback = !isSaturatedEnough(raw)
        let accent = useFallback ? NSColor.systemBlue : raw

        var payload: [String: Any] = [
            "isDark": isDark,
            "accent": hex(accent) ?? (isDark ? "#0A84FF" : "#007AFF"),
            // Lets the UI know whether to trust the value or keep its own default.
            "accentIsFallback": useFallback,
        ]

        // Read each group color so tabs, chips, and dots match the browser's
        // actual palette rather than guessed hex values.
        let palette: [(String, NSColor)] = [
            ("grey", .systemGray),
            ("blue", .systemBlue),
            ("red", .systemRed),
            ("yellow", .systemYellow),
            ("green", .systemGreen),
            ("pink", .systemPink),
            ("purple", .systemPurple),
            ("cyan", .systemCyan),
            ("orange", .systemOrange),
        ]
        payload["groupColors"] = Dictionary(
            uniqueKeysWithValues: palette.compactMap { name, color in
                hex(color).map { (name, $0) }
            }
        )
        return payload
    }

    /// Named system colors are dynamic: resolving to sRGB already picks the
    /// variant for the current appearance, so yellow stays legible in light mode
    /// instead of glowing.
    private static func hex(_ color: NSColor) -> String? {
        color.usingColorSpace(.sRGB).map(format)
    }

    /// Chroma-based saturation in HSB, which is what "is this color colorful"
    /// actually means for UI tinting.
    private static func isSaturatedEnough(_ color: NSColor) -> Bool {
        guard let c = color.usingColorSpace(.sRGB) else { return true }
        let max = max(c.redComponent, c.greenComponent, c.blueComponent)
        let min = min(c.redComponent, c.greenComponent, c.blueComponent)
        guard max > 0 else { return true }
        return (max - min) / max >= Double(minimumSaturation)
    }

    private static func isCurrentAppearanceDark() -> Bool {
        let current = NSApp?.effectiveAppearance ?? NSAppearance.currentDrawing()
        return current.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    }

    private static func format(_ color: NSColor) -> String {
        let r = Int((color.redComponent * 255).rounded())
        let g = Int((color.greenComponent * 255).rounded())
        let b = Int((color.blueComponent * 255).rounded())
        return String(format: "#%02X%02X%02X", r, g, b)
    }
}

// MARK: - Message pump

/// Blocking stdin reader on its own thread, so the cooperative pool stays free
/// while we await model responses.
func incomingMessages() -> AsyncStream<[String: Any]> {
    AsyncStream { continuation in
        let thread = Thread {
            while let message = Wire.readMessage() {
                continuation.yield(message)
            }
            continuation.finish()
        }
        thread.stackSize = 512 * 1024
        thread.start()
    }
}

func handle(_ message: [String: Any]) async {
    let id = message["id"] as? String ?? ""

    // Availability probe: answers without touching the model, so the settings page
    // can poll it cheaply.
    if message["op"] as? String == "status" {
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            Wire.write(["id": id, "ok": true, "available": true])
        case .unavailable(let reason):
            Wire.write([
                "id": id, "ok": true, "available": false,
                "reason": AppleModel.explain(reason),
            ])
        }
        return
    }

    // Appearance query: accent color and group palette, no model involved.
    if message["op"] as? String == "theme" {
        Wire.write(Theme.current().merging(["id": id, "ok": true]) { _, new in new })
        return
    }

    let prompt = message["prompt"] as? String ?? ""
    let systemPrompt = message["systemPrompt"] as? String ?? ""
    let maxTokens = message["maxTokens"] as? Int ?? 4096

    guard !prompt.isEmpty else {
        Wire.write(["id": id, "ok": false, "error": "prompt is required"])
        return
    }

    do {
        let (content, inputTokens, outputTokens) = try await AppleModel.complete(
            systemPrompt: systemPrompt, prompt: prompt, maxTokens: maxTokens
        )
        Wire.write([
            "id": id,
            "ok": true,
            "content": content,
            "inputTokens": inputTokens,
            "outputTokens": outputTokens,
        ])
    } catch {
        Wire.write(["id": id, "ok": false, "error": error.localizedDescription])
    }
}

@main
enum HostMain {
    static func main() async {
        // One request at a time: Foundation Models serializes internally anyway, and a
        // shared stdout stream must not interleave two responses.
        for await message in incomingMessages() {
            await handle(message)
        }
    }
}