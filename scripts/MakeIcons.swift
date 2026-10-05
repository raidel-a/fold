// Renders the Fold app icon from an SF Symbol into the PNGs Chrome requires.
//
// Chrome takes bitmaps only, so the symbol has to be rasterised. Rendering it
// here rather than hand-drawing an SVG keeps the glyph authentic, and lets the
// icon take the user's accent colour so the toolbar matches the rest of the
// extension.
//
// The background is left transparent and the art is fitted to the full canvas
// width. The symbol's question mark is a cut-out, so it shows whatever the
// browser paints behind the icon; bold weight at toolbar size keeps it open.
//
// Usage: swiftc -O MakeIcons.swift -o make-icons && ./make-icons <output-dir>
//        [symbol-name] [hex-colour]

import AppKit

// MARK: - Arguments

let args = CommandLine.arguments
let outputDir = args.count > 1 ? args[1] : FileManager.default.currentDirectoryPath
let symbolName = args.count > 2 ? args[2] : "questionmark.folder.fill"
let overrideHex = args.count > 3 ? args[3] : nil

/// Chrome reads exactly these three.
let sizes: [Int] = [16, 48, 128]

/// The symbol's art is wider than it is tall, so it is fitted to the canvas
/// width and centred vertically.
let widthFill = 1.0
let oversample = 4               // render large, downsample for clean 16px edges

/// Arbitrary size used once to measure how wide the art renders, so the fill can
/// be solved for rather than guessed at.
let referencePointSize: CGFloat = 100

/// The symbol knocks its question mark out of the folder. With no tile behind
/// it that cut-out shows whatever the browser draws the icon over, so the mark
/// has to be large to survive: a bolder weight at toolbar size keeps it open.
func glyphMetrics(forSize size: Int) -> NSFont.Weight {
    size <= 16 ? .bold : .semibold
}

// MARK: - Colour

func hex(_ value: String) -> NSColor? {
    var s = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let n = UInt32(s, radix: 16) else { return nil }
    return NSColor(
        srgbRed: CGFloat((n >> 16) & 0xff) / 255,
        green: CGFloat((n >> 8) & 0xff) / 255,
        blue: CGFloat(n & 0xff) / 255,
        alpha: 1
    )
}

func hexString(_ color: NSColor) -> String {
    guard let rgb = color.usingColorSpace(.sRGB) else { return "??????" }
    return [rgb.redComponent, rgb.greenComponent, rgb.blueComponent]
        .map { String(format: "%02X", Int(($0 * 255).rounded())) }
        .joined()
}

/// Honour an explicit colour, otherwise adopt the system accent like the UI does.
let accent: NSColor = {
    if let overrideHex, let c = hex(overrideHex) { return c }
    let accent = NSColor.controlAccentColor
    // A desaturated accent (graphite, from "Multicolor") would read as disabled
    // against a toolbar. Mirrors the fallback in the native host.
    if let rgb = accent.usingColorSpace(.sRGB) {
        let maxV = max(rgb.redComponent, rgb.greenComponent, rgb.blueComponent)
        let minV = min(rgb.redComponent, rgb.greenComponent, rgb.blueComponent)
        if maxV > 0 && (maxV - minV) / maxV < 0.18 { return .systemBlue }
    }
    return accent
}()

// Depends on `accent`, so it must be declared after it.
let glyphColor = accent

// MARK: - Helpers

func makeBitmapRep(pixels: Int) -> NSBitmapImageRep? {
    NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixels,
        pixelsHigh: pixels,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )
}

// MARK: - Render

guard let reference = NSImage(
    systemSymbolName: symbolName, accessibilityDescription: nil
)?.withSymbolConfiguration(.init(pointSize: referencePointSize, weight: .semibold)),
      reference.size.width > 0 else {
    FileHandle.standardError.write(Data("error: unknown SF Symbol \"\(symbolName)\"\n".utf8))
    exit(1)
}

var written: [String] = []

for size in sizes {
    let big = size * oversample
    guard let bigRep = makeBitmapRep(pixels: big) else { continue }

    NSGraphicsContext.saveGraphicsState()
    guard let ctx = NSGraphicsContext(bitmapImageRep: bigRep) else {
        NSGraphicsContext.restoreGraphicsState()
        continue
    }
    NSGraphicsContext.current = ctx
    ctx.imageInterpolation = .high

    // Work in target-pixel units; the scale factor handles the supersampling.
    let scale = CGFloat(oversample)
    ctx.cgContext.scaleBy(x: scale, y: scale)
    let canvas = NSRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size))

    // Fit to the canvas width. Symbol art scales linearly with point size, so
    // one reference measurement is enough to solve for the size that fills it.
    let targetWidth = canvas.width * widthFill
    let pointSize = referencePointSize * targetWidth / reference.size.width
    let symbol = NSImage(
        systemSymbolName: symbolName, accessibilityDescription: nil
    )?.withSymbolConfiguration(
        .init(pointSize: pointSize, weight: glyphMetrics(forSize: size))
    )

    if let symbol {
        let glyph = NSRect(
            x: (canvas.width - symbol.size.width) / 2,
            // Folder art sits slightly high in its box; nudge down so the visual
            // centre matches the geometric one.
            y: (canvas.height - symbol.size.height) / 2 + canvas.height * 0.012,
            width: symbol.size.width,
            height: symbol.size.height
        )
        // Tinting through a transparency layer keeps the recolour on the glyph's
        // own pixels. The question mark stays a genuine cut-out, so it takes
        // whatever the browser paints behind the icon.
        ctx.cgContext.beginTransparencyLayer(auxiliaryInfo: nil)
        symbol.draw(in: glyph)
        glyphColor.setFill()
        glyph.fill(using: .sourceIn)
        ctx.cgContext.endTransparencyLayer()
    }

    NSGraphicsContext.restoreGraphicsState()

    // Downsample to the requested pixel size.
    guard let finalRep = makeBitmapRep(pixels: size) else { continue }
    NSGraphicsContext.saveGraphicsState()
    if let ctx = NSGraphicsContext(bitmapImageRep: finalRep) {
        NSGraphicsContext.current = ctx
        ctx.imageInterpolation = .high
        bigRep.draw(in: NSRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size)))
    }
    NSGraphicsContext.restoreGraphicsState()

    guard let png = finalRep.representation(using: .png, properties: [:]) else { continue }
    let path = (outputDir as NSString).appendingPathComponent("icon\(size).png")
    do {
        try png.write(to: URL(fileURLWithPath: path))
        written.append("icon\(size).png")
    } catch {
        FileHandle.standardError.write(Data("error: cannot write \(path): \(error)\n".utf8))
    }
}

print("symbol:  \(symbolName)")
print("accent:  #\(hexString(accent))\(overrideHex == nil ? " (from macOS)" : " (override)")")
print("wrote:   \(written.joined(separator: ", ")) -> \(outputDir)")