# Legacy AI — server-backed version

This replaces the earlier GitHub-Pages-only demo (which stored everything in
one browser's `localStorage`) with a real backend: a small Node server and a
real SQLite database. Multiple people, on different machines, now see the
same data — the directory of employees/managers/self-review docs, and every
transition, validation item, context answer, and daily check-in.

## What changed vs. the static version

- **A real backend** (`server/server.js`) instead of browser-only state.
- **A real database** (`server/legacy_ai.db`, created automatically) instead
  of `localStorage`.
- **A user directory** (name, title, manager, self-review doc links) that
  the "New transition" form on the HR/Manager dashboard picks from directly
  — no more typing an employee's manager or doc links by hand.
- Everything else (the workflow, the mailto: real-email buttons, the
  knowledge-pack generation, the successor Q&A matching) works the same as
  before, just reading from/writing to the API instead of `localStorage`.

Because there's now a real backend, **this can no longer be hosted on
GitHub Pages** (which only serves static files). It needs somewhere that
can run a Node process.

## Running it locally

Requires **Node 22.5 or newer** (for the built-in `node:sqlite` module —
check with `node --version`). No `npm install` needed; there are zero
dependencies.

```
cd server
node server.js
```

Then open `http://localhost:3000/` (or `http://localhost:3000/legacy-ai-demo-hub.html`
directly). The database file `server/legacy_ai.db` is created and seeded
with the demo scenario (Alisha Leitao / TR-1042, plus 9 other directory
users) the first time you run it. Delete that file to reset everything back
to the original seed data.

Set `PORT=xxxx` as an environment variable to run on a different port.

## Deploying via GitHub + Render (for demo day)

This is the flow to actually get a live, shareable URL: GitHub hosts the
code and triggers deploys; Render (a real host that can run a Node
process) runs the app. **GitHub Pages is not involved in serving the app at
all** — it can't run a server, full stop. This just uses GitHub as the
source-of-truth + auto-deploy trigger.

Everything Render needs is already committed: `Dockerfile` (how to build
it) and `render.yaml` (a Render Blueprint — the exact service config, so
you don't configure anything by hand in their dashboard).

**1. Push this folder to a new GitHub repo** (run from this folder, in a
terminal — I can't run these for you, they need your own GitHub login):

```
git init
git add .
git commit -m "Legacy AI"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

If you don't have a repo yet: github.com/new → create it (empty, no
README/gitignore template) → use the URL it gives you above.

**2. Deploy on Render:**

- Go to the [Render dashboard](https://dashboard.render.com) → **New** →
  **Blueprint**.
- Connect your GitHub account if you haven't, then pick the repo you just
  pushed.
- Render reads `render.yaml` automatically and shows you the one service
  it's about to create (`legacy-ai`, Docker-based, with a 1 GB persistent
  disk). Click **Apply**.
- First deploy takes a couple of minutes (building the Docker image).
  You'll get a URL like `https://legacy-ai-xxxx.onrender.com` — that's
  your live app.

**3. Every push to `main` after this auto-deploys** — no extra steps, no
manual redeploy button. That's the "foolproof" part: edit, commit, push,
it's live.

**Cost note:** `render.yaml` is set to Render's **Starter plan (~$7/mo)**
because that's the cheapest plan that supports a persistent disk — without
one, `legacy_ai.db` gets wiped every time the service restarts or wakes
from sleep, which is a real risk for a judged demo with any gap in it. If
you'd rather not pay: open `render.yaml`, change `plan: starter` to
`plan: free`, and delete the `disk:` block. It'll still work, just with
that data-loss risk on restart/sleep (free services sleep after 15 min of
inactivity).

**Syncing the directory once it's live:** the "paste sheet data" flow
(Directory source panel on the HR dashboard) works exactly the same on the
hosted URL as it does locally — nothing about it depends on where the app
is running.

## Deploying this for real (Razorpay-internal)

I can't tell you exactly how this plugs into Razorpay's actual internal
deployment platform — that depends on infrastructure and conventions I
don't have visibility into (their container platform, CI/CD, internal auth
system, and so on). What I *can* tell you is that this was built to make
that handoff as friction-free as possible for whoever picks it up:

- It's a single Node process with **zero npm dependencies** — nothing to
  `npm install`, no native modules to compile, no version conflicts to
  chase. `node server.js` is the entire deployment step.
- A `Dockerfile` is included if Razorpay's platform deploys containers.
- The only stateful thing is one SQLite file (`server/legacy_ai.db`). For
  anything beyond a demo, that file needs to sit on a persistent volume/disk
  — an ephemeral container filesystem will lose it on redeploy. A real
  production rollout would probably swap SQLite for whatever managed
  database Razorpay standardizes on, but the `db.js` module is a single,
  isolated file specifically so that swap is contained to one place.
- Login here is **not real SSO** — it's a domain check (`@razorpay.com`) and
  an email-match check, same as the earlier version. For a real
  deployment this should go through Razorpay's actual SSO/Okta, not a
  free-text email field.
- There's no authentication on the API itself (any request to `/api/...`
  is served) — fine for a hackathon demo behind a login screen in the UI,
  not fine for production. A real deployment needs the API to check who's
  calling, not just the frontend.

## The user directory

Right now the directory is seeded once in `server/db.js` (search for
`if (isNewDb)`). To add or edit people in it before a demo, either:

- Edit that seed list and delete `legacy_ai.db` so it reseeds, or
- Insert directly with SQL, e.g.:
  ```js
  const { db } = require('./db');
  db.prepare(`INSERT INTO users (email, name, title, manager_email, q1_link, q2_link, q3_link, exp_link)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('new.person@razorpay.com', 'New Person', 'Title', 'manager@razorpay.com', null, null, null, null);
  ```

If you want a proper "Add user" screen in the UI instead of editing the
seed file, that's a contained addition I can build next — just say so.

## What's intentionally still a stub

- Only the seeded demo transition (TR-1042 / Alisha) has pre-populated
  validation items and context-capture questions. Any transition you create
  through the directory picker starts empty — there's no real parsing of
  the linked Google Docs into structured items, so faking content for a
  new employee would just be dishonest. Someone (today: the employee, via
  the validation dashboard) still has to fill those in.
- Sending email is still `mailto:` links, not an actual SMTP send — same
  reasoning as before: no credentials embedded in a page anyone can view
  source on. A real deployment should send through whatever mail
  infrastructure/service Razorpay already uses internally.
