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

// ---------------------------------------------------------------------
// Gemini-backed companion answers — the one genuinely load-bearing AI step
// in this app. Everything else (doc-search keyword tagging, successor Q&A
// word-overlap scoring) is deliberately NOT AI, honestly labeled as such.
// This is a real model call: given the transition's captured handover
// items + context-capture answers as grounding, Gemini decides how to
// answer (or honestly declines) instead of a lookup table scoring word
// overlap. Requires GEMINI_API_KEY as an env var — never in client code.
// ---------------------------------------------------------------------

const GEMINI_MODEL = 'gemini-2.5-flash';

function buildGeminiContext(state) {
  const items = (state.validationItems || []).map(v =>
    `- ${v.item}: ${v.desc} Current status: ${v.curStatus}. Stakeholders: ${v.stakeholders}.`
  ).join('\n');
  const qa = (state.contextQuestions || []).map(q => {
    const saved = (state.contextAnswers || []).find(a => a.item === q.item);
    return `Q: ${q.q}\nA: ${saved ? saved.a : q.dummy}`;
  }).join('\n\n');
  return `Handover items:\n${items || '(none captured yet)'}\n\nCaptured context Q&A:\n${qa || '(none captured yet)'}`;
}

// Returns { text, src, mode: 'ai' } on success, or { text: null, error,
// mode: 'unavailable' } if the key is missing or the call fails — callers
// (the client) should fall back to the local keyword-overlap answer in
// that case, not hide the gap or pretend the AI path worked.
async function askGemini(question, state) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { text: null, error: 'GEMINI_API_KEY is not configured on the server.', mode: 'unavailable' };
  }
  if (!question || !question.trim()) {
    return { text: 'Ask me something about the role — e.g. approvals, risks, or people to know.', src: null, mode: 'ai' };
  }
  const context = buildGeminiContext(state);
  const employeeName = state.employee ? state.employee.name : 'the outgoing employee';
  const prompt = `You are a knowledge-transfer assistant helping a successor take over ${employeeName}'s role. `
    + `Answer the question using ONLY the facts below. If the facts don't cover it, say so honestly and suggest `
    + `checking with the manager or outgoing employee directly — never invent an answer. Keep it to 2-4 sentences.\n\n`
    + `${context}\n\nQuestion: ${question}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { text: null, error: `Gemini API error (HTTP ${res.status}): ${errText.slice(0, 200)}`, mode: 'unavailable' };
    }
    const data = await res.json();
    const text = data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
      && data.candidates[0].content.parts[0].text;
    if (!text) {
      return { text: null, error: 'Gemini returned no answer (possibly blocked by a safety filter).', mode: 'unavailable' };
    }
    return { text: text.trim(), src: 'Generated live by Gemini from captured handover context', mode: 'ai' };
  } catch (e) {
    return { text: null, error: 'Could not reach Gemini: ' + e.message, mode: 'unavailable' };
  }
}

// Where uploaded self-review / manager-expectations docs land when there's
// no existing Google Doc link to use instead. Lives inside FRONTEND_DIR so
// the existing static-file serving below already covers /uploads/* for
// free — no separate route needed to serve them back out.
const UPLOADS_DIR = path.join(FRONTEND_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain; charset=utf-8',
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

    // POST /api/directory/:email/upload — upload a missing self-review or
    // manager-expectations doc directly, for when there's no existing
    // Google Doc link to paste in. Body is JSON ({ field, filename,
    // contentBase64 }) rather than multipart — reuses the existing JSON
    // body reader instead of writing a multipart parser from scratch.
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'directory' && parts[2] && parts[3] === 'upload') {
      const body = await readBody(req);
      const { field, filename, contentBase64 } = body;
      if (!field || !filename || !contentBase64) {
        return sendJson(res, 400, { error: 'field, filename and contentBase64 are required' });
      }
      const buffer = Buffer.from(contentBase64, 'base64');
      const safeName = `${Date.now()}-${String(filename).replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buffer);
      const url = `/uploads/${safeName}`;
      const updated = store.updateUserDocLink(decodeURIComponent(parts[2]), field, url);
      return sendJson(res, 200, { url, user: updated });
    }

    // POST /api/directory/:email/sync-docs — re-fetch and re-tag all four
    // of this employee's linked docs (keyword matching, not AI — see the
    // comment above syncEmployeeDocs in db.js). Must come before the
    // generic GET /:email route below, same reason as /upload above.
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'directory' && parts[2] && parts[3] === 'sync-docs') {
      const results = await store.syncEmployeeDocs(decodeURIComponent(parts[2]));
      return sendJson(res, 200, { results });
    }

    // GET /api/directory/:email/doc-chunks?tag=stake — keyword-matched
    // excerpts from that employee's docs, optionally filtered to one tag.
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'directory' && parts[2] && parts[3] === 'doc-chunks') {
      const tag = searchParams.get('tag');
      const chunks = store.getDocChunks(decodeURIComponent(parts[2]), tag || null);
      return sendJson(res, 200, chunks);
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

    // POST /api/transitions/:id/companion-ask — real Gemini-generated
    // answer, grounded in this transition's captured context. See the
    // long comment above askGemini() for why this is the one genuinely
    // load-bearing AI step in the app.
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'transitions' && parts[2] && parts[3] === 'companion-ask') {
      const body = await readBody(req);
      const state = store.getFullTransitionState(parts[2]);
      if (!state) return sendJson(res, 404, { error: 'Transition not found' });
      const answer = await askGemini(body.question, state);
      return sendJson(res, 200, answer);
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

    // GET /api/transitions/:id/context-batches — list all daily question
    // batches for a transition (most recent first).
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'transitions' && parts[2] && parts[3] === 'context-batches' && !parts[4]) {
      return sendJson(res, 200, store.listBatches(parts[2]));
    }

    // POST /api/transitions/:id/context-batches/today — get or create
    // today's batch of up to 10 questions for this transition.
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'transitions' && parts[2] && parts[3] === 'context-batches' && parts[4] === 'today') {
      const batch = store.getOrCreateTodayBatch(parts[2]);
      const questions = store.getBatchQuestions(parts[2], batch.batch_date);
      return sendJson(res, 200, { batchDate: batch.batch_date, status: batch.status, questions });
    }

    // POST /api/transitions/:id/context-batches/:date/submit — employee
    // has answered every question in that day's batch; hand it to the
    // manager's queue.
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'transitions' && parts[2] && parts[3] === 'context-batches' && parts[4] && parts[5] === 'submit') {
      const updated = store.submitBatch(parts[2], decodeURIComponent(parts[4]));
      return sendJson(res, 200, updated);
    }

    // POST /api/transitions/:id/context-batches/:date/review — manager has
    // gone through every item in that day's batch. Body: { outcome:
    // 'approved' | 'needs_revision' }.
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'transitions' && parts[2] && parts[3] === 'context-batches' && parts[4] && parts[5] === 'review') {
      const body = await readBody(req);
      const updated = store.reviewBatch(parts[2], decodeURIComponent(parts[4]), body.outcome);
      return sendJson(res, 200, updated);
    }

    // GET /api/hr-emails — every directory user flagged is_hr, so the
    // "submit for manager review" step can cc HR without hardcoding a
    // single address.
    if (req.method === 'GET' && pathname === '/api/hr-emails') {
      return sendJson(res, 200, store.listHrEmails());
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
