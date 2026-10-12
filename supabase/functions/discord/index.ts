// Mon Stock — bot Discord (Supabase Edge Function « discord »)
// Commandes : /tresorerie /mois /carte /objectifs /reglage
// Discord envoie chaque commande ici (Interactions Endpoint URL). La signature Ed25519 de Discord est vérifiée,
// puis les chiffres sont calculés comme sur stock.philoudng.fr à partir de la copie en ligne (table stock_entries).
// Réglages dans la table bot_config (accessible seulement côté serveur) ; jeton du bot dans le secret DISCORD_BOT_TOKEN.

const SB_URL = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');

function serviceKey() {
  const k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (k) return k;
  try {
    const j = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    const v = Object.values(j)[0];
    if (typeof v === 'string') return v;
  } catch (_) { /* rien */ }
  return '';
}

async function db(path, init) {
  init = init || {};
  const key = serviceKey();
  const h = { apikey: key, 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (!key.startsWith('sb_')) h.Authorization = 'Bearer ' + key;
  const r = await fetch(SB_URL + '/rest/v1/' + path, { ...init, headers: h });
  const t = await r.text();
  if (!r.ok) throw new Error('db ' + r.status + ' ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

let cfgCache = null, cfgAt = 0;
async function config(force) {
  if (!force && cfgCache && Date.now() - cfgAt < 30000) return cfgCache;
  const rows = await db('bot_config?select=key,value');
  const c = {};
  (rows || []).forEach(r => { c[r.key] = r.value; });
  if (!c.discord_public_key && Deno.env.get('DISCORD_PUBLIC_KEY')) c.discord_public_key = Deno.env.get('DISCORD_PUBLIC_KEY');
  if (!c.discord_app_id && Deno.env.get('DISCORD_APP_ID')) c.discord_app_id = Deno.env.get('DISCORD_APP_ID');
  cfgCache = c; cfgAt = Date.now();
  return c;
}
async function setConfig(key, value) {
  await db('bot_config?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ key, value: value || '' }]) });
  cfgCache = null;
}

// ---- Signature Discord (Ed25519)
function hexBytes(s) {
  if (!s || s.length % 2) return new Uint8Array(0);
  const a = new Uint8Array(s.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16);
  return a;
}
async function verifySig(req, body, pub) {
  const sig = req.headers.get('x-signature-ed25519'), ts = req.headers.get('x-signature-timestamp');
  if (!sig || !ts || !pub) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hexBytes(pub), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, hexBytes(sig), new TextEncoder().encode(ts + body));
  } catch (_) { return false; }
}

// ---- Formats
const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const MCOURT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const GAMES = { pokemon: 'Pokémon', onepiece: 'One Piece', lorcana: 'Lorcana', riftbound: 'Riftbound', babaticket: 'Babaticket', divers: 'Divers', autre: 'Autres jeux' };
const GAME_ORDER = ['pokemon', 'onepiece', 'lorcana', 'riftbound', 'babaticket', 'divers', 'autre'];
const gameName = id => GAMES[id] || GAMES.autre;
const cents = n => Math.round(n * 100) / 100;
function eur(n) {
  n = cents(n || 0);
  const neg = n < 0;
  const [i, d] = Math.abs(n).toFixed(2).split('.');
  return (neg ? '−' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + d + ' €';
}
const sgn = n => (cents(n) > 0 ? '+' : '') + eur(n);
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const qteOf = e => Math.max(1, Math.round(e.qte || 1));
const puOf = e => typeof e.pu === 'number' ? e.pu : (e.montant || 0) / qteOf(e);
const mkey = s => { const m = /^(\d{4})-(\d{2})/.exec(s || ''); return m ? (+m[1]) * 12 + (+m[2] - 1) : null; };
function fdate(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? `${+m[3]} ${MCOURT[+m[2] - 1]} ${m[1]}` : ''; }
function parisToday() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (_) { return new Date().toISOString().slice(0, 10); }
}
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const lastCote = t => { const c = Array.isArray(t.cotes) ? t.cotes : []; return c.length ? c[c.length - 1] : null; };
function cmUrl(u) { try { const x = new URL(u); return x.protocol === 'https:' && (x.hostname === 'cardmarket.com' || x.hostname.endsWith('.cardmarket.com') || x.hostname === 'prices.pokemontcg.io') ? x.href : ''; } catch (_) { return ''; } }

// ---- Calculs (identiques au site)
function norm(e) {
  if (e.kind === 'achat' && e.cat === 'cartes') return { ...e, kind: 'tcg', jeu: 'autre', sens: 'achat' };
  if (e.kind === 'vente') return { ...e, kind: 'tcg', jeu: 'autre', sens: 'vente', libelle: e.article, montant: e.prix };
  return e;
}
function makeCalc(raw, today) {
  const NOWK = mkey(today);
  const all = raw.map(norm);
  const of = k => all.filter(e => e.kind === k);
  function subCost(a, k) {
    const s = mkey(a.date); if (s === null || k < s) return 0;
    const end = a.actif === false ? (mkey(a.fin) ?? s) : Infinity;
    if (k > end) return 0;
    if (a.freq === 'annuel') return ((k - s) % 12 === 0) ? a.montant : 0;
    return a.montant;
  }
  const implicitCost = t => (t.kind === 'tcg' && t.sens === 'vente' && !t.achatId && typeof t.cout === 'number' && t.cout > 0) ? t.cout : 0;
  const costDate = t => t.cdate || t.date;
  function flowOf(e) {
    if (e.kind === 'tcg') return e.sens === 'vente' ? e.montant : -e.montant;
    if (e.kind === 'achat' && e.cat === 'abonnement') { const s = mkey(e.date); if (s === null) return 0; let t = 0; for (let k = s; k <= NOWK; k++) t += subCost(e, k); return -t; }
    if (e.kind === 'achat') return -e.montant;
    return 0;
  }
  const soldeOf = c => cents((c.solde || 0) + all.filter(e => e.compteId === c._id && e.kind !== 'compte').reduce((s, e) => s + flowOf(e), 0));
  function soldMap() { const m = new Map(); of('tcg').forEach(t => { if (t.sens === 'vente' && t.achatId) m.set(t.achatId, (m.get(t.achatId) || 0) + qteOf(t)); }); return m; }
  function stockItems() {
    const sold = soldMap();
    return of('tcg').filter(t => t.sens === 'achat').map(t => {
      const rem = Math.max(0, qteOf(t) - (sold.get(t._id) || 0)); if (!rem) return null;
      const lc = lastCote(t);
      return { t, rem, val: cents((lc ? lc.prix : puOf(t)) * rem), cost: cents(puOf(t) * rem), coted: !!lc };
    }).filter(Boolean);
  }
  function stockTotals() { const it = stockItems(); return { val: cents(it.reduce((s, x) => s + x.val, 0)), cost: cents(it.reduce((s, x) => s + x.cost, 0)), items: it }; }
  const cashTotal = () => cents(of('compte').reduce((s, c) => s + soldeOf(c), 0));
  function monthTotals(k) {
    const ach = of('achat'), tcg = of('tcg');
    const abos = ach.filter(a => a.cat === 'abonnement').reduce((s, a) => s + subCost(a, k), 0);
    const autres = ach.filter(a => a.cat === 'autre' && mkey(a.date) === k).reduce((s, a) => s + a.montant, 0);
    const inMonth = tcg.filter(t => mkey(t.date) === k);
    const hidden = tcg.filter(t => implicitCost(t) && mkey(costDate(t)) === k);
    const tcgOut = inMonth.filter(t => t.sens === 'achat' && !t.obtenu).reduce((s, t) => s + t.montant, 0) + hidden.reduce((s, t) => s + implicitCost(t), 0);
    const ventes = inMonth.filter(t => t.sens === 'vente');
    const tcgIn = ventes.reduce((s, t) => s + t.montant, 0);
    const marge = ventes.filter(t => typeof t.cout === 'number').reduce((s, t) => s + t.montant - t.cout, 0);
    const out = abos + autres + tcgOut;
    return { abos, autres, tcgOut, tcgIn, marge, out, net: tcgIn - out, nV: ventes.length, nMiss: ventes.filter(t => typeof t.cout !== 'number').length };
  }
  function monthLines(k) {
    const out = [], inn = [], obt = [];
    of('achat').filter(a => a.cat === 'abonnement').forEach(a => { const c = subCost(a, k); if (c) out.push({ t: a.libelle, d: 'abonnement', a: c }); });
    of('achat').filter(a => a.cat === 'autre' && mkey(a.date) === k).forEach(a => out.push({ t: a.libelle, d: 'achat', a: a.montant }));
    of('tcg').filter(t => implicitCost(t) && mkey(costDate(t)) === k).forEach(t => out.push({ t: t.libelle, d: gameName(t.jeu) + ' · prix d’achat d’une vente', a: implicitCost(t) }));
    of('tcg').filter(t => mkey(t.date) === k).forEach(t => {
      if (t.obtenu) { const lc = lastCote(t); obt.push({ t: t.libelle, d: gameName(t.jeu), a: lc ? cents(lc.prix * qteOf(t)) : 0, q: qteOf(t) }); }
      else if (t.sens === 'achat') out.push({ t: t.libelle, d: gameName(t.jeu), a: t.montant });
      else inn.push({ t: t.libelle, d: gameName(t.jeu), a: t.montant, m: typeof t.cout === 'number' ? t.montant - t.cout : null });
    });
    return { out, inn, obt };
  }
  function goalValue(g) {
    const src = g && g.source || 'total';
    if (src === 'total') return cashTotal() + stockTotals().val;
    if (src === 'cash') return cashTotal();
    const c = of('compte').find(x => x._id === src); return c ? soldeOf(c) : 0;
  }
  return { NOWK, all, of, subCost, implicitCost, costDate, soldeOf, soldMap, stockItems, stockTotals, cashTotal, monthTotals, monthLines, goalValue };
}

const EMO_RULES = [
  [/voiture|auto\b|permis|tesla|golf\b|clio|208|bmw|audi|mercedes/, '🚗'], [/moto|scooter/, '🏍️'], [/v[ée]lo|trottinette/, '🚲'],
  [/maison|appart|logement|loyer|immo|d[ée]m[ée]nag/, '🏠'], [/voyage|vacances|japon|tokyo|avion|s[ée]jour|trip/, '✈️'],
  [/ps5|ps4|playstation|console|switch|xbox|jeu vid|gaming/, '🎮'], [/\bpc\b|ordi|laptop|macbook|mac\b|setup|[ée]cran/, '💻'],
  [/t[ée]l[ée]phone|iphone|samsung|smartphone|pixel/, '📱'], [/montre|rolex|watch/, '⌚'], [/bague|mariage|fian/, '💍'],
  [/[ée]pargne|urgence|s[ée]curit[ée]|matelas|livret/, '🛟'], [/pok[ée]mon|carte|display|booster|tcg|lorcana|one piece|riftbound|psa|grad/, '🃏'],
  [/[ée]tude|[ée]cole|fac|formation|dipl/, '🎓'], [/cadeau|anniv|no[ëe]l/, '🎁'], [/chaussure|sneaker|jordan|nike/, '👟'],
  [/v[êe]tement|habit|manteau|veste/, '👕'], [/photo|cam[ée]ra|appareil/, '📷'], [/t[ée]l[ée]\b|tv\b|t[ée]l[ée]vis/, '📺'],
  [/guitare|piano|musique|instrument/, '🎸'], [/chien|chiot/, '🐶'], [/chat\b|chaton/, '🐱'], [/b[ée]b[ée]|naissance/, '👶'],
  [/sport|salle|muscu|gym/, '🏋️'], [/concert|festival|billet|ticket/, '🎟️'], [/imp[ôo]t|taxe|facture/, '🧾'],
  [/restau|resto|repas/, '🍽️'], [/invest|bourse|action|crypto|bitcoin|etf/, '📈'], [/meuble|canap|lit\b|d[ée]co/, '🛋️'],
];
function autoEmoji(nom) { const n = (nom || '').toLowerCase(); for (const [re, e] of EMO_RULES) if (re.test(n)) return e; return '🎯'; }

// ---- Données
async function loadData(uid) {
  if (!/^[0-9a-f-]{36}$/i.test(uid || '')) throw new Error('owner');
  const rows = await db(`stock_entries?select=id,data&user_id=eq.${uid}&deleted=eq.false&limit=5000`);
  return (rows || []).filter(r => r.data && typeof r.data === 'object').map(r => ({ ...r.data, _id: r.id }));
}

// ---- Réponses Discord
const COLOR = 0x1f5c4a;
const FOOT = { text: 'Mon Stock · stock.philoudng.fr' };
function reply(content, eph, embeds, components) {
  const data = { content: content || '', embeds: embeds || [], flags: eph ? 64 : 0, allowed_mentions: { parse: [] } };
  if (components) data.components = components;
  return { type: 4, data };
}
function joinLines(lines, max) {
  let s = '', n = 0;
  for (const l of lines) { if ((s + l + '\n').length > max - 30) { s += `… et ${lines.length - n} autre${lines.length - n > 1 ? 's' : ''}`; return s; } s += l + '\n'; n++; }
  return s.trim() || '—';
}
const opt = (it, name) => { const o = (it.data.options || []).find(x => x.name === name); return o ? o.value : undefined; };

function cmdTresorerie(C) {
  const comptes = C.of('compte');
  const cash = C.cashTotal(), st = C.stockTotals();
  const fields = [];
  [['banque', '🏦 Banques'], ['espece', '💶 Espèces']].forEach(([t, title]) => {
    const g = comptes.filter(c => c.type === t).sort((a, b) => String(a.nom).localeCompare(String(b.nom), 'fr', { sensitivity: 'base', numeric: true }));
    if (!g.length) return;
    fields.push({ name: `${title} · ${eur(g.reduce((s, c) => s + C.soldeOf(c), 0))}`, value: joinLines(g.map(c => `${clip(c.nom, 40)} — **${eur(C.soldeOf(c))}**`), 1024) });
  });
  if (st.items.length) {
    const lines = GAME_ORDER.map(id => {
      const its = st.items.filter(x => (x.t.jeu || 'autre') === id); if (!its.length) return null;
      const v = its.reduce((s, x) => s + x.val, 0), c = its.reduce((s, x) => s + x.cost, 0);
      return `${gameName(id)} — **${eur(v)}** (payé ${eur(c)}, ${sgn(v - c)})`;
    }).filter(Boolean);
    fields.push({ name: `🃏 Stock · ${eur(st.val)}`, value: joinLines(lines, 1024) + `\nPlus-value latente : **${sgn(st.val - st.cost)}**` });
  }
  const subs = C.of('achat').filter(a => a.cat === 'abonnement' && a.actif !== false);
  const perMonth = subs.reduce((s, a) => s + (a.freq === 'annuel' ? a.montant / 12 : a.montant), 0);
  if (subs.length) fields.push({ name: '🔁 Abonnements', value: `${eur(perMonth)} par mois · ${subs.length} actif${subs.length > 1 ? 's' : ''} · ${eur(perMonth * 12)}/an` });
  const esp = comptes.filter(c => c.type === 'espece').reduce((s, c) => s + C.soldeOf(c), 0);
  return [{ title: '💰 Trésorerie', color: COLOR, description: `**${eur(cash + st.val)}** au total\n${eur(cash)} d’argent${esp ? ` (dont ${eur(esp)} en espèces)` : ''} · ${eur(st.val)} de stock`, fields, footer: FOOT, timestamp: new Date().toISOString() }];
}

function cmdMois(C, it) {
  let k = C.NOWK;
  const m = opt(it, 'mois'), y = opt(it, 'annee');
  const Y = Number.isInteger(y) ? y : Math.floor(C.NOWK / 12);
  const M = Number.isInteger(m) && m >= 1 && m <= 12 ? m - 1 : (Number.isInteger(y) ? C.NOWK % 12 : C.NOWK % 12);
  k = Y * 12 + M;
  const t = C.monthTotals(k), L = C.monthLines(k);
  const fields = [
    { name: 'Dépenses', value: `**${eur(t.out)}**\n${eur(t.abos)} abonnements · ${eur(t.tcgOut + t.autres)} achats`, inline: true },
    { name: 'Ventes', value: `**${eur(t.tcgIn)}**\n${t.nV} vente${t.nV > 1 ? 's' : ''}`, inline: true },
    { name: 'Net', value: `**${sgn(t.net)}**\nventes − dépenses`, inline: true },
    { name: 'Bénéfice', value: `**${sgn(t.marge)}**\nmarge sur les ventes${t.nMiss ? ` (${t.nMiss} sans prix d’achat)` : ''}`, inline: true },
  ];
  if (L.obt.length) { const v = L.obt.reduce((s, r) => s + r.a, 0), n = L.obt.reduce((s, r) => s + r.q, 0); fields.push({ name: 'Obtenu', value: `**${n}** article${n > 1 ? 's' : ''}${v ? `\n≈ ${eur(v)} à la cote` : ''}`, inline: true }); }
  const byAmt = (a, b) => b.a - a.a;
  if (L.out.length) fields.push({ name: `Détail des dépenses (${L.out.length})`, value: joinLines(L.out.sort(byAmt).map(r => `−${eur(r.a)} · ${clip(r.t, 50)} *(${r.d})*`), 1024) });
  if (L.inn.length) fields.push({ name: `Détail des ventes (${L.inn.length})`, value: joinLines(L.inn.sort(byAmt).map(r => `+${eur(r.a)} · ${clip(r.t, 50)}${r.m !== null ? ` *(marge ${sgn(r.m)})*` : ''}`), 1024) });
  if (L.obt.length) fields.push({ name: `Obtenu (${L.obt.length})`, value: joinLines(L.obt.map(r => `${clip(r.t, 50)}${r.q > 1 ? ` ×${r.q}` : ''}${r.a ? ` · ≈ ${eur(r.a)}` : ''} *(${r.d})*`), 1024) });
  const empty = !L.out.length && !L.inn.length && !L.obt.length;
  return [{ title: `📅 ${MOIS[M]} ${Y}`, color: t.net >= 0 ? 0x1d7a4f : 0xb3402f, description: empty ? 'Rien d’enregistré ce mois-ci.' : undefined, fields: empty ? [] : fields, footer: FOOT }];
}

// ---- /carte : séries d'abord, tri, et grande fiche de carte avec navigation (boutons et menus)
let serCache = null, serAt = 0;
async function seriesNames() {
  if (serCache && Date.now() - serAt < 6 * 3600e3) return serCache;
  try {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch('https://raw.githubusercontent.com/philoudng/mon-stock/main/data/series.json', { signal: ctl.signal });
    clearTimeout(tm);
    if (r.ok) { serCache = await r.json(); serAt = Date.now(); }
  } catch (_) { /* noms complets indisponibles : codes seuls */ }
  return serCache || { pk: {}, op: {} };
}
const keyClean = s => String(s || '').replace(/[|~]/g, '/').slice(0, 30);
function serieOf(t, SER) {
  const jeu = t.jeu || 'autre', lib = String(t.libelle || '');
  let code = '', label = '';
  if (t.serieCode) { code = keyClean(t.serieCode); label = t.serie || ''; }
  else if (jeu === 'onepiece') {
    const m = lib.match(/\b(OP|ST|EB|PRB)-?(\d{2})\b/i);
    if (m) code = m[1].toUpperCase() + m[2];
    else if (/\bP-\d{3}\b/i.test(lib)) code = 'P';
    if (code) label = (SER.op || {})[code] || (code === 'P' ? 'Promos' : '');
  } else if (jeu === 'pokemon') {
    const g = lib.match(/\(([^()]+)\)\s*$/);
    const tok = g ? g[1].trim().split(/\s+/)[0].toUpperCase() : '';
    if (tok && (SER.pk || {})[tok] && /\d/.test(g[1])) { code = tok; label = SER.pk[tok]; }
  }
  if (!code && t.serie) code = keyClean(t.serie);
  // Produits scellés : nom de l'extension dans l'article (ex. « The Time of Battle Booster Box » → OP16)
  if (!code && (jeu === 'onepiece' || jeu === 'pokemon')) {
    const names = (jeu === 'onepiece' ? SER.op : SER.pk) || {}, f = fold(lib);
    let best = '';
    for (const [c, n] of Object.entries(names)) { const fn = fold(n); if (fn.length >= 6 && f.includes(fn) && fn.length > fold(names[best] || '').length) best = c; }
    if (best) { code = best; label = names[best]; }
  }
  if (code) return { key: `${jeu}~${code}`, jeu, code, label, name: `${gameName(jeu)} · ${code}${label && label !== code ? ' — ' + label : ''}` };
  const cat = keyClean(t.categorie || 'Autres articles');
  return { key: `${jeu}~#${cat}`, jeu, code: '', label: cat, name: `${gameName(jeu)} · ${cat}` };
}
function numOf(t) {
  const lib = String(t.libelle || '');
  let m = lib.match(/\b(?:OP|ST|EB|PRB)-?\d{2}-(\d{3})\b/i) || lib.match(/\bP-(\d{3})\b/i);
  if (m) { const v = lib.match(/\(V\.(\d+)\)/i); return +m[1] + (v ? +v[1] / 100 : 0); }
  m = lib.match(/(\d{1,3})\s*\/\s*\d{1,3}/); if (m) return +m[1];
  m = lib.match(/\([^()]*?(\d{1,3})\)\s*$/); if (m) return +m[1];
  return 1e9;
}
function collection(C, SER) {
  const sold = C.soldMap();
  return C.of('tcg').filter(t => t.libelle && !(t.sens === 'vente' && t.achatId)).map(t => {
    const q = qteOf(t), lc = lastCote(t);
    const rem = t.sens === 'achat' ? Math.max(0, q - (sold.get(t._id) || 0)) : 0;
    const gain = lc && rem ? cents((t.obtenu ? lc.prix : lc.prix - puOf(t)) * rem) : null;
    return { t, s: serieOf(t, SER), rem, q, lc, cote: lc ? lc.prix : null, gain, num: numOf(t) };
  });
}
const TRIS = { numero: 'numéro', recent: 'plus récents', cote: 'cote', plusvalue: 'plus-value', prix: 'prix payé', nom: 'nom' };
function sortItems(list, tri) {
  const by = {
    numero: (a, b) => a.num - b.num || fold(a.t.libelle).localeCompare(fold(b.t.libelle)),
    recent: (a, b) => String(b.t.date || '').localeCompare(String(a.t.date || '')),
    cote: (a, b) => (b.cote ?? -1) - (a.cote ?? -1),
    plusvalue: (a, b) => (b.gain ?? -1e9) - (a.gain ?? -1e9),
    prix: (a, b) => (b.t.montant || 0) - (a.t.montant || 0),
    nom: (a, b) => fold(a.t.libelle).localeCompare(fold(b.t.libelle)),
  }[tri] || (() => 0);
  const owned = x => (x.rem > 0 ? 0 : 1);  // ce que tu as encore d'abord, puis le vendu
  return list.slice().sort((a, b) => owned(a) - owned(b) || by(a, b) || String(b.t.date || '').localeCompare(String(a.t.date || '')));
}
const GCOLOR = { pokemon: 0xE3B323, onepiece: 0xC8352B, lorcana: 0x5B4BA8, riftbound: 0x2A7AB8, babaticket: 0xD9637E, divers: 0x6B7A75, autre: 0x6B7A75 };
function bigImg(t) {
  const u = (Array.isArray(t.img) ? t.img : []).find(x => /^https:\/\//.test(x || ''));
  if (!u) return '';
  if (/assets\.tcgdex\.net/.test(u)) return u.replace(/\/(?:low|high)\.(?:webp|png|jpg)(\?.*)?$/, '/high.png');
  if (/images\.pokemontcg\.io/.test(u) && !/_hires/.test(u)) return u.replace(/\.png(\?.*)?$/, '_hires.png');
  return u;
}
const cardShort = x => [x.rem ? `${x.rem} en stock` : x.t.sens === 'vente' ? `vendu ${eur(x.t.montant)}` : 'tout vendu', x.cote ? `cote ${eur(x.cote)}` : ''].filter(Boolean).join(' · ');
function cardEmbed(x, idx, total, tri) {
  const t = x.t, lc = x.lc, q = x.q, rem = x.rem, fields = [];
  if (t.obtenu) fields.push({ name: '🎁 Obtenu', value: `sans dépense\nle ${fdate(t.date)}`, inline: true });
  else if (t.sens === 'achat') fields.push({ name: '🛒 Payé', value: `**${eur(t.montant)}**${q > 1 ? `\n${q} × ${eur(puOf(t))}` : ''}\nle ${fdate(t.date)}`, inline: true });
  else fields.push({ name: '💸 Vendu', value: `**${eur(t.montant)}**${typeof t.cout === 'number' ? `\nmarge ${sgn(t.montant - t.cout)}` : ''}\nle ${fdate(t.date)}`, inline: true });
  if (t.sens === 'achat') fields.push({ name: '📦 En stock', value: rem ? `**${rem}** sur ${q}` : 'Tout vendu', inline: true });
  if (lc) fields.push({ name: '📈 Cote Cardmarket', value: `**${eur(lc.prix)}**${lc.min ? `\ndès ${eur(lc.min)}` : ''}\nau ${fdate(lc.date)}`, inline: true });
  if (x.gain !== null) fields.push({ name: t.obtenu ? '💎 Valeur' : '💹 Plus-value', value: `**${t.obtenu ? '≈ ' + eur(x.gain) : sgn(x.gain)}**${rem > 1 ? `\nsur ${rem} ex.` : ''}`, inline: true });
  if (t.plateforme) fields.push({ name: t.sens === 'vente' ? '🏷️ Vendu sur' : '🏷️ Où', value: clip(t.plateforme, 100), inline: true });
  if (t.categorie) fields.push({ name: '🗃️ Catégorie', value: clip(t.categorie, 100), inline: true });
  const url = cmUrl(t.lien);
  const e = { author: { name: clip(x.s.name, 250) }, title: clip(t.libelle, 250), color: GCOLOR[t.jeu] || COLOR, fields,
    footer: { text: `${total > 1 ? `Carte ${idx + 1} / ${total} · tri : ${TRIS[tri] || tri} · ` : ''}Mon Stock` } };
  if (url) { e.url = url; e.description = `🔗 [Voir sur Cardmarket](${url})`; }
  const img = bigImg(t); if (img) e.image = { url: img };
  return e;
}
const cid = (op, page, tri, serie, q) => [op, page, tri || '', String(serie || '').replace(/\|/g, '/'), clip(String(q || '').replace(/\|/g, ' '), 40)].join('|').slice(0, 100);
const btnSeries = tri => ({ type: 2, style: 2, emoji: { name: '🗂️' }, label: 'Toutes les séries', custom_id: cid('o', 0, tri, '', '') });
function cardComponents(list, idx, tri, serie, q) {
  const rows = [], total = list.length;
  if (total > 1) {
    rows.push({ type: 1, components: [
      { type: 2, style: 2, emoji: { name: '⏮️' }, custom_id: cid('f', 0, tri, serie, q), disabled: idx === 0 },
      { type: 2, style: 1, emoji: { name: '◀️' }, custom_id: cid('b', Math.max(0, idx - 1), tri, serie, q), disabled: idx === 0 },
      { type: 2, style: 2, label: `${idx + 1} / ${total}`, custom_id: cid('x', idx, tri, serie, q), disabled: true },
      { type: 2, style: 1, emoji: { name: '▶️' }, custom_id: cid('n', Math.min(total - 1, idx + 1), tri, serie, q), disabled: idx >= total - 1 },
      { type: 2, style: 2, emoji: { name: '⏭️' }, custom_id: cid('l', total - 1, tri, serie, q), disabled: idx >= total - 1 },
    ] });
    const start = Math.max(0, Math.min(idx - 12, total - 25));
    rows.push({ type: 1, components: [{ type: 3, custom_id: cid('j', 0, tri, serie, q), placeholder: 'Aller à une carte…',
      options: list.slice(start, start + 25).map((x, k) => ({ label: clip(`${start + k + 1}. ${x.t.libelle}`, 100), value: String(start + k), description: clip(cardShort(x), 100) || undefined, default: start + k === idx })) }] });
    rows.push({ type: 1, components: [{ type: 3, custom_id: cid('t', 0, tri, serie, q), placeholder: 'Trier par…',
      options: Object.entries(TRIS).map(([k, v]) => ({ label: `Trier par ${v}`, value: k, default: k === tri })) }] });
  }
  rows.push({ type: 1, components: [btnSeries(tri)] });
  return rows;
}
function seriesGroups(all) {
  const map = new Map();
  all.forEach(x => {
    const g = map.get(x.s.key) || { s: x.s, items: 0, val: 0 };
    g.items++; if (x.rem) g.val += (x.cote ?? puOf(x.t)) * x.rem;
    map.set(x.s.key, g);
  });
  return [...map.values()].sort((a, b) => GAME_ORDER.indexOf(a.s.jeu) - GAME_ORDER.indexOf(b.s.jeu) || b.val - a.val || a.s.name.localeCompare(b.s.name));
}
function seriesOverview(all, tri) {
  const groups = seriesGroups(all);
  if (!groups.length) return { content: 'Aucune carte dans ton stock pour l’instant.', embeds: [], components: [] };
  const fields = GAME_ORDER.map(j => {
    const gs = groups.filter(g => g.s.jeu === j); if (!gs.length) return null;
    return { name: `${gameName(j)} · ${gs.length} série${gs.length > 1 ? 's' : ''}`, value: joinLines(gs.map(g => `**${g.s.code || g.s.label}**${g.s.code && g.s.label && g.s.label !== g.s.code ? ` — ${clip(g.s.label, 38)}` : ''} · ${g.items} article${g.items > 1 ? 's' : ''}${g.val ? ` · ≈ ${eur(g.val)}` : ''}`), 1024) };
  }).filter(Boolean);
  const top = groups.slice().sort((a, b) => b.val - a.val).slice(0, 25);
  const pick = groups.filter(g => top.includes(g));
  return { content: '', embeds: [{ title: '🗂️ Tes séries', color: COLOR, description: 'Choisis une série dans le menu pour voir ses cartes en grand, une par une.\nAstuce : `/carte serie:` puis `nom:` pour aller directement à une carte.', fields: fields.slice(0, 25), footer: FOOT }],
    components: [{ type: 1, components: [{ type: 3, custom_id: cid('v', 0, tri, '', ''), placeholder: 'Choisir une série…',
      options: pick.map(g => ({ label: clip(g.s.name, 100), value: g.s.key.slice(0, 100), description: clip(`${g.items} article${g.items > 1 ? 's' : ''}${g.val ? ` · ≈ ${eur(g.val)}` : ''}`, 100) })) }] }] };
}
const inSerie = (x, s) => !s || (s.endsWith('~*') ? x.s.jeu === s.slice(0, -2) : x.s.key === s);
function resolveSerie(all, s) {
  if (!s || s.endsWith('~*') || all.some(x => x.s.key === s)) return s;
  const f = fold(s).trim();
  const m = all.find(x => fold(x.s.code) === f) || all.find(x => fold(x.s.label) === f) || all.find(x => fold(x.s.name).includes(f));
  return m ? m.s.key : s;
}
async function carteView(C, a) {
  const SER = await seriesNames();
  const all = collection(C, SER);
  if (!a.serie && !a.q && !a.focusId) return seriesOverview(all, a.tri || 'numero');
  let s = resolveSerie(all, a.serie || ''), q = a.q || '';
  if (a.focusId) { const f = all.find(x => x.t._id === a.focusId); if (f) { s = f.s.key; q = ''; } }
  const tri = TRIS[a.tri] ? a.tri : (s ? (s.endsWith('~*') ? 'cote' : 'numero') : 'recent');
  const words = fold(q).split(/\s+/).filter(Boolean);
  const list = sortItems(all.filter(x => inSerie(x, s) && words.every(w => fold(`${x.t.libelle} ${x.t.categorie || ''} ${x.s.name}`).includes(w))), tri);
  if (!list.length) return { content: `Aucun article ne correspond${q ? ` à « ${clip(q, 60)} »` : ''}${s ? ' dans cette série' : ''}.`, embeds: [], components: [{ type: 1, components: [btnSeries(tri)] }] };
  let idx = Math.max(0, Math.min(list.length - 1, a.page || 0));
  if (a.focusId) { const k = list.findIndex(x => x.t._id === a.focusId); if (k >= 0) idx = k; }
  return { content: '', embeds: [cardEmbed(list[idx], idx, list.length, tri)], components: cardComponents(list, idx, tri, s, q) };
}

function cmdObjectifs(C) {
  const goals = C.of('objectif').slice().sort((a, b) => (a.montant || 0) - (b.montant || 0) || (a.createdAt || 0) - (b.createdAt || 0));
  if (!goals.length) return [{ title: '🎯 Objectifs', color: COLOR, description: 'Aucun objectif pour l’instant. Ajoute-en un sur stock.philoudng.fr.', footer: FOOT }];
  const lines = goals.map(g => {
    const have = C.goalValue(g), pct = g.montant > 0 ? Math.max(0, have / g.montant * 100) : 0;
    const n = Math.min(10, Math.floor(pct / 10));
    const bar = '▰'.repeat(n) + '▱'.repeat(10 - n);
    const pc = pct >= 100 ? '100 % ✓' : `${pct < 10 ? pct.toFixed(1).replace('.', ',') : Math.floor(pct)} %`;
    const src = g.source === 'cash' ? ' *(argent seulement)*' : g.source && g.source !== 'total' ? ` *(${clip((C.of('compte').find(c => c._id === g.source) || {}).nom || 'compte', 30)})*` : '';
    return `${g.emoji || autoEmoji(g.nom)} **${clip(g.nom || 'Objectif', 60)}**${src}\n${bar} ${pc}\n${eur(have)} / ${eur(g.montant)} · ${pct >= 100 ? 'atteint 🎉' : `reste ${eur(g.montant - have)}`}`;
  });
  return [{ title: '🎯 Objectifs', color: COLOR, description: joinLines(lines.map(l => l + '\n'), 4000), footer: FOOT }];
}

// ---- /pokemon, /onepiece… : petit résumé d'un jeu
const GAME_CMDS = { pokemon: ['pokemon', '⚡'], onepiece: ['onepiece', '🏴‍☠️'], lorcana: ['lorcana', '✨'], riftbound: ['riftbound', '🌀'], babaticket: ['babaticket', '🎟️'], divers: ['divers', '📦'] };
function gameStatsFor(C, jeu, test) {
  const tcg = C.of('tcg').filter(t => (t.jeu || 'autre') === jeu);
  const inP = t => test(mkey(t.date));
  const achats = tcg.filter(t => t.sens === 'achat' && !t.obtenu && inP(t));
  const ventes = tcg.filter(t => t.sens === 'vente' && inP(t));
  const hidden = tcg.filter(t => C.implicitCost(t) && test(mkey(C.costDate(t))));
  const out = achats.reduce((s, t) => s + (t.montant || 0), 0) + hidden.reduce((s, t) => s + C.implicitCost(t), 0);
  const inn = ventes.reduce((s, t) => s + (t.montant || 0), 0);
  const known = ventes.filter(t => typeof t.cout === 'number');
  const obt = tcg.filter(t => t.obtenu && inP(t)).reduce((s, t) => s + qteOf(t), 0);
  return { out, inn, net: inn - out, marge: known.reduce((s, t) => s + t.montant - t.cout, 0), nA: achats.length, nV: ventes.length, nMiss: ventes.length - known.length, obt };
}
function periodField(name, st, withMarge) {
  if (!st.nA && !st.nV && !st.out && !st.obt) return { name, value: 'Rien', inline: true };
  const lines = [`🛒 ${eur(st.out)}${st.nA ? ` (${st.nA} achat${st.nA > 1 ? 's' : ''})` : st.out ? ' (achats des ventes)' : ''}`, `💸 ${eur(st.inn)}${st.nV ? ` (${st.nV} vente${st.nV > 1 ? 's' : ''})` : ''}`, `**Net ${sgn(st.net)}**`];
  if (withMarge && st.nV) lines.push(`Bénéfice ${sgn(st.marge)}`);
  if (st.obt) lines.push(`🎁 ${st.obt} obtenu${st.obt > 1 ? 's' : ''}`);
  return { name, value: lines.join('\n'), inline: true };
}
function cmdJeu(C, SER, jeu) {
  const [, emoji] = GAME_CMDS[jeu] || ['', '🃏'];
  const all = collection(C, SER).filter(x => (x.t.jeu || 'autre') === jeu);
  if (!all.length) return { content: `Rien dans ${gameName(jeu)} pour l’instant.`, embeds: [], components: [] };
  const K = C.NOWK, Y = Math.floor(K / 12);
  const stock = all.filter(x => x.rem > 0);
  const val = stock.reduce((s, x) => s + (x.cote ?? puOf(x.t)) * x.rem, 0), cost = stock.reduce((s, x) => s + puOf(x.t) * x.rem, 0);
  const n = stock.reduce((s, x) => s + x.rem, 0), nCoted = stock.filter(x => x.cote !== null).length;
  const sY = gameStatsFor(C, jeu, k => k !== null && Math.floor(k / 12) === Y), sAll = gameStatsFor(C, jeu, () => true);
  const fields = [periodField(`📅 ${MOIS[K % 12]}`, gameStatsFor(C, jeu, k => k === K)), periodField(`📆 ${Y}`, sY, true)];
  if (cents(sAll.out) !== cents(sY.out) || cents(sAll.inn) !== cents(sY.inn) || sAll.obt !== sY.obt) fields.push(periodField('♾️ Depuis le début', sAll, true));
  const top = stock.filter(x => x.cote !== null).sort((a, b) => b.cote - a.cote).slice(0, 5);
  if (top.length) fields.push({ name: '🏆 Plus grosses cotes', value: joinLines(top.map((x, i) => `${['🥇', '🥈', '🥉', '4.', '5.'][i]} ${clip(x.t.libelle, 55)} — **${eur(x.cote)}**${x.rem > 1 ? ` ×${x.rem}` : ''}`), 1024) });
  const groups = seriesGroups(all);
  if (groups.length) fields.push({ name: `🗂️ Séries (${groups.length})`, value: joinLines(groups.slice(0, 6).map(g => `**${g.s.code || g.s.label}**${g.s.code && g.s.label && g.s.label !== g.s.code ? ` — ${clip(g.s.label, 32)}` : ''} · ${g.items} art.${g.val ? ` · ≈ ${eur(g.val)}` : ''}`), 1024) + (groups.length > 6 ? `\n… et ${groups.length - 6} autre${groups.length - 6 > 1 ? 's' : ''}` : '') });
  const recent = C.of('tcg').filter(t => (t.jeu || 'autre') === jeu && t.libelle).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5);
  if (recent.length) fields.push({ name: '🕑 Derniers mouvements', value: joinLines(recent.map(t => `${t.obtenu ? '🎁' : t.sens === 'vente' ? '💸' : '🛒'} ${clip(t.libelle, 48)} · ${t.obtenu ? 'obtenu' : (t.sens === 'vente' ? '+' : '−') + eur(t.montant)} · ${fdate(t.date)}`), 1024) });
  const e = { title: `${emoji} ${gameName(jeu)}`, color: GCOLOR[jeu] || COLOR,
    description: stock.length ? `**${eur(val)}** de stock · ${n} article${n > 1 ? 's' : ''}\npayé ${eur(cost)} · plus-value **${sgn(val - cost)}**${nCoted < stock.length ? `\n${stock.length - nCoted} ligne${stock.length - nCoted > 1 ? 's' : ''} sans cote (comptée${stock.length - nCoted > 1 ? 's' : ''} au prix payé)` : ''}` : 'Plus rien en stock.',
    fields, footer: FOOT, timestamp: new Date().toISOString() };
  const img = top.length ? bigImg(top[0].t) : '';
  if (img) e.thumbnail = { url: img };
  const comps = [{ type: 1, components: [
    { type: 2, style: 1, emoji: { name: '🃏' }, label: 'Voir les cartes', custom_id: cid('g', 0, 'cote', `${jeu}~*`, '') },
    btnSeries('numero'),
  ] }];
  const pick = groups.slice().sort((a, b) => b.val - a.val).slice(0, 25);
  if (pick.length > 1) comps.push({ type: 1, components: [{ type: 3, custom_id: cid('v', 0, 'numero', '', ''), placeholder: `Séries ${gameName(jeu)}…`,
    options: pick.map(g => ({ label: clip(g.s.name, 100), value: g.s.key.slice(0, 100), description: clip(`${g.items} article${g.items > 1 ? 's' : ''}${g.val ? ` · ≈ ${eur(g.val)}` : ''}`, 100) })) }] });
  return { content: '', embeds: [e], components: comps };
}

// ---- Commandes
const ADMIN = 8n, MANAGE_GUILD = 32n;
function isAdmin(it) { try { const p = BigInt(it.member && it.member.permissions || '0'); return (p & ADMIN) !== 0n || (p & MANAGE_GUILD) !== 0n; } catch (_) { return false; } }

// Qui peut voir les chiffres : serveur autorisé + rôle choisi (ou administrateur)
function access(it, cfg) {
  const g = it.guild_id;
  if (!g) return { ok: false, msg: 'Ces commandes s’utilisent dans ton serveur Discord.' };
  const guilds = String(cfg.guilds || '').split(',').filter(Boolean);
  if (guilds.length && !guilds.includes(g)) return { ok: false, msg: 'Ce bot est réservé à un autre serveur.' };
  if (!guilds.length) return { ok: false, msg: 'Pas encore de serveur choisi : un administrateur doit d’abord faire /reglage.' };
  const roleId = cfg['role:' + g], roles = (it.member && it.member.roles) || [];
  if (!(isAdmin(it) || (roleId && roles.includes(roleId)))) return { ok: false, msg: roleId ? `Commande réservée aux membres qui ont le rôle <@&${roleId}>.` : 'Pas encore de rôle choisi : un administrateur doit d’abord faire /reglage.' };
  if (!cfg.owner_user_id) return { ok: false, msg: 'Le bot n’est pas encore relié à ton compte Mon Stock.' };
  const salon = cfg['salon:' + g];
  return { ok: true, eph: !!salon && it.channel_id !== salon };
}
async function loadCalc(cfg) {
  const [raw] = await Promise.all([loadData(cfg.owner_user_id), seriesNames()]);
  return makeCalc(raw, parisToday());
}

async function command(it) {
  const cfg = await config();
  const name = it.data && it.data.name, g = it.guild_id;
  if (!g) return reply('Ces commandes s’utilisent dans ton serveur Discord.', true);
  // Un seul serveur autorisé : celui où /reglage a été fait la première fois (ou la liste « guilds » de bot_config)
  const guilds = String(cfg.guilds || '').split(',').filter(Boolean);
  if (guilds.length && !guilds.includes(g)) return reply('Ce bot est réservé à un autre serveur.', true);
  if (name === 'reglage') {
    if (!isAdmin(it)) return reply('Seuls les administrateurs du serveur peuvent changer ce réglage.', true);
    if (!guilds.length) await setConfig('guilds', g);
    const role = String(opt(it, 'role') || ''), salon = String(opt(it, 'salon') || '');
    if (!/^\d+$/.test(role)) return reply('Choisis un rôle.', true);
    await setConfig('role:' + g, role);
    await setConfig('salon:' + g, /^\d+$/.test(salon) ? salon : '');
    return reply(`Réglage enregistré ✓\nLes membres qui ont le rôle <@&${role}> peuvent utiliser /tresorerie, /mois, /carte, /objectifs et les résumés par jeu (/pokemon, /onepiece…).\n` +
      (salon ? `Dans <#${salon}>, les réponses sont visibles par tout le salon ; ailleurs, seulement par la personne qui tape la commande.` : 'Les réponses s’affichent dans le salon où la commande est tapée. Astuce : crée un salon visible seulement par ce rôle, puis refais /reglage avec ce salon.'), true);
  }
  const acc = access(it, cfg);
  if (!acc.ok) return reply(acc.msg, true);
  const eph = acc.eph;
  let C;
  try { C = await loadCalc(cfg); }
  catch (_) { return reply('Impossible de lire tes données pour le moment. Réessaie dans un instant.', true); }
  if (name === 'tresorerie') return reply('', eph, cmdTresorerie(C));
  if (name === 'mois') return reply('', eph, cmdMois(C, it));
  if (name === 'objectifs') return reply('', eph, cmdObjectifs(C));
  if (GAME_CMDS[name]) { const v = cmdJeu(C, await seriesNames(), name); return reply(v.content, eph, v.embeds, v.components); }
  if (name === 'carte') {
    const nom = String(opt(it, 'nom') || '').trim();
    const isId = !!nom && C.of('tcg').some(t => t._id === nom);
    const v = await carteView(C, { serie: String(opt(it, 'serie') || '').trim(), q: isId ? '' : nom, tri: opt(it, 'tri'), page: 0, focusId: isId ? nom : '' });
    return reply(v.content, eph, v.embeds, v.components);
  }
  return reply('Commande inconnue.', true);
}

// Boutons et menus sous les fiches de cartes
async function component(it) {
  const cfg = await config();
  const acc = access(it, cfg);
  if (!acc.ok) return reply(acc.msg, true);
  const [op, page, tri, serie, ...rest] = String(it.data && it.data.custom_id || '').split('|');
  const q = rest.join('|'), val = ((it.data && it.data.values) || [])[0];
  let C;
  try { C = await loadCalc(cfg); }
  catch (_) { return reply('Impossible de lire tes données pour le moment. Réessaie dans un instant.', true); }
  let a = { serie, q, tri, page: +page || 0 };
  if (op === 'j') a.page = +val || 0;
  else if (op === 't') a = { serie, q, tri: val || tri, page: 0 };
  else if (op === 'v') a = { serie: val || '', q: '', tri: 'numero', page: 0 };
  else if (op === 'o') a = { tri };
  const v = await carteView(C, a);
  return { type: 7, data: { content: v.content || '', embeds: v.embeds || [], components: v.components || [], allowed_mentions: { parse: [] } } };
}

async function autocomplete(it) {
  try {
    const cfg = await config();
    const g = it.guild_id, roleId = cfg['role:' + g], roles = (it.member && it.member.roles) || [];
    const guilds = String(cfg.guilds || '').split(',').filter(Boolean);
    if (!g || !guilds.includes(g) || !(isAdmin(it) || (roleId && roles.includes(roleId))) || !cfg.owner_user_id) return [];
    const focused = (it.data.options || []).find(o => o.focused);
    const q = fold(String(focused && focused.value || '').trim());
    const C = await loadCalc(cfg);
    const all = collection(C, await seriesNames());
    if (focused && focused.name === 'serie') {
      return seriesGroups(all).filter(g => !q || fold(`${g.s.name} ${g.s.code}`).includes(q)).slice(0, 25)
        .map(g => ({ name: clip(`${g.s.name} (${g.items})`, 100), value: g.s.key.slice(0, 100) }));
    }
    const serie = resolveSerie(all, String(opt(it, 'serie') || '').trim());
    const words = q.split(/\s+/).filter(Boolean);
    const list = sortItems(all.filter(x => inSerie(x, serie) && words.every(w => fold(`${x.t.libelle} ${x.t.categorie || ''}`).includes(w))), serie && !serie.endsWith('~*') ? 'numero' : 'recent');
    return list.slice(0, 25).map(x => ({ name: clip(`${x.t.libelle}${serie ? '' : ` · ${x.s.code || gameName(x.t.jeu)}`}${x.t.sens === 'vente' ? ' (vendu)' : x.t.obtenu ? ' (obtenu)' : ''}`, 100), value: String(x.t._id).slice(0, 100) }));
  } catch (_) { return []; }
}

// ---- Enregistrement des commandes auprès de Discord (une fois, avec ?setup=<clé>)
const MONTH_CHOICES = MOIS.map((m, i) => ({ name: m, value: i + 1 }));
const COMMANDS = [
  { name: 'tresorerie', description: 'Trésorerie : argent, comptes et valeur du stock' },
  { name: 'mois', description: 'Dépenses, ventes et bénéfice d’un mois', options: [
    { type: 4, name: 'mois', description: 'Mois (par défaut : le mois en cours)', required: false, choices: MONTH_CHOICES },
    { type: 4, name: 'annee', description: 'Année (par défaut : cette année)', required: false, min_value: 2000, max_value: 2100 },
  ] },
  { name: 'carte', description: 'Tes cartes en grand : choisis une série, trie et fais défiler', options: [
    { type: 3, name: 'serie', description: 'Série / extension (ex. OP13, 151…) : sans rien, la liste de tes séries', required: false, autocomplete: true },
    { type: 3, name: 'nom', description: 'Nom de la carte ou de l’article (filtré par la série choisie)', required: false, autocomplete: true },
    { type: 3, name: 'tri', description: 'Ordre des cartes', required: false, choices: Object.entries(TRIS).map(([k, v]) => ({ name: v[0].toUpperCase() + v.slice(1), value: k })) },
  ] },
  { name: 'objectifs', description: 'Avancement de tes objectifs financiers' },
  ...Object.keys(GAME_CMDS).map(j => ({ name: GAME_CMDS[j][0], description: `Résumé ${gameName(j)} : stock, achats, ventes, meilleures cotes, séries` })),
  { name: 'reglage', description: 'Choisir le rôle qui peut utiliser les commandes (administrateurs)', default_member_permissions: '32', options: [
    { type: 8, name: 'role', description: 'Rôle autorisé à utiliser les commandes', required: true },
    { type: 7, name: 'salon', description: 'Salon où les réponses sont visibles par tous (facultatif)', required: false, channel_types: [0] },
  ] },
].map(c => ({ type: 1, contexts: [0], integration_types: [0], ...c }));

async function setup(key) {
  const cfg = await config(true);
  const page = (msg, ok) => new Response(`${ok ? '✅' : '⚠️'} Mon Stock · ${msg}`, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (!cfg.setup_key || key !== cfg.setup_key) return page('Clé de réglage incorrecte.', false);
  const token = String(Deno.env.get('DISCORD_BOT_TOKEN') || '').trim().replace(/^Bot\s+/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!token) return page('Il manque le secret DISCORD_BOT_TOKEN dans Supabase (Edge Functions → Secrets).', false);
  if (!/^\d+$/.test(cfg.discord_app_id || '')) return page('Il manque l’identifiant de l’application Discord (discord_app_id).', false);
  const r = await fetch(`https://discord.com/api/v10/applications/${cfg.discord_app_id}/commands`, { method: 'PUT', headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(COMMANDS) });
  const t = await r.text();
  if (!r.ok) {
    // Diagnostic sans dévoiler le jeton : forme et application d'origine
    const parts = token.split('.');
    let owner = '';
    try { owner = atob(parts[0].replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((parts[0].length + 3) % 4)); } catch (_) { /* rien */ }
    const diag = `jeton de ${token.length} caractères en ${parts.length} partie${parts.length > 1 ? 's' : ''}` +
      (parts.length !== 3 ? ' (un jeton de bot en a 3, séparées par des points)' : owner === cfg.discord_app_id ? ', bien lié à cette application' : /^\d+$/.test(owner) ? ', mais il appartient à une autre application' : '');
    return page(`Discord a refusé l’enregistrement (${r.status}) : ${t.slice(0, 200)} · ${diag}.`, false);
  }
  let n = 0; try { n = JSON.parse(t).length; } catch (_) { /* rien */ }
  return page(`${n} commandes enregistrées sur Discord : ${COMMANDS.map(c => '/' + c.name).join(', ')}.`, true);
}

const json = o => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });

Deno.serve(async req => {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.searchParams.has('setup')) return setup(url.searchParams.get('setup'));
  if (req.method !== 'POST') return new Response('Mon Stock · bot Discord', { status: 200 });
  const body = await req.text();
  let cfg;
  try { cfg = await config(); } catch (_) { return new Response('config', { status: 500 }); }
  if (!(await verifySig(req, body, cfg.discord_public_key))) return new Response('signature invalide', { status: 401 });
  let it; try { it = JSON.parse(body); } catch (_) { return new Response('json', { status: 400 }); }
  if (it.type === 1) return json({ type: 1 });
  if (it.type === 4) return json({ type: 8, data: { choices: await autocomplete(it) } });
  if (it.type === 2) { try { return json(await command(it)); } catch (_) { return json(reply('Oups, une erreur est survenue. Réessaie.', true)); } }
  if (it.type === 3) { try { return json(await component(it)); } catch (_) { return json(reply('Oups, une erreur est survenue. Réessaie.', true)); } }
  return json(reply('Interaction non prise en charge.', true));
});
