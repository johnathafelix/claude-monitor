'use strict';

// Incremental ingestion: every SCAN_INTERVAL_SECONDS, stat all source files,
// read only bytes appended since the last cycle, and upsert into Mongo.
// Transcripts are append-only, so a per-file byte offset (committed only after
// the batch writes succeed) plus deterministic _ids gives effective
// exactly-once ingestion — a crash anywhere just re-upserts the same docs.
//
// Raw archive: EVERY line of every transcript lands in raw_entries, whatever
// its type, so future dashboards never need the (retention-pruned) files.
// Metrics: assistant lines with usage are deduped into usage_events by
// message.id:requestId — Claude Code re-appends the same message up to 12x
// while streaming, with GROWING usage, and naive sums over-count 2-6x. The
// LAST occurrence (by timestamp, then file/offset) carries the final usage,
// so a seq-guarded replace keeps exactly that one whatever order lines are
// (re)processed in — verified to match ccusage's totals field-for-field.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const config = require('./config');
const { coll } = require('./db');
const pricing = require('./pricing');
const backfill = require('./backfill');

const BATCH_SIZE = 500;

// A file whose last line lacks a trailing newline is normally mid-append and
// re-read next cycle; if it hasn't been touched this long, treat the tail as a
// complete line so closed files can't strand data forever.
const STALE_TAIL_MS = 5 * 60 * 1000;

const stats = {
  scans: 0,
  lastScanAt: null,
  lastScanMs: 0,
  filesTracked: 0,
  filesDeleted: 0,
  rawUpserts: 0,
  eventUpserts: 0,
  parseErrors: 0,
  lastError: null,
};

let running = false;

async function readSlice(abs, start, end) {
  const fh = await fsp.open(abs, 'r');

  try {
    const len = end - start;
    const buf = Buffer.allocUnsafe(len);
    let read = 0;

    while (read < len) {
      const { bytesRead } = await fh.read(buf, read, len - read, start + read);

      if (!bytesRead) {
        break;
      }

      read += bytesRead;
    }

    return buf.subarray(0, read);
  } finally {
    await fh.close();
  }
}

// Complete lines in `buf` (which starts at byte `base` of the file), plus the
// byte offset consumed. Splitting on 0x0A is UTF-8 safe and `base` is always a
// line boundary, so decoding per-line never cuts a multibyte character.
function* lines(buf, base, mtimeMs) {
  let start = 0;

  for (;;) {
    const nl = buf.indexOf(0x0a, start);

    if (nl === -1) {
      break;
    }

    if (nl > start) {
      yield { text: buf.toString('utf8', start, nl), offset: base + start, bytes: nl - start };
    }

    start = nl + 1;
  }

  if (start < buf.length && Date.now() - mtimeMs > STALE_TAIL_MS) {
    yield { text: buf.toString('utf8', start), offset: base + start, bytes: buf.length - start };
    start = buf.length;
  }

  return base + start;
}

function consumeLines(buf, base, mtimeMs, onLine) {
  const iter = lines(buf, base, mtimeMs);

  for (;;) {
    const { value, done } = iter.next();

    if (done) {
      return value;
    }

    onLine(value);
  }
}

async function setState(rel, fields) {
  await coll('files').updateOne({ _id: rel }, { $set: { ...fields, lastIngestAt: new Date() } }, { upsert: true });
}

function walkProjects() {
  const root = path.join(config.claudeDir, 'projects');
  const transcripts = [];
  const metas = [];

  const visit = (dir) => {
    let entries;

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        visit(abs);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      let stat;

      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }

      const rel = path.relative(config.claudeDir, abs);
      const file = { abs, rel, size: stat.size, mtimeMs: stat.mtimeMs };

      if (entry.name.endsWith('.jsonl')) {
        transcripts.push(file);
      } else if (entry.name.endsWith('.meta.json') && path.basename(dir) === 'subagents') {
        metas.push(file);
      }
    }
  };

  visit(root);

  return { transcripts, metas };
}

