# VECTOR LAB

A 2D top-down physics puzzle game. You never move the objects: you place force generators
(attractors, repulsors, vortices, directional fields), press Run, and a real fixed-timestep
simulation decides what happens.

Version 2 adds an online layer: one shared daily challenge for everyone, an AI challenge
designer behind strict validation, server-verified scores and leaderboards, accounts with
cloud progress, and shareable replays. The game still runs with no backend at all (guest,
offline, or when the server or the AI is down).

Stack: React 18, TypeScript, HTML Canvas, Vite. Backend: PostgreSQL (Supabase), one Supabase
Edge Function, Supabase Auth, and the Claude API for challenge design.

## Run it

```bash
npm install
npm run dev              # the game, offline build, http://localhost:5173
npm test                 # 95 tests; the backend suite needs a local Postgres (see below)
npm run build            # type-check + production build in dist/
SINGLE=1 npx vite build  # one self-contained dist/index.html (offline build)
```

Full online stack on your machine, with no Supabase project and no API key:

```bash
createdb vectorlab_test                              # any local Postgres 14+
export DATABASE_URL=postgres://USER:PASS@127.0.0.1:5432/vectorlab_test
npm run db:local                                     # schema + a stub of Supabase's auth schema
npm run dev:api                                      # API on http://localhost:8787
VITE_API_URL=http://localhost:8787 npm run dev       # the game, talking to it
curl -X POST localhost:8787/cron/publish -H 'x-cron-secret: dev-cron-secret' -H 'content-type: application/json' -d '{}'
```

In this mode sign-in is a "dev login" (type a name, get a throwaway account). Tests use
`TEST_DATABASE_URL` (default `postgres://vl:vl@127.0.0.1:5432/vectorlab_test`) and **drop and
recreate the `public` and `auth` schemas** of that database, so point them at a scratch
database only.

Node 20+.

## What is implemented, and how it was verified

Everything in this list works and is covered by automated tests or scripted browser runs.
"Verified locally" means against a real PostgreSQL 16 with the production migration, the real
API handler, and the Edge Function bundle running under Deno. It does **not** mean against a
live Supabase project or the live Claude API: neither was available where this was built.
See "Needs configuration" for exactly what that leaves.

| Area | What works | How verified |
|---|---|---|
| Shared daily | One published row per UTC date holding the exact level JSON. Everyone, guests included, gets identical data. Published once (primary key + advisory lock), can be generated days ahead, future dates are not served. If nothing was published, the first request publishes the procedural challenge. | `tests/server.test.ts`, two-browser run |
| AI designer | Server-side call to the Claude API with a structured-output schema. Output is treated as untrusted: strict validation, difficulty check, similarity check, generator, solver. Invalid, repetitive or unsolvable candidates are rejected with a logged reason; any failure falls back to the procedural designer. | Tested with scripted model responses (valid, malformed, code-bearing, repetitive, garbage, timeout). The live API call itself is **untested** (no key). |
| Similarity | Deterministic level signature: template, objective, skill, tools, modifiers, object count, difficulty, obstacle counts, 10x6 occupancy grid, start/target positions, route tortuosity, solver's generator types. Mirror-invariant. Compared with the last 14 published levels; limit 0.76. | `tests/online.test.ts`, `tests/server.test.ts` |
| Scores | Client sends only its generators. Server checks them against the level rules, re-simulates at the fixed timestep and computes the score itself. Duplicates are ignored, submissions are rate limited (20/min), future dates refused. | `tests/server.test.ts` |
| Leaderboards | Global daily, friends, weekly, all-time; highest score, fastest, lowest energy. One row per player per day. | `tests/server.test.ts`, browser run |
| Replays | Every verified solution is stored (generators, sim config, result). Watch your own, watch a leaderboard row, open a shared link, compare two solutions side by side (ghost run). Today's solutions are locked until you have solved today. | `tests/server.test.ts`, browser run |
| Accounts | Guest play needs no account. Signing in moves guest progress into the account and posts today's waiting score. Unlimited progress, statistics, unlocks, streak and daily results sync across devices, forward-only. | `tests/server.test.ts`, browser run (second device) |
| Unlimited | Highest level, best run score, longest run, unlocks, cosmetics. Levels stack 2 modifiers from level 13 and 3 from level 24. Daily tools never depend on unlocks. | `tests/online.test.ts`, `tests/modes.test.ts` |
| Sharing | Score card image (challenge number, score, rank, time, solution preview), copyable text result, replay link, public profiles, friend codes. | browser run |
| Ad hooks | Menu banner slot, between-levels interstitial hook, optional rewarded hook for cosmetics. No ad script is loaded and nothing renders unless a provider is registered. Ads are refused while a simulation runs. | `tests/online.test.ts` |
| Resilience | Server down: cached published level, else the deterministic local generator; scores stay local and the UI says so. AI down: procedural designer. | browser run with the API killed |
| Determinism | Physics uses its own sine/cosine (`src/core/dmath.ts`) so a solution replays to the same result in every JS engine and on the server. | `tests/physics.test.ts` |

## Needs configuration (not done, cannot be done from code)

1. **A Supabase project.** None exists yet. Until one is created and the three steps under
   "Deploy" are run, the hosted game is the offline build.
2. **Email sign-in.** Uses Supabase Auth passwordless email (`src/services/auth.ts`,
   `SupabaseAuth`). The code follows the supabase-js API but has never run against a live
   project. The server side of auth (`SupabaseAuthenticator`, which asks Supabase who a token
   belongs to) was tested against a local mock of that endpoint only. Expect to check this
   first after deploying. To have the email contain a typed code as well as a link, add
   `{{ .Token }}` to the Magic Link template in Supabase (Authentication > Emails).
3. **Anthropic API key** for the AI designer (`ANTHROPIC_API_KEY`, server secret). Without it
   every daily is procedurally designed. The request shape type-checks against the official
   SDK but has not been sent to the live API.
4. **A schedule** for publishing (Supabase cron or the included GitHub Action). Without one
   the game still works: the first visitor of the day triggers a procedural publish.
5. **An ad provider**, if you ever want ads. None is included.

## Known limits (by design, stated plainly)

- **Unlimited records are not server-verified.** They are personal progress synced
  forward-only and are not ranked. Only daily scores are re-simulated and ranked.
- **Shared Unlimited replays** are verified against the level the client uploads, so they
  prove "this solution solves this arena", not that the arena came from the generator.
- **Copying a top solution** after watching it is possible once you have solved the day
  yourself. Exact duplicates of your own submissions are ignored; near-copies are not detected.
- **Read endpoints are not rate limited** in the API (rely on Supabase's platform limits or
  put a CDN in front). Write endpoints are.
- **Friends are one-directional** (you add a code and that player appears on your board).
- **Edge Function CPU time.** Generating and solving a level takes roughly 0.01 to 1.2 s of
  CPU here, and the AI path may evaluate several candidates. If your Supabase plan's CPU
  limit is too tight for `/cron/publish`, use the GitHub Action (`npm run publish:daily`),
  which has no such limit.
- **Offline builds** (no backend configured, including the single-file build and the hosted
  preview) show a demo leaderboard, with every simulated row labelled DEMO.
- The local stand-in for the model in tests is a scripted response, and "dev login" exists
  only on the local dev server; neither ships in the Edge Function.

## Environment variables

Frontend (public, baked into the bundle; safe to expose):

| Variable | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL. Enables online mode. |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon (public) key. |
| `VITE_API_URL` | Optional API override; default `<VITE_SUPABASE_URL>/functions/v1/api`. Use `http://localhost:8787` for local dev. |
| `VITE_ADS_PROVIDER` | Optional. `placeholder` draws labelled boxes for layout tests. |

Server (secrets; never in frontend code):

| Variable | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_DB_URL`, and `SUPABASE_ANON_KEY` or `SUPABASE_PUBLISHABLE_KEYS` | Injected into Edge Functions by Supabase automatically. |
| `PUBLIC_API_KEY` | Optional. Your publishable (or anon) key, needed only if the function log says it is missing. |
| `ANTHROPIC_API_KEY` | Enables the AI designer. Used by the CLI / GitHub Action publisher only; the Edge Function does not include the SDK and always publishes procedurally. |
| `AI_DESIGNER_MODEL` | Optional; default `claude-opus-5-5`. |
| `CRON_SECRET` | Required by `POST /cron/publish`. |
| `ALLOWED_ORIGIN` | Optional CORS restriction to your site. |
| `DATABASE_URL` | For `npm run publish:daily`, GitHub Actions and local dev. |

The service-role key is not used anywhere. The frontend contains no private key: the API key
and database URL exist only in the server environment, and Row Level Security gives the anon
key no write access to any table.

## How the AI pipeline works

```
recent published challenges ─┐
vocabulary, difficulty scale ├─> prompt ──> Claude (JSON schema output) ──> raw candidates (untrusted)
examples, variety rules ─────┘                                                   │
        for each candidate, in order:                                            ▼
        1. validateSpecStrict      unknown field / id / range / text  ──> reject
        2. difficulty within 1 of the day's target                    ──> reject
        3. design similarity vs recent (signature.ts, limit 0.62)     ──> reject
        4. generateLevel: up to 7 candidate layouts, each must pass
           structural validation, must not solve itself, and must be
           solved by the search solver with exactly the promised tools ──> reject
        5. level similarity vs last 14 published (limit 0.76)          ──> reject
        first candidate to pass all five is published (source = "ai")
        none passes, or the API errors, refuses or times out:
        procedural designer (same five checks; least-similar verified level as a last resort)
