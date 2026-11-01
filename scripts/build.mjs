// Build the blind arena:
//  - validate the manual roster against the Tier 1-4 source folders
//  - de-duplicate by content
//  - copy sanitized, opaque-slug HTML into public/s/
//  - write public/data/sims.json (public, no names)
//  - write private/roster.json (plaintext, never deployed)
//  - write public/data/roster.locked.json (AES-256-GCM, passphrase-gated)
//  - scan deployed copies for model-name leaks

import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { createHash, randomBytes, pbkdf2Sync, createCipheriv } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SIMS_OUT = path.join(PUBLIC, 's');
const DATA_OUT = path.join(PUBLIC, 'data');
const PRIVATE = path.join(ROOT, 'private');
const TIERS = ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 4'];
const EXCLUDED = new Set([
  // Removed by request: suspected repeat of Beam Max.
  'Tier 3/Beam free Max zen_sanctuary.html',
  // Removed by request.
  'Tier 1/Deepseek v4.1 Flash 1017 Max Zen Sanctuary OpenRouter.html',
]);
const STRICT = process.argv.includes('--strict');

// Manual, reviewable attribution. This is the single source of truth.
// `file` is relative to the project root. The duplicate GPT 6.1 Sol Max file is omitted.
const ROSTER = [
  // Tier 1
  ['Tier 1/Gemini 4 High Zen Sanctuary.html', 'Gemini 4 High', 'Gemini 4'],
  ['Tier 1/Gemini 3_7 Flash High Github Copilot Zen Temple.html', 'Gemini 3.7 Flash High (GitHub Copilot)', 'Gemini 3.7 Flash'],
  ['Tier 1/Deepseek v4.1 Flash Max 1017 Zen Sanctuary.html', 'DeepSeek V4.1 Flash Max 1017', 'DeepSeek V4.1 Flash'],
  ['Tier 1/Deepseek v4.1 flash max 0910 zen-sanctuary.html', 'DeepSeek V4.1 Flash Max 0910', 'DeepSeek V4.1 Flash'],
  ['Tier 1/Deepseek v4.1 Flash High 1017 Zen Sanctuary.html', 'DeepSeek V4.1 Flash High 1017', 'DeepSeek V4.1 Flash'],
  ['Tier 1/GPT 6.1 Sol Max Zen Sanctuary.html', 'GPT-6.1 Sol Max', 'GPT-6.1 Sol'],
  ['Tier 1/GPT 6.1 Sol High Zen Sanctuary.html', 'GPT-6.1 Sol High', 'GPT-6.1 Sol'],
  ['Tier 1/GPT 6.1 Sol Extra High Zen Sanctuary.html', 'GPT-6.1 Sol Extra High', 'GPT-6.1 Sol'],
  ['Tier 1/GPT 6 Sol Max Zen Sanctuary.html', 'GPT-6 Sol Max', 'GPT-6 Sol'],
  ['Tier 1/GPT 6.1 Terra Max Zen Sanctuary.html', 'GPT-6.1 Terra Max', 'GPT-6.1 Terra'],
  ['Tier 1/GPT 6.1 Sol Medium Zen Sanctuary.html', 'GPT-6.1 Sol Medium', 'GPT-6.1 Sol'],
  ['Tier 1/Minimax M3.1 flash Max Zen Sanctuary.html', 'MiniMax M3.1 Flash Max', 'MiniMax M3.1 Flash'],
  ['Tier 1/Opus 5 Max Github Copilot.html', 'Opus 5 Max (GitHub Copilot)', 'Opus 5'],
  ['Tier 1/Opus 5 Zen Sanctuary.html', 'Opus 5', 'Opus 5'],
  ['Tier 1/Opus 5.5 Max zen-sanctuary.html', 'Opus 5.5 Max', 'Opus 5.5'],
  ['Tier 1/Opus 5_5 Medium GC Zen Sanctuary.html', 'Opus 5.5 Medium (GitHub Copilot)', 'Opus 5.5'],
  ['Tier 1/Sonnet 5_5 High Zen Sanctuary.html', 'Sonnet 5.5 High', 'Sonnet 5.5'],

  // Tier 2
  ['Tier 2/GPT 5_6 Terra Max Zen Temple.html', 'GPT-5.6 Terra Max', 'GPT-5.6 Terra'],
  ['Tier 2/GPT 5_6 Terra Extra High Zen Temple.html', 'GPT-5.6 Terra Extra High', 'GPT-5.6 Terra'],
  ['Tier 2/GPT 5_6 Sol PGPT.html', 'GPT-5.6 Sol (PGPT)', 'GPT-5.6 Sol'],
  ['Tier 2/GPT 5_6 Luna Max Zen Temple.html', 'GPT-5.6 Luna Max', 'GPT-5.6 Luna'],
  ['Tier 2/GPT 5_6 Luna Extra High Zen Temple.html', 'GPT-5.6 Luna Extra High', 'GPT-5.6 Luna'],
  ['Tier 2/GLM 5_3 High Deep Think Zen Temple.html', 'GLM 5.3 High Deep Think', 'GLM 5.3'],
  ['Tier 2/GLM 5_3 Flash Ox Alpha Zen Temple.html', 'GLM 5.3 Flash (Ox Alpha)', 'GLM 5.3'],
  ['Tier 2/GLM 5.3 flash max zen sanctuary.html', 'GLM 5.3 Flash Max', 'GLM 5.3'],
  ['Tier 2/Gemini 3_8 Flash High Github Copilot.html', 'Gemini 3.8 Flash High (GitHub Copilot)', 'Gemini 3.8 Flash'],
  ['Tier 2/Gemini 3_7 flash Zen Sanctuary.html', 'Gemini 3.7 Flash', 'Gemini 3.7 Flash'],
  ['Tier 2/Deepseek v4.1 Flash Low 1017 Zen Sanctuary.html', 'DeepSeek V4.1 Flash Low 1017', 'DeepSeek V4.1 Flash'],
  ['Tier 2/GPT 6.1 Terra xHigh Zen Sanctuary.html', 'GPT-6.1 Terra xHigh', 'GPT-6.1 Terra'],
  ['Tier 2/GPT 6.1 Terra Medium Zen Sanctuary.html', 'GPT-6.1 Terra Medium', 'GPT-6.1 Terra'],
  ['Tier 2/GPT 6.1 Terra High Zen Sanctuary.html', 'GPT-6.1 Terra High', 'GPT-6.1 Terra'],
  ['Tier 2/GPT 6.1 Sol Low Zen Sanctuary.html', 'GPT-6.1 Sol Low', 'GPT-6.1 Sol'],
  ['Tier 2/GPT 6 Luna Max Zen Sanctuary.html', 'GPT-6 Luna Max', 'GPT-6 Luna'],
  ['Tier 2/GPT 5_6 thinking copilit 365 zen_sanctuary.html', 'GPT-5.6 Thinking (Copilot 365)', 'GPT-5.6'],
  ['Tier 2/Grok 4_7 High Zen Centuary.html', 'Grok 4.7 High', 'Grok 4.7'],
  ['Tier 2/Grok 4_5 High Github copilot Zen Temple.html', 'Grok 4.5 High (GitHub Copilot)', 'Grok 4.5'],
  ['Tier 2/Grok 4.5 zen-sanctuary.html', 'Grok 4.5', 'Grok 4.5'],
  ['Tier 2/Meta Muse Assistant zen-sanctuary.html', 'Meta Muse Assistant', 'Meta Muse'],
  ['Tier 2/Longcat 2_5 High zen-sanctuary.html', 'LongCat 2.5 High', 'LongCat 2.5'],
  ['Tier 2/Kimi K3 Zen Sanctuary.html', 'Kimi K3', 'Kimi K3'],
  ['Tier 2/Mimo 2.6 flash zen sanctuary.html', 'MiMo 2.6 Flash', 'MiMo 2.6'],
  ['Tier 2/Mimo v2_6 pro high zen sanctuary.html', 'MiMo v2.6 Pro High', 'MiMo 2.6'],
  ['Tier 2/Opus 4_8 zen_sanctuary.html', 'Opus 4.8', 'Opus 4.8'],
  ['Tier 2/Opus 4_6 Zen Temple.html', 'Opus 4.6', 'Opus 4.6'],
  ['Tier 2/Muse Spark 1.3 Max Opencode.html', 'Muse Spark 1.3 Max (OpenCode)', 'Muse Spark 1.3'],
  ['Tier 2/Muse Spark 1.3 Max Opencode 2 Zen Sanctuary.html', 'Muse Spark 1.3 Max (OpenCode, run 2)', 'Muse Spark 1.3'],
  ['Tier 2/Minimax M3.1 flash xHigh Zen Sanctuary.html', 'MiniMax M3.1 Flash xHigh', 'MiniMax M3.1 Flash'],
  ['Tier 2/Minimax M3.1 flash High Zen Sanctuary.html', 'MiniMax M3.1 Flash High', 'MiniMax M3.1 Flash'],
  ['Tier 2/Space Bunny Alpha Zen Sanctuary.html', 'Space Bunny Alpha', 'Space Bunny'],
  ['Tier 2/Sonnet 5 zen-sanctuary.html', 'Sonnet 5', 'Sonnet 5'],
  ['Tier 2/Qwen 3_8 Max Zen Temple.html', 'Qwen 3.8 Max', 'Qwen 3.8'],
  ['Tier 2/Step 5 High Opencode Zen Sanctuary.html', 'Step 5 High (OpenCode)', 'Step 5'],
  ['Tier 2/Union alpha zen-sanctuary.html', 'Union Alpha', 'Union Alpha'],

  // Tier 3
  ['Tier 3/GPT 5_2 Zen Temple.html', 'GPT-5.2', 'GPT-5.2'],
  ['Tier 3/GLM 5_2 voxel-zen-sanctuary.html', 'GLM 5.2', 'GLM 5.2'],
  ['Tier 3/gemini 3_6 flash extended thinking.html', 'Gemini 3.6 Flash Extended Thinking', 'Gemini 3.6 Flash'],
  ['Tier 3/Gemini 3_1 Pro.html', 'Gemini 3.1 Pro', 'Gemini 3.1'],
  ['Tier 3/Deepseek V4 flash Zen Sanctuary.html', 'DeepSeek V4 Flash', 'DeepSeek V4 Flash'],
  ['Tier 3/Big Pickle Zen Sanctuary.html', 'Big Pickle', 'Big Pickle'],
  ['Tier 3/Grok 4.6 kiri-yama-standalone.html', 'Grok 4.6', 'Grok 4.6'],
  ['Tier 3/GPT 5_5 test Zen temple.html', 'GPT-5.5', 'GPT-5.5'],
  ['Tier 3/GPT 5_4 Zen Temple.html', 'GPT-5.4', 'GPT-5.4'],
  ['Tier 3/Muse Spark 1_2 Xhigh Zen Sanctuary.html', 'Muse Spark 1.2 xHigh', 'Muse Spark 1.2'],
  ['Tier 3/Minimax M3 Opencode.html', 'MiniMax M3 (OpenCode)', 'MiniMax M3'],
  ['Tier 3/Tencent HY 3 zen-sanctuary.html', 'Tencent HY 3', 'Tencent HY'],

  // Tier 4
  ['Tier 4/Step 3_7 flash VoxelZenSanctuary.html', 'Step 3.7 Flash', 'Step 3.7 Flash'],
  ['Tier 4/Solar pro 4 Zen Sanctuary.html', 'Solar Pro 4', 'Solar Pro'],
  ['Tier 4/O4 mini Zen Temple.html', 'o4-mini', 'o4-mini'],
  ['Tier 4/Muse Spark 1_1 zen sanctuary.html', 'Muse Spark 1.1', 'Muse Spark 1.1'],
  ['Tier 4/MAI 1_1 flash High Zen Temple.html', 'MAI-1.1 Flash High', 'MAI-1.1'],
  ['Tier 4/Longcat 2 zen_sanctuary.html', 'LongCat 2', 'LongCat 2'],
  ['Tier 4/Iceman contributor Zen Sanctuary.html', 'Iceman Contributor', 'Iceman'],
  ['Tier 4/GPT 5_6 Luna High Zen Temple.html', 'GPT-5.6 Luna High', 'GPT-5.6 Luna'],
  ['Tier 4/GPT 5_1 Zen Temple.html', 'GPT-5.1', 'GPT-5.1'],
  ['Tier 4/GPT 5 Zen Temple.html', 'GPT-5', 'GPT-5'],
  ['Tier 4/Gemini 3_6 initial multi prompt.html', 'Gemini 3.6 Flash (initial multi-prompt)', 'Gemini 3.6 Flash'],
  ['Tier 4/Gemini 3_6 Flash.html', 'Gemini 3.6 Flash', 'Gemini 3.6 Flash'],
  ['Tier 4/Gemini 3_5 flash lite Extended thinking zen_sanctuary.html', 'Gemini 3.5 Flash Lite Extended Thinking', 'Gemini 3.5 Flash Lite'],
  ['Tier 4/Copilot free think deeper Zen Temple.html', 'Copilot Free (Think Deeper)', 'Copilot'],
  ['Tier 4/Beam Max Zen Sanctuary.html', 'Beam Max', 'Beam'],
].map(([file, label, family, note]) => ({ file, label, family, note: note || null }));

