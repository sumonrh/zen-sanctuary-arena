import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import { getFirestore, collection, getDocs } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js";
import { firebaseConfig, BALLOT_COLLECTION } from "./firebase-config.js";
import {
  fitBT,
  bootstrapBT,
  estimateSummary,
  familyBallots,
  connectedComponents,
  tally,
} from "./ranking.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const state = {
  roster: null,
  ballots: null,
  lastRun: null,
  busy: false,
};

const BOOT_REPS = 300;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const fmt = (value, digits = 0) =>
  Number.isFinite(value) ? value.toFixed(digits) : "—";

const pct = (value) => {
  if (!Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.005) return "<1%";
  if (value >= 0.995) return ">99%";
  return `${Math.round(value * 100)}%`;
};

const dateLabel = (ms) => ms == null ? "—" : new Date(ms).toLocaleDateString(undefined, {
  year: "numeric", month: "short", day: "numeric",
});

function bytesFromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function decryptRoster(passphrase) {
  const blob = await fetch("/data/roster.locked.json", { cache: "no-store" }).then((response) => {
    if (!response.ok) throw new Error("roster-fetch");
    return response.json();
  });
  if (!crypto?.subtle) throw new Error("insecure-context");
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: bytesFromBase64(blob.salt), iterations: blob.iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesFromBase64(blob.iv) },
    key,
    bytesFromBase64(blob.data),
  );
  const payload = JSON.parse(new TextDecoder().decode(plaintext));
  if (!payload?.sims?.length) throw new Error("roster-invalid");
  return payload;
}

async function fetchBallots() {
  if (!crypto?.subtle) throw new Error("insecure-context");
  const snapshot = await getDocs(collection(db, BALLOT_COLLECTION));
  return snapshot.docs.map((item) => {
    const data = item.data();
    return {
      ...data,
      id: item.id,
      createdAtMs: typeof data.createdAt?.toMillis === "function" ? data.createdAt.toMillis() : null,
    };
  });
}

function compute(roster, ballots) {
  const sims = roster.sims;
  const ids = sims.map((sim) => sim.id);
  const byId = new Map(sims.map((sim) => [sim.id, sim]));
  const counts = tally(ballots);

  const fit = fitBT(ids, ballots);
  const boot = bootstrapBT(ids, ballots, BOOT_REPS);
  const summary = estimateSummary(ids, fit, boot);

  const submissions = summary
    .filter((row) => row.matches > 0)
    .map((row) => {
      const sim = byId.get(row.id);
      return { ...row, label: sim.label, family: sim.family, tier: sim.tier, note: sim.note };
    })
    .sort((a, b) => b.theta - a.theta);

  const unrated = summary
    .filter((row) => row.matches === 0)
    .map((row) => byId.get(row.id))
    .sort((a, b) => a.label.localeCompare(b.label));

  const familyById = new Map(sims.map((sim) => [sim.id, sim.family]));
  const families = [...new Set(sims.map((sim) => sim.family))];
  const famBallots = familyBallots(ballots, familyById);
  const famFit = fitBT(families, famBallots);
  const famBoot = bootstrapBT(families, famBallots, BOOT_REPS);
  const famSummary = estimateSummary(families, famFit, famBoot);

  const bestByFamily = new Map();
  for (const row of submissions) {
    if (!bestByFamily.has(row.family)) bestByFamily.set(row.family, row);
  }
  const familyRows = famSummary
    .filter((row) => row.matches > 0)
    .map((row) => ({
      ...row,
      family: row.id,
      best: bestByFamily.get(row.id) || null,
      count: sims.filter((sim) => sim.family === row.id).length,
    }))
    .sort((a, b) => b.theta - a.theta);

  const components = connectedComponents(ids, ballots)
    .filter((component) => component.length > 1);
  const ratedIds = new Set(submissions.map((row) => row.id));
  const ratedInLargest = components.length ? components[0].filter((id) => ratedIds.has(id)).length : 0;

  return {
    submittedAt: new Date().toISOString(),
    totalSims: sims.length,
    ballots: ballots.length,
    counts,
    submissions,
    unrated,
    families: familyRows,
    components,
    ratedInLargest,
    ratedCount: ratedIds.size,
    familyCount: familyRows.length,
  };
}

/* ---------------- rendering ---------------- */

