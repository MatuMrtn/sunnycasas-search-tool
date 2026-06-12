# Sunny Casas Search Engine

Locked-in property search sessions for agents, synced two-way with GoHighLevel.

Each client search becomes a **session**: a guided, locked walk through the portal list
(SunnyCasas.com → Inmovilla → Idealista → …) with criteria pulled from GHL and everything
written back on completion — a note with the full portal log, the SE tracking fields, an
automatic stage move to *Awaiting Feedback*, a follow-up task, and parking-lot items as tasks.

---

## 1. Try it in 2 minutes (demo mode, no GHL token)

Requires Node.js 18+ (https://nodejs.org).

```bash
cd sunnycasas-search-engine
npm install
GHL_MOCK=1 node server.js
```

Open http://localhost:3000 — sign in as **Karl**, password **demo**.
Demo mode serves sample clients and prints would-be GHL writes to the console instead of sending them.

## 2. Go live

### a) Create the GHL Private Integration token
In GoHighLevel: **Settings → Private Integrations → New Integration**.
Grant these scopes:

- contacts.readonly, contacts.write
- opportunities.readonly, opportunities.write
- locations.readonly, locations/customFields.readonly, locations/customFields.write
- users.readonly (matches each agent to their GHL user for ownership filtering)

Copy the `pit-…` token.

### b) Configure
```bash
cp .env.example .env
```
Edit `.env`: paste `GHL_TOKEN`, set `COOKIE_SECRET` (any long random string), and list your
agents in `AGENTS` as `Name:email:password` — each agent has their own password and sees only
the opportunities assigned to them in GHL. The location, pipeline and stage IDs are already
set to the Sunny Casas account.

### c) Run
```bash
npm install
node server.js
```

On first run the app checks GHL and **creates five opportunity custom fields** if missing:
*SE Last Search Date, SE Search Round, SE Portals Covered, SE Shortlist Link, SE Search Feedback.*

### d) Deploy (pick one)

**Railway / Render (easiest).** Create a new project from this folder (push it to a private
GitHub repo first). Set the environment variables from your `.env` in the dashboard.
Add a persistent volume mounted at `/data` and set `DB_FILE=/data/search-engine.db`.

**Any VPS (€5/mo).**
```bash
npm install -g pm2
pm2 start server.js --name search-engine
pm2 save && pm2 startup
```
Put Nginx or Caddy in front for HTTPS (e.g. `search.sunnycasas.com`).

> The app must be reachable only by your team — it has login, but don't expose it without HTTPS.

## 3. How it maps to GHL

| App concept | GHL |
|---|---|
| Queue | Open opportunities in *Active Property Search* + *Long-Term Property Search* (Sales Pipeline), **assigned to the signed-in agent** (matched by email to their GHL user; set `SHOW_UNASSIGNED=1` to also show ownerless ones) |
| Client criteria | Budget Min/Max, Search Areas, Min Bedrooms/Bathrooms, Property Status Wanted, Buying Timeline, Client Arriving, Preferred Contact Method, Lead Temperature, Priority Score |
| Session wrap-up | Note on contact + SE fields + stage move (if shortlist starred) + follow-up task |
| Parking-lot items | Tasks on the contact, due next day |

Aging (the 24 h amber / 48 h red markers) uses *SE Last Search Date*; before the first synced
session it falls back to the app's own log.

## 4. Customising

- **Portal order, notes, deep-link templates, time targets:** edit the `portals` array in
  `src/config.js`. URL templates accept `{minPrice}`, `{maxPrice}`, `{beds}`, `{q}`.
- **Follow-up delay:** `FOLLOW_UP_DAYS` in `.env`.
- **Stage auto-move:** `AUTO_STAGE_MOVE=0` to disable.
- **Agents:** `AGENTS=Name:email:password,Name2:email2:password2` in `.env` (append a GHL user
  id as a 4th part if the login email differs from the GHL user email).

## 5. Files

```
server.js          Express app: auth, queue, sessions, wrap-up sync
src/config.js      All IDs and settings (pipeline/stage/field IDs preset to your account)
src/ghl.js         GoHighLevel API v2 client (verified endpoint shapes, retry + rate-limit aware)
src/db.js          SQLite schema (sessions, steps, candidates, parking, cross-tags)
src/mock.js        Demo-mode fixtures
public/            Frontend (DM Sans + Sunny Casas brand tokens from sunnycasas.com)
data/              SQLite database (created at runtime — back this up)
```

## 6. Troubleshooting

- **"Could not load queue"** — check `GHL_TOKEN` and that the Private Integration has the
  opportunities scopes; restart after fixing.
- **Stage never moves** — the move happens only when at least one property is starred in wrap-up
  (and `AUTO_STAGE_MOVE=1`).
- **Boot warning about custom fields** — token lacks `locations/customFields.write`; either add
  the scope or create the five SE fields manually (any names containing the same words work,
  the app matches by name).
- **"Cannot match you to a GoHighLevel user"** — the agent's login email doesn't match any GHL
  user email. Either fix the email in `AGENTS`, or append the GHL user id explicitly
  (`Name:email:GHL_USER_ID`), and make sure the token has `users.readonly`.
- **Queue is empty but GHL has searches** — check the opportunities are *assigned* to the agent
  in GHL (Owner field on the opportunity). Unassigned ones are hidden unless `SHOW_UNASSIGNED=1`.
