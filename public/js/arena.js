import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  getDocs,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js";
import { firebaseConfig, BALLOT_COLLECTION } from "./firebase-config.js";
import { fitBT, eloFromTheta } from "./ranking.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const MAX_BLOCK = 5;

const LS = {
  voter: "zen.voter.v1",
  voted: "zen.voted.v1",
  exposure: "zen.exposure.v1",
  count: "zen.count.v1",
  intro: "zen.intro.v1",
  session: "zen.session.v1",
};

const state = {
  sims: [],
  byId: new Map(),
  voter: "",
  current: null,
  busy: false,
  readyAt: 0,
  timer: null,
  pending: null,
  lastPairKey: null,
  simsPromise: null,
  advanceTimer: null,
  session: null,
  rankingBusy: false,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

/* ---------------- storage ---------------- */

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: keep going without persistence */
  }
}

function randomHex(bytes = 16) {
  try {
    return [...crypto.getRandomValues(new Uint8Array(bytes))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return Array.from({ length: bytes * 2 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  }
}

function getVoter() {
  let voter = null;
  try { voter = localStorage.getItem(LS.voter); } catch { /* ignore */ }
  if (!voter) {
    voter = (crypto.randomUUID && crypto.randomUUID()) || randomHex(16);
    try { localStorage.setItem(LS.voter, voter); } catch { /* ignore */ }
  }
  return voter;
}

function readSession() {
  const raw = readJSON(LS.session, null);
  if (!raw || typeof raw !== "object") {
    return { block: 0, total: 0, round: 1, done: false };
  }
  return {
    block: Math.min(MAX_BLOCK, Math.max(0, Number(raw.block) || 0)),
    total: Math.max(0, Number(raw.total) || 0),
    round: Math.max(1, Number(raw.round) || 1),
    done: Boolean(raw.done),
  };
}

function saveSession() {
  if (state.session) writeJSON(LS.session, state.session);
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/* ---------------- data ---------------- */

async function loadSims() {
  const response = await fetch("/data/sims.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load the simulation roster.");
  const data = await response.json();
  if (!Array.isArray(data.sims) || data.sims.length < 2) throw new Error("The roster is empty.");
  state.sims = data.sims;
  state.byId = new Map(data.sims.map((s) => [s.id, s]));
  $("#sim-count").textContent = String(data.count);
  $("#intro-count").textContent = String(data.count);
  const footerCount = $("#footer-count");
  if (footerCount) footerCount.textContent = String(data.count);
}

function pairKey(a, b) {
  return a < b ? `${a}__${b}` : `${b}__${a}`;
}

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickPair() {
  const ids = state.sims.map((s) => s.id);
  if (ids.length < 2) return null;

  const exposures = readJSON(LS.exposure, {});
  const voted = new Set(readJSON(LS.voted, []));
  const score = (id) => (Number(exposures[id]) || 0) + Math.random() * 0.75;

  const aPool = shuffle(ids).slice(0, 40).sort((x, y) => score(x) - score(y));
  const a = aPool[Math.floor(Math.random() * Math.min(6, aPool.length))];

  const eligible = (allowRepeat) => ids.filter((id) => {
    if (id === a) return false;
    if (state.byId.get(id)?.g === state.byId.get(a)?.g) return false;
    const key = pairKey(a, id);
    if (key === state.lastPairKey) return false;
    if (!allowRepeat && voted.has(key)) return false;
    return true;
  });

  let pool = eligible(false);
  if (!pool.length) pool = eligible(true);
  if (!pool.length) pool = ids.filter((id) => id !== a && pairKey(a, id) !== state.lastPairKey);
  if (!pool.length) pool = ids.filter((id) => id !== a);
  if (!pool.length) return null;

  const bPool = shuffle(pool).slice(0, 40).sort((x, y) => score(x) - score(y));
  const b = bPool[Math.floor(Math.random() * Math.min(12, bPool.length))];
  return a && b && a !== b ? [a, b] : null;
}

/* ---------------- rendering ---------------- */

function startArena() {
  if (state.sims.length < 2) return;
  $("#intro").hidden = true;
  $("#finished").hidden = true;
  $("#ranking").hidden = true;
  $("#arena").hidden = false;
  writeJSON(LS.intro, true);
  window.scrollTo(0, 0);
  loadNext();
}

function loadNext() {
  clearTimeout(state.advanceTimer);
  const pair = pickPair();
  if (!pair) {
    $("#arena").hidden = true;
    $("#finished").hidden = false;
    return;
  }

  const [x, y] = pair;
  const [left, right] = Math.random() < 0.5 ? [x, y] : [y, x];
  state.current = {
    a: left,
    b: right,
    pairKey: pairKey(left, right),
    startedAt: Date.now(),
    loaded: { a: false, b: false },
    submitted: false,
  };
  state.pending = null;
  state.busy = false;
  state.readyAt = Date.now() + 2000;

  hideError();
  $("#pair-state").textContent = "Take your time";
  $("#vote-status").textContent = "Look for a moment. Then choose.";
  $("#dwell").textContent = "0:00";
  $("#match-number").textContent = `Matchup ${(Number(readJSON(LS.count, 0)) || 0) + 1}`;
  setStageView("a");
  mountFrame("a", left);
  mountFrame("b", right);
  startClock();
  window.scrollTo(0, 0);
}

function mountFrame(side, id) {
  const wrap = $(`#frame-${side}`);
  const panel = $(`#panel-${side}`);
  if (!wrap || !panel) return;

  panel.classList.remove("is-loaded");
  wrap.replaceChildren();

  const loading = document.createElement("div");
  loading.className = "panel-loading";
  loading.innerHTML = `<span class="loading-mark" aria-hidden="true"></span><span>Preparing world ${side.toUpperCase()}</span>`;

  const frame = document.createElement("iframe");
  frame.className = "sim-frame";
  frame.title = `Sanctuary ${side.toUpperCase()}`;
  frame.setAttribute("sandbox", "allow-scripts allow-pointer-lock allow-downloads");
  frame.setAttribute("allow", "autoplay; fullscreen; gamepad");
  frame.referrerPolicy = "no-referrer";
  frame.src = `/s/${encodeURIComponent(id)}.html`;

  frame.addEventListener("load", () => {
    if (!frame.isConnected) return;
    if (state.current?.a === id || state.current?.b === id) {
      panel.classList.add("is-loaded");
      state.current.loaded[side] = true;
    }
  }, { once: true });

  wrap.append(frame, loading);
  window.setTimeout(() => {
    if (!panel.classList.contains("is-loaded") && loading.isConnected) {
      const label = loading.querySelector("span:last-child");
      if (label) label.textContent = "Still loading — you can report it";
    }
  }, 12000);
}

function startClock() {
  clearInterval(state.timer);
  state.timer = window.setInterval(() => {
    if (!state.current) return;
    const seconds = Math.max(0, Math.floor((Date.now() - state.current.startedAt) / 1000));
    $("#dwell").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    if (!state.busy && Date.now() >= state.readyAt && $("#pair-state").textContent === "Take your time") {
      $("#pair-state").textContent = "Choose when ready";
    }
    updateVoteButtons();
  }, 500);
}

function setStageView(side) {
  $("#stage").dataset.view = side;
  $$("#side-toggle button").forEach((button) => {
    const active = button.dataset.show === side;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function updateVoteButtons() {
  const enabled = Boolean(state.current) && !state.busy &&
    !state.current.submitted && Date.now() >= state.readyAt;
  $$(".vote-btn").forEach((button) => { button.disabled = !enabled; });
}

/* ---------------- voting ---------------- */

function voteOutcome(kind, brokenSide) {
  if (kind === "a" || kind === "b" || kind === "tie") {
    return { winner: kind, broken: null };
  }
  if (brokenSide === "a") return { winner: "b", broken: state.current.a };
  if (brokenSide === "b") return { winner: "a", broken: state.current.b };
  return { winner: "skip", broken: "both" };
}

function castVote(kind, brokenSide = null) {
  if (!state.current || state.busy || state.current.submitted) return;
  if (Date.now() < state.readyAt) return;
  state.pending = { kind, brokenSide };
  submitBallot();
}

async function submitBallot() {
  if (!state.current || state.busy || !state.pending) return;
  const { a, b, pairKey: key, startedAt } = state.current;
  const { kind, brokenSide } = state.pending;
  const outcome = voteOutcome(kind, brokenSide);

  state.busy = true;
  updateVoteButtons();
  hideError();
  $("#vote-status").textContent = "Recording your choice…";

  const data = {
    v: 1,
    voter: state.voter,
    pairKey: key,
    a,
    b,
    winner: outcome.winner,
    broken: outcome.broken,
    dwellMs: Math.min(7200000, Math.max(0, Date.now() - startedAt)),
    phase: 1,
    createdAt: serverTimestamp(),
  };

  const reference = doc(db, BALLOT_COLLECTION, `${state.voter}__${key}`);
  try {
    await withTimeout(setDoc(reference, data), 15000);
    recordSuccess();
  } catch (error) {
    console.warn("Ballot write failed", error);
    if (error?.code === "permission-denied") {
      const exists = await getDoc(reference).then((snap) => snap.exists()).catch(() => false);
      if (exists) { recordSuccess(); return; }
    }
    state.busy = false;
    updateVoteButtons();
    $("#vote-status").textContent = "Not saved yet. Your pair is still here.";
    showError(error?.code === "timeout"
      ? "The vote server is slow to answer. Try again — nothing is lost."
      : "The vote could not be saved. Check your connection and try again.");
  }
}

function recordSuccess() {
  if (!state.current || state.current.submitted) return;
  state.current.submitted = true;
  state.busy = true;
  state.lastPairKey = state.current.pairKey;

  const voted = readJSON(LS.voted, []);
  voted.push(state.current.pairKey);
  writeJSON(LS.voted, voted.slice(-4000));

  const exposures = readJSON(LS.exposure, {});
  exposures[state.current.a] = (Number(exposures[state.current.a]) || 0) + 1;
  exposures[state.current.b] = (Number(exposures[state.current.b]) || 0) + 1;
  writeJSON(LS.exposure, exposures);

  writeJSON(LS.count, (Number(readJSON(LS.count, 0)) || 0) + 1);

  state.session.block += 1;
  state.session.total += 1;
  saveSession();

  $("#vote-status").textContent = `Recorded · ${state.session.block} of ${MAX_BLOCK} this round.`;
  updateVoteButtons();
  showToast("Vote recorded. Thank you.");
  if (state.session.block >= MAX_BLOCK) {
    state.advanceTimer = window.setTimeout(() => {
      if (state.current?.submitted) showCheckpoint();
    }, 650);
  } else {
    state.advanceTimer = window.setTimeout(() => {
      if (state.current?.submitted) loadNext();
    }, 800);
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("timeout");
        error.code = "timeout";
        reject(error);
      }, ms);
    }),
  ]);
}

/* ---------------- round checkpoints and ranking ---------------- */

function showCheckpoint() {
  if (!state.session || state.session.done) return;
  clearInterval(state.timer);
  $("#checkpoint-progress").textContent =
    `Round ${state.session.round} · ${state.session.total} comparison${state.session.total === 1 ? "" : "s"} total.`;
  const dialog = $("#checkpoint-dialog");
  if (!dialog.open) dialog.showModal();
  state.busy = true;
  updateVoteButtons();
}

function judgeMore() {
  closeDialog($("#checkpoint-dialog"));
  state.session.round += 1;
  state.session.block = 0;
  state.session.done = false;
  saveSession();
  $("#ranking").hidden = true;
  startArena();
}

function finishSession() {
  closeDialog($("#checkpoint-dialog"));
  showRanking();
}

async function showRanking() {
  if (!state.session) return;
  state.session.done = true;
  saveSession();
  clearInterval(state.timer);
  $("#intro").hidden = true;
  $("#arena").hidden = true;
  $("#finished").hidden = true;
  $("#ranking").hidden = false;
  $("#ranking-status").hidden = false;
  $("#ranking-content").hidden = true;
  $("#ranking-retry").hidden = true;
  $("#ranking-status-text").textContent = "Reading the current ranking…";
  window.scrollTo(0, 0);
  await loadRanking();
}

async function loadRanking() {
  if (!state.session || state.rankingBusy) return;
  state.rankingBusy = true;
  $("#ranking-status").hidden = false;
  $("#ranking-content").hidden = true;
  $("#ranking-retry").hidden = true;
  $("#ranking-status-text").textContent = "Reading the current ranking…";

  try {
    const [rosterResponse, snapshot] = await Promise.all([
      fetch("/data/roster.json", { cache: "no-store" }),
      getDocs(collection(db, BALLOT_COLLECTION)),
    ]);
    if (!rosterResponse.ok) throw new Error("Could not load the model roster.");
    const roster = await rosterResponse.json();
    if (!Array.isArray(roster.sims) || !roster.sims.length) throw new Error("The model roster is empty.");

    const ballots = snapshot.docs.map((item) => item.data());
    const fit = fitBT(roster.sims.map((sim) => sim.id), ballots);
    const rows = roster.sims
      .map((sim, index) => ({
        ...sim,
        theta: fit.theta[index],
        matches: fit.matches[index],
        wins: fit.decisiveWins[index],
        ties: fit.ties[index],
      }))
      .filter((row) => row.matches > 0)
      .sort((a, b) => b.theta - a.theta || b.matches - a.matches || a.label.localeCompare(b.label));

    const votedIds = new Set();
    for (const key of readJSON(LS.voted, [])) {
      for (const id of String(key).split("__")) votedIds.add(id);
    }

    if ($("#ranking").hidden) return;
    renderRanking(rows, snapshot.size, votedIds);
  } catch (error) {
    console.error(error);
    if ($("#ranking").hidden) return;
    $("#ranking-status-text").textContent = "Could not load the current ranking. Check your connection.";
    $("#ranking-retry").hidden = false;
  } finally {
    state.rankingBusy = false;
  }
}

function renderRanking(rows, ballotCount, votedIds) {
  const session = state.session;
  const top = rows.slice(0, 12);

  $("#ranking-lede").textContent =
    `You judged ${session.total} pair${session.total === 1 ? "" : "s"} across ` +
    `${session.round} round${session.round === 1 ? "" : "s"}. Here is how the models stand right now.`;

  const stats = [
    ["Your comparisons", session.total],
    ["Community ballots", ballotCount],
    ["Models rated", rows.length],
    ["Rounds", session.round],
  ];
  $("#ranking-stats").innerHTML = stats.map(([label, value]) =>
    `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`
  ).join("");

  if (!top.length) {
    $("#ranking-body").innerHTML = `<tr><td colspan="6" class="cell-muted">No community votes yet.</td></tr>`;
  } else {
    $("#ranking-body").innerHTML = top.map((row, index) => {
      const rating = Math.round(eloFromTheta(row.theta));
      const winRate = Math.round(((row.wins + 0.5 * row.ties) / row.matches) * 100);
      const judged = votedIds.has(row.id) ? ` <span class="you-badge">you judged</span>` : "";
      return `<tr>
        <td class="rank-num">${index + 1}</td>
        <td class="cell-name">
          <a class="model-link" href="/s/${encodeURIComponent(row.id)}.html" target="_blank" rel="noopener noreferrer" title="Open this simulation in a new tab">
            <strong>${escapeHtml(row.label)}</strong><span class="ext" aria-hidden="true">↗</span>
          </a>${judged}
        </td>
        <td class="cell-family">${escapeHtml(row.family)}</td>
        <td class="cell-rating">${rating}</td>
        <td class="cell-muted">${row.matches}</td>
        <td class="cell-muted">${winRate}%</td>
      </tr>`;
    }).join("");
  }

  $("#ranking-note").textContent =
    `Provisional · top ${Math.min(12, rows.length)} of ${rows.length} rated model${rows.length === 1 ? "" : "s"} ` +
    `· ${ballotCount} ballot${ballotCount === 1 ? "" : "s"} total. ` +
    `Model names open the full simulation in a new tab. ` +
    `The organizer page has the full table with confidence intervals.`;
  $("#ranking-status").hidden = true;
  $("#ranking-content").hidden = false;
}

function startNewSession() {
  state.session = { block: 0, total: 0, round: 1, done: false };
  saveSession();
  writeJSON(LS.intro, false);
  $("#ranking").hidden = true;
  $("#arena").hidden = true;
  $("#finished").hidden = true;
  $("#intro").hidden = false;
  const startButton = $("#start-btn");
  if (startButton) startButton.disabled = false;
  window.scrollTo(0, 0);
}

/* ---------------- UI helpers ---------------- */

function showError(message) {
  $("#error-text").textContent = message;
  $("#error-banner").hidden = false;
}

function hideError() {
  $("#error-banner").hidden = true;
}

let toastTimer;
function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 1900);
}