function renderStats(report) {
  const stats = [
    ["Ballots", report.counts.total],
    ["Voters", report.counts.voters],
    ["Contenders", report.totalSims],
    ["Ties", report.counts.ties],
    ["Skips", report.counts.skips],
    ["Broken reports", report.counts.broken],
    ["Votes < 3s", report.counts.quick],
    ["Pairs covered", report.counts.pairs],
  ];
  $("#stats-grid").innerHTML = stats.map(([label, value]) =>
    `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`
  ).join("");
}

function renderWarnings(report) {
  const warnings = [];
  if (!report.ballots) {
    warnings.push("No ballots yet. Share the arena link, then refresh this page.");
  } else if (report.ballots < 300) {
    warnings.push(`<strong>Early signal.</strong> Only ${report.ballots} ballots have been cast. Treat the order below the top few as provisional.`);
  }
  if (report.counts.quick > 0) {
    warnings.push(`<strong>${report.counts.quick} vote${report.counts.quick === 1 ? "" : "s"} under 3 seconds.</strong> They are included in the main fit; consider a sensitivity check without them.`);
  }
  if (report.components.length > 1) {
    warnings.push(`<strong>Disconnected comparisons.</strong> The graph has ${report.components.length} separate groups; ratings across groups are not directly comparable.`);
  } else if (report.components.length === 1 && report.ratedInLargest < report.ratedCount) {
    warnings.push(`<strong>Isolated contenders.</strong> ${report.ratedCount - report.ratedInLargest} rated submission(s) sit outside the main comparison graph.`);
  }
  const thin = report.submissions.filter((row) => row.matches < 8).length;
  if (thin) {
    warnings.push(`<strong>${thin} submission${thin === 1 ? "" : "s"} with fewer than 8 matches.</strong> Their confidence intervals will be wide.`);
  }
  $("#warnings").innerHTML = warnings.map((text) => `<div class="banner"><span aria-hidden="true">◐</span><span>${text}</span></div>`).join("");
}

function renderSubmissions(report) {
  const body = $("#submissions-body");
  if (!report.submissions.length) {
    body.innerHTML = `<tr><td colspan="8" class="cell-muted">No rated submissions yet.</td></tr>`;
  } else {
    body.innerHTML = report.submissions.map((row, index) => `
      <tr>
        <td class="rank-num">${index + 1}</td>
        <td class="cell-name">
          <a class="model-link" href="/s/${encodeURIComponent(row.id)}.html" target="_blank" rel="noopener noreferrer" title="Open this simulation in a new tab">
            <strong>${escapeHtml(row.label)}</strong><span class="ext" aria-hidden="true">↗</span>
          </a>
          ${row.note ? `<span title="${escapeHtml(row.note)}" aria-label="${escapeHtml(row.note)}">†</span>` : ""}
          <span class="tier-badge">Tier ${row.tier}</span>
        </td>
        <td class="cell-family">${escapeHtml(row.family)}</td>
        <td class="cell-rating">${Math.round(row.rating)}</td>
        <td class="cell-ci">${row.ciLow == null ? "—" : `${Math.round(row.ciLow)}–${Math.round(row.ciHigh)}`}</td>
        <td class="cell-muted">${row.matches}</td>
        <td class="cell-muted">${fmt(row.winRate * 100, 0)}%</td>
        <td>
          <div class="p-top" title="${pct(row.pTop)} probability of rank #1">
            <span class="p-top-bar"><i style="width:${Math.max(0, Math.min(100, row.pTop * 100))}%"></i></span>
            <span>${pct(row.pTop)}</span>
          </div>
        </td>
      </tr>
    `).join("");
  }

  const notes = report.submissions.filter((row) => row.note);
  $("#submissions-note").innerHTML =
    `${report.submissions.length} rated submissions · ${report.ballots} ballots · sorted by Bradley–Terry rating. ` +
    `Model names link to the full simulation.` +
    (notes.length ? `<br>† ${notes.map((row) => `${escapeHtml(row.label)}: ${escapeHtml(row.note)}`).join("<br>")}` : "");

  if (report.unrated.length) {
    $("#unrated-box").hidden = false;
    $("#unrated-summary").textContent = `${report.unrated.length} unrated submission${report.unrated.length === 1 ? "" : "s"} (no matches yet)`;
    $("#unrated-list").textContent = report.unrated.map((sim) => sim.label).join(" · ");
  } else {
    $("#unrated-box").hidden = true;
  }
}

