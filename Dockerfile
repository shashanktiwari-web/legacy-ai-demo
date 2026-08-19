# Legacy AI — deployable container
#
# Zero npm dependencies: the app only uses Node's own built-in modules
# (http, node:sqlite, fs, path, url), so this image just needs a Node
# runtime new enough to have node:sqlite (22.5+) — no `npm install` step,
# nothing to compile.

FROM node:22-slim

WORKDIR /app

# Frontend pages sit one level above /app/server (server.js resolves
# static files as ../ from its own location) — copy the whole project.
COPY . .

WORKDIR /app/server

EXPOSE 3000
ENV PORT=3000

# legacy_ai.db is created and seeded automatically on first boot if it
# doesn't already exist — mount a volume at /app/server if you want the
# database to survive container restarts/redeploys.
CMD ["node", "server.js"]
