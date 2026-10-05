// Measures the model's real context budget so CHUNK_SIZE can be set from evidence.
//
// This exists because CHUNK_SIZE was 60, which was a round number rather than a
// measured one. On realistic tab titles a 40-tab chunk needs ~3277 prompt tokens
// and a 60-tab chunk ~4917, both over the 4096-token window: the generation fails
// and the whole fold errors out. Re-run this after changing CHUNK_SIZE or the
// maxTitleLength setting.
//
// Usage: swiftc -O ProbeContext.swift -o probe-context && ./probe-context

import Foundation
import FoundationModels

// Unbuffered: this runs to a crash or a long generation, and buffered output is
// lost when it dies.
setvbuf(stdout, nil, _IONBF, 0)

@Generable(description: "A partition of the supplied tabs into groups.")
struct TabGroupPlan {
    @Guide(description: "Every group, together covering each supplied tab id exactly once.")
    var groups: [TabGroup]
}

@Generable(description: "One proposed tab group.")
struct TabGroup {
    @Guide(description: "Short group name, 1 to 3 words.")
    var name: String
    @Guide(description: "Tab group colour.")
    var color: String
    @Guide(description: "The ids of the tabs in this group.")
    var tabIds: [Int]
}

let system = "You are a browser tab organizer. Group tabs by topic."

/// Realistic worst case: long titles, as the settings page allows up to 200 chars.
func prompt(tabs: Int, titleChars: Int) -> String {
    let filler = String(repeating: "M", count: titleChars)
    let rows = (0..<tabs).map { i in
        "  - id: \(i + 1) | \"\(filler) project board \(i) — status update thread\" | https://subdomain\(i).example-company.io/path/to/resource/\(i)"
    }.joined(separator: "\n")

    return """
        Group these browser tabs into at most 6 logical groups.

        Every tab belongs in exactly one group. Use short group names, one to three words.

        Tabs:
        \(rows)
        """
}

let model = SystemLanguageModel.default
guard case .available = model.availability else {
    print("model unavailable")
    exit(1)
}

print("Context budget probe")
print(String(format: "stated maximum response tokens: %d", 4096))
print("")

// Count tokens for a spread of chunk sizes at both ends of the title-length
// setting, without spending a generation on any of it.
print("prompt tokens (prompt + instructions):")
print("     tabs    80 chars   200 chars")

var worstCaseAtSixty: Int = 0

for tabs in [10, 20, 30, 40, 50, 60] {
    let short = prompt(tabs: tabs, titleChars: 80)
    let long = prompt(tabs: tabs, titleChars: 200)
    let shortTokens = (try? await model.tokenCount(for: short)) ?? -1
    let longTokens = (try? await model.tokenCount(for: long)) ?? -1
    let systemTokens = (try? await model.tokenCount(for: Instructions(system))) ?? 0

    print(String(format: "  %6d  %10d  %10d", tabs, shortTokens + systemTokens, longTokens + systemTokens))

    if tabs == 60 { worstCaseAtSixty = longTokens + systemTokens }
}

// Confirm the ceiling empirically rather than trusting the arithmetic: token
// counting and the sampler's own accounting can disagree.
print("")
print("empirical ceiling (generation must succeed, 200-char titles):")

var largestWorking = 0
for tabs in [15, 20, 25] {
    let session = LanguageModelSession(instructions: system)
    let promptText = prompt(tabs: tabs, titleChars: 200)
    let started = Date()
    print(String(format: "  %3d tabs: ", tabs), terminator: "")
    do {
        _ = try await session.respond(
            to: promptText,
            schema: TabGroupPlan.generationSchema,
            options: GenerationOptions(maximumResponseTokens: 2048)
        )
        print(String(format: "ok in %.1fs", Date().timeIntervalSince(started)))
        largestWorking = tabs
    } catch {
        print("FAILED — \(String(String(describing: error).prefix(70)))")
        break
    }
}

print("")
print("largest chunk that works: \(largestWorking) tabs")
if worstCaseAtSixty > 0 {
    print(String(format: "A chunk of 60 tabs reaches %d prompt tokens at the 200-char setting, over the 4096 limit.", worstCaseAtSixty))
}