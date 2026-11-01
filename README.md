# Zen Sanctuary Arena

A blind pairwise comparison of **80 single-file Three.js Zen Sanctuary
simulations**, built by different AI models. Voters see two unlabeled worlds at
a time, judge five comparisons, then can continue in blocks of five or stop and
see the current model ranking.

**Live arena:** https://zen-sanctuary-arena.web.app  
**Organizer results:** https://zen-sanctuary-arena.web.app/results.html

The organizer passphrase is **not** in this repository. The `private/` folder is
gitignored; the committed `public/data/roster.locked.json` is the encrypted
roster used by the live organizer page.

## How it works

- Two randomly chosen simulations are shown as **A** and **B**, with model names
  hidden during the round.
- A session is **five comparisons**. After five, a checkpoint offers
  **Judge 5 more** or **Finish & see ranking**.
- Stopping shows a provisional top-12 model ranking and a thank-you. Model names
  there link to the full simulation in a new tab.
- Votes are anonymous pairwise ballots in Firestore. One browser can vote once
  per pair. The ranking uses a Bradley–Terry model; the organizer page adds
  bootstrap confidence intervals, tiers, and CSV/JSON export.

## Repository layout

```
public/                 deployable Firebase Hosting root
  index.html            arena / intro / checkpoint / stop ranking
  results.html          passphrase-gated organizer results
  js/arena.js           voting, five-vote blocks, public stop ranking
  js/results.js         organizer decrypt + full ranking
  js/ranking.js         Bradley–Terry fit + bootstrap helpers
  data/sims.json        opaque simulation ids + family hashes
  data/roster.json      public id -> model label/family (stop-screen ranking)
  data/roster.locked.json  AES-256-GCM roster for the organizer page
  s/<id>.html           sanitized simulation copies
Tier 1/ ... Tier 4/     original single-file submissions used by the test
Tier 5/                 original submissions; excluded from the test roster
scripts/build.mjs       validates the roster, dedupes, sanitizes, encrypts
firestore.rules         append-only ballots; public read for the ranking
firebase.json           Hosting headers + deploy config
PLAN.md                 full blind-testing methodology and decisions
```

The two grading workbooks (`*.xlsx`) are kept local and are not required to
build or deploy the site.

## Build

Building rewrites `public/s/`, `public/data/*`, and the encrypted roster. It
requires the private passphrase file:

```bash
# create private/passphrase.txt with your organizer passphrase first
node scripts/build.mjs --strict
```

The build:

- includes Tier 1–4 only; Tier 5 is excluded;
- excludes `Tier 3/Beam free Max zen_sanctuary.html` and
  `Tier 1/Deepseek v4.1 Flash 1017 Max Zen Sanctuary OpenRouter.html` by request;
- removes the exact duplicate GPT 6.1 Sol Max file;
- sanitizes visible model branding and writes the public/encrypted rosters.

The committed `public/` output means you can deploy the site without the private
passphrase.

## Deploy

```bash
firebase deploy --only "hosting:zen-arena,firestore:rules" \
  --project cozy-sanctuary-app-2026
```

The Firebase project also hosts the original Cozy Sanctuary app on its default
site; this repo targets only the separate `zen-sanctuary-arena` Hosting site.

## Test-data and blindness notes

- Model names are hidden during voting. As an explicit choice, the stop screen
  reveals the current ranking, and `public/data/roster.json` is public. Blindness
  is therefore enforced by the voting UI, not by a secret mapping.
- Ballots contain only opaque simulation ids, a random voter UUID, the winner,
  dwell time, and a server timestamp. No accounts or emails.
- Firestore rules allow ballot creation with schema validation, deny updates and
  deletes, and allow public reads so the ranking can be computed without a
  server.
- Direct simulation links carry a CSP sandbox (no same-origin), so an opened
  simulation cannot read the arena’s voter state.

See [PLAN.md](PLAN.md) for the full protocol, statistics, and caveats.
