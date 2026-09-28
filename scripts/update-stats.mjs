// Updates the <!-- STATS-START -->…<!-- STATS-END --> block in README.md
// with lifetime activity counters from the DSH session logs.
// Runs both locally (node scripts/update-stats.mjs) and in GitHub Actions.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readmePath = join(__dirname, "..", "README.md");
const assetsDir = join(__dirname, "..", "assets");

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

// ---- SVG card generation (self-hosted in assets/, no third-party service) ----

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const FONT = `'Segoe UI', Ubuntu, sans-serif`;

/** Convert "1.4M"-style formatted numbers to short display form. */
const n = (v) => v.toLocaleString("en-US");

/** A stat card in the github-readme-stats visual style, dark theme. */
function statCard(title, rows, { width = 494, labelColor = "#c9d1d9", valueColor = "#58a6ff" } = {}) {
    const height = 60 + 33 * rows.length + 10;
    const svgRows = rows.map(([label, value], i) => {
        const y = 62 + i * 33;
        const icon = ICONS[label] ?? "";
        return `
    <g transform="translate(25, ${y})">
        ${icon ? `<text x="0" y="14" font-size="16">${icon}</text>` : ""}
        <text x="${icon ? 28 : 4}" y="15" fill="${labelColor}" font-family="${FONT}" font-size="14">${esc(label)}</text>
        <text x="${width - 25}" y="15" text-anchor="end" fill="${valueColor}" font-family="${FONT}" font-size="14" font-weight="600">${esc(value)}</text>
    </g>`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="4.5" fill="#0d1117" stroke="#30363d"/>
  <text x="25" y="35" fill="#58a6ff" font-family="${FONT}" font-size="18" font-weight="600">${esc(title)}</text>
  <line x1="0" y1="47" x2="${width}" y2="47" stroke="#21262d" stroke-width="1"/>${svgRows}
</svg>`;
}

const ICONS = {
    Projects: "💻",
    "Agent sessions": "🚀",
    "User turns": "🔁",
    "Agent steps": "⚙️",
    "Tool calls": "🛠",
    "Shell commands": "⌨️",
    "Files written": "📝",
    "Files edited": "✏️",
    "Files read": "📖",
    Searches: "🔎",
    "Web requests": "🌐",
    "Model time": "🧠",
    "Tool time": "🔧",
    "Tokens generated": "🪙",
    "Followers": "👥"
};

/** Emoji are rendered as <text> glyphs inside the SVG (GitHub sanitizer keeps <text>). */
function writeAsset(name, svg) {
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, name), svg.trim() + "\n", "utf8");
}

// --- main activity card ---
const activityRows = [
    ["Projects", String(projects)],
    ["Agent sessions", n(stats.sessions)],
    ["User turns", n(stats.turns)],
    ["Agent steps", n(stats.steps)],
    ["Tool calls", n(stats.toolCalls)],
    ["Shell commands", n(stats.shellCommands)],
    ["Files written", n(stats.filesWritten)],
    ["Files edited", n(stats.filesEdited)],
    ["Files read", n(stats.filesRead)],
    ["Searches", n(stats.searches)],
    ["Web requests", n(stats.webRequests)],
    ["Model time", formatDuration(stats.llmMs)],
    ["Tool time", formatDuration(stats.toolMs)],
    ["Tokens generated", formatTokens(stats.decodeTokens)]
];
writeAsset("lifetime-activity.svg", statCard("⚡ Lifetime activity", activityRows));
writeAsset("summary.svg", summaryCard([
    ["sessions", n(stats.sessions)],
    ["agent steps", n(stats.steps)],
    ["tool calls", n(stats.toolCalls)],
    ["tokens", formatTokens(stats.decodeTokens)]
]));

// --- summary card (compact, 3 big numbers) ---
function summaryCard(items) {
    const w = 494;
    const h = 130;
    const cols = items.map(([label, value], i) => {
        const cx = (w / items.length) * i + w / items.length / 2;
        return `
    <text x="${cx}" y="62" text-anchor="middle" fill="#c9d1d9" font-family="${FONT}" font-size="34" font-weight="700">${esc(value)}</text>
    <text x="${cx}" y="90" text-anchor="middle" fill="#8b949e" font-family="${FONT}" font-size="13">${esc(label)}</text>`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="4.5" fill="#0d1117" stroke="#30363d"/>
  <text x="${w / 2}" y="30" text-anchor="middle" fill="#58a6ff" font-family="${FONT}" font-size="15" font-weight="600">All-time agent-powered work</text>${cols}
</svg>`;
}

// --- DSH contribution-style heatmap from session log timestamps ---
function heatmapCard(dayCounts, firstDay, lastDay) {
    const cell = 11, gap = 3, weeks = 26, days = 7;
    const w = 40 + weeks * (cell + gap) + 10;
    const h = 20 + days * (cell + gap) + 24;
    const start = new Date(firstDay);
    // align to Sunday-start week
    const offsetDays = (6 + start.getUTCDay() + 1) % 7;
    const cells = [];
    const maxCount = Math.max(1, ...dayCounts.values());
    const step = (c) => {
        if (c === 0) return "#161b22";
        const t = c / maxCount;
        if (t > 0.75) return "#58a6ff";
        if (t > 0.5) return "#3d8bdd";
        if (t > 0.25) return "#2668a5";
        return "#1a4a75";
    };
    for (let wk = 0; wk < weeks; wk++) {
        for (let d = 0; d < days; d++) {
            const dayIndex = wk * days + d - offsetDays;
            const date = new Date(start);
            date.setUTCDate(start.getUTCDate() + dayIndex);
            const key = date.toISOString().slice(0, 10);
            const c = dayCounts.get(key) ?? 0;
            const x = 40 + wk * (cell + gap);
            const y = 20 + d * (cell + gap);
            const title = `${key}: ${c} session start${c === 1 ? "" : "s"}`;
            cells.push(`  <rect width="${cell}" height="${cell}" x="${x}" y="${y}" rx="2" fill="${step(c)}"><title>${title}</title></rect>`);
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <style>text{font-family:${FONT};}</style>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="4.5" fill="#0d1117" stroke="#30363d"/>
  <text x="25" y="12" fill="#8b949e" font-size="10">Sessions per day, last ${weeks} weeks</text>
  <g transform="translate(15, 0)">
    <text x="0" y="31" fill="#8b949e" font-size="9">Mon</text>
    <text x="0" y="72" fill="#8b949e" font-size="9">Wed</text>
    <text x="0" y="113" fill="#8b949e" font-size="9">Fri</text>
  </g>
${cells.join("\n")}
  <text x="25" y="${h - 8}" fill="#8b949e" font-size="10">Less</text>
  <rect width="10" height="10" x="58" y="${h - 17}" rx="2" fill="#161b22"/>
  <rect width="10" height="10" x="71" y="${h - 17}" rx="2" fill="#1a4a75"/>
  <rect width="10" height="10" x="84" y="${h - 17}" rx="2" fill="#2668a5"/>
  <rect width="10" height="10" x="97" y="${h - 17}" rx="2" fill="#3d8bdd"/>
  <rect width="10" height="10" x="110" y="${h - 17}" rx="2" fill="#58a6ff"/>
  <text x="126" y="${h - 8}" fill="#8b949e" font-size="10">More</text>
</svg>`;
}

// session-per-day counts from the session headers (already scanned via cwd+createdAt)
const dayCounts = new Map();
const sessionRoot = process.env.DSH_HOME ? join(process.env.DSH_HOME, "sessions") : join(homedir(), ".dsh", "sessions");
try {
    for (const proj of readdirSync(sessionRoot, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue;
        for (const sd of readdirSync(join(sessionRoot, proj.name), { withFileTypes: true })) {
            if (!sd.isDirectory()) continue;
            for (const gen of ["session.v3.jsonl.zstd", "session.v2.jsonl.zstd", "session.v1.jsonl.zstd", "session.jsonl.zstd"]) {
                try {
                    const buf = readFileSync(join(sessionRoot, proj.name, sd.name, gen));
                    // first frame = header line only; decode just it
                    const firstFrame = zstdFirstFrame(buf);
                    const header = JSON.parse(firstFrame.toString("utf8"));
                    if ((header.delegationDepth ?? 0) > 0) break;
                    const key = new Date(header.createdAt).toISOString().slice(0, 10);
                    dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
                    break;
                } catch {
                    // try next generation
                }
            }
        }
    }
} catch {
    // no sessions dir: empty heatmap
}

function zstdFirstFrame(buf) {
    const second = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 1);
    return zlib.zstdDecompressSync(second === -1 ? buf : buf.subarray(0, second));
}

const daysSorted = [...dayCounts.keys()].sort();
if (daysSorted.length > 0) {
    const last = daysSorted[daysSorted.length - 1];
    const cutoff = new Date(last);
    cutoff.setUTCDate(cutoff.getUTCDate() - 26 * 7);
    const first = daysSorted[0] > cutoff.toISOString().slice(0, 10) ? daysSorted[0] : cutoff.toISOString().slice(0, 10);
    writeAsset("activity-heatmap.svg", heatmapCard(dayCounts, first, last));
}

const block = [
    "## ⚡ Lifetime activity",
    "",
    `<img src="assets/summary.svg" alt="summary" />`,
    "",
    `<img src="assets/lifetime-activity.svg" alt="lifetime activity" />`,
    "",
    `<img src="assets/activity-heatmap.svg" alt="activity heatmap" />`,
    "",
    `*Auto-updated · last update: ${today}*`
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
writeFileSync(readmePath, updated, "utf8");
console.log("README.md + assets/ updated");
console.log(block);
