/*
 * db.js — SQLite storage layer for Legacy AI.
 *
 * Uses Node's built-in `node:sqlite` (available Node 22.5+) so there is
 * zero npm dependency for storage — no native module to compile, no
 * `npm install` needed to get a working database. The file lives next to
 * this script as legacy_ai.db and is created + seeded automatically on
 * first run if it doesn't exist yet.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = path.join(__dirname, 'legacy_ai.db');
const isNewDb = !fs.existsSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT,
    manager_email TEXT,
    is_hr INTEGER DEFAULT 0,
    q1_link TEXT,
    q2_link TEXT,
    q3_link TEXT,
    exp_link TEXT
  );

  CREATE TABLE IF NOT EXISTS transitions (
    id TEXT PRIMARY KEY,
    employee_email TEXT NOT NULL,
    manager_email TEXT,
    successor_email TEXT,
    type TEXT NOT NULL,
    trigger_date TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    successor_notified_at TEXT
  );

  CREATE TABLE IF NOT EXISTS validation_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transition_id TEXT NOT NULL,
    cat TEXT, cat_label TEXT, item TEXT, description TEXT, cur_status TEXT, doc TEXT,
    stakeholders TEXT, priority TEXT, owner TEXT, source TEXT,
    emp_status TEXT DEFAULT 'pending', mgr_status TEXT DEFAULT 'na', note TEXT
  );

  CREATE TABLE IF NOT EXISTS context_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transition_id TEXT NOT NULL,
    item TEXT, q TEXT, dummy TEXT, feeds TEXT, batch_date TEXT
  );

  CREATE TABLE IF NOT EXISTS context_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transition_id TEXT NOT NULL,
    item TEXT, q TEXT, a TEXT,
    UNIQUE(transition_id, item)
  );

  CREATE TABLE IF NOT EXISTS context_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transition_id TEXT NOT NULL,
    item TEXT, status TEXT DEFAULT 'pending', note TEXT,
    UNIQUE(transition_id, item)
  );

  CREATE TABLE IF NOT EXISTS daily_checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transition_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS context_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transition_id TEXT NOT NULL,
    batch_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', -- open | submitted | needs_revision | approved
    submitted_at TEXT,
    reviewed_at TEXT,
    UNIQUE(transition_id, batch_date)
  );

  CREATE TABLE IF NOT EXISTS doc_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_email TEXT NOT NULL,
    doc_field TEXT NOT NULL, -- q1Link | q2Link | q3Link | expLink
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    tags TEXT NOT NULL, -- JSON array of keyword-matched tags
    fetched_at TEXT NOT NULL
  );
`);

// Migration for DBs created before batch_date existed on context_questions
// (CREATE TABLE IF NOT EXISTS above only applies to brand-new tables).
try { db.exec(`ALTER TABLE context_questions ADD COLUMN batch_date TEXT`); } catch (e) { /* column already exists */ }

// ---------------------------------------------------------------------
// Seed data — only runs once, when the DB file didn't already exist.
// Mirrors the original hardcoded demo (Alisha Leitao / TR-1042) plus a
// small directory of other employees/managers so the "pick from
// directory" flow has more than one person to demonstrate with.
// ---------------------------------------------------------------------

