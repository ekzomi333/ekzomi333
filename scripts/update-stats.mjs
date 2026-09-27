// Updates the <!-- STATS-START -->…<!-- STATS-END --> block in README.md
// with lifetime activity counters from the DSH session logs.
// Runs both locally (node scripts/update-stats.mjs) and in GitHub Actions.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readmePath = join(__dirname, "..", "README.md");

const COUNTED_TOOLS = {
    pwsh: "shellCommands",
    bash: "shellCommands",
    read: "filesRead",
    glob: "searches",
    grep: "searches",
    web_search: "webRequests",
    web_fetch: "webRequests"
};

function emptyStats() {
    return {
        sessions: 0,
        turns: 0,
        steps: 0,
        toolCalls: 0,
        shellCommands: 0,
        filesWritten: 0,
        filesEdited: 0,
        filesRead: 0,
        searches: 0,
        webRequests: 0,
        llmMs: 0,
        toolMs: 0,
        decodeTokens: 0,
        projects: new Set()
    };
}

function sumFromCache(cacheRow, field) {
    const v = cacheRow?.val?.[field];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function decodeSessionLog(buf) {
    const starts = [];
    for (let i = 0; i + 4 <= buf.length; i++) {
        if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
    }
    const parts = [];
    for (let k = 0; k < starts.length; k++) {
        const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
        parts.push(zlib.zstdDecompressSync(buf.subarray(starts[k], end)));
    }
    return Buffer.concat(parts).toString("utf8");
}

function scanSessionFile(path, stats) {
    const text = decodeSessionLog(readFileSync(path));
    for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }
        switch (event.type) {
            case "session": {
                if ((event.delegationDepth ?? 0) > 0) return false; // subagent session: skip
                stats.sessions += 1;
                if (typeof event.cwd === "string" && event.cwd.length > 0) stats.projects.add(event.cwd);
                break;
            }
            case "turn/end":
                stats.turns += 1;
                break;
            case "step/end":
                stats.steps += 1;
                break;
            case "tool/call": {
                stats.toolCalls += 1;
                const tool = event.data?.name;
                if (tool === "write") stats.filesWritten += 1;
                else if (tool === "edit") stats.filesEdited += 1;
                else if (Object.hasOwn(COUNTED_TOOLS, tool)) stats[COUNTED_TOOLS[tool]] += 1;
                break;
            }
            default:
                break;
        }
    }
    return true;
}

function scanAll() {
    const stats = emptyStats();
    // Local run: real home (~/.dsh). Actions run: DSH_HOME points at the synced logs checkout.
    const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    const sessionsRoot = join(home, "sessions");
    const cacheRoot = join(home, "storages", "session_projcache", "sessions");
    let projectDirs = [];
    try {
        projectDirs = readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(sessionsRoot, e.name));
    } catch {
        console.log(`no sessions tree at ${sessionsRoot} — stats unchanged`);
        process.exit(0);
    }
    for (const dir of projectDirs) {
        let sessionDirs = [];
        try {
            sessionDirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
        } catch {
            continue;
        }
        for (const sd of sessionDirs) {
            const candidates = ["session.v3.jsonl.zstd", "session.v2.jsonl.zstd", "session.v1.jsonl.zstd", "session.jsonl.zstd"];
            let path = null;
            for (const c of candidates) {
                const candidate = join(sd, c);
                try {
                    readFileSync(candidate);
                    path = candidate;
                    break;
                } catch {
                    // try next generation
                }
            }
            if (path === null) continue;
            try {
                const counted = scanSessionFile(path, stats);
                if (!counted) continue;
                const sessionId = sd.split(/[\\/]/).pop();
                try {
                    const cache = JSON.parse(readFileSync(join(cacheRoot, `${sessionId}.json`), "utf8"));
                    stats.llmMs += sumFromCache(cache?.record?.rows?.sessionStats, "llmMs");
                    stats.toolMs += sumFromCache(cache?.record?.rows?.sessionStats, "toolMs");
                    stats.decodeTokens += sumFromCache(cache?.record?.rows?.sessionStats, "decodeTokens");
                } catch {
                    // cache row missing: counts stay log-only
                }
            } catch {
                // unreadable log: skip file
            }
        }
    }
    return stats;
}

function formatDuration(ms) {
    const totalMinutes = Math.round(ms / 60_000);
    if (totalMinutes < 60) return `${totalMinutes}m`;
    const hours = totalMinutes / 60;
    if (hours < 100) return `${Math.round(hours * 10) / 10}h`;
    return `${Math.round(hours)}h`;
}

function formatTokens(tokens) {
    if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
    if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}k`;
    return String(tokens);
}

const stats = scanAll();

// Public GitHub repo count for the 🖥 Projects row (best-effort, unauthenticated).
let projects = stats.projects.size;
try {
    const res = await fetch("https://api.github.com/users/ekzomi333");
    if (res.ok) {
        const user = await res.json();
        if (typeof user.public_repos === "number") projects = Math.max(projects, user.public_repos);
    }
} catch {
    // offline: keep local count
}

const today = new Date().toISOString().slice(0, 10);
const block = [
    "## ⚡ Lifetime activity",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| 🖥 Projects | ${projects} |`,
    `| 🚀 Agent sessions | ${stats.sessions} |`,
    `| 🔁 User turns | ${stats.turns} |`,
    `| ⚙️ Agent steps | ${stats.steps} |`,
    `| 🛠 Tool calls | ${stats.toolCalls} |`,
    `| 💻 Shell commands | ${stats.shellCommands} |`,
    `| 📝 Files written | ${stats.filesWritten} |`,
    `| ✏️ Files edited | ${stats.filesEdited} |`,
    `| 📖 Files read | ${stats.filesRead} |`,
    `| 🔎 Searches | ${stats.searches} |`,
    `| 🌐 Web requests | ${stats.webRequests} |`,
    `| 🧠 Model time | ${formatDuration(stats.llmMs)} |`,
    `| 🔧 Tool time | ${formatDuration(stats.toolMs)} |`,
    `| 🪙 Tokens generated | ${formatTokens(stats.decodeTokens)} |`,
    "",
    `*Auto-updated daily by GitHub Actions · last update: ${today}*`
].join("\n");

const readme = readFileSync(readmePath, "utf8");
const start = "<!-- STATS-START -->";
const end = "<!-- STATS-END -->";
const startIdx = readme.indexOf(start);
const endIdx = readme.indexOf(end);
if (startIdx === -1 || endIdx === -1) {
    console.error("STATS markers not found in README.md");
    process.exit(1);
}
const updated = readme.slice(0, startIdx + start.length) + "\n" + block + "\n" + readme.slice(endIdx);
if (updated === readme) {
    console.log("stats unchanged, nothing to commit");
    process.exit(0);
}
writeFileSync(readmePath, updated, "utf8");
console.log("README.md updated:");
console.log(block);
