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
  return { NOWK, all, of, subCost, soldeOf, soldMap, stockItems, stockTotals, cashTotal, monthTotals, monthLines, goalValue };
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
function reply(content, eph, embeds) {
  return { type: 4, data: { content: content || '', embeds: embeds || [], flags: eph ? 64 : 0, allowed_mentions: { parse: [] } } };
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

function searchCards(C, q) {
  const tcg = C.of('tcg').filter(t => t.libelle);
  if (q && tcg.some(t => t._id === q)) return tcg.filter(t => t._id === q);
  const words = fold(q).split(/\s+/).filter(Boolean);
  const hits = tcg.filter(t => { const f = fold(t.libelle + ' ' + (t.categorie || '') + ' ' + gameName(t.jeu)); return words.every(w => f.includes(w)); });
  const sold = C.soldMap();
  const remOf = t => t.sens === 'achat' ? Math.max(0, qteOf(t) - (sold.get(t._id) || 0)) : 0;
  return hits.sort((a, b) => (remOf(b) > 0 ? 1 : 0) - (remOf(a) > 0 ? 1 : 0) || String(b.date || '').localeCompare(String(a.date || '')));
}
function cardLine(C, t) {
  const sold = C.soldMap(), lc = lastCote(t), q = qteOf(t);
  const parts = [];
  if (t.obtenu) parts.push(`obtenu le ${fdate(t.date)}`);
  else if (t.sens === 'achat') parts.push(`acheté ${eur(t.montant)}${q > 1 ? ` (${q} × ${eur(puOf(t))})` : ''} le ${fdate(t.date)}`);
  else parts.push(`vendu ${eur(t.montant)} le ${fdate(t.date)}${typeof t.cout === 'number' ? ` · marge ${sgn(t.montant - t.cout)}` : ''}`);
  if (t.sens === 'achat') { const rem = Math.max(0, q - (sold.get(t._id) || 0)); parts.push(rem ? `${rem} en stock` : 'tout vendu'); }
  if (lc) parts.push(`cote ${eur(lc.prix)}${lc.min ? ` (dès ${eur(lc.min)})` : ''}`);
  return parts.join(' · ');
}
function cmdCarte(C, it) {
  const q = String(opt(it, 'nom') || '').trim();
  const hits = searchCards(C, q);
  if (!hits.length) return { content: `Aucun article ne correspond à « ${clip(q, 60)} ».`, embeds: [] };
  if (hits.length === 1) {
    const t = hits[0], lc = lastCote(t), q1 = qteOf(t), sold = C.soldMap();
    const rem = t.sens === 'achat' ? Math.max(0, q1 - (sold.get(t._id) || 0)) : 0;
    const fields = [];
    if (t.obtenu) fields.push({ name: 'Provenance', value: 'Obtenu sans dépense', inline: true });
    else if (t.sens === 'achat') fields.push({ name: 'Prix payé', value: `**${eur(t.montant)}**${q1 > 1 ? `\n${q1} × ${eur(puOf(t))}` : ''}`, inline: true });
    else fields.push({ name: 'Vendu', value: `**${eur(t.montant)}**${typeof t.cout === 'number' ? `\nmarge ${sgn(t.montant - t.cout)}` : ''}`, inline: true });
    if (t.sens === 'achat') fields.push({ name: 'En stock', value: rem ? `${rem} sur ${q1}` : 'Tout vendu', inline: true });
    if (lc) {
      fields.push({ name: 'Cote Cardmarket', value: `**${eur(lc.prix)}**${lc.min ? `\ndès ${eur(lc.min)}` : ''}\nrelevée le ${fdate(lc.date)}`, inline: true });
      if (rem && !t.obtenu) fields.push({ name: 'Plus-value latente', value: sgn(cents((lc.prix - puOf(t)) * rem)), inline: true });
      if (rem && t.obtenu) fields.push({ name: 'Valeur', value: `≈ ${eur(cents(lc.prix * rem))}`, inline: true });
    }
    if (t.plateforme) fields.push({ name: t.sens === 'vente' ? 'Vendu sur' : 'Plateforme', value: clip(t.plateforme, 100), inline: true });
    const e = { title: clip(t.libelle, 250), color: COLOR, description: `${gameName(t.jeu)}${t.categorie ? ` · ${t.categorie}` : ''} · ${t.obtenu ? 'Obtenu' : t.sens === 'vente' ? 'Vente' : 'Achat'} du ${fdate(t.date)}${cmUrl(t.lien) ? `\n🔗 [Voir sur Cardmarket](${cmUrl(t.lien)})` : ''}`, fields, footer: FOOT };
    if (cmUrl(t.lien)) e.url = cmUrl(t.lien);
    const img = Array.isArray(t.img) ? t.img.find(u => /^https:\/\//.test(u || '')) : '';
    if (img) e.thumbnail = { url: img };
    return { content: '', embeds: [e] };
  }
  const shown = hits.slice(0, 10);
  const fields = shown.map(t => ({ name: clip(`${t.libelle} · ${gameName(t.jeu)}`, 256), value: clip(cardLine(C, t) + (cmUrl(t.lien) ? `\n[Cardmarket](${cmUrl(t.lien)})` : ''), 1024) }));
  return { content: '', embeds: [{ title: `🔎 « ${clip(q, 60)} » · ${hits.length} résultat${hits.length > 1 ? 's' : ''}`, description: hits.length > shown.length ? `Les ${shown.length} premiers. Précise le nom pour affiner.` : undefined, color: COLOR, fields, footer: FOOT }] };
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

// ---- Commandes
const ADMIN = 8n, MANAGE_GUILD = 32n;
function isAdmin(it) { try { const p = BigInt(it.member && it.member.permissions || '0'); return (p & ADMIN) !== 0n || (p & MANAGE_GUILD) !== 0n; } catch (_) { return false; } }

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
    return reply(`Réglage enregistré ✓\nLes membres qui ont le rôle <@&${role}> peuvent utiliser /tresorerie, /mois, /carte et /objectifs.\n` +
      (salon ? `Dans <#${salon}>, les réponses sont visibles par tout le salon ; ailleurs, seulement par la personne qui tape la commande.` : 'Les réponses s’affichent dans le salon où la commande est tapée. Astuce : crée un salon visible seulement par ce rôle, puis refais /reglage avec ce salon.'), true);
  }
  if (!guilds.length) return reply('Pas encore de serveur choisi : un administrateur doit d’abord faire /reglage.', true);
  const roleId = cfg['role:' + g];
  const roles = (it.member && it.member.roles) || [];
  if (!(isAdmin(it) || (roleId && roles.includes(roleId)))) {
    return reply(roleId ? `Commande réservée aux membres qui ont le rôle <@&${roleId}>.` : 'Pas encore de rôle choisi : un administrateur doit d’abord faire /reglage.', true);
  }
  const salon = cfg['salon:' + g];
  const eph = !!salon && it.channel_id !== salon;
  if (!cfg.owner_user_id) return reply('Le bot n’est pas encore relié à ton compte Mon Stock.', true);
  let C;
  try { C = makeCalc(await loadData(cfg.owner_user_id), parisToday()); }
  catch (_) { return reply('Impossible de lire tes données pour le moment. Réessaie dans un instant.', true); }
  if (name === 'tresorerie') return reply('', eph, cmdTresorerie(C));
  if (name === 'mois') return reply('', eph, cmdMois(C, it));
  if (name === 'objectifs') return reply('', eph, cmdObjectifs(C));
  if (name === 'carte') { const r = cmdCarte(C, it); return reply(r.content, eph, r.embeds); }
  return reply('Commande inconnue.', true);
}

async function autocomplete(it) {
  try {
    const cfg = await config();
    const g = it.guild_id, roleId = cfg['role:' + g], roles = (it.member && it.member.roles) || [];
    const guilds = String(cfg.guilds || '').split(',').filter(Boolean);
    if (!g || !guilds.includes(g) || !(isAdmin(it) || (roleId && roles.includes(roleId))) || !cfg.owner_user_id) return [];
    const focused = (it.data.options || []).find(o => o.focused);
    const q = String(focused && focused.value || '').trim();
    const C = makeCalc(await loadData(cfg.owner_user_id), parisToday());
    const list = q ? searchCards(C, q) : C.of('tcg').filter(t => t.libelle).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    return list.slice(0, 25).map(t => ({ name: clip(`${t.libelle} · ${gameName(t.jeu)}${t.sens === 'vente' ? ' (vente)' : t.obtenu ? ' (obtenu)' : ''}`, 100), value: String(t._id).slice(0, 100) }));
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
  { name: 'carte', description: 'Chercher une carte ou un article dans ton stock', options: [
    { type: 3, name: 'nom', description: 'Nom de la carte ou de l’article', required: true, autocomplete: true },
  ] },
  { name: 'objectifs', description: 'Avancement de tes objectifs financiers' },
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
  return page(`${n} commandes enregistrées sur Discord : /tresorerie, /mois, /carte, /objectifs, /reglage.`, true);
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
  return json(reply('Interaction non prise en charge.', true));
});
