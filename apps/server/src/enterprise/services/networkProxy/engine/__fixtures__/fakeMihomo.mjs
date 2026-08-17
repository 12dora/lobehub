#!/usr/bin/env node
/**
 * Tiny stand-in for mihomo used by supervisor child-process tests.
 * Serves GET /version (and a few other REST shapes) on the controller port
 * parsed from the generated config, then sleeps until SIGTERM.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

if (process.argv.includes('-v')) {
  process.stdout.write('Mihomo Meta v1.19.30-fake\n');
  process.exit(0);
}

const flagIndex = process.argv.indexOf('-f');
const configPath = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
if (!configPath) {
  process.stderr.write('fakeMihomo: missing -f config path\n');
  process.exit(2);
}

const yaml = readFileSync(configPath, 'utf8');
const portMatch = /external-controller:\s*127\.0\.0\.1:(\d+)/u.exec(yaml);
const port = portMatch ? Number(portMatch[1]) : NaN;
if (!Number.isInteger(port)) {
  process.stderr.write('fakeMihomo: no external-controller port in config\n');
  process.exit(2);
}

const startsFile = process.env.FAKE_ENGINE_STARTS_FILE;
if (startsFile) appendFileSync(startsFile, '1');

const skipListen = Number(process.env.FAKE_ENGINE_SKIP_LISTEN ?? 0);
if (startsFile && skipListen > 0) {
  const starts = readFileSync(startsFile, 'utf8').length;
  if (starts <= skipListen) process.exit(1);
}

let versionHits = 0;
const failAfter = process.env.FAKE_ENGINE_FAIL_AFTER
  ? Number(process.env.FAKE_ENGINE_FAIL_AFTER)
  : Number.POSITIVE_INFINITY;
const crashAfterMs = process.env.FAKE_ENGINE_CRASH_AFTER_MS
  ? Number(process.env.FAKE_ENGINE_CRASH_AFTER_MS)
  : null;

const emptyGroup = { all: [], alive: false, history: [], now: '', type: 'URLTest' };

const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (url === '/version') {
    versionHits += 1;
    if (versionHits > failAfter) {
      res.destroy();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ meta: true, version: 'v1.19.30-fake' }));
    return;
  }
  if (url === '/proxies') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ proxies: { 'AIHUB-OUT': emptyGroup } }));
    return;
  }
  if (url.startsWith('/proxies/')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(emptyGroup));
    return;
  }
  if (url.startsWith('/configs') || url.startsWith('/providers/')) {
    res.statusCode = 204;
    res.end();
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

server.listen(port, '127.0.0.1');

if (crashAfterMs !== null) {
  setTimeout(() => process.exit(1), crashAfterMs).unref();
}

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 200).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
