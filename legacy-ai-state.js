/*
 * legacy-ai-state.js — client for the Legacy AI backend API.
 *
 * This replaces the old localStorage-only version. All reads/writes now
 * go through fetch() calls to the Node server (server.js) sitting behind
 * this page, which persists to a real SQLite database instead of one
 * browser's local storage. Every function that touches the network is
 * async now — call sites must `await` them.
 *
 * Which transition a page is looking at is carried in the URL as
 * `?tr=TR-1042`. Call LegacyAIState.linkTo('some-page.html') to build a
 * link to another page that preserves the current transition.
 */

const LegacyAIState = (() => {
  const SESSION_KEY = 'legacyai_current_tr';
  const DEFAULT_TR = 'TR-1042';

  function currentTransitionId() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('tr');
    if (fromUrl) {
      sessionStorage.setItem(SESSION_KEY, fromUrl);
      return fromUrl;
    }
    return sessionStorage.getItem(SESSION_KEY) || DEFAULT_TR;
  }

  function setTransitionId(id) {
    sessionStorage.setItem(SESSION_KEY, id);
  }

  function linkTo(page) {
    return `${page}?tr=${encodeURIComponent(currentTransitionId())}`;
  }

  // ---------------------------------------------------------------------
  // Thin fetch helpers
  // ---------------------------------------------------------------------

  async function apiGet(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`API GET ${path} failed: ${r.status}`);
    return r.json();
  }

  async function apiSend(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw new Error(`API ${method} ${path} failed: ${r.status}`);
    return r.json();
  }

  // ---------------------------------------------------------------------
  // Transition state (replaces the old get/patch/save over localStorage)
  // ---------------------------------------------------------------------

  async function get() {
    return apiGet(`/api/transitions/${currentTransitionId()}/full`);
  }

  async function patch(partial) {
    return apiSend('PATCH', `/api/transitions/${currentTransitionId()}`, partial);
  }

  async function saveContextAnswer(item, q, a) {
    return apiSend('POST', `/api/transitions/${currentTransitionId()}/context-answers`, { item, q, a });
  }

  async function saveContextReview(item, status, note) {
    return apiSend('POST', `/api/transitions/${currentTransitionId()}/context-reviews`, { item, status, note });
  }

  async function appendDailyCheckIn(entry) {
    return apiSend('POST', `/api/transitions/${currentTransitionId()}/daily-checkins`, entry);
  }

  async function updateValidationItem(itemId, patchObj) {
    return apiSend('PUT', `/api/transitions/${currentTransitionId()}/validation-items/${itemId}`, patchObj);
  }

  async function reset() {
    await apiSend('POST', `/api/transitions/${currentTransitionId()}/reset`, {});
    return get();
  }

  // ---------------------------------------------------------------------
  // Directory (users/managers/self-review doc links) + transition list —
  // used by the HR/Manager dashboard to pick an employee instead of
  // free-typing their details.
  // ---------------------------------------------------------------------

  async function listDirectory() {
    return apiGet('/api/directory');
  }

  async function getDirectoryUser(email) {
    return apiGet(`/api/directory/${encodeURIComponent(email)}`);
  }

  async function listTransitions(managerEmail) {
    const qs = managerEmail ? `?managerEmail=${encodeURIComponent(managerEmail)}` : '';
    return apiGet(`/api/transitions${qs}`);
  }

  async function createTransition(payload) {
    return apiSend('POST', '/api/transitions', payload);
  }

  async function getDirectorySource() {
    return apiGet('/api/directory/source');
  }

  async function syncDirectory(csvUrl) {
    return apiSend('POST', '/api/directory/sync', csvUrl ? { csvUrl } : {});
  }

  async function syncDirectoryFromPastedCsv(csvText) {
    return apiSend('POST', '/api/directory/sync-pasted', { csvText });
  }

  // Used by the HR/Manager dashboard, which manages many transitions at
  // once and needs to update a specific one by id — not "the current
  // page's" transition the way patch() above does.
  async function updateTransitionById(id, partial) {
    return apiSend('PATCH', `/api/transitions/${id}`, partial);
  }

  // ---------------------------------------------------------------------
  // Knowledge-pack generation — pure function of whatever `state` object
  // is passed in (same shape whether it came from the API or a test
  // fixture), so this is unchanged from the localStorage version.
  // ---------------------------------------------------------------------

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function answersFeeding(state, tag) {
    return state.contextQuestions
      .filter(q => q.feeds.includes(tag))
      .map(q => {
        const saved = state.contextAnswers.find(a => a.item === q.item);
        return { item: q.item, q: q.q, a: saved ? saved.a : q.dummy };
      });
  }

  function bulletsFromAnswers(answers) {
    if (!answers.length) return '<p class="footnote">Nothing captured for this yet.</p>';
    return '<ul>' + answers.map(a =>
      `<li><b>${escapeHtml(a.item)}:</b> ${escapeHtml(a.a)}</li>`
    ).join('') + '</ul>';
  }

  function buildAssets(state) {
    const items = state.validationItems;
    const employeeName = state.employee.name;

    const stakeholderNames = [...new Set(items.map(v => v.stakeholders).filter(Boolean))];
    const timelineItem = items.find(v => v.item.toLowerCase().includes('autopay')) || items[0] || { item: 'No project on file yet', curStatus: '—' };

    return [
      { key: 'exec', icon: 'ti-file-text', title: 'Executive role summary',
        teaser: 'One-page overview of scope, ownership, and key relationships.',
        source: 'Validated handover items + context-capture answers',
        html: `<p>${escapeHtml(employeeName)} owns ${items.map(v => escapeHtml(v.item)).join(', ') || 'nothing validated yet'}.</p>`
          + bulletsFromAnswers(answersFeeding(state, 'exec')) },

      { key: 'ktguide', icon: 'ti-book-2', title: 'Knowledge transfer guide',
        teaser: 'Active projects, status, and what still needs attention.',
        source: 'Handover dashboard (validated)',
        html: '<ul>' + items.map(v => `<li><b>${escapeHtml(v.item)}</b> — ${escapeHtml(v.curStatus)}</li>`).join('') + '</ul>'
          + bulletsFromAnswers(answersFeeding(state, 'ktguide')) },

      { key: 'playbook', icon: 'ti-compass', title: 'Successor playbook',
        teaser: 'What the successor should do differently from day one.',
        source: 'Context-capture answers',
        html: bulletsFromAnswers(answersFeeding(state, 'playbook')) },

      { key: 'stake', icon: 'ti-users-group', title: 'Stakeholder relationship map',
        teaser: 'Who matters, and for what kind of decision.',
        source: 'Validated handover items + context-capture answers',
        html: '<ul>' + stakeholderNames.map(s => `<li><b>${escapeHtml(s)}</b></li>`).join('') + '</ul>'
          + bulletsFromAnswers(answersFeeding(state, 'stake')) },

      { key: 'decisions', icon: 'ti-git-branch', title: 'Decision history',
        teaser: 'Why things are the way they are today.',
        source: 'Context-capture answers',
        html: bulletsFromAnswers(answersFeeding(state, 'decisions')) },

      { key: 'risk', icon: 'ti-alert-triangle', title: 'Risk register',
        teaser: 'Where things are most likely to break.',
        source: 'Context-capture answers',
        html: bulletsFromAnswers(answersFeeding(state, 'risk')) },

      { key: 'timeline', icon: 'ti-timeline', title: 'Project timeline',
        teaser: `${timelineItem.item} — where it stands and what is next.`,
        source: 'Handover dashboard + context-capture answers',
        html: `<p><b>${escapeHtml(timelineItem.item)}:</b> ${escapeHtml(timelineItem.curStatus)}</p>`
          + bulletsFromAnswers(answersFeeding(state, 'timeline')) },

      { key: 'faq', icon: 'ti-help-circle', title: 'Frequently asked questions',
        teaser: 'The questions every successor asks in month one.',
        source: 'Context-capture answers',
        html: answersFeeding(state, 'faq').map(a =>
          `<div class="faq-q">${escapeHtml(a.q)}</div><div class="faq-a">${escapeHtml(a.a)}</div>`
        ).join('') || '<p class="footnote">Nothing captured for this yet.</p>' },

      { key: 'tips', icon: 'ti-bulb', title: 'Success tips',
        teaser: 'Small habits that save the most time.',
        source: 'Context-capture answers',
        html: bulletsFromAnswers(answersFeeding(state, 'tips')) },

      { key: 'best', icon: 'ti-star', title: 'Best practices',
        teaser: 'Process recommendations worth keeping.',
        source: 'Context-capture answers',
        html: bulletsFromAnswers(answersFeeding(state, 'best')) },

      { key: 'cheat', icon: 'ti-clipboard-list', title: 'Operational cheat sheet',
        teaser: 'Quick reference pulled from validated items and answers.',
        source: 'Handover dashboard + context-capture answers',
        html: bulletsFromAnswers(answersFeeding(state, 'cheat')) },
    ];
  }

  // ---------------------------------------------------------------------
  // Successor Q&A retrieval — unchanged keyword-overlap matching, still a
  // pure function of the fetched state.
  // ---------------------------------------------------------------------

  const STOPWORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'do', 'does', 'did',
    'what', 'who', 'whom', 'which', 'when', 'where', 'why', 'how',
    'i', 'my', 'me', 'you', 'your', 'to', 'of', 'in', 'on', 'for',
    'and', 'or', 'should', 'would', 'can', 'could', 'will', 'shall',
    'this', 'that', 'it', 'as', 'if', 'be', 'have', 'has', 'had',
  ]);

  function stem(word) {
    const suffixes = ['ing', 'ies', 'es', 's'];
    for (const suf of suffixes) {
      if (word.endsWith(suf) && word.length - suf.length > 3) return word.slice(0, -suf.length);
    }
    return word;
  }

  function tokenize(text) {
    const words = (String(text || '').toLowerCase().match(/[a-z]+/g)) || [];
    const out = new Set();
    words.forEach(w => {
      if (!STOPWORDS.has(w) && w.length > 2) out.add(stem(w));
    });
    return out;
  }

  function overlapScore(queryTokens, chunkTokens) {
    if (queryTokens.size === 0 || chunkTokens.size === 0) return 0;
    let shared = 0;
    queryTokens.forEach(t => { if (chunkTokens.has(t)) shared += 1; });
    return shared / queryTokens.size;
  }

  function starterFacts(state) {
    const items = state.validationItems;
    const vendorItem = items.find(v => v.item.toLowerCase().includes('vendor exception'));
    const reconItem = items.find(v => v.item.toLowerCase().includes('reconciliation'));

    const decisionsText = answersFeeding(state, 'decisions').map(a => a.a).join(' ');
    const riskText = answersFeeding(state, 'risk').map(a => a.a).join(' ');
    const tipsText = answersFeeding(state, 'tips').map(a => a.a).join(' ');
    const stakeText = answersFeeding(state, 'stake').map(a => a.a).join(' ');

    return [
      { q: 'Who approves vendor exceptions?',
        text: [
          vendorItem ? `${vendorItem.item}: ${vendorItem.desc} Stakeholders: ${vendorItem.stakeholders}.` : '',
          reconItem ? `${reconItem.item}: ${reconItem.desc}` : '',
        ].filter(Boolean).join(' ') || 'Nothing captured on approvals yet.',
        src: 'Handover dashboard' },
      { q: 'Why was this process changed?',
        text: decisionsText || 'No decision history captured yet.',
        src: 'Context capture — decision history' },
      { q: 'Which stakeholders are critical for month-end close?',
        text: [
          reconItem ? `${reconItem.item}: ${reconItem.desc} Stakeholders: ${reconItem.stakeholders}.` : '',
          stakeText,
        ].filter(Boolean).join(' ') || 'No stakeholder context captured yet.',
        src: 'Handover dashboard + context capture' },
      { q: 'What usually causes delays in this workflow?',
        text: riskText || 'No risks captured yet.',
        src: 'Context capture — risk register' },
      { q: 'What mistakes should I avoid during my first month?',
        text: [tipsText, riskText].filter(Boolean).join(' ') || 'No tips captured yet.',
        src: 'Context capture — success tips & risk register' },
    ];
  }

  function buildFacts(state) {
    const facts = [];
    starterFacts(state).forEach(f => facts.push(f));
    state.validationItems.forEach(v => {
      facts.push({
        text: `${v.item}: ${v.desc} Current status: ${v.curStatus}. Stakeholders: ${v.stakeholders}.`,
        src: 'Handover dashboard',
      });
    });
    state.contextQuestions.forEach(q => {
      const saved = state.contextAnswers.find(a => a.item === q.item);
      facts.push({
        text: saved ? saved.a : q.dummy,
        q: q.q,
        src: `Context capture — "${q.item}"`,
      });
    });
    return facts;
  }

  function findAnswer(question, state) {
    const facts = buildFacts(state);
    if (!question || !question.trim()) {
      return { text: 'Ask me something about the role — e.g. approvals, risks, or people to know.', src: null, confidence: 'low' };
    }
    const qTokens = tokenize(question);
    let best = null, bestScore = 0;
    facts.forEach(f => {
      let score = overlapScore(qTokens, tokenize(f.text));
      if (f.q) {
        const qScore = overlapScore(qTokens, tokenize(f.q));
        score = Math.max(score, qScore * 1.15);
      }
      if (score > bestScore) { bestScore = score; best = f; }
    });
    if (best && bestScore >= 0.34) {
      const confidence = bestScore >= 0.6 ? 'high' : 'medium';
      return { text: best.text, src: best.src, confidence };
    }
    return {
      text: "I don't have captured knowledge on that yet — worth checking with your manager or the outgoing employee directly.",
      src: null,
      confidence: 'low',
    };
  }

  // ---------------------------------------------------------------------
  // Real email — mailto: links, unchanged. Still no SMTP credentials in
  // the page; the presenter's own mail client sends it.
  // ---------------------------------------------------------------------

  function buildMailto(to, subject, body) {
    return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  // ---------------------------------------------------------------------
  // Export — same idea as before (download a JSON snapshot), now backed
  // by a fetch instead of a synchronous localStorage read.
  // ---------------------------------------------------------------------

  async function exportBrainroomJSON() {
    const state = await get();
    const shaped = {
      transitionId: state.transitionId,
      outgoingEmployee: state.employee,
      manager: state.manager,
      successor: state.successor,
      sourceSummary: 'Generated from live validated handover items and context-capture answers (server-backed state).',
      knowledgeAssets: buildAssets(state).reduce((acc, a) => {
        acc[a.key] = { title: a.title, source: a.source, html: a.html };
        return acc;
      }, {}),
      dailyCheckIn: { entries: state.dailyCheckIn },
      meta: {
        generatedBy: 'Legacy AI',
        note: 'Downloaded snapshot from the live database.',
        exportedAt: new Date().toISOString(),
      },
    };
    const blob = new Blob([JSON.stringify(shaped, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.employee.name.replace(/\s+/g, ' ')} - ${state.transitionId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return {
    currentTransitionId, setTransitionId, linkTo,
    get, patch, reset,
    saveContextAnswer, saveContextReview, appendDailyCheckIn, updateValidationItem,
    listDirectory, getDirectoryUser, listTransitions, createTransition, updateTransitionById,
    getDirectorySource, syncDirectory, syncDirectoryFromPastedCsv,
    buildAssets, findAnswer, exportBrainroomJSON, buildMailto,
  };
})();