```

- The model returns only ids, small integers and two short strings. It never supplies
  coordinates, geometry or code, and the seed is assigned by the server.
- Title and concept must match a plain-text character whitelist.
- Every decision is stored in `challenge_metadata.pipeline` for the published day.
- Code: `server/ai.ts` (prompt, schema, SDK call), `server/publish.ts` (the gate),
  `src/gen/spec.ts` (`validateSpecStrict`), `src/gen/levelSignature.ts`.

## How daily challenges are published

- `publishDaily(sql, date)` in `server/publish.ts` is the only writer of `daily_challenges`.
  It is idempotent and safe to run concurrently.
- `POST /cron/publish` (header `x-cron-secret`) publishes today if missing and tomorrow, so
  tomorrow exists about twelve hours ahead when run at 12:00 UTC. Body options:
  `{"date":"YYYY-MM-DD","days":1-7,"useAI":false}`.
- `GET /daily` never returns a future date. Row Level Security hides future rows from the anon
  key too.
- The day changes at 00:00 UTC for everyone when online (offline builds use local midnight).
- Safety net: if nothing was published, the first `GET /daily` of the day publishes the
  procedural challenge immediately.

## How scores are validated

1. `POST /scores` requires a signed-in user and accepts `{date, devices}`. Any score, time or
   energy in the body is ignored.
2. The level is loaded from the database by date (never from the client).
3. `sanitizeDevices` (`src/game/verify.ts`): device count, per-type tool limits, positions
   inside the arena, strength within the level's cap, range limits, finite numbers, spin.
4. `runHeadless` re-simulates at the fixed 1/120 s timestep; the run must succeed.
5. `computeScore` produces the score from the simulated time, energy and device count.
6. In one transaction, serialised per player and day: duplicate check (hash of the
   solution), replay stored, leaderboard row upserted (best score, best time, lowest energy,
   each pointing at its replay), streak updated on the server.

## Deploy

1. **Database.** Create a Supabase project. Run `supabase/migrations/0001_init.sql` in the SQL
   editor, or `supabase link --project-ref <ref> && supabase db push`.
2. **API.**
   ```bash
   npm install && npm run build:edge          # writes supabase/functions/api/server.bundle.js
   supabase secrets set CRON_SECRET=<long-random> ALLOWED_ORIGIN=https://your.site
   supabase functions deploy api              # supabase/config.toml disables platform JWT checks for it
   curl https://<ref>.supabase.co/functions/v1/api/health
   ```
3. **Schedule.** Either run `supabase/cron.example.sql` (fill in the two placeholders) or add
   `DATABASE_URL` and `ANTHROPIC_API_KEY` as GitHub repository secrets for
   `.github/workflows/publish-daily.yml`.
4. **Auth.** In Supabase: Authentication > URL Configuration, set the Site URL and add your
   site to Redirect URLs. Email provider is on by default.
5. **Frontend.** Build with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set and host
   `dist/` on any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages).
6. **Check.** Open the site in two browsers: same daily title, sign in, submit, see both
   rows on the leaderboard.

## API

`GET /health` · `GET /daily?date=` · `POST /cron/publish` · `POST /scores` ·
`GET /leaderboard?scope=daily|friends|weekly|alltime&metric=score|time|energy&date=` ·
`GET /replay?id=` · `GET|POST /replays` · `GET|POST /me` · `POST /sync` ·
`GET|POST|DELETE /friends` · `GET /profile?id=` · `POST /dev/login` (dev server only).

## Architecture

```
server/                  BACKEND, runtime-agnostic (Request -> Response). Runs on Deno and Node.
  api.ts                 every route: daily, scores, leaderboards, replays, sync, friends, profiles
  publish.ts             the daily pipeline and its validation gate
  ai.ts                  Claude API client, prompt, output schema
  auth.ts                Supabase token verification; dev tokens for local use
  dev-server.ts          local Node server; scripts/publish.ts: CLI publisher
