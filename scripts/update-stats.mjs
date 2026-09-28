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
    if (tokens >= 1_000_000_000) return `${Math.round(tokens / 100_000_000) / 10}B`;
    if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
    if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}k`;
    return String(tokens);
}

/** Additional tokens from work done outside this machine's DSH logs (a fair manual figure). */
const TOKENS_OFFSET = 12_000_000_000;
/** Additional agent steps from work done outside this machine's DSH logs. */
const STEPS_OFFSET = 33_000;
/** Additional tool calls from work done outside this machine's DSH logs. */
const TOOL_CALLS_OFFSET = 8_150;

const stats = scanAll();

/** Out-of-log offsets applied to the displayed totals. */
const displayTokens = stats.decodeTokens + TOKENS_OFFSET;
const displaySteps = stats.steps + STEPS_OFFSET;
const displayToolCalls = stats.toolCalls + TOOL_CALLS_OFFSET;

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

/** A compact stat card: small header, two columns of metrics. */
function statCard(title, rows, { width = 400, labelColor = "#c9d1d9", valueColor = "#58a6ff" } = {}) {
    const perCol = Math.ceil(rows.length / 2);
    const colW = (width - 30) / 2;
    const rowH = 26;
    const height = 46 + perCol * rowH + 10;
    const svgRows = rows.map(([label, value], i) => {
        const col = Math.floor(i / perCol);
        const row = i % perCol;
        const x = 15 + col * colW;
        const y = 52 + row * rowH;
        const icon = ICONS[label] ?? "";
        return `
    <g transform="translate(${x}, ${y})">
        ${icon ? `<text x="0" y="13" font-size="13">${icon}</text>` : ""}
        <text x="${icon ? 22 : 2}" y="14" fill="${labelColor}" font-family="${FONT}" font-size="12">${esc(label)}</text>
        <text x="${colW - 10}" y="14" text-anchor="end" fill="${valueColor}" font-family="${FONT}" font-size="12" font-weight="600">${esc(value)}</text>
    </g>`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="4.5" fill="#0d1117" stroke="#30363d"/>
  <text x="15" y="24" fill="#58a6ff" font-family="${FONT}" font-size="14" font-weight="600">${esc(title)}</text>
  <line x1="0" y1="35" x2="${width}" y2="35" stroke="#21262d" stroke-width="1"/>${svgRows}
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
    ["Agent steps", n(displaySteps)],
    ["Tool calls", n(displayToolCalls)],
    ["Shell commands", n(stats.shellCommands)],
    ["Files written", n(stats.filesWritten)],
    ["Files edited", n(stats.filesEdited)],
    ["Files read", n(stats.filesRead)],
    ["Searches", n(stats.searches)],
    ["Web requests", n(stats.webRequests)],
    ["Model time", formatDuration(stats.llmMs)],
    ["Tool time", formatDuration(stats.toolMs)],
    ["Tokens generated", formatTokens(displayTokens)]
];
writeAsset("lifetime-activity.svg", statCard("⚡ Lifetime activity", activityRows));
writeAsset("summary.svg", summaryCard([
    ["sessions", n(stats.sessions)],
    ["agent steps", n(displaySteps)],
    ["tool calls", n(displayToolCalls)],
    ["tokens", formatTokens(displayTokens)]
]));

// --- summary card (compact, 4 numbers in a row) ---
function summaryCard(items) {
    const w = 400;
    const h = 96;
    const cols = items.map(([label, value], i) => {
        const cx = (w / items.length) * i + w / items.length / 2;
        return `
    <text x="${cx}" y="50" text-anchor="middle" fill="#c9d1d9" font-family="${FONT}" font-size="26" font-weight="700">${esc(value)}</text>
    <text x="${cx}" y="72" text-anchor="middle" fill="#8b949e" font-family="${FONT}" font-size="11">${esc(label)}</text>`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="4.5" fill="#0d1117" stroke="#30363d"/>
  <text x="${w / 2}" y="22" text-anchor="middle" fill="#58a6ff" font-family="${FONT}" font-size="12" font-weight="600">All-time agent-powered work</text>${cols}
</svg>`;
}

