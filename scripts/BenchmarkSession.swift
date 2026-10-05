// Benchmark: a fresh LanguageModelSession per request (Fold's current path)
// against one reused session across requests.
//
// Fold chunks at 60 tabs, so a large window pays several round trips back to back.
// If reusing the session is meaningfully faster, that is a real win; if not, the
// current code is fine and should be left alone.
//
// Also measures what reuse costs: a reused session accumulates turns, so latency
// and output are re-checked at the end of a run rather than only at the start.
//
// Usage: swiftc -O BenchmarkSession.swift -o benchmark-session && ./benchmark-session

import Foundation
import FoundationModels

// MARK: - Fixtures

/// A prompt shaped like Fold's: system instructions plus a chunk of tabs.
struct Chunk {
    let system: String
    let user: String
    let schema: GenerationSchema
    let label: String
}

@Generable(description: "A partition of the supplied tabs into groups.")
struct TabGroupPlan {
    @Guide(description: "Every group, together covering each supplied tab id exactly once.")
    var groups: [TabGroup]
}

@Generable(description: "One proposed tab group.")
struct TabGroup {
    @Guide(description: "Short group name, 1 to 3 words.")
    var name: String
    @Guide(description: "Tab group colour, one of: grey, blue, red, yellow, green, pink, purple, cyan, orange.")
    var color: String
    @Guide(description: "The ids of the tabs in this group, copied exactly from the input.")
    var tabIds: [Int]
}

// Titles are padded toward the settings page's 80-char default rather than being
// uniformly short, so the token counts reflect what Fold actually sends.
let topics: [(String, String)] = [
    ("github.com/myorg/pulls", "Fix flaky auth test that only fails on arm64 runners in CI"),
    ("github.com/trending", "Trending repositories today, mostly Rust and small CLIs"),
    ("stackoverflow.com/questions/8821", "How do I centre a div properly in 2026 without a wrapper"),
    ("news.ycombinator.com", "Show HN: I wrote a tiny embedded database engine in Swift"),
    ("shop.example.com/shoes", "Running shoes, size 10, blue, with the wide toe box"),
    ("shop.example.com/jackets", "Rain jacket, waterproof, hooded, medium, olive green"),
    ("docs.google.com/document/d/abc", "Q3 planning notes - revenue, hiring, and the migration"),
    ("calendar.google.com", "Week of 12 October, four meetings and one all-hands"),
    ("mail.google.com/inbox", "Inbox (412) - unread, from recruiting and a vendor"),
    ("arxiv.org/abs/2601.01234", "On-device transformers for UI agents, with ablations"),
    ("developer.apple.com/documentation", "Tab Groups API reference and available methods"),
    ("figma.com/file/xyz", "Design review - comments resolved except the nav"),
    ("linear.app/team/ENG/1234", "ENG-1234 flaky CI on arm64, intermittent, needs a bisect"),
    ("youtube.com/watch?v=abc", "Conference talk: local inference is finally practical"),
    ("reddit.com/r/swift", "Swift concurrency patterns thread, structured tasks everywhere"),
    ("notion.so/workspace", "Team handbook - on-call process and escalation paths"),
    ("slack.com/archives/C123", "#eng standup notes from this morning, async format"),
    ("jira.com/browse/PROJ-88", "PROJ-88 memory leak on window close, needs a repro"),
    ("medium.com/@someone", "Why on-device is the right default for private tools"),
    ("wikipedia.org/wiki/Tab_stop", "Tab stop - typography reference, variable and fixed"),
    ("aws.amazon.com/console", "S3 buckets overview, monthly transfer and storage"),
    ("console.aws.amazon.com/ec2", "Instances: 1 pending, 6 running, 1 stopping"),
    ("grafana.io/d/abc123", "Latency dashboard, p50 p95 p99 over the last six hours"),
    ("sentry.io/organizations/issues", "TypeError: undefined reading 'id' in popup render"),
    ("vercel.com/acme/settings", "Project settings, domains, environment variables"),
    ("localhost:3000", "dev server - home page, hot reload, 4 warnings"),
    ("trello.com/b/abc/board", "Sprint 42 board, twelve cards, three in review"),
    ("zoom.us/j/123456", "Weekly sync - reorganisation retrospective, 45 minutes"),
    ("dropbox.com/team/design", "Design files, shared folder, updated yesterday"),
    ("icloud.com", "iCloud Drive - shared with two people, 4GB used"),
]