function renderFamilies(report) {
  const body = $("#families-body");
  if (!report.families.length) {
    body.innerHTML = `<tr><td colspan="8" class="cell-muted">No cross-family matches yet.</td></tr>`;
  } else {
    body.innerHTML = report.families.map((row, index) => `
      <tr>
        <td class="rank-num">${index + 1}</td>
        <td class="cell-name"><strong>${escapeHtml(row.family)}</strong> <span class="cell-muted">${row.count} submission${row.count === 1 ? "" : "s"}</span></td>
        <td class="cell-family">
          ${row.best ? `<a class="model-link" href="/s/${encodeURIComponent(row.best.id)}.html" target="_blank" rel="noopener noreferrer" title="Open this simulation in a new tab"><strong>${escapeHtml(row.best.label)}</strong><span class="ext" aria-hidden="true">↗</span></a> <span class="cell-muted">(${Math.round(row.best.rating)})</span>` : "—"}
        </td>
        <td class="cell-rating">${Math.round(row.rating)}</td>
        <td class="cell-ci">${row.ciLow == null ? "—" : `${Math.round(row.ciLow)}–${Math.round(row.ciHigh)}`}</td>
        <td class="cell-muted">${row.matches}</td>
        <td class="cell-muted">${fmt(row.winRate * 100, 0)}%</td>
        <td>
          <div class="p-top" title="${pct(row.pTop)} probability of rank #1">
            <span class="p-top-bar"><i style="width:${Math.max(0, Math.min(100, row.pTop * 100))}%"></i></span>
            <span>${pct(row.pTop)}</span>
          </div>
        </td>
      </tr>
    `).join("");
  }
  $("#families-note").textContent =
    `${report.familyCount} model families with at least one cross-family match. ` +
    `Same-family ballots are excluded from this view; the rating is fitted over families, not submissions. ` +
    `Best submission names open the simulation in a new tab.`;
}

function renderCoverage(report) {
  const simById = new Map(state.roster.sims.map((sim) => [sim.id, sim]));
  const rows = [...state.roster.sims]
    .map((sim) => ({ sim, matches: (report.counts.per.get(sim.id)?.matches) || 0 }))
    .sort((a, b) => a.matches - b.matches)
    .slice(0, 12);
  $("#coverage-list").innerHTML = rows.map(({ sim, matches }) =>
    `<div class="coverage-item"><span>${escapeHtml(sim.label)}</span><span>${matches} match${matches === 1 ? "" : "es"}</span></div>`
  ).join("");
}

function renderSummary(report) {
  const parts = [
    `${report.ballots} ballot${report.ballots === 1 ? "" : "s"}`,
    `${report.counts.voters} voter${report.counts.voters === 1 ? "" : "s"}`,
    `${report.counts.pairs} distinct pair${report.counts.pairs === 1 ? "" : "s"}`,
  ];
  if (report.counts.minTime != null) {
    parts.push(`${dateLabel(report.counts.minTime)} – ${dateLabel(report.counts.maxTime)}`);
  }
  $("#summary-lede").textContent = parts.join(" · ");

  const note = $("#export-note");
  note.textContent = `Computed ${new Date(report.submittedAt).toLocaleString()} · ${BOOT_REPS} bootstrap resamples`;
}

function renderReport(report) {
  state.lastRun = report;
  renderStats(report);
  renderWarnings(report);
  renderSubmissions(report);
  renderFamilies(report);
  renderCoverage(report);
  renderSummary(report);
  $("#status-line").hidden = true;
}

/* ---------------- data flow ---------------- */

async function refresh() {
  if (state.busy || !state.roster) return;
  state.busy = true;
  $("#refresh-btn").disabled = true;
  $("#status-line").hidden = false;
  $("#status-text").textContent = "Reading ballots…";
  $("#results-view").hidden = false;
  try {
    const ballots = await fetchBallots();
    $("#status-text").textContent = `Fitting ${ballots.length} ballots…`;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const report = compute(state.roster, ballots);
    renderReport(report);
  } catch (error) {
    console.error(error);
    $("#status-line").hidden = false;
    $("#status-text").textContent = error?.code === "permission-denied"
      ? "Firestore denied the read. Check that firestore.rules is deployed."
      : "Could not read the ballots. Check the connection and try again.";
  } finally {
    state.busy = false;
    $("#refresh-btn").disabled = false;
  }
}