// projects/<project>/<sessionId>.jsonl
// projects/<project>/<sessionId>/subagents/agent-<hash>.jsonl
function transcriptPathInfo(rel) {
  const parts = rel.split(path.sep);
  const project = parts[1] || null;

  if (parts.length === 3) {
    return { project, sessionId: parts[2].replace(/\.jsonl$/, ''), agentHash: null };
  }

  if (parts.length === 5 && parts[3] === 'subagents') {
    const match = parts[4].match(/^agent-([0-9a-v]+)\.jsonl$/);

    return { project, sessionId: parts[2], agentHash: match ? match[1] : parts[4].replace(/\.jsonl$/, '') };
  }

  return { project, sessionId: null, agentHash: null };
}

function truncateOversized(entry, lineBytes) {
  if (entry.toolUseResult) {
    entry.toolUseResult = { _truncated: true, bytes: lineBytes };
  }

  if (entry.message && entry.message.content) {
    entry.message.content = { _truncated: true, bytes: lineBytes };
  }
}

function buildRawDoc(rel, info, line, lineNo) {
  const base = {
    _id: `${rel}#${line.offset}`,
    file: rel,
    project: info.project,
    subagent: info.agentHash ? { hash: info.agentHash } : null,
    offset: line.offset,
    line: lineNo,
    oversized: false,
    rawStr: null,
  };

  let entry;

  try {
    entry = JSON.parse(line.text);
  } catch {
    stats.parseErrors += 1;

    return {
      ...base,
      sessionId: info.sessionId,
      type: '__parse_error__',
      uuid: null,
      ts: null,
      raw: null,
      rawStr: line.text.slice(0, 1024 * 1024),
      entry: null,
    };
  }

  if (line.bytes > config.maxLineBytes) {
    truncateOversized(entry, line.bytes);
    base.oversized = true;
    base.sha256 = crypto.createHash('sha256').update(line.text).digest('hex');
  }

  const ts = entry.timestamp ? new Date(entry.timestamp) : null;

  return {
    ...base,
    sessionId: entry.sessionId || info.sessionId,
    type: entry.type || null,
    uuid: entry.uuid || null,
    ts: ts && !Number.isNaN(ts.getTime()) ? ts : null,
    raw: entry,
    entry,
  };
}

function buildEventOp(entry, info, rel, offset, agentMetaByHash, unknownModels) {
  const usage = entry.type === 'assistant' && entry.message && entry.message.usage;

  if (!usage || !entry.timestamp) {
    return null;
  }

  const tsMs = Date.parse(entry.timestamp);

  if (!Number.isFinite(tsMs)) {
    return null;
  }

  const msgId = entry.message.id || null;
  // Entries without a message id can't be deduped (ccusage counts each too);
  // key them by file position instead.
  const id = msgId ? `${msgId}:${entry.requestId || 'noreq'}` : `line:${rel}#${offset}`;
  const model = entry.message.model || 'unknown';

  const cacheCreation = usage.cache_creation;
  const hasSplit = Boolean(cacheCreation && typeof cacheCreation === 'object');
  const cc1h = hasSplit ? cacheCreation.ephemeral_1h_input_tokens || 0 : 0;
  const cc5m = hasSplit ? cacheCreation.ephemeral_5m_input_tokens || 0 : 0;
  const serverTools = usage.server_tool_use || {};

  const usageDoc = {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    // The flat cache_creation_input_tokens occasionally disagrees with the
    // ephemeral TTL split; the split is what gets priced per-TTL (and what
    // ccusage sums), so it wins whenever present.
    cacheCreation: hasSplit ? cc1h + cc5m : usage.cache_creation_input_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheCreation1h: cc1h,
    cacheCreation5m: cc5m,
    webSearch: serverTools.web_search_requests || 0,
    webFetch: serverTools.web_fetch_requests || 0,
    serviceTier: usage.service_tier || null,
    speed: usage.speed || null,
  };

  const cost = pricing.priceEvent(model, usageDoc, tsMs);

  if (!cost.priced) {
    unknownModels.add(model);
  }

  const meta = info.agentHash ? agentMetaByHash.get(info.agentHash) : null;
  const agent = {
    isSubagent: Boolean(info.agentHash || entry.isSidechain),
    agentType: (meta && meta.agentType) || null,
    spawnDepth: meta && meta.spawnDepth != null ? meta.spawnDepth : null,
    agentHash: info.agentHash || entry.agentId || null,
  };

  // Lexicographically comparable "which line is newer" key: ISO timestamp,
  // then file, then zero-padded byte offset.
  const seq = `${new Date(tsMs).toISOString()}|${rel}|${String(offset).padStart(12, '0')}`;

  const doc = {
    _id: id,
    seq,
    ts: new Date(tsMs),
    msgId,
    requestId: entry.requestId || null,
    model,
    usage: usageDoc,
    cost,
    sessionId: entry.sessionId || info.sessionId,
    cwd: entry.cwd || null,
    gitBranch: entry.gitBranch || null,
    version: entry.version || null,
    entrypoint: entry.entrypoint || null,
    isSidechain: Boolean(entry.isSidechain),
    slug: entry.slug || null,
    stopReason: entry.message.stop_reason || null,
    agent,
    sourceFile: rel,
  };

  // Later duplicates replace earlier ones (never the other way around), so
  // re-ingesting in any order converges on the final-usage line.
  return {
    updateOne: {
      filter: { _id: id },
      update: [
        {
          $replaceWith: {
            $cond: [{ $lt: [{ $ifNull: ['$seq', ''] }, seq] }, { $literal: doc }, '$$ROOT'],
          },
        },
      ],
      upsert: true,
    },
  };
}