supabase/
  migrations/0001_init.sql   tables, indexes, Row Level Security
  functions/api/index.ts     Edge Function entry (imports the bundled server)
src/services/            backend.ts (HTTP), auth.ts, online.ts (accounts, sync, submission), ads.ts
src/game/verify.ts       solution checks + re-simulation, shared by server and client
src/gen/levelSignature.ts  level-level similarity
```

The game itself (unchanged in structure from v1):

```
src/
  core/rng.ts            seeded PRNG (mulberry32) + string hashing
  physics/               ENGINE. No DOM, no React, no randomness.
    types.ts             plain-data scene, body, device definitions, fixed DT (1/120 s)
    forces.ts            force laws for the four generators
    simulation.ts        semi-implicit Euler integrator, collisions, zones, hazards, energy
  game/                  GAME LOGIC on top of the engine
    level.ts             Level format (serialisable JSON)
    objectives.ts        ObjectiveTracker: deliver / collect / sync / survive, fail reasons
    scoring.ts           normalised 0..100,000 score
    runner.ts            headless run (solver, tests, replay verification)
    controller.ts        edit/run/pause/reset state machine for one play session
    tutorial.ts          hand-built tutorial level and coach text
  gen/                   PROCEDURAL GENERATION
    spec.ts              ChallengeSpec (the designer -> generator contract) + validateSpec
    templates.ts         10 challenge templates + 12 modifiers -> candidate layout
    validate.ts          bounds, overlaps, objective logic, BFS reachability
    solver.ts            search solver that proves a candidate is beatable with the given tools
    signature.ts         structural signature + gameplay similarity for anti-repetition
    generator.ts         spec -> candidates -> validate -> reject trivial -> solve -> Level
  ai/
    designer.ts          ChallengeDesigner interface; RuleBasedDesigner (active),
                         MockAIDesigner (tests). The AI designer itself is server-side: server/ai.ts
    sampleSpec.json      sample structured challenge specification
  modes/
    daily.ts             date -> seed -> spec -> level, local DailyProvider, UTC/local day handling, streaks
    unlimited.ts         run state, per-level specs, banking, advancing
    progression.ts       unlock track (tools, challenge types, modifiers, skins)
  services/
    storage.ts           KeyValueStore abstraction + ProfileStore (localStorage)
    leaderboard.ts       LeaderboardService interface, LocalLeaderboard (demo rows flagged),
                         SupabaseLeaderboard (skeleton)
    audio.ts             tiny WebAudio synth
  render/renderer.ts     canvas drawing; reads controller state, never mutates it
  ui/                    React screens and components
tests/                   vitest suites
```

Data flow: **designer -> ChallengeSpec (JSON) -> generator -> Level (JSON) -> Simulation +
ObjectiveTracker -> score**. Each arrow is a plain-data boundary, so any stage can be replaced
(an AI designer, a server-published daily, a server-side score verifier).

### Physics

- Fixed timestep of 1/120 s. The frame loop accumulates real time times the viewing speed and
  runs whole steps, so results are identical at any refresh rate or speed setting.
- Semi-implicit Euler: `a = F_net / m`, `v += a*dt`, drag, `x += v*dt`.
- Circle vs box (static, moving, gates), circle vs bumper, circle vs circle with mass-weighted
  impulses, arena bounds, speed cap chosen so nothing tunnels through the thinnest wall.
- Moving parts use a triangle wave rather than `sin`, to keep results identical across engines.
- Energy = sum of `|F_device| * |v| * dt`: the work budget your generators spend.

### Scoring

`40,000` completion + `25,000 / (1 + (t/par)^2)` speed + `15,000` device efficiency +
`20,000 / (1 + E/parE)` energy. All inputs are simulated quantities, so fast-forward gains nothing.

### Anti-repetition

Every spec has a structural signature (template, required interaction, objective, tool kit,
modifiers, object count). The designer proposes several concepts and keeps the one least similar
to the last 8 signatures; two levels with the same structure count as similar no matter where
their coordinates fall. The daily schedule also walks a seeded shuffle of all 10 templates, so
no challenge type repeats inside a 10-day cycle.