async function toggleFocus(side) {
  const panel = $(`#panel-${side}`);
  if (!panel) return;
  if (document.fullscreenElement) {
    await document.exitFullscreen?.();
    return;
  }
  if (panel.classList.contains("is-focused")) {
    panel.classList.remove("is-focused");
    document.body.classList.remove("has-focus");
    return;
  }
  try {
    await panel.requestFullscreen();
  } catch {
    panel.classList.add("is-focused");
    document.body.classList.add("has-focus");
  }
}

function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}

/* ---------------- wire up ---------------- */

function bind() {
  state.voter = getVoter();
  state.session = readSession();

  $("#start-btn").addEventListener("click", async () => {
    $("#start-btn").disabled = true;
    try {
      await state.simsPromise;
      startArena();
      $("#start-btn").disabled = false;
    } catch {
      showError("The arena could not load. Please refresh the page.");
      $("#start-btn").disabled = false;
    }
  });

  $("#again-btn").addEventListener("click", judgeMore);

  $("#about-btn").addEventListener("click", () => $("#about-dialog").showModal());
  $("#problem-btn").addEventListener("click", () => $("#problem-dialog").showModal());

  $("#more-btn").addEventListener("click", judgeMore);
  $("#finish-btn").addEventListener("click", finishSession);
  $("#judge-more-btn").addEventListener("click", judgeMore);
  $("#new-session-btn").addEventListener("click", startNewSession);
  $("#ranking-retry").addEventListener("click", loadRanking);

  $$("[data-close]").forEach((button) => {
    button.addEventListener("click", () => closeDialog(button.closest("dialog")));
  });

  $$("dialog.sheet").forEach((dialog) => {
    if (dialog.id === "checkpoint-dialog") return;
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  $("#checkpoint-dialog").addEventListener("cancel", (event) => event.preventDefault());

  $$(".vote-btn").forEach((button) => {
    button.addEventListener("click", () => castVote(button.dataset.vote));
  });

  $$("[data-reload]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.busy || !state.current) return;
      const side = button.dataset.reload;
      mountFrame(side, side === "a" ? state.current.a : state.current.b);
    });
  });

  $$("[data-focus]").forEach((button) => {
    button.addEventListener("click", () => toggleFocus(button.dataset.focus));
  });

  $$("#side-toggle button").forEach((button) => {
    button.addEventListener("click", () => setStageView(button.dataset.show));
  });

  $$(".problem-choice").forEach((button) => {
    button.addEventListener("click", () => {
      const side = button.dataset.broken;
      closeDialog($("#problem-dialog"));
      castVote("broken", side);
    });
  });

  $("#retry-btn").addEventListener("click", () => {
    hideError();
    submitBallot();
  });

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector("dialog[open]")) return;
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || event.target?.isContentEditable) return;
    if ($("#arena").hidden) return;

    if (event.key === "1") { event.preventDefault(); castVote("a"); }
    else if (event.key === "2") { event.preventDefault(); castVote("tie"); }
    else if (event.key === "3") { event.preventDefault(); castVote("b"); }
    else if (event.key === "Escape") {
      const focused = $(".panel.is-focused");
      if (focused) {
        focused.classList.remove("is-focused");
        document.body.classList.remove("has-focus");
      }
    }
  });

  window.addEventListener("beforeunload", () => clearInterval(state.timer));
}

async function boot() {
  bind();
  state.simsPromise = loadSims();
  try {
    await state.simsPromise;
  } catch (error) {
    console.error(error);
    showError("The arena could not load its roster. Please refresh the page.");
    $("#start-btn").disabled = true;
    return;
  }
  if (!state.session) return;
  if (state.session.done) { showRanking(); return; }
  if (state.session.block >= MAX_BLOCK) { showCheckpoint(); return; }
  if (readJSON(LS.intro, false)) startArena();
}

boot();