// Exact-string patches for visible branding that survives the title rewrite.
// Filled in after the first leak scan.
const PATCHES = {
};

const BRANDS = [
  'ChatGPT', 'OpenAI', 'Anthropic', 'Claude', 'Opus', 'Sonnet', 'Gemini',
  'DeepSeek', 'Grok', 'Kimi', 'Moonshot', 'MiniMax', 'MiMo', 'Qwen', 'Alibaba',
  'GLM', 'Zhipu', 'Nemotron', 'NVIDIA', 'Gemma', 'Mercury', 'Inception',
  'LongCat', 'Tencent', 'Hunyuan', 'Copilot', 'OpenRouter', 'OpenCode',
  'Antigravity', 'Space Bunny', 'Union Alpha', 'Cat Jam', 'Iceman',
  'Big Pickle', 'Muse Spark', 'MAI-1', 'Solar Pro', 'Step 3.7', 'Step 5',
  'GPT-6', 'GPT-5', 'GPT-4', 'o4-mini', 'Beam Max', 'Ox Alpha',
];

const sha = (s) => createHash('sha256').update(s).digest('hex');
const norm = (p) => p.split(path.sep).join('/');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const brandRe = new RegExp(`\\b(${BRANDS.map(escapeRe).join('|')})\\b`, 'i');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.name.toLowerCase().endsWith('.html')) out.push(full);
  }
  return out;
}