async function unlock(event) {
  event.preventDefault();
  const input = $("#passphrase");
  const button = $("#unlock-btn");
  const errorLine = $("#lock-error");
  const passphrase = input.value.trim();
  if (!passphrase) return;

  errorLine.hidden = true;
  button.disabled = true;
  button.textContent = "Decrypting…";

  try {
    const roster = await decryptRoster(passphrase);
    state.roster = roster;
    input.value = "";
    $("#lock-view").hidden = true;
    $("#results-view").hidden = false;
    $("#status-line").hidden = false;
    $("#status-text").textContent = "Reading ballots…";
    await refresh();
  } catch (error) {
    console.error(error);
    let message = "That passphrase did not unlock the roster. Check it and try again.";
    if (error?.message === "roster-fetch") message = "The locked roster is missing. Rebuild and redeploy the site.";
    if (error?.message === "roster-invalid") message = "The roster decrypted, but its contents were not valid.";
    if (error?.message === "insecure-context") message = "This page must be opened over HTTPS to decrypt the roster.";
    errorLine.textContent = message;
    errorLine.hidden = false;
    input.select();
  } finally {
    button.disabled = false;
    button.textContent = "Unlock";
  }
}

/* ---------------- exports ---------------- */

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv() {
  const report = state.lastRun;
  if (!report) return;
  const header = [
    "view", "rank", "label", "family", "tier", "rating", "ci_low", "ci_high",
    "matches", "wins", "losses", "ties", "win_rate", "p_top1", "note",
  ];
  const lines = [header.join(",")];
  report.submissions.forEach((row, index) => {
    lines.push([
      "submission", index + 1, row.label, row.family, row.tier,
      row.rating.toFixed(2), row.ciLow?.toFixed(2) ?? "", row.ciHigh?.toFixed(2) ?? "",
      row.matches, row.wins, row.losses, row.ties, row.winRate.toFixed(4),
      row.pTop.toFixed(4), row.note || "",
    ].map(csvCell).join(","));
  });
  report.families.forEach((row, index) => {
    lines.push([
      "family", index + 1, row.family, row.family, "",
      row.rating.toFixed(2), row.ciLow?.toFixed(2) ?? "", row.ciHigh?.toFixed(2) ?? "",
      row.matches, row.wins, row.losses, row.ties, row.winRate.toFixed(4),
      row.pTop.toFixed(4), row.best ? `best: ${row.best.label}` : "",
    ].map(csvCell).join(","));
  });
  const date = new Date().toISOString().slice(0, 10);
  download(`zen-arena-results-${date}.csv`, lines.join("\n"), "text/csv;charset=utf-8");
}

function exportJson() {
  const report = state.lastRun;
  if (!report) return;
  const payload = {
    generatedAt: report.submittedAt,
    method: {
      model: "Bradley-Terry, L2 prior, ties = half win, skips excluded",
      bootstrapReps: BOOT_REPS,
      ratingScale: "Elo-style, 1500 + 173.7178 * theta",
      familyModel: "refit over families with same-family ballots removed",
    },
    summary: {
      ballots: report.ballots,
      voters: report.counts.voters,
      pairs: report.counts.pairs,
      ties: report.counts.ties,
      skips: report.counts.skips,
      broken: report.counts.broken,
      quick: report.counts.quick,
      firstBallot: report.counts.minTime ? new Date(report.counts.minTime).toISOString() : null,
      lastBallot: report.counts.maxTime ? new Date(report.counts.maxTime).toISOString() : null,
      connectedComponents: report.components.length,
    },
    submissions: report.submissions,
    unrated: report.unrated,
    families: report.families,
  };
  const date = new Date().toISOString().slice(0, 10);
  download(`zen-arena-results-${date}.json`, JSON.stringify(payload, null, 2), "application/json");
}

/* ---------------- wire up ---------------- */

function bind() {
  $("#pass-form").addEventListener("submit", unlock);

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((other) => {
        const active = other === tab;
        other.classList.toggle("is-active", active);
        other.setAttribute("aria-selected", String(active));
      });
      const target = tab.dataset.tab;
      $("#panel-submissions").hidden = target !== "submissions";
      $("#panel-families").hidden = target !== "families";
    });
  });

  $("#refresh-btn").addEventListener("click", refresh);
  $("#lock-btn").addEventListener("click", () => window.location.reload());
  $("#export-csv").addEventListener("click", exportCsv);
  $("#export-json").addEventListener("click", exportJson);
}

bind();