if (isNewDb) {
  const insertUser = db.prepare(`
    INSERT INTO users (email, name, title, manager_email, is_hr, q1_link, q2_link, q3_link, exp_link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const users = [
    ['alisha.leitao@razorpay.com', 'Alisha Leitao', 'Sr. Product Manager, Payments', 'shashank.tiwari@razorpay.com', 0,
      'https://docs.google.com/document/d/alisha-self-review-q1', 'https://docs.google.com/document/d/alisha-self-review-q2',
      'https://docs.google.com/document/d/alisha-self-review-q3', 'https://docs.google.com/document/d/alisha-manager-expectations'],
    ['shashank.tiwari@razorpay.com', 'Shashank Tiwari', 'Manager, FinOps', null, 1, null, null, null, null],
    ['vaibhav.tandon@razorpay.com', 'Vaibhav Tandon', 'Sr. Manager FinOps, Payments', 'shashank.tiwari@razorpay.com', 0, null, null, null, null],
    ['ranjini.bs@razorpay.com', 'Ranjini BS', 'DM, FinOps', 'vaibhav.tandon@razorpay.com', 0,
      'https://docs.google.com/document/d/karan-self-review-q1', 'https://docs.google.com/document/d/karan-self-review-q2', null,
      'https://docs.google.com/document/d/karan-manager-expectations'],
    ['priya.nair@razorpay.com', 'Priya Nair', 'Director, Risk Engineering', null, 1, null, null, null, null],
    ['meera.iyer@razorpay.com', 'Meera Iyer', 'FinOps Analyst', 'shashank.tiwari@razorpay.com', 0,
      'https://docs.google.com/document/d/meera-self-review-q1', 'https://docs.google.com/document/d/meera-self-review-q2',
      'https://docs.google.com/document/d/meera-self-review-q3', 'https://docs.google.com/document/d/meera-manager-expectations'],
    ['devansh.rao@razorpay.com', 'Devansh Rao', 'Support Lead, PA-PG', 'nikita.kapoor@razorpay.com', 0,
      'https://docs.google.com/document/d/devansh-self-review-q1', null, null, null],
    ['nikita.kapoor@razorpay.com', 'Nikita Kapoor', 'Head of Support', null, 1, null, null, null, null],
    ['ananya.gupta@razorpay.com', 'Ananya Gupta', 'Compliance Associate', 'rohan.desai@razorpay.com', 0,
      'https://docs.google.com/document/d/ananya-self-review-q1', 'https://docs.google.com/document/d/ananya-self-review-q2',
      'https://docs.google.com/document/d/ananya-self-review-q3', 'https://docs.google.com/document/d/ananya-manager-expectations'],
    ['rohan.desai@razorpay.com', 'Rohan Desai', 'Compliance Lead', null, 1, null, null, null, null],
  ];
  for (const u of users) insertUser.run(...u);

  const insertTransition = db.prepare(`
    INSERT INTO transitions (id, employee_email, manager_email, successor_email, type, trigger_date, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  insertTransition.run('TR-1042', 'alisha.leitao@razorpay.com', 'shashank.tiwari@razorpay.com', 'vaibhav.tandon@razorpay.com', 'resign', '2026-08-18', 'ready', now);
  insertTransition.run('TR-1041', 'ranjini.bs@razorpay.com', 'vaibhav.tandon@razorpay.com', null, 'ijp', null, 'awaiting', now);
  insertTransition.run('TR-1039', 'vaibhav.tandon@razorpay.com', 'shashank.tiwari@razorpay.com', null, 'resign', '2026-08-05', 'sent', now);
  insertTransition.run('TR-1035', 'devansh.rao@razorpay.com', 'nikita.kapoor@razorpay.com', null, 'pip', '2026-08-01', 'draft', now);
  insertTransition.run('TR-1029', 'ananya.gupta@razorpay.com', 'rohan.desai@razorpay.com', null, 'ijp', '2026-07-20', 'done', now);

  // Full pre-populated validation items + context Q&A — only for the demo
  // transition (TR-1042). Every other transition intentionally starts
  // empty: nothing has actually parsed the linked self-review docs into
  // structured items, so fabricating content for them would be dishonest.
  const insertItem = db.prepare(`
    INSERT INTO validation_items (transition_id, cat, cat_label, item, description, cur_status, doc, stakeholders, priority, owner, source, emp_status, mgr_status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const items = [
    ['cat-projects', 'Projects', 'UPI Autopay renewal revamp', 'Redesign mandate renewal flow to cut failed auto-debits.',
      'In progress — design done, dev 60%', 'PRD v3', 'Finance, NPCI liaison', 'high', 'Alisha Leitao', 'Self-review Q3', 'confirmed', 'na', null],
    ['cat-stake', 'Stakeholders', 'NPCI liaison relationship', 'Primary point of contact for compliance escalations on UPI changes.',
      'Active, monthly sync', 'Manager expectations doc', 'R. Kulkarni (NPCI)', 'high', 'Alisha Leitao', 'Manager expectations', 'pending', 'na', null],
    ['cat-process', 'Process', 'Monthly reconciliation sign-off', 'Approves recon exceptions above ₹5L before finance close.',
      'Recurring, 1st week of month', 'SOP-Recon-04', 'Finance ops', 'medium', 'Alisha Leitao', 'Self-review Q2', 'edited', 'na', null],
    ['cat-access', 'Access', 'Datum dashboard admin access', 'Admin rights on settlement reporting dashboard.',
      'Active', 'IT access ticket #4821', 'IT, Data platform', 'medium', 'Alisha Leitao', 'Self-review Q1', 'disputed', 'pending',
      'Employee says access was revoked in June — item is stale.'],
    ['cat-deps', 'Dependencies', 'Waiting on Legal for T&C update', 'Blocked pending legal review of revised autopay consent language.',
      'Blocked since 3 weeks', 'Email thread — Legal review', 'Legal team', 'high', 'Alisha Leitao', 'Public Slack #payments-legal', 'disputed', 'agreed',
      'Employee flagged wrong owner — manager confirmed and reassigned to successor.'],
    ['cat-projects', 'Projects', 'Vendor exception approval workflow', 'One-off approval path for vendor payout mismatches.',
      'Stable, low volume', 'Playbook-Vendor-Exceptions', 'Vendor ops', 'low', 'Alisha Leitao', 'Self-review Q1', 'pending', 'na', null],
  ];
  for (const it of items) insertItem.run('TR-1042', ...it);

  const insertQ = db.prepare(`
    INSERT INTO context_questions (transition_id, item, q, dummy, feeds) VALUES (?, ?, ?, ?, ?)
  `);
  const insertA = db.prepare(`
    INSERT INTO context_answers (transition_id, item, q, a) VALUES (?, ?, ?, ?)
  `);
  const insertR = db.prepare(`
    INSERT INTO context_reviews (transition_id, item, status, note) VALUES (?, ?, ?, ?)
  `);
  const questions = [
    { item: 'Waiting on Legal for T&C update',
      q: 'This item was flagged as blocked for three weeks. What actually caused the delay, and who could unblock it faster next time?',
      dummy: 'Legal wanted a redline on the revised consent clause and I only looped them in after the design was final. Next time, pull in Priyanka from Legal at the draft stage — she is the actual reviewer, not the generic legal@ alias, and she turns things around in 2 days if asked directly.',
      feeds: ['playbook', 'risk', 'stake', 'tips'] },
    { item: 'Datum dashboard admin access',
      q: 'You disputed this access item as stale. Walk me through when and why it was revoked — is there a replacement process your successor should know about?',
      dummy: 'My admin access was revoked in June after the Datum platform migrated to role-based access. Successors now request access through the IT self-serve portal under "Settlement Reporting - Admin" instead of a manual ticket — much faster, usually same day.',
      feeds: ['ktguide', 'decisions', 'playbook', 'best', 'cheat'] },
    { item: 'NPCI liaison relationship',
      q: 'You meet with R. Kulkarni at NPCI monthly. What kind of decisions actually need their sign-off, versus ones you can make without them?',
      dummy: "Anything that changes the mandate renewal UX or consent language needs Kulkarni's sign-off since it touches NPCI compliance guidelines. Internal-only changes like dashboard tweaks or reporting don't need him — I looped him in on too many of those early on and it slowed things down.",
      feeds: ['stake', 'playbook', 'faq', 'tips'] },
    { item: 'UPI Autopay renewal revamp',
      q: 'If your successor remembered only three things about this project, what would they be?',
      dummy: 'One, the mandate renewal failure rate spikes right after bank-side maintenance windows, so always check the bank status page first. Two, Finance needs 48 hours notice before any change that affects auto-debit timing. Three, the NPCI sign-off takes 2 weeks minimum, so build that into any launch timeline.',
      feeds: ['timeline', 'risk', 'cheat'] },
    { item: 'Monthly reconciliation sign-off',
      q: 'This recurring approval changed at some point in the last year. What drove that change, and what mistake do people usually make the first time they run it?',
      dummy: "We raised the auto-approval threshold from 2L to 5L after Finance flagged too many low-value exceptions eating review time. First-timers usually forget to cross-check the FX-adjusted entries separately — those don't net out the same way as INR-only transactions.",
      feeds: ['decisions', 'risk', 'best', 'cheat', 'faq'] },
    { item: 'General',
      q: 'Looking back at your notice period so far — what is the one thing you wish someone had told you on your first day in this role?',
      dummy: 'That the NPCI relationship matters more than the org chart suggests — spend time there early instead of only when something breaks. Also, the "quick" vendor exception process is quick only if you loop in Vendor Ops first; skipping that step is what usually causes the delays people complain about.',
      feeds: ['exec', 'faq'] },
  ];
  for (const q of questions) {
    insertQ.run('TR-1042', q.item, q.q, q.dummy, JSON.stringify(q.feeds));
    insertA.run('TR-1042', q.item, q.q, q.dummy);
    insertR.run('TR-1042', q.item, 'pending', '');
  }

  console.log('legacy_ai.db created and seeded with demo data.');
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function userByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

const DOC_FIELD_TO_COLUMN = {
  q1Link: 'q1_link', q2Link: 'q2_link', q3Link: 'q3_link', expLink: 'exp_link',
};

// Points one of a user's doc-link columns at a freshly uploaded file
// instead of a Google Doc link — used when there's nothing to paste a
// link for. `field` is the client-facing name (q1Link/q2Link/q3Link/
// expLink); `url` is wherever the uploaded file now lives (e.g. /uploads/...).
function updateUserDocLink(email, field, url) {
  const column = DOC_FIELD_TO_COLUMN[field];
  if (!column) throw new Error(`Unknown doc field "${field}" — expected one of ${Object.keys(DOC_FIELD_TO_COLUMN).join(', ')}.`);
  const result = db.prepare(`UPDATE users SET ${column} = ? WHERE email = ?`).run(url, email);
  if (result.changes === 0) throw new Error('Unknown employee email — not found in directory.');
  return userByEmail(email);
}

function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY name').all();
}

function computeStatus(row, docsOk) {
  if (row.status === 'sent' || row.status === 'done') return row.status;
  if (!row.trigger_date) return 'awaiting';
  return docsOk ? 'ready' : 'draft';
}

function listTransitions(managerEmail) {
  const rows = managerEmail
    ? db.prepare('SELECT * FROM transitions WHERE manager_email = ? ORDER BY id DESC').all(managerEmail)
    : db.prepare('SELECT * FROM transitions ORDER BY id DESC').all();
  return rows.map(shapeTransitionSummary);
}

function shapeTransitionSummary(row) {
  const employee = userByEmail(row.employee_email);
  const manager = userByEmail(row.manager_email);
  const successor = row.successor_email ? userByEmail(row.successor_email) : null;
  const docsOk = !!(employee && employee.q1_link && employee.q2_link && employee.q3_link && employee.exp_link);
  return {
    id: row.id,
    employeeEmail: row.employee_email,
    employeeName: employee ? employee.name : row.employee_email,
    managerEmail: row.manager_email,
    managerName: manager ? manager.name : row.manager_email,
    successorEmail: row.successor_email,
    successorName: successor ? successor.name : null,
    type: row.type,
    triggerDate: row.trigger_date,
    status: computeStatus(row, docsOk),
    q1: !!(employee && employee.q1_link),
    q2: !!(employee && employee.q2_link),
    q3: !!(employee && employee.q3_link),
    exp: !!(employee && employee.exp_link),
  };
}

function nextTransitionId() {
  const row = db.prepare(`
    SELECT id FROM transitions
    WHERE id LIKE 'TR-%' AND CAST(SUBSTR(id, 4) AS INTEGER) IS NOT NULL
    ORDER BY CAST(SUBSTR(id, 4) AS INTEGER) DESC LIMIT 1
  `).get();
  const lastNum = row ? parseInt(row.id.slice(3), 10) : 1042;
  return 'TR-' + (lastNum + 1);
}

function createTransition({ employeeEmail, managerEmail, type, triggerDate }) {
  const employee = userByEmail(employeeEmail);
  if (!employee) throw new Error('Unknown employee email — not found in directory.');
  const id = nextTransitionId();
  const finalManagerEmail = managerEmail || employee.manager_email;
  db.prepare(`
    INSERT INTO transitions (id, employee_email, manager_email, successor_email, type, trigger_date, status, created_at)
    VALUES (?, ?, ?, NULL, ?, ?, 'draft', ?)
  `).run(id, employeeEmail, finalManagerEmail, type, triggerDate || null, new Date().toISOString());
  return getTransitionSummary(id);
}

function getTransitionSummary(id) {
  const row = db.prepare('SELECT * FROM transitions WHERE id = ?').get(id);
  return row ? shapeTransitionSummary(row) : null;
}

function updateTransition(id, patch) {
  const row = db.prepare('SELECT * FROM transitions WHERE id = ?').get(id);
  if (!row) return null;
  const fields = [];
  const values = [];
  if (patch.status !== undefined) { fields.push('status = ?'); values.push(patch.status); }
  if (patch.triggerDate !== undefined) { fields.push('trigger_date = ?'); values.push(patch.triggerDate); }
  if (patch.successorEmail !== undefined) { fields.push('successor_email = ?'); values.push(patch.successorEmail); }
  if (patch.successorNotifiedAt !== undefined) { fields.push('successor_notified_at = ?'); values.push(patch.successorNotifiedAt); }
  if (fields.length) {
    db.prepare(`UPDATE transitions SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
  }
  return getTransitionSummary(id);
}

function getFullTransitionState(id) {
  const row = db.prepare('SELECT * FROM transitions WHERE id = ?').get(id);
  if (!row) return null;
  const employee = userByEmail(row.employee_email);
  const manager = userByEmail(row.manager_email);
  const successor = row.successor_email ? userByEmail(row.successor_email) : null;

  const validationItems = db.prepare('SELECT * FROM validation_items WHERE transition_id = ? ORDER BY id').all(id)
    .map(v => ({
      id: v.id, cat: v.cat, catLabel: v.cat_label, item: v.item, desc: v.description,
      curStatus: v.cur_status, doc: v.doc, stakeholders: v.stakeholders, priority: v.priority,
      owner: v.owner, source: v.source, empStatus: v.emp_status, mgrStatus: v.mgr_status, note: v.note,
    }));

  const contextQuestions = db.prepare('SELECT * FROM context_questions WHERE transition_id = ? ORDER BY id').all(id)
    .map(q => ({ item: q.item, q: q.q, dummy: q.dummy, feeds: JSON.parse(q.feeds || '[]'), batchDate: q.batch_date || null }));

  const contextAnswers = db.prepare('SELECT item, q, a FROM context_answers WHERE transition_id = ?').all(id);
  const contextReview = db.prepare('SELECT item, status, note FROM context_reviews WHERE transition_id = ?').all(id);
  const dailyCheckIn = db.prepare('SELECT created_at, payload FROM daily_checkins WHERE transition_id = ? ORDER BY id DESC').all(id)
    .map(r => ({ createdAt: r.created_at, ...JSON.parse(r.payload || '{}') }));

  return {
    transitionId: row.id,
    type: row.type,
    triggerDate: row.trigger_date,
    status: row.status,
    successorNotifiedAt: row.successor_notified_at,
    employee: employee ? { name: employee.name, email: employee.email, role: employee.title } : null,
    manager: manager ? { name: manager.name, email: manager.email } : null,
    successor: successor ? { name: successor.name, email: successor.email } : null,
    validationItems,
    contextQuestions,
    contextAnswers,
    contextReview,
    dailyCheckIn,
  };
}

function updateValidationItem(transitionId, itemId, patch) {
  const fields = [];
  const values = [];
  if (patch.empStatus !== undefined) { fields.push('emp_status = ?'); values.push(patch.empStatus); }
  if (patch.mgrStatus !== undefined) { fields.push('mgr_status = ?'); values.push(patch.mgrStatus); }
  if (patch.note !== undefined) { fields.push('note = ?'); values.push(patch.note); }
  if (patch.curStatus !== undefined) { fields.push('cur_status = ?'); values.push(patch.curStatus); }
  if (!fields.length) return;
  db.prepare(`UPDATE validation_items SET ${fields.join(', ')} WHERE id = ? AND transition_id = ?`)
    .run(...values, itemId, transitionId);
}

function saveContextAnswer(transitionId, item, q, a) {
  db.prepare(`
    INSERT INTO context_answers (transition_id, item, q, a) VALUES (?, ?, ?, ?)
    ON CONFLICT(transition_id, item) DO UPDATE SET q = excluded.q, a = excluded.a
  `).run(transitionId, item, q, a);
}

function saveContextReview(transitionId, item, status, note) {
  db.prepare(`
    INSERT INTO context_reviews (transition_id, item, status, note) VALUES (?, ?, ?, ?)
    ON CONFLICT(transition_id, item) DO UPDATE SET status = excluded.status, note = excluded.note
  `).run(transitionId, item, status, note || '');

  // If this item belongs to a dated daily batch and it just moved OUT of
  // "flagged" (e.g. the employee resubmitted a corrected answer, resetting
  // it to 'pending'), and no other item in that same batch is still
  // flagged, put the whole batch back to "submitted" so the manager sees
  // it queued for another look — without requiring a separate manual
  // "resubmit the batch" button.
  if (status !== 'flagged') {
    const q = db.prepare('SELECT batch_date FROM context_questions WHERE transition_id = ? AND item = ?').get(transitionId, item);
    if (q && q.batch_date) maybeResubmitBatch(transitionId, q.batch_date);
  }
}

function appendDailyCheckIn(transitionId, payload) {
  db.prepare('INSERT INTO daily_checkins (transition_id, created_at, payload) VALUES (?, ?, ?)')
    .run(transitionId, new Date().toISOString(), JSON.stringify(payload || {}));
}

function resetTransitionProgress(transitionId) {
  db.prepare('DELETE FROM daily_checkins WHERE transition_id = ?').run(transitionId);
  const questions = db.prepare('SELECT item, q, dummy FROM context_questions WHERE transition_id = ?').all(transitionId);
  for (const q of questions) {
    db.prepare(`
      INSERT INTO context_answers (transition_id, item, q, a) VALUES (?, ?, ?, ?)
      ON CONFLICT(transition_id, item) DO UPDATE SET q = excluded.q, a = excluded.a
    `).run(transitionId, q.item, q.q, q.dummy);
    db.prepare(`
      INSERT INTO context_reviews (transition_id, item, status, note) VALUES (?, ?, 'pending', '')
      ON CONFLICT(transition_id, item) DO UPDATE SET status = 'pending', note = ''
    `).run(transitionId, q.item);
  }
  db.prepare("UPDATE transitions SET successor_notified_at = NULL WHERE id = ?").run(transitionId);
}

// ---------------------------------------------------------------------
// Daily question batches — up to 10 context-capture questions per day,
// pulled from a generic template bank (NOT AI-personalized — there is no
// document-scraping or LLM step in this build; these are the same
// standard knowledge-transfer prompts for everyone, honestly labeled as
// such in the UI). Each transition gets its own sequence of dated batches
// so the daily submit -> manager-review -> revision-or-approval loop is a
// real, generic mechanism rather than something that only works for the
// one pre-seeded demo transition (TR-1042), which keeps using its
// original flat, undated question list untouched (batch_date stays NULL
// for those rows).
// ---------------------------------------------------------------------

const QUESTION_BANK = [
  { q: "What's the single most important thing your successor needs to know to avoid a first-week mistake?", feeds: ['tips', 'risk'] },
  { q: "Which recurring task or process do you own that isn't documented anywhere?", feeds: ['ktguide', 'cheat'] },
  { q: "Who are the 2-3 people your successor absolutely needs a good relationship with, and why?", feeds: ['stake'] },
  { q: "What's a decision you made that looked wrong at the time but turned out right (or vice versa)?", feeds: ['decisions'] },
  { q: "What's currently blocked, and who's the real unblocker (not just the official owner)?", feeds: ['risk', 'playbook'] },
  { q: "If this task or project failed, what would be the most likely cause?", feeds: ['risk'] },
  { q: "What's a shortcut or workaround you use that isn't official process?", feeds: ['tips', 'best'] },
  { q: "What should your successor double-check before trusting a report or number?", feeds: ['cheat', 'best'] },
  { q: "What's the most time-consuming part of your role that could be simplified?", feeds: ['ktguide', 'tips'] },
  { q: "What's a mistake a new person in this role commonly makes?", feeds: ['faq', 'tips'] },
  { q: "Which stakeholder relationship took the longest to build, and how did you build it?", feeds: ['stake', 'playbook'] },
  { q: "What's one thing you wish you'd automated or documented earlier?", feeds: ['best', 'ktguide'] },
  { q: "What's the status of your highest-priority open item right now?", feeds: ['timeline', 'ktguide'] },
  { q: "What deadline or recurring date should your successor never miss?", feeds: ['cheat', 'risk'] },
  { q: "What's a question you get asked often that isn't written down anywhere?", feeds: ['faq'] },
  { q: "What context would help your successor make a fast decision without waiting on you?", feeds: ['exec', 'playbook'] },
  { q: "Which vendor, tool, or system is trickier to use than it looks?", feeds: ['tips', 'risk'] },
  { q: "What's the one meeting or sync your successor must not skip?", feeds: ['cheat', 'stake'] },
  { q: "What feedback have you gotten about this role that your successor should know?", feeds: ['exec', 'best'] },
  { q: "What's still unresolved that you're leaving behind?", feeds: ['risk', 'decisions'] },
];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Returns today's batch for a transition, creating it (with up to 10 fresh
// questions pulled from QUESTION_BANK, skipping any question text already
// asked in an earlier batch for this transition) if it doesn't exist yet.
function getOrCreateTodayBatch(transitionId) {
  const date = todayStr();
  let batch = db.prepare('SELECT * FROM context_batches WHERE transition_id = ? AND batch_date = ?').get(transitionId, date);
  if (batch) return batch;

  const askedTexts = new Set(
    db.prepare('SELECT q FROM context_questions WHERE transition_id = ?').all(transitionId).map(r => r.q)
  );
  const askedCount = askedTexts.size;

  db.prepare(`INSERT INTO context_batches (transition_id, batch_date, status) VALUES (?, ?, 'open')`).run(transitionId, date);

  const insertQ = db.prepare(`INSERT INTO context_questions (transition_id, item, q, dummy, feeds, batch_date) VALUES (?, ?, ?, ?, ?, ?)`);
  const insertA = db.prepare(`INSERT INTO context_answers (transition_id, item, q, a) VALUES (?, ?, ?, ?) ON CONFLICT(transition_id, item) DO NOTHING`);
  const insertR = db.prepare(`INSERT INTO context_reviews (transition_id, item, status, note) VALUES (?, ?, 'pending', '') ON CONFLICT(transition_id, item) DO NOTHING`);

  let picked = 0;
  let offset = askedCount;
  let attempts = 0;
  while (picked < 10 && attempts < QUESTION_BANK.length * 3) {
    const bankItem = QUESTION_BANK[offset % QUESTION_BANK.length];
    offset++; attempts++;
    if (askedTexts.has(bankItem.q)) continue; // don't repeat a question already asked on an earlier day
    const itemLabel = `Day ${date} — Q${picked + 1}`;
    insertQ.run(transitionId, itemLabel, bankItem.q, '', JSON.stringify(bankItem.feeds), date);
    insertA.run(transitionId, itemLabel, bankItem.q, '');
    insertR.run(transitionId, itemLabel);
    askedTexts.add(bankItem.q);
    picked++;
  }

  return db.prepare('SELECT * FROM context_batches WHERE transition_id = ? AND batch_date = ?').get(transitionId, date);
}

function getBatchQuestions(transitionId, batchDate) {
  return db.prepare('SELECT * FROM context_questions WHERE transition_id = ? AND batch_date = ? ORDER BY id').all(transitionId, batchDate)
    .map(q => ({ item: q.item, q: q.q, dummy: q.dummy, feeds: JSON.parse(q.feeds || '[]') }));
}

function listBatches(transitionId) {
  return db.prepare('SELECT * FROM context_batches WHERE transition_id = ? ORDER BY batch_date DESC').all(transitionId)
    .map(b => ({
      id: b.id, transitionId: b.transition_id, batchDate: b.batch_date, status: b.status,
      submittedAt: b.submitted_at, reviewedAt: b.reviewed_at,
    }));
}

function submitBatch(transitionId, batchDate) {
  const result = db.prepare(`
    UPDATE context_batches SET status = 'submitted', submitted_at = ?
    WHERE transition_id = ? AND batch_date = ? AND status IN ('open', 'needs_revision')
  `).run(new Date().toISOString(), transitionId, batchDate);
  if (result.changes === 0) throw new Error('Batch not found, or not in a submittable state.');
  return listBatches(transitionId).find(b => b.batchDate === batchDate);
}

// outcome: 'approved' | 'needs_revision' — set by the manager after going
// through every item in the batch (approved all -> 'approved'; flagged at
// least one -> 'needs_revision').
function reviewBatch(transitionId, batchDate, outcome) {
  if (outcome !== 'approved' && outcome !== 'needs_revision') {
    throw new Error(`Unknown batch outcome "${outcome}" — expected "approved" or "needs_revision".`);
  }
  const result = db.prepare(`
    UPDATE context_batches SET status = ?, reviewed_at = ? WHERE transition_id = ? AND batch_date = ?
  `).run(outcome, new Date().toISOString(), transitionId, batchDate);
  if (result.changes === 0) throw new Error('Batch not found.');
  return listBatches(transitionId).find(b => b.batchDate === batchDate);
}

// Internal — see the comment inside saveContextReview() above for why this
// exists: once every previously-flagged item in a batch has been
// corrected and resubmitted, the batch itself should go back to
// "submitted" automatically rather than needing a separate button.
function maybeResubmitBatch(transitionId, batchDate) {
  const remaining = db.prepare(`
    SELECT COUNT(*) AS c FROM context_questions q
    JOIN context_reviews r ON r.transition_id = q.transition_id AND r.item = q.item
    WHERE q.transition_id = ? AND q.batch_date = ? AND r.status = 'flagged'
  `).get(transitionId, batchDate).c;
  if (remaining === 0) {
    db.prepare(`
      UPDATE context_batches SET status = 'submitted', submitted_at = ?
      WHERE transition_id = ? AND batch_date = ? AND status = 'needs_revision'
    `).run(new Date().toISOString(), transitionId, batchDate);
  }
}

function listHrEmails() {
  return db.prepare('SELECT email FROM users WHERE is_hr = 1').all().map(r => r.email);
}

// ---------------------------------------------------------------------
// Directory sync — pull the employee directory from a published Google
// Sheet (File -> Share -> Publish to web -> CSV). Upserts by email and
// never deletes anyone, so a blank/glitchy sheet can't wipe the directory.
// ---------------------------------------------------------------------

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// Minimal quote-aware CSV parser — Google Sheets' CSV export quotes any
// field containing a comma (e.g. a title like "DM, FinOps"), so a naive
// split(',') would break those rows. Handles quoted fields, embedded
// commas/newlines inside quotes, and "" as an escaped quote.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (c === '\r') {
      // ignore, \n handles the line break
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

// Shared upsert core — takes already-parsed rows (header row + data rows)
// and writes them into the users table. Used by both the URL-fetch path
// and the pasted-text path below, so the actual sync logic only lives once.
function upsertDirectoryRows(rows) {
  if (rows.length < 2) throw new Error('Sheet looks empty — expected a header row plus at least one person.');
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = name => header.indexOf(name);
  const required = ['email', 'name'];
  for (const r of required) {
    if (col(r) === -1) throw new Error(`Sheet is missing a required "${r}" column.`);
  }
  const upsert = db.prepare(`
    INSERT INTO users (email, name, title, manager_email, is_hr, q1_link, q2_link, q3_link, exp_link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name = excluded.name, title = excluded.title, manager_email = excluded.manager_email,
      is_hr = excluded.is_hr, q1_link = excluded.q1_link, q2_link = excluded.q2_link,
      q3_link = excluded.q3_link, exp_link = excluded.exp_link
  `);
  const at = (r, name) => { const i = col(name); return i === -1 ? '' : (r[i] || '').trim(); };
  let count = 0;
  for (const r of rows.slice(1)) {
    const email = at(r, 'email').toLowerCase();
    if (!email) continue;
    upsert.run(
      email, at(r, 'name') || email, at(r, 'title') || null,
      (at(r, 'manager_email') || '').toLowerCase() || null,
      at(r, 'is_hr') === '1' ? 1 : 0,
      at(r, 'q1_link') || null, at(r, 'q2_link') || null, at(r, 'q3_link') || null, at(r, 'exp_link') || null,
    );
    count++;
  }
  return count;
}

async function syncDirectoryFromCsv(csvUrl) {
  if (!csvUrl) throw new Error('No Google Sheet CSV URL configured yet.');
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error(`Could not fetch the sheet (HTTP ${res.status}). Make sure it's published to the web as CSV.`);
  const text = await res.text();
  const count = upsertDirectoryRows(parseCsv(text));
  setSetting('directory_csv_url', csvUrl);
  setSetting('directory_last_synced_at', new Date().toISOString());
  return { count, syncedAt: getSetting('directory_last_synced_at') };
}

// Same sync, but for orgs where the Sheet can't be made publicly fetchable
// (e.g. a Workspace admin blocks "anyone with the link" / publish-to-web —
// this rejects with a `publishOutNotPermitted` error on Razorpay's domain).
// Instead of the app fetching a URL, someone with access to the Sheet reads
// it and pastes the CSV text here directly — no outbound fetch needed.
function syncDirectoryFromPastedCsv(csvText) {
  if (!csvText || !csvText.trim()) throw new Error('No CSV text was pasted.');
  const count = upsertDirectoryRows(parseCsv(csvText));
  setSetting('directory_csv_url', null);
  setSetting('directory_last_synced_at', new Date().toISOString());
  return { count, syncedAt: getSetting('directory_last_synced_at') };
}

// ---------------------------------------------------------------------
// Document search — keyword-matched excerpts from the employee's real
// self-review / manager-expectations docs. This is deliberately NOT
// billed as AI: there is no LLM call anywhere in this app, so nothing
// here "understands" the document. It fetches the real text (works for
// Google Docs shared as "anyone with the link can view", via the same
// export-as-plain-text trick used elsewhere for CSV publishing) and
// tags each sentence-sized chunk against a fixed keyword list — the
// same category vocabulary already used for context-capture "feeds"
// tags. Good for retrieval (surfacing real, relevant source text);
// not reliable for extraction (never used to auto-fill structured
// fields like priority/owner/stakeholders — that would just be
// fabricating structure the matching can't actually verify).
// ---------------------------------------------------------------------

const DOC_FIELDS = [
  { field: 'q1Link', column: 'q1_link' },
  { field: 'q2Link', column: 'q2_link' },
  { field: 'q3Link', column: 'q3_link' },
  { field: 'expLink', column: 'exp_link' },
];

function extractGoogleDocId(url) {
  const m = String(url || '').match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

async function fetchDocText(url) {
  const docId = extractGoogleDocId(url);
  if (!docId) {
    throw new Error('Not a Google Doc link — only docs.google.com/document/d/<id>/... URLs can be fetched this way.');
  }
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const res = await fetch(exportUrl);
  if (!res.ok) {
    throw new Error(`Could not fetch the doc (HTTP ${res.status}). Make sure it's shared as "Anyone with the link can view".`);
  }
  return res.text();
}

// Splits raw doc text into sentence-ish chunks. Deliberately crude (regex
// on sentence punctuation / blank lines) — good enough for keyword
// matching, not meant to be a real NLP sentence splitter.
function chunkText(text) {
  const cleaned = String(text || '').replace(/\r\n/g, '\n');
  const rough = cleaned.split(/(?<=[.!?])\s+|\n{2,}/);
  return rough.map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length >= 25 && s.length <= 500);
}

// Same tag vocabulary as the context-capture "feeds" tags, so matched
// excerpts line up with the same categories used elsewhere in the app.
const TAG_KEYWORDS = {
  exec: ['overview', 'own ', 'responsible for', 'scope of', 'summary'],
  ktguide: ['process', 'workflow', 'procedure', 'step ', 'how to', 'guide'],
  playbook: ['successor', 'next person', 'day one', 'should do', 'recommend that'],
  stake: ['stakeholder', 'sign-off', 'sign off', 'approve', 'approval', 'relationship', 'point of contact'],
  decisions: ['decided', 'decision', 'we changed', 'because', 'reason for', 'why we'],
  risk: ['risk', 'blocked', 'delay', 'concern', 'issue', 'fail', 'problem'],
  timeline: ['deadline', 'timeline', 'schedule', 'launch', 'due date'],
  tips: ['tip:', 'avoid', 'mistake', 'save time', 'habit'],
  best: ['best practice', 'always', 'standard process', 'recommended way'],
  cheat: ['quick reference', 'checklist', 'remember to', 'note:'],
};

function tagChunk(text) {
  const lower = text.toLowerCase();
  const tags = [];
  for (const [tag, keywords] of Object.entries(TAG_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) tags.push(tag);
  }
  if (/\?\s*$/.test(text.trim())) tags.push('faq');
  return tags;
}

// Re-fetches and re-tags all four of an employee's linked docs, replacing
// whatever was cached before. Returns a per-doc status so the caller can
// show exactly what worked and what didn't (missing link, not a Google
// Doc, not shared correctly, etc.) instead of a single opaque success/fail.
async function syncEmployeeDocs(employeeEmail) {
  const user = userByEmail(employeeEmail);
  if (!user) throw new Error('Unknown employee email — not found in directory.');
  const results = [];
  const insert = db.prepare(`
    INSERT INTO doc_chunks (employee_email, doc_field, chunk_index, text, tags, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const { field, column } of DOC_FIELDS) {
    const url = user[column];
    db.prepare('DELETE FROM doc_chunks WHERE employee_email = ? AND doc_field = ?').run(employeeEmail, field);
    if (!url) { results.push({ field, status: 'missing' }); continue; }
    try {
      const text = await fetchDocText(url);
      const chunks = chunkText(text);
      const now = new Date().toISOString();
      chunks.forEach((c, i) => insert.run(employeeEmail, field, i, c, JSON.stringify(tagChunk(c)), now));
      results.push({ field, status: 'ok', chunkCount: chunks.length });
    } catch (e) {
      results.push({ field, status: 'error', message: e.message });
    }
  }
  return results;
}

function getDocChunks(employeeEmail, tag) {
  const rows = db.prepare('SELECT doc_field, chunk_index, text, tags, fetched_at FROM doc_chunks WHERE employee_email = ? ORDER BY doc_field, chunk_index').all(employeeEmail);
  return rows
    .map(r => ({ docField: r.doc_field, text: r.text, tags: JSON.parse(r.tags || '[]'), fetchedAt: r.fetched_at }))
    .filter(r => !tag || r.tags.includes(tag));
}

module.exports = {
  db,
  userByEmail,
  listUsers,
  listTransitions,
  createTransition,
  getTransitionSummary,
  updateTransition,
  getFullTransitionState,
  updateValidationItem,
  saveContextAnswer,
  saveContextReview,
  appendDailyCheckIn,
  resetTransitionProgress,
  getSetting,
  setSetting,
  syncDirectoryFromCsv,
  syncDirectoryFromPastedCsv,
  updateUserDocLink,
  getOrCreateTodayBatch,
  getBatchQuestions,
  listBatches,
  submitBatch,
  reviewBatch,
  listHrEmails,
  syncEmployeeDocs,
  getDocChunks,
};