function sanitize(html) {
  let out = html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, '<title>Zen Sanctuary</title>');
  if (!/<title\b/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, (m) => `${m}\n<title>Zen Sanctuary</title>`);
  }
  if (!/<meta\s+name=["']robots["']/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, (m) => `${m}\n<meta name="robots" content="noindex, nofollow">`);
  }
  return out;
}

function visibleText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-zA-Z#0-9]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findLeaks(html) {
  const leaks = [];
  const push = (where, text) => {
    const m = text.match(brandRe);
    if (m) leaks.push({ where, match: m[0], context: text.slice(Math.max(0, m.index - 45), m.index + 65).replace(/\s+/g, ' ') });
  };
  push('visible', visibleText(html));
  for (const m of html.matchAll(/<!--([\s\S]*?)-->/g)) push('comment', m[1]);
  for (const m of html.matchAll(/(?:alt|title|aria-label|placeholder)\s*=\s*["']([^"']{3,300})["']/gi)) push('attribute', m[1]);
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) if (/name=["'](author|generator|description)["']/i.test(m[0])) push('meta', m[0]);
  // Dynamic UI strings and code comments. Report only, so a human can judge context.
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) push('script', m[1]);
  const seen = new Set();
  return leaks.filter((l) => {
    const k = `${l.where}|${l.match}|${l.context}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function main() {
  const errors = [];
  const sources = [];
  for (const tier of TIERS) {
    const dir = path.join(ROOT, tier);
    for (const full of await walk(dir)) {
      const rel = norm(path.relative(ROOT, full));
      if (EXCLUDED.has(rel)) continue;
      const buf = await readFile(full);
      sources.push({ rel, full, hash: sha(buf), buf });
    }
  }
  sources.sort((a, b) => a.rel.localeCompare(b.rel));

  const rosterByFile = new Map(ROSTER.map((r) => [r.file, r]));
  const byHash = new Map();
  const unique = [];
  const duplicates = [];
  for (const s of sources) {
    const prev = byHash.get(s.hash);
    if (!prev) { byHash.set(s.hash, s); unique.push(s); continue; }
    // Prefer the file named in the manual roster as the canonical copy.
    if (rosterByFile.has(s.rel) && !rosterByFile.has(prev.rel)) {
      unique[unique.indexOf(prev)] = s;
      byHash.set(s.hash, s);
      duplicates.push({ ...prev, duplicateOf: s.rel });
    } else {
      duplicates.push({ ...s, duplicateOf: prev.rel });
    }
  }

  for (const s of unique) {
    if (!rosterByFile.has(s.rel)) errors.push(`No roster entry for: ${s.rel}`);
  }
  for (const r of ROSTER) {
    if (!unique.some((s) => s.rel === r.file)) errors.push(`Roster file not found (or duplicate): ${r.file}`);
  }
  if (errors.length) {
    console.error('\nROSTER ERRORS');
    for (const e of errors) console.error('  -', e);
    process.exit(1);
  }

  await rm(SIMS_OUT, { recursive: true, force: true });
  await rm(DATA_OUT, { recursive: true, force: true });
  await mkdir(SIMS_OUT, { recursive: true });
  await mkdir(DATA_OUT, { recursive: true });
  await mkdir(PRIVATE, { recursive: true });

  const publicSims = [];
  const privateSims = [];
  const allLeaks = [];

  for (const s of unique) {
    const entry = rosterByFile.get(s.rel);
    let html = s.buf.toString('utf8');
    for (const [from, to] of (PATCHES[s.rel] || [])) {
      if (!html.includes(from)) errors.push(`Patch target not found in ${s.rel}: ${from.slice(0, 60)}`);
      html = html.split(from).join(to);
    }
    html = sanitize(html);
    const leaks = findLeaks(html);
    for (const l of leaks) allLeaks.push({ file: s.rel, ...l });

    const id = sha(`zen-arena-v1|${s.rel}`).slice(0, 10);
    const group = sha(`zen-arena-family-v1|${entry.family}`).slice(0, 6);
    await writeFile(path.join(SIMS_OUT, `${id}.html`), html, 'utf8');
    publicSims.push({ id, g: group });
    privateSims.push({
      id,
      label: entry.label,
      family: entry.family,
      tier: Number(s.rel.match(/^Tier (\d)/)?.[1] || 0),
      note: entry.note,
      file: s.rel,
      sha256: s.hash,
    });
  }

  publicSims.sort((a, b) => a.id.localeCompare(b.id));
  privateSims.sort((a, b) => a.label.localeCompare(b.label));

  await writeFile(
    path.join(DATA_OUT, 'sims.json'),
    JSON.stringify({ version: 1, count: publicSims.length, sims: publicSims }, null, 0),
    'utf8',
  );
  await writeFile(
    path.join(PRIVATE, 'roster.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), count: privateSims.length, sims: privateSims }, null, 2),
    'utf8',
  );
  // Public, simplified mapping used by the post-vote ranking on the arena page.
  await writeFile(
    path.join(DATA_OUT, 'roster.json'),
    JSON.stringify({
      v: 1,
      count: privateSims.length,
      sims: privateSims.map(({ id, label, family }) => ({ id, label, family })),
    }, null, 0),
    'utf8',
  );

  const passphrase = (await readFile(path.join(PRIVATE, 'passphrase.txt'), 'utf8')).trim();
  if (passphrase.length < 12) throw new Error('Passphrase must be at least 12 characters.');
  const payload = {
    v: 1,
    generatedAt: new Date().toISOString(),
    count: privateSims.length,
    sims: privateSims.map(({ id, label, family, tier, note }) => ({ id, label, family, tier, note })),
  };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(passphrase, salt, 310000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  await writeFile(
    path.join(DATA_OUT, 'roster.locked.json'),
    JSON.stringify({
      v: 1,
      kdf: 'PBKDF2-SHA256',
      iterations: 310000,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      data: ciphertext.toString('base64'),
    }),
    'utf8',
  );

  console.log(`\nBuilt ${unique.length} simulations.`);
  console.log(`Duplicates skipped: ${duplicates.length}`);
  for (const d of duplicates) console.log(`  = ${d.rel}  (same bytes as ${d.duplicateOf})`);
  console.log(`Public data: public/data/sims.json (${publicSims.length} opaque ids)`);
  console.log(`Public roster: public/data/roster.json (${privateSims.length} labels)`);
  console.log(`Private roster: private/roster.json`);
  console.log(`Locked roster: public/data/roster.locked.json`);
  if (errors.length) {
    console.error('\nPATCH ERRORS');
    for (const e of errors) console.error('  -', e);
    process.exit(1);
  }

  if (allLeaks.length) {
    console.log(`\nPotential branding leaks: ${allLeaks.length}`);
    for (const l of allLeaks.slice(0, 80)) {
      console.log(`  [${l.where}] ${l.file} :: ${l.match} :: ${l.context}`);
    }
    if (allLeaks.length > 80) console.log(`  ... and ${allLeaks.length - 80} more`);
    if (STRICT) {
      console.error('\nStrict mode: leaks remain. Add patches or rewrite the source UI.');
      process.exit(1);
    }
  } else {
    console.log('\nNo model-name leaks found in deployed copies.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
