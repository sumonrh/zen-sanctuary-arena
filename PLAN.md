# Zen Sanctuary Arena — Blind Testing Plan

## 1. Objective

Find out which AI model produced the best single-file Three.js **Zen Sanctuary**
simulation, using pairwise human preference votes. The test is blind **while
voters compare**: they see only A and B, with names, filenames, tiers, and scores
hidden. Each session is a block of five comparisons; after a block, the voter can
choose five more or stop. Stopping shows the current model ranking and thanks the
voter. The organizer page remains passphrase-protected for the full table, tiers,
confidence intervals, and exports.

**Success is observable when:**

1. `https://zen-sanctuary-arena.web.app` serves two randomly chosen simulations
   from all 80 unique submissions.
2. No model name appears in the arena URL, iframe title, visible iframe text, or
   voting UI while a round is in progress. Names are revealed only on the
   post-vote ranking screen.
3. Each vote is stored exactly once per voter and pair in Firestore.
4. The organizer page decrypts the roster only with the passphrase and reports
   Bradley–Terry ratings with 95% confidence intervals and P(rank #1), for both
   submissions and model families.
5. The existing Cozy Sanctuary site at `https://cozy-sanctuary-app-2026.web.app`
   is unchanged.
6. A voter is offered five comparisons, then a checkpoint to judge five more or
   stop; stopping shows a provisional top-12 model ranking and a thank-you.

## 2. Roster

- Source: `Tier 1`–`Tier 4` folders (Tier 5 excluded by request). 83 HTML files.
- Two files are excluded by request:
  `Tier 3/Beam free Max zen_sanctuary.html` (suspected repeat) and
  `Tier 1/Deepseek v4.1 Flash 1017 Max Zen Sanctuary OpenRouter.html`.
- SHA-256 content dedupe removes 1 exact duplicate (the two GPT 6.1 Sol Max
  files) → **80 unique submissions**.
- Every submission competes individually. Reasoning/effort variants
  (High / Max / Medium / xHigh, runs 1 and 2) remain separate contenders.
- A second, family-level ranking answers “which LLM” by grouping variants
  (e.g. all GPT 6.1 Sol settings). Same-family matchups are skipped so they
  cannot distort that ranking.
- The old `Zen Sanctuary Grading Results.xlsx` is **not** used for seeding or
  filtering: it is stale and its file paths no longer match the reorganized
  folders.
- `sims.json` exposes only an opaque 10-character submission id and an opaque
  6-character family hash. A separate public `roster.json` exposes
  id → model label and family for the post-vote ranking. Tiers, notes, and source
  paths remain only in the encrypted roster and the private build file.

## 3. Blindness protocol

- Opaque ids: `sha256("zen-arena-v1|" + relative_path).slice(0, 10)`.
  No model, tier, or filename leaks through the URL.
- Deployed copies get `<title>Zen Sanctuary</title>`, `noindex`, and a scan of
  visible text / titles / alt text / comments for model branding.
- The arena shows only **A** and **B**; the left/right assignment is a fresh coin
  flip for every ballot.
- No leaderboard, score, tier, or name is visible while a round is in progress.
  After each five-vote block, the stop screen reveals the current top-12 model
  ranking. This reveal is an explicit organizer choice.
- Simulations are embedded with `sandbox="allow-scripts allow-pointer-lock
  allow-downloads"` (deliberately **no** `allow-same-origin`). Each sim runs in an
  opaque origin, so it cannot read the arena DOM, votes, or roster. Direct sim
  links use the same sandbox via a CSP header. None of the 80 files use
  `localStorage` / `sessionStorage`, so this does not break them.
- Organizer roster: AES-256-GCM with a PBKDF2-SHA256 key (310,000 iterations).
  The passphrase is kept in `private/passphrase.txt`, never deployed. The public
  roster has only id, label, and family; the encrypted roster adds tier and note.
- **Limits:** this is a UI-level blind test, not a guarantee against someone
  reading source comments or devtools. The public roster makes the id → model
  mapping retrievable before voting, so blindness applies to the voting flow, not
  to a determined inspector. Votes are public (needed for the serverless ranking
  page), but the reveal is deliberate.

## 4. Voting protocol

- One matchup = two simulations, side by side on desktop, A/B toggle on mobile.
- Each session is a block of **five comparisons**. After the fifth, a checkpoint
  offers **Judge 5 more** or **Finish & see ranking**; the loop repeats in blocks
  of five.
- Stopping marks the session done and shows a provisional top-12 model ranking
  (Bradley–Terry point ratings, no CIs) plus a thank-you. The voter can start
  another block from that screen.
- Each model name in the stop-screen ranking links to its
  `/s/<id>.html` simulation in a new tab. The organizer table has the same links.
  Direct simulation pages carry a CSP sandbox (scripts allowed, no same-origin),
  so they cannot read the arena’s voter state or votes.
- The arena asks voters to maximize the browser window for the full scene and
  offers an expand button that gives one world the whole screen. On a phone,
  the A/B toggle switches worlds.
- Choices: **A is better** (`1`), **Too close** (`2`), **B is better** (`3`).
- “Something broke?” lets a voter record a load/usability failure; the working
  sim gets the win, or the ballot is skipped if both failed.
- Dwell time is recorded. Votes under 3 seconds are flagged in analysis.
- Within a block, the next random matchup loads immediately; results stay hidden
  until the stop screen.
- One ballot per voter per pair, enforced by document id
  `{voterUuid}__{pairKey}` and create-only rules. The voter UUID is generated in
  the browser and kept in `localStorage`; there is no account or email.
- Matchmaking: uniform random, with these constraints:
  - never the same family (avoids wasting a vote on two variants of one model);
  - never a pair this voter has already judged (while unjudged pairs remain);
  - prefers the least-exposed simulations from a random candidate pool.
- Target: **800–1,200 ballots** in the open round. 800 ballots gives each sim
  roughly 20 appearances. At five comparisons per block, that is about 160–240
  completed first blocks, or fewer sessions with multiple blocks.
- Optional finals: take the top 12 submissions, run 300–500 more ballots, stop
  when P(#1) ≥ 0.90 and each of the top 10 has ≥ 25 matches, or when the budget
  is exhausted.

## 5. Measurement

- **Bradley–Terry:** `P(i beats j) = logistic(θ_i − θ_j)`.
- Ties count as half a win each; skips are excluded; a broken sim is a loss.
- Fit by MM/Zermelo iteration with a weak L2 prior (1 pseudo-match at equal
  strength), θ centered at 0.
- Displayed as an Elo-style rating: `1500 + (400 / ln 10) × θ`.
- 95% CIs and P(#1) come from 300 bootstrap resamples of the ballots.
- The public stop screen uses the same fit with point ratings only, limited to
  the top 12. CIs, P(#1), tiers, and the full table stay on the organizer page.
- Family ranking: refit the same model over families, discarding same-family
  ballots. Also report the best variant per family.
- Report per contender: rank, rating, CI, matches, wins, losses, ties, win rate,
  P(#1), tier (organizer only), family.
- Quality checks: total ballots, unique voters, ties, skips, broken reports,
  sub-3-second votes, per-sim exposure, and connected components. If the
  comparison graph is disconnected, ratings across components are not
  comparable and this is stated on the results page.
- **Do not over-claim.** With 80 contenders and ~1,000 votes, only the top group
  is meaningfully separated. Publish CIs, not just rank order.

## 6. Data model

Firestore collection `ballots`, document id `{voter}__{pairKey}`:

```json
{
  "v": 1,
  "voter": "uuid",
  "pairKey": "aaaaaaaaaa__bbbbbbbbbb",
  "a": "aaaaaaaaaa",
  "b": "bbbbbbbbbb",
  "winner": "a | b | tie | skip",
  "broken": null,
  "dwellMs": 18240,
  "phase": 1,
  "createdAt": "<server timestamp>"
}
```

Rules: public create with strict schema validation; update/delete denied; read
public so the serverless results page can compute the ranking. No PII beyond a
random UUID.

**Known limitation:** without Cloud Functions / App Check, a determined actor
can generate multiple voter UUIDs. This is acceptable for a private-link study.
Upgrade path: Firebase App Check (reCAPTCHA v3) plus a callable function that
writes ballots.

## 7. Hosting and operations

- Firebase project: `cozy-sanctuary-app-2026` (existing Cozy Sanctuary app kept
  on its default site).
- New, separate Hosting site: `zen-sanctuary-arena` →
  `https://zen-sanctuary-arena.web.app`.
- Firestore database: `(default)`, `asia-south1` (Mumbai).
- Deploy: `firebase deploy --only "hosting:zen-arena,firestore:rules"`.
- Never deploy the default site from this repo; the target `zen-arena` is pinned
  in `.firebaserc`.
- Passphrase rotation: edit `private/passphrase.txt`, run
  `node scripts/build.mjs`, redeploy Hosting. Existing votes stay valid.
- Close-out: stop sharing the link, export CSV/JSON from the organizer page,
  verify no test ballots remain, publish the full ranking (model names are
  already revealed on the stop screen by design), and keep the private build
  roster/plaintext details.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| 80 contenders, too few votes | Report CIs; target 1,000; optional top-12 finals |
| Self-promotion / repeat voting | One ballot per voter-pair; dwell filter; inspect duplicate patterns |
| Two heavy WebGL sims at once | Mobile A/B toggle, per-panel reload, fullscreen focus, “Something broke?” |
| CDN blocked (jsdelivr, unpkg, Tailwind, fonts) | Broken-sim reporting; votes still recorded |
| Model attribution errors | Manual roster is the single source of truth and is validated at build time |
| Voter sees names in a sim's own UI | Title rewrite + visible-text scan before deploy |
| Post-vote reveal / public roster | Accepted tradeoff: names show only on the stop screen, but `/data/roster.json` is public |
| Live ranking reads all ballots per stop | Ranking fetched only when a voter stops; monitor Firestore free-tier reads |
| Router/privacy leakage | No accounts, no emails; only a random UUID |
