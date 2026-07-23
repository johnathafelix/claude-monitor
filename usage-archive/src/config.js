'use strict';

// All environment knobs in one place. Defaults match the docker-compose setup;
// the localhost fallbacks make `node src/index.js` work outside the container.

module.exports = {
  port: Number(process.env.PORT || 3002),
  mongoUrl: process.env.MONGO_URL || 'mongodb://127.0.0.1:37017/usage_archive?directConnection=true',
  claudeDir: process.env.CLAUDE_DIR || `${process.env.HOME}/.claude`,
  scanIntervalMs: Number(process.env.SCAN_INTERVAL_SECONDS || 60) * 1000,
  pricingUrl:
    process.env.PRICING_URL
    || 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  pricingRefreshMs: Number(process.env.PRICING_REFRESH_HOURS || 6) * 60 * 60 * 1000,
  // Price ephemeral 1h cache writes at LiteLLM's above-1hr rate when available.
  // Set PRICE_1H_PREMIUM=0 for strict A/B comparison against ccusage, which
  // prices all cache writes at the base (5m) rate.
  price1hPremium: process.env.PRICE_1H_PREMIUM !== '0',
  bucketTz: process.env.BUCKET_TZ || 'UTC',
  maxSeriesPoints: Number(process.env.MAX_SERIES_POINTS || 2000),
  // A single JSONL line larger than this gets its bulky fields truncated so the
  // document stays under Mongo's 16MB cap (largest whole file today is ~13MB).
  maxLineBytes: Number(process.env.MAX_LINE_BYTES || 14 * 1024 * 1024),
};