async function flush(name, ops, counter) {
  if (!ops.length) {
    return;
  }

  const result = await coll(name).bulkWrite(ops, { ordered: false });

  stats[counter] += result.upsertedCount;
  ops.length = 0;
}

async function ingestTranscript(file, state, agentMetaByHash, unknownModels) {
  let offset = state ? state.offset : 0;
  let lineNo = state ? state.line : 0;

  if (state && file.size < state.offset) {
    // Shrunk file = rewritten (should never happen for transcripts). Drop its
    // raw lines so stale tail docs can't linger, then re-ingest from zero.
    // usage_events stay: the seq-guarded replace is idempotent on re-seen
    // lines, and events unique to the old content survive — that's the
    // archive contract.
    console.warn(`${file.rel} shrank (${state.offset} -> ${file.size}), re-ingesting`);
    await coll('raw').deleteMany({ file: file.rel });
    offset = 0;
    lineNo = 0;
  }

  if (file.size <= offset) {
    if (state && (state.deletedAt || state.size !== file.size || state.mtimeMs !== file.mtimeMs)) {
      await setState(file.rel, { kind: 'transcript', size: file.size, mtimeMs: file.mtimeMs, offset, line: lineNo, deletedAt: null });
    }

    return;
  }

  const info = transcriptPathInfo(file.rel);
  const buf = await readSlice(file.abs, offset, file.size);
  const rawOps = [];
  const eventOps = [];
  const pendingFlushes = [];

  const consumed = consumeLines(buf, offset, file.mtimeMs, (line) => {
    lineNo += 1;

    const rawDoc = buildRawDoc(file.rel, info, line, lineNo);
    const { entry } = rawDoc;

    delete rawDoc.entry;
    rawOps.push({ updateOne: { filter: { _id: rawDoc._id }, update: { $setOnInsert: rawDoc }, upsert: true } });

    if (entry) {
      const eventOp = buildEventOp(entry, info, file.rel, line.offset, agentMetaByHash, unknownModels);

      if (eventOp) {
        eventOps.push(eventOp);
      }
    }

    if (rawOps.length >= BATCH_SIZE) {
      pendingFlushes.push([rawOps.splice(0), eventOps.splice(0)]);
    }
  });

  pendingFlushes.push([rawOps, eventOps]);

  for (const [raws, events] of pendingFlushes) {
    await flush('raw', raws, 'rawUpserts');
    await flush('events', events, 'eventUpserts');
  }

  await setState(file.rel, {
    kind: 'transcript',
    size: file.size,
    mtimeMs: file.mtimeMs,
    offset: consumed,
    line: lineNo,
    deletedAt: null,
  });
}

