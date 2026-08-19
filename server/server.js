/*
 * server.js — Legacy AI backend.
 *
 * Zero-dependency on purpose: only Node's own built-in modules (http,
 * node:sqlite, fs, path, url). Nothing to `npm install`, no native module
 * to compile — `node server.js` is the entire deployment step. Requires
 * Node 22.5+ for the built-in SQLite module.
 *
 * Serves the static frontend (the legacy-ai-*.html pages + shared state
 * script) AND the JSON API on the same origin/port, so there's no CORS
 * configuration to get right in a real deployment.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const store = require('./db');

const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.join(__dirname, '..'); // legacy-ai-*.html live one level up from /server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/legacy-ai-demo-hub.html' : pathname;
  const filePath = path.join(FRONTEND_DIR, decodeURIComponent(rel));
  // Prevent path traversal outside the frontend directory.
  if (!filePath.startsWith(FRONTEND_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found: ' + rel); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------

async function handleApi(req, res, pathname, searchParams) {
  const parts = pathname.split('/').filter(Boolean); // ['api', 'transitions', 'TR-1042', 'full']

  try {
    // GET /api/directory
    if (req.method === 'GET' && pathname === '/api/directory') {
      const users = store.listUsers().map(u => ({
        email: u.email, name: u.name, title: u.title, managerEmail: u.manager_email,
        isHr: !!u.is_hr, q1Link: u.q1_link, q2Link: u.q2_link, q3Link: u.q3_link, expLink: u.exp_link,
      }));
      return sendJson(res, 200, users);
    }

    // GET /api/directory/source — the saved Google Sheet CSV URL, if any.
    // Must come before the /:email route below, otherwise "source" gets
    // treated as an email address and 404s.
    if (req.method === 'GET' && pathname === '/api/directory/source') {
      return sendJson(res, 200, {
        csvUrl: store.getSetting('directory_csv_url'),
        lastSyncedAt: store.getSetting('directory_last_synced_at'),
      });
    }

    // POST /api/directory/sync — pull the directory from a published
    // Google Sheet CSV. Pass { csvUrl } to set/change the source, or omit
    // it to re-sync from whatever URL was saved last time. Also must come
    // before the /:email route (same reason).
    if (req.method === 'POST' && pathname === '/api/directory/sync') {
      const body = await readBody(req);
      const csvUrl = body.csvUrl || store.getSetting('directory_csv_url');
      const result = await store.syncDirectoryFromCsv(csvUrl);
      return sendJson(res, 200, result);
    }

    // POST /api/directory/sync-pasted — same as above, but for orgs where
    // the Sheet can't be made publicly fetchable (Workspace admin blocks
    // "anyone with the link" / publish-to-web). Pass { csvText } — the raw
    // CSV content, already read out of the Sheet by someone with access —
    // and it's parsed and upserted with no outbound fetch at all.
    if (req.method === 'POST' && pathname === '/api/directory/sync-pasted') {
      const body = await readBody(req);
      const result = store.syncDirectoryFromPastedCsv(body.csvText);
      return sendJson(res, 200, result);
    }

    // GET /api/directory/:email
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'directory' && parts[2]) {
      const u = store.userByEmail(decodeURIComponent(parts[2]));
      if (!u) return sendJson(res, 404, { error: 'Not found' });
      return sendJson(res, 200, {
        email: u.email, name: u.name, title: u.title, managerEmail: u.manager_email,
        isHr: !!u.is_hr, q1Link: u.q1_link, q2Link: u.q2_link, q3Link: u.q3_link, expLink: u.exp_link,
      });
    }

    // GET /api/transitions?managerEmail=...
    if (req.method === 'GET' && pathname === '/api/transitions') {
      const managerEmail = searchParams.get('managerEmail');
      return sendJson(res, 200, store.listTransitions(managerEmail || null));
    }

    // POST /api/transitions
    if (req.method === 'POST' && pathname === '/api/transitions') {
      const body = await readBody(req);
      if (!body.employeeEmail || !body.type) return sendJson(res, 400, { error: 'employeeEmail and type are required' });
      const created = store.createTransition(body);
      return sendJson(res, 201, created);
    }

    // GET /api/transitions/:id/full
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'transitions' && parts[2] && parts[3] === 'full') {
      const state = store.getFullTransitionState(parts[2]);
      if (!state) return sendJson(res, 404, { error: 'Transition not found' });
      return sendJson(res, 200, state);
    }

    // PATCH /api/transitions/:id
    if (req.method === 'PATCH' && parts[0] === 'api' && parts[1] === 'transitions' && parts[2] && !parts[3]) {
      const body = await readBody(req);
      const updated = store.updateTransition(parts[2], body);
      if (!updated) return sendJson(res, 404, { error: 'Transition not found' });
      return sendJson(res, 200, updated);
    }

    // PUT /api/transitions/:id/validation-items/:itemId
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'transitions' && parts[2] && parts[3] === 'validation-items' && parts[4]) {
      const body = await readBody(req);
      store.updateValidationItem(parts[2], Number(parts[4]), body);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/transitions/:id/context-answers
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'transitions' && parts[2] && parts[3] === 'context-answers') {
      const body = await readBody(req);
      store.saveContextAnswer(parts[2], body.item, body.q, body.a);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/transitions/:id/context-reviews
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'transitions' && parts[2] && parts[3] === 'context-reviews') {
      const body = await readBody(req);
      store.saveContextReview(parts[2], body.item, body.status, body.note);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/transitions/:id/daily-checkins
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'transitions' && parts[2] && parts[3] === 'daily-checkins') {
      const body = await readBody(req);
      store.appendDailyCheckIn(parts[2], body);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/transitions/:id/reset
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'transitions' && parts[2] && parts[3] === 'reset') {
      store.resetTransitionProgress(parts[2]);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'No such API route: ' + req.method + ' ' + pathname });
  } catch (e) {
    console.error(e);
    return sendJson(res, 500, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url.pathname, url.searchParams);
  } else {
    serveStatic(req, res, url.pathname);
  }
});

server.listen(PORT, () => {
  console.log(`Legacy AI server running at http://localhost:${PORT}`);
});