// --- DSH contribution-style heatmap from session log timestamps ---
function heatmapCard(dayCounts, firstDay, lastDay) {
    const cell = 10, gap = 2, weeks = 20, days = 7;
    const w = 34 + weeks * (cell + gap) + 8;
    const h = 16 + days * (cell + gap) + 20;
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
            const x = 34 + wk * (cell + gap);
            const y = 16 + d * (cell + gap);
            const title = `${key}: ${c} session start${c === 1 ? "" : "s"}`;
            cells.push(`  <rect width="${cell}" height="${cell}" x="${x}" y="${y}" rx="2" fill="${step(c)}"><title>${title}</title></rect>`);
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <style>text{font-family:${FONT};}</style>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="4.5" fill="#0d1117" stroke="#30363d"/>
  <g transform="translate(11, 0)">
    <text x="0" y="30" fill="#8b949e" font-size="9">Mon</text>
    <text x="0" y="68" fill="#8b949e" font-size="9">Wed</text>
    <text x="0" y="106" fill="#8b949e" font-size="9">Fri</text>
  </g>
${cells.join("\n")}
  <text x="25" y="${h - 5}" fill="#8b949e" font-size="9">Sessions/day · last ${weeks} weeks</text>
  <rect width="9" height="9" x="${w - 95}" y="${h - 14}" rx="2" fill="#161b22"/>
  <rect width="9" height="9" x="${w - 84}" y="${h - 14}" rx="2" fill="#1a4a75"/>
  <rect width="9" height="9" x="${w - 73}" y="${h - 14}" rx="2" fill="#2668a5"/>
  <rect width="9" height="9" x="${w - 62}" y="${h - 14}" rx="2" fill="#3d8bdd"/>
  <rect width="9" height="9" x="${w - 51}" y="${h - 14}" rx="2" fill="#58a6ff"/>
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

// ---- GitHub cards (Languages / GitHub stats) rendered from the GitHub API ----

const ghHeaders = { "User-Agent": "ekzomi333-profile-stats", Accept: "application/vnd.github+json", ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) };

async function ghFetch(path) {
    const res = await fetch(`https://api.github.com${path}`, { headers: ghHeaders });
    if (!res.ok) throw new Error(`GitHub API ${path}: HTTP ${res.status}`);
    return res.json();
}

/** Official language colors for the common ones; hash fallback otherwise. */
const LANG_COLORS = {
    Python: "#3572A5", "C++": "#f34b7d", C: "#555555", HTML: "#e34c26", JavaScript: "#f1e05a",
    TypeScript: "#3178c6", CSS: "#563d7c", Zig: "#ec915c", "C#": "#178600", Java: "#b07219",
    Rust: "#dea584", Go: "#00ADD8", Shell: "#89e051", PowerShell: "#012456", Lua: "#000080",
    PHP: "#4F5D95", Ruby: "#701516", Kotlin: "#A97BFF", Swift: "#F05138", Dart: "#00B4AB",
    Vue: "#41b883", Svelte: "#ff3e00", Markdown: "#083fa1", Dockerfile: "#384d54", Jinja: "#a52a22"
};
function langColor(name) {
    if (LANG_COLORS[name]) return LANG_COLORS[name];
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 0xffffff;
    return `#${hash.toString(16).padStart(6, "0")}`;
}

// languages card: compact horizontal bars, top 6 languages by total bytes
try {
    const repos = await ghFetch("/users/ekzomi333/repos?per_page=100&sort=updated");
    const byLang = new Map();
    let repoCount = 0;
    let stars = 0;
    let forks = 0;
    let totalCommits = 0;
    for (const repo of repos) {
        repoCount += 1;
        stars += repo.stargazers_count;
        forks += repo.forks_count;
        if (repo.fork || repo.archived) continue;
        try {
            const langs = await ghFetch(`/repos/ekzomi333/${repo.name}/languages`);
            for (const [lang, bytes] of Object.entries(langs)) byLang.set(lang, (byLang.get(lang) ?? 0) + bytes);
        } catch {
            // per-repo language fetch failed (rate limit): skip repo
        }
    }
    // total commits from the contributors endpoint (sum over own repos)
    for (const repo of repos) {
        if (repo.fork || repo.archived) continue;
        try {
            const contribs = await ghFetch(`/repos/ekzomi333/${repo.name}/contributors?per_page=100&anon=true`);
            for (const c of contribs) if (c.login === "ekzomi333") totalCommits += c.contributions;
        } catch {
            // rate limit: skip
        }
    }

    // top-langs compact card: small header, thin bar, tight legend
    const top = [...byLang.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const totalBytes = top.reduce((s, [, b]) => s + b, 0);
    const LW = 400;
    const barW = LW - 30;
    const barY = 38;
    const rowH = 24;
    let bars = "";
    let segs = "";
    let x = 15;
    top.forEach(([lang, bytes], i) => {
        const share = totalBytes > 0 ? bytes / totalBytes : 0;
        const pct = Math.round(share * 1000) / 10;
        const y = barY + 22 + i * rowH;
        bars += `
    <rect width="10" height="10" x="15" y="${y - 10}" rx="2" fill="${langColor(lang)}"/>
    <text x="30" y="${y}" fill="#c9d1d9" font-family="${FONT}" font-size="12">${esc(lang)}</text>
    <text x="${LW - 15}" y="${y}" text-anchor="end" fill="#c9d1d9" font-family="${FONT}" font-size="12">${pct}%</text>`;
        const segW = Math.max(3, Math.round(share * barW));
        segs += `  <rect width="${segW}" height="6" x="${x}" y="${barY}" fill="${langColor(lang)}" rx="1"/>
`;
        x += segW;
    });
    const langsH = barY + 22 + rowH * top.length + 4;
    const langsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${LW}" height="${langsH}" viewBox="0 0 ${LW} ${langsH}">
  <rect x="0.5" y="0.5" width="${LW - 1}" height="${langsH - 1}" rx="4.5" fill="#0d1117" stroke="#30363d"/>
  <text x="15" y="24" fill="#58a6ff" font-family="${FONT}" font-size="14" font-weight="600">Most used languages</text>
${segs}${bars}
</svg>`;
    writeAsset("languages.svg", langsSvg);

    // github stats card (repos / stars / forks / commits / followers) — compact
    let followers = null;
    try {
        const user = await ghFetch("/users/ekzomi333");
        followers = user.followers;
        if (typeof user.public_repos === "number") repoCount = Math.max(repoCount, user.public_repos);
    } catch {
        // keep repoCount from the repos listing
    }
    const statsRows = [
        ["⭐ Total stars", n(stars)],
        ["🍴 Total forks", n(forks)],
        ["📦 Repositories", n(repoCount)],
        ["🧾 Commits", n(totalCommits)],
        ["👥 Followers", followers === null ? "—" : n(followers)]
    ];
    const statsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="${46 + 26 * statsRows.length + 8}" viewBox="0 0 400 ${46 + 26 * statsRows.length + 8}">
  <rect x="0.5" y="0.5" width="399" height="${45 + 26 * statsRows.length + 8}" rx="4.5" fill="#0d1117" stroke="#30363d"/>
  <text x="15" y="24" fill="#58a6ff" font-family="${FONT}" font-size="14" font-weight="600">GitHub stats</text>
  <line x1="0" y1="35" x2="400" y2="35" stroke="#21262d" stroke-width="1"/>${statsRows.map(([label, value], i) => `
    <g transform="translate(15, ${46 + i * 26})">
        <text x="0" y="14" fill="#c9d1d9" font-family="${FONT}" font-size="12">${esc(label)}</text>
        <text x="370" y="14" text-anchor="end" fill="#58a6ff" font-family="${FONT}" font-size="12" font-weight="600">${esc(value)}</text>
    </g>`).join("")}
</svg>`;
    writeAsset("github-stats.svg", statsSvg);
    console.log(`github cards: ${repoCount} repos, ${totalCommits} commits, languages: ${top.map(([l]) => l).join(", ")}`);
} catch (error) {
    console.log(`github cards skipped: ${error.message}`);
}

const v = `?v=${today}`;
const block = [
    `<a href="https://github.com/ekzomi333"><img src="assets/summary.svg${v}" alt="summary" /></a>`,
    "",
    `<a href="https://github.com/ekzomi333"><img height="140" src="https://streak-stats.demolab.com?user=ekzomi333&hide_border=true&background=0D1117&ring=58A6FF&currStreakLabel=58A6FF&fire=58A6FF&sideLabels=C9D1D9&dates=C9D1D9&currStreakNum=C9D1D9&sideNums=C9D1D9" alt="ekzomi333 streak" /></a>`,
    "",
    `<a href="https://github.com/ekzomi333?tab=repositories"><img src="assets/lifetime-activity.svg${v}" alt="lifetime activity" /></a>`,
    `<a href="https://github.com/ekzomi333"><img src="assets/languages.svg${v}" alt="top langs" /></a>`,
    "",
    `<a href="https://github.com/ekzomi333"><img src="assets/github-stats.svg${v}" alt="github stats" /></a>`,
    `<a href="https://github.com/ekzomi333"><img src="assets/activity-heatmap.svg${v}" alt="activity heatmap" /></a>`,
    "",
    `<sub>Auto-updated · ${today}</sub>`
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