async function ingestMeta(file, state, agentMetaByHash) {
  const unchanged = state && state.size === file.size && state.mtimeMs === file.mtimeMs && !state.deletedAt;

  if (unchanged) {
    return;
  }

  let raw;

  try {
    raw = JSON.parse(await fsp.readFile(file.abs, 'utf8'));
  } catch (err) {
    console.error(`unreadable meta ${file.rel}:`, err.message);

    return;
  }

  const pairedRel = file.rel.replace(/\.meta\.json$/, '.jsonl');
  const info = transcriptPathInfo(pairedRel);
  const doc = {
    sessionId: info.sessionId,
    project: info.project,
    agentHash: info.agentHash,
    agentType: raw.agentType || null,
    description: raw.description || null,
    toolUseId: raw.toolUseId || null,
    spawnDepth: raw.spawnDepth != null ? raw.spawnDepth : null,
    mtimeMs: file.mtimeMs,
    raw,
  };

  await coll('subagentMeta').replaceOne({ _id: file.rel }, doc, { upsert: true });
  agentMetaByHash.set(info.agentHash, doc);

  // The transcript may have been ingested in an earlier cycle, before this
  // meta existed — backfill its events' agent fields.
  if (await coll('files').findOne({ _id: pairedRel })) {
    await coll('events').updateMany(
      { sourceFile: pairedRel, 'agent.agentType': null },
      { $set: { 'agent.agentType': doc.agentType, 'agent.spawnDepth': doc.spawnDepth } },
    );
  }

  await setState(file.rel, { kind: 'meta', size: file.size, mtimeMs: file.mtimeMs, offset: file.size, line: 0, deletedAt: null });
}

async function markDeleted(stateMap, seenRels) {
  let deleted = 0;

  for (const [rel, state] of stateMap) {
    if (seenRels.has(rel)) {
      continue;
    }

    if (!state.deletedAt) {
      await coll('files').updateOne({ _id: rel }, { $set: { deletedAt: new Date() } });
    }

    deleted += 1;
  }

  stats.filesDeleted = deleted;
}

async function runCycle() {
  const startedAt = Date.now();
  const unknownModels = new Set();

  const stateDocs = await coll('files').find({}).toArray();
  const stateMap = new Map(stateDocs.map((doc) => [doc._id, doc]));

  const agentMetaDocs = await coll('subagentMeta')
    .find({}, { projection: { agentHash: 1, agentType: 1, spawnDepth: 1 } })
    .toArray();
  const agentMetaByHash = new Map(agentMetaDocs.map((doc) => [doc.agentHash, doc]));

  const { transcripts, metas } = walkProjects();
  const seenRels = new Set();

  // Metas first, so a subagent transcript ingested in the same cycle already
  // finds its agentType in the cache.
  for (const file of metas) {
    seenRels.add(file.rel);
    await ingestMeta(file, stateMap.get(file.rel), agentMetaByHash);
  }

  for (const file of transcripts) {
    seenRels.add(file.rel);
    await ingestTranscript(file, stateMap.get(file.rel), agentMetaByHash, unknownModels);
  }

  await backfill.run({ stateMap, seenRels, readSlice, consumeLines, setState, stats });

  await markDeleted(stateMap, seenRels);

  stats.scans += 1;
  stats.lastScanAt = new Date();
  stats.lastScanMs = Date.now() - startedAt;
  stats.filesTracked = seenRels.size;

  await pricing.maybeRefreshForUnknown(unknownModels);
}

function start() {
  const tick = async () => {
    if (!running) {
      running = true;

      try {
        await runCycle();
        stats.lastError = null;
      } catch (err) {
        stats.lastError = err.message;
        console.error('scan cycle failed:', err);
      } finally {
        running = false;
      }
    }

    setTimeout(tick, config.scanIntervalMs).unref();
  };

  tick();
}

module.exports = { start, stats };