func makeChunk(index: Int, count: Int) -> Chunk {
    let rows = (0..<count).map { i -> String in
        let d = topics[(index * count + i) % topics.count]
        let id = index * 1000 + i
        return "  - id: \(id) | \"\(d.1)\" | https://\(d.0)"
    }.joined(separator: "\n")

    return Chunk(
        system: "You are a browser tab organizer. Group tabs by topic.",
        user: """
            Group these browser tabs into at most 6 logical groups.

            Every tab belongs in exactly one group. Use short group names, one to three words.

            Tabs:
            \(rows)
            """,
        schema: TabGroupPlan.generationSchema,
        label: "chunk\(index) x\(count)"
    )
}

// MARK: - Timing

@discardableResult
func timed(_ body: () async throws -> Void) async rethrows -> Double {
    let start = Date()
    try await body()
    return Date().timeIntervalSince(start)
}

func stats(_ samples: [Double]) -> String {
    let sorted = samples.sorted()
    let n = sorted.count
    let median = sorted[n / 2]
    let mean = sorted.reduce(0, +) / Double(n)
    return String(format: "median %.2fs  mean %.2fs  min %.2fs  max %.2fs", median, mean, sorted[0], sorted[n - 1])
}

func guardAvailable() {
    guard case .available = SystemLanguageModel.default.availability else {
        print("model unavailable; cannot benchmark")
        exit(1)
    }
}

// MARK: - Paths

/// What Fold does today: a new session per request.
func freshSessionPerRequest(_ chunks: [Chunk]) async throws -> [Double] {
    var times: [Double] = []
    for chunk in chunks {
        let t = try await timed {
            let session = LanguageModelSession(instructions: chunk.system)
            _ = try await session.respond(
                to: chunk.user,
                schema: chunk.schema,
                options: GenerationOptions(maximumResponseTokens: 2048)
            )
        }
        times.append(t)
    }
    return times
}

/// The alternative: one session reused across the whole run.
func reusedSession(_ chunks: [Chunk]) async throws -> [Double] {
    var times: [Double] = []
    let session = LanguageModelSession(instructions: chunks[0].system)
    for chunk in chunks {
        let t = try await timed {
            _ = try await session.respond(
                to: chunk.user,
                schema: chunk.schema,
                options: GenerationOptions(maximumResponseTokens: 2048)
            )
        }
        times.append(t)
    }
    return times
}

// MARK: - Main

// Measured context ceiling: at realistic title lengths a chunk of 40 tabs exceeds
// the 4096-token window and the generation fails outright. 20 tabs completes with
// room to spare. Fold's CHUNK_SIZE of 60 is above this ceiling; see the note below.
let chunkSizes = [20, 20]
let chunks = zip(chunkSizes.indices, chunkSizes).map { makeChunk(index: $0, count: $1) }

guardAvailable()

print("Apple Foundation Models - session reuse benchmark")
print("Fixture: \(chunks.map(\.label).joined(separator: " + "))  (\(chunkSizes.reduce(0, +)) tabs)")
print("")

// Cold cost is paid once either way, and both paths pay it, so it is measured and
// reported separately rather than folded into the comparison.
let coldStart = try await timed {
    let session = LanguageModelSession(instructions: "You are a browser tab organizer. Group tabs by topic.")
    _ = try await session.respond(to: "Reply with exactly: OK")
}
print(String(format: "cold start (both paths pay this): %.2fs", coldStart))
print("")

// Interleave the two paths so any drift in machine load hits both equally.
var fresh: [Double] = []
var reused: [Double] = []

for _ in 0..<2 {
    fresh += try await freshSessionPerRequest(chunks)
    reused += try await reusedSession(chunks)
}

print("fresh session per request (current)")
print("  \(stats(fresh))")
print("")
print("one reused session")
print("  \(stats(reused))")
print("")

let freshMedian = fresh.sorted()[fresh.count / 2]
let reusedMedian = reused.sorted()[reused.count / 2]
let delta = freshMedian - reusedMedian
print(String(format: "median difference: %+.2fs (%+.0f%%)", delta, delta / freshMedian * 100))

// Growth check: reuse is only worth it if later requests stay as fast as the
// first. A session that accumulates context could get slower with each turn.
print("")
if reused.count >= 4 {
    let firstHalf = reused.prefix(reused.count / 2).reduce(0, +) / Double(reused.count / 2)
    let secondHalf = reused.suffix(reused.count / 2).reduce(0, +) / Double(reused.count / 2)
    print(String(format: "reused session, first half mean %.2fs vs second half mean %.2fs (%+.2fs)",
                 firstHalf, secondHalf, secondHalf - firstHalf))
}