'use strict';

// Tiny HTTP bridge: runs `ccusage <cmd> --json` and republishes the output as
// Grafana-friendly JSON so the Infinity datasource can read it. ccusage reads
// the same ~/.claude logs the old cc-exporter did; this just reshapes them.
//
// The per-minute view (`/blocks-series`) parses the raw JSONL logs directly and
// buckets by minute, so history is available for any window (not just since the
// bridge started) and there is no state to persist across restarts.
//
// ccusage applies --since/--until only after parsing every JSONL file, so
// windowed commands run against a pruned copy of the logs (just the files
// modified inside the window) instead of the full history.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3001);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 30) * 1000;

// Pricing mode: live LiteLLM quotes by default (the bundled --offline snapshot
// can't price brand-new models like claude-sonnet-5 yet -> $0), with automatic
// fallback to --offline if the live fetch fails. Set CCUSAGE_OFFLINE=1 to force
// the bundled snapshot; CCUSAGE_NO_FALLBACK=1 to disable the safety net.
const FORCE_OFFLINE = process.env.CCUSAGE_OFFLINE === '1';
const NO_FALLBACK = process.env.CCUSAGE_NO_FALLBACK === '1';
const BIN_PARTS = (process.env.CCUSAGE_BIN || 'ccusage').split(' ').filter(Boolean);
const BIN = BIN_PARTS[0];
const BIN_PREFIX = BIN_PARTS.slice(1);

const CONFIG_DIRS = (process.env.CLAUDE_CONFIG_DIR || '')
  .split(',')
  .map((dir) => dir.trim())
  .filter(Boolean);
const MAX_SERIES_POINTS = Number(process.env.MAX_SERIES_POINTS || 2000);
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000;

const cache = new Map();

function sanitizeDate(value) {
  if (!value) {
    return null;
  }

  const match = String(value).match(/^\d{4}-?\d{2}-?\d{2}/);

  return match ? match[0] : null;
}

function buildArgs(sub, { since, until, breakdown, active } = {}, offline) {
  const args = [...BIN_PREFIX, sub, '--json'];

  if (offline) {
    args.push('--offline');
  }

  if (active) {
    args.push('--active');
  }

  if (breakdown) {
    args.push('--breakdown');
  }

  const from = sanitizeDate(since);
  const to = sanitizeDate(until);

  if (from) {
    args.push('--since', from);
  }

  if (to) {
    args.push('--until', to);
  }

  return args;
}

function execCcusage(args, env) {
  return new Promise((resolve, reject) => {
    execFile(BIN, args, { env, maxBuffer: 128 * 1024 * 1024, timeout: 60000 }, (err, stdout) => {
      if (err) {
        return reject(err);
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

async function runCcusageUncached(sub, opts) {
  const cutoffMs = pruneCutoffMs(sub, opts);
  const prunedDir = cutoffMs ? buildPrunedConfigDir(cutoffMs) : null;
  const env = prunedDir ? { ...process.env, CLAUDE_CONFIG_DIR: prunedDir } : undefined;

  try {
    if (FORCE_OFFLINE) {
      return await execCcusage(buildArgs(sub, opts, true), env);
    }

    try {
      return await execCcusage(buildArgs(sub, opts, false), env);
    } catch (err) {
      if (NO_FALLBACK) {
        throw err;
      }

      console.error(`live pricing failed for "${sub}", falling back to --offline:`, err.message);

      return await execCcusage(buildArgs(sub, opts, true), env);
    }
  } finally {
    if (prunedDir) {
      fs.rmSync(prunedDir, { recursive: true, force: true });
    }
  }
}

const inflight = new Map();

async function runCcusage(sub, opts = {}) {
  const key = JSON.stringify([sub, opts.since, opts.until, Boolean(opts.breakdown), Boolean(opts.active)]);
  const hit = cache.get(key);

  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.data;
  }

  // A dashboard refresh fires many panels at once; on a cache miss they share
  // one ccusage run instead of spawning a process each.
  let pending = inflight.get(key);

  if (!pending) {
    pending = runCcusageUncached(sub, opts)
      .then((data) => {
        cache.set(key, { at: Date.now(), data });

        return data;
      })
      .finally(() => inflight.delete(key));

    inflight.set(key, pending);
  }

  return pending;
}

function daily(query) {
  return runCcusage('daily', query);
}

function summary(report) {
  return report.totals || {};
}

function types(report) {
  const totals = report.totals || {};

  return [
    { type: 'input', tokens: totals.inputTokens || 0 },
    { type: 'output', tokens: totals.outputTokens || 0 },
    { type: 'cacheCreation', tokens: totals.cacheCreationTokens || 0 },
    { type: 'cacheRead', tokens: totals.cacheReadTokens || 0 },
  ];
}

function models(report) {
  const byModel = new Map();

  for (const day of report.daily || []) {
    for (const mb of day.modelBreakdowns || []) {
      const name = mb.modelName || 'unknown';
      const row = byModel.get(name) || {
        model: name,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        cost: 0,
      };

      row.inputTokens += mb.inputTokens || 0;
      row.outputTokens += mb.outputTokens || 0;
      row.cacheCreationTokens += mb.cacheCreationTokens || 0;
      row.cacheReadTokens += mb.cacheReadTokens || 0;
      row.cost += mb.cost || 0;
      row.totalTokens
        += (mb.inputTokens || 0)
        + (mb.outputTokens || 0)
        + (mb.cacheCreationTokens || 0)
        + (mb.cacheReadTokens || 0);

      byModel.set(name, row);
    }
  }

  return [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function timeseries(report) {
  return (report.daily || []).map((day) => ({
    time: day.period,
    input: day.inputTokens || 0,
    output: day.outputTokens || 0,
    cacheRead: day.cacheReadTokens || 0,
    cacheCreation: day.cacheCreationTokens || 0,
    totalTokens: day.totalTokens || 0,
    cost: day.totalCost || 0,
  }));
}

// Collapse a daily report down to a single model by pulling that model's
// per-day breakdown. `all` (or empty) leaves the report untouched.
function filterReportByModel(report, model) {
  if (!model || model === 'all' || model === 'All' || model === '$__all') {
    return report;
  }

  const days = (report.daily || []).map((day) => {
    const mb = (day.modelBreakdowns || []).find((m) => m.modelName === model);
    const input = (mb && mb.inputTokens) || 0;
    const output = (mb && mb.outputTokens) || 0;
    const cacheCreation = (mb && mb.cacheCreationTokens) || 0;
    const cacheRead = (mb && mb.cacheReadTokens) || 0;

    return {
      period: day.period,
      inputTokens: input,
      outputTokens: output,
      cacheCreationTokens: cacheCreation,
      cacheReadTokens: cacheRead,
      totalTokens: input + output + cacheCreation + cacheRead,
      totalCost: (mb && mb.cost) || 0,
      modelBreakdowns: mb ? [mb] : [],
    };
  });

  const totals = days.reduce((acc, d) => ({
    inputTokens: acc.inputTokens + d.inputTokens,
    outputTokens: acc.outputTokens + d.outputTokens,
    cacheCreationTokens: acc.cacheCreationTokens + d.cacheCreationTokens,
    cacheReadTokens: acc.cacheReadTokens + d.cacheReadTokens,
    totalTokens: acc.totalTokens + d.totalTokens,
    totalCost: acc.totalCost + d.totalCost,
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  });

  return { daily: days, totals };
}

async function filteredDaily(query) {
  const report = await daily(query);

  return filterReportByModel(report, query.model);
}

async function burnRate() {
  const report = await runCcusage('blocks', { active: true });
  const block = (report.blocks || [])[0];
  const rate = (block && block.isActive && block.burnRate) || {};

  return {
    tokensPerMinute: rate.tokensPerMinute || 0,
    tokensPerMinuteForIndicator: rate.tokensPerMinuteForIndicator || 0,
    costPerHour: rate.costPerHour || 0,
    active: Boolean(block && block.isActive),
  };
}

// Resolve the `projects/` directories that hold the JSONL logs.
function projectRoots() {
  const roots = [];
  const seen = new Set();
  const add = (dir) => {
    const root = path.basename(dir) === 'projects' ? dir : path.join(dir, 'projects');

    if (!seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  };

  if (CONFIG_DIRS.length) {
    CONFIG_DIRS.forEach(add);
  } else if (process.env.HOME) {
    add(path.join(process.env.HOME, '.claude'));
    add(path.join(process.env.HOME, '.config', 'claude'));
  }

  return roots.filter((root) => {
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

// Collect *.jsonl files touched at/after `sinceMs` (a file not written since the
// window opened can't hold entries inside it, so we can skip it entirely).
function collectJsonlFiles(dir, sinceMs, out) {
  let entries;

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      collectJsonlFiles(full, sinceMs, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        if (fs.statSync(full).mtimeMs >= sinceMs) {
          out.push(full);
        }
      } catch {
        // ignore unreadable files
      }
    }
  }
}

const PRUNE_TZ_MARGIN_MS = 24 * 60 * 60 * 1000;
const ACTIVE_BLOCK_PRUNE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_PRUNE_BYTES = 200 * 1024 * 1024;

// Earliest mtime a JSONL file can have and still hold entries the command
// cares about. Daily-style reports get a day of margin so timezone differences
// between Grafana, this container, and ccusage can't clip the window edge. An
// active billing block spans at most the last 5h; three days is safely beyond
// anything that can influence it. Null means "needs full history, don't prune".
function pruneCutoffMs(sub, opts) {
  if (sub === 'blocks') {
    return opts.active ? Date.now() - ACTIVE_BLOCK_PRUNE_MS : null;
  }

  const from = sanitizeDate(opts.since);

  if (!from) {
    return null;
  }

  const digits = from.replace(/-/g, '');
  const parsed = Date.parse(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T00:00:00Z`);

  return Number.isFinite(parsed) ? parsed - PRUNE_TZ_MARGIN_MS : null;
}

// Copy the JSONL files touched at/after `cutoffMs` into a throwaway config dir
// so ccusage parses days of logs instead of the full history. Symlinks would be
// cheaper, but ccusage's globber ignores them, so real copies it is. Returns
// null (= run against the real logs) when the matched set is so large that
// copying would cost more than the parse time it saves.
function buildPrunedConfigDir(cutoffMs) {
  const matched = [];
  let bytes = 0;

  for (const [index, root] of projectRoots().entries()) {
    const files = [];

    collectJsonlFiles(root, cutoffMs, files);

    for (const file of files) {
      try {
        bytes += fs.statSync(file).size;
      } catch {
        continue;
      }

      if (bytes > MAX_PRUNE_BYTES) {
        return null;
      }

      matched.push({ index, root, file });
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccusage-prune-'));

  for (const { index, root, file } of matched) {
    const dest = path.join(dir, 'projects', String(index), path.relative(root, file));

    fs.mkdirSync(path.dirname(dest), { recursive: true });

    try {
      fs.copyFileSync(file, dest);
    } catch {
      // a session file may vanish mid-copy; ccusage just sees fewer logs
    }
  }

  return dir;
}

// Per-minute token series built straight from the raw logs, deduped by
// messageId:requestId the way ccusage does.
function blocksSeriesFromLogs(fromMs, toMs) {
  const files = [];

  for (const root of projectRoots()) {
    collectJsonlFiles(root, fromMs - 5 * 60 * 1000, files);
  }

  let bucketMs = 60 * 1000;
  const span = Math.max(0, toMs - fromMs);

  if (span / bucketMs > MAX_SERIES_POINTS) {
    bucketMs = Math.ceil(span / MAX_SERIES_POINTS / 60000) * 60000;
  }

  const buckets = new Map();
  const seen = new Set();

  for (const file of files) {
    let text;

    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const line of text.split('\n')) {
      if (line.indexOf('"assistant"') === -1) {
        continue;
      }

      let event;

      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      const usage = event.type === 'assistant' && event.message && event.message.usage;

      if (!usage || !event.timestamp) {
        continue;
      }

      const at = Date.parse(event.timestamp);

      if (!Number.isFinite(at) || at < fromMs || at > toMs) {
        continue;
      }

      const msgId = event.message && event.message.id;

      if (msgId && event.requestId) {
        const key = `${msgId}:${event.requestId}`;

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
      }

      const bucket = Math.floor(at / bucketMs) * bucketMs;
      const acc = buckets.get(bucket) || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

      acc.input += usage.input_tokens || 0;
      acc.output += usage.output_tokens || 0;
      acc.cacheRead += usage.cache_read_input_tokens || 0;
      acc.cacheCreation += usage.cache_creation_input_tokens || 0;
      buckets.set(bucket, acc);
    }
  }

  const out = [];
  const start = Math.floor(fromMs / bucketMs) * bucketMs;

  for (let bucket = start; bucket <= toMs; bucket += bucketMs) {
    const acc = buckets.get(bucket) || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

    out.push({
      time: new Date(bucket).toISOString(),
      input: acc.input,
      output: acc.output,
      cacheRead: acc.cacheRead,
      cacheCreation: acc.cacheCreation,
      totalTokens: acc.input + acc.output + acc.cacheRead + acc.cacheCreation,
    });
  }

  return out;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const query = {
      since: url.searchParams.get('since'),
      until: url.searchParams.get('until'),
      breakdown: url.searchParams.get('breakdown') === '1',
      model: url.searchParams.get('model'),
    };
    const path = url.pathname.replace(/\/+$/, '') || '/';

    let body;

    switch (path) {
      case '/':
      case '/health':
        body = { status: 'ok', pricing: FORCE_OFFLINE ? 'offline' : 'live', roots: projectRoots().length };
        break;
      case '/summary':
        body = summary(await filteredDaily(query));
        break;
      case '/types':
        body = types(await filteredDaily(query));
        break;
      case '/models':
        body = models(await filteredDaily(query));
        break;
      case '/model-names':
        body = models(await daily({})).map((m) => m.model);
        break;
      case '/timeseries':
        body = timeseries(await filteredDaily(query));
        break;
      case '/blocks-series': {
        const now = Date.now();
        const toMs = Number(url.searchParams.get('to')) || now;
        const fromMs = Number(url.searchParams.get('from')) || toMs - DEFAULT_WINDOW_MS;
        body = blocksSeriesFromLogs(fromMs, toMs);
        break;
      }
      case '/burnrate':
        body = await burnRate();
        break;
      case '/daily':
        body = await runCcusage('daily', query);
        break;
      case '/monthly':
        body = await runCcusage('monthly', query);
        break;
      case '/session':
        body = await runCcusage('session', query);
        break;
      case '/blocks':
        body = await runCcusage('blocks', { active: url.searchParams.get('active') === '1' });
        break;
      default:
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
    }

    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String((err && err.message) || err) }));
  }
});

server.listen(PORT, () => {
  console.log(
    `ccusage-http listening on :${PORT} (pricing=${FORCE_OFFLINE ? 'offline' : 'live'}, cacheTtl=${CACHE_TTL_MS}ms)`,
  );
});
