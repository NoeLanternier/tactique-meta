// Objet suivant : quel 3e, 4e, 5e ou 6e objet légendaire acheter, compte tenu des objets déjà
// achetés, de la composition des deux équipes et de l'état de la partie au moment de l'achat (avance
// ou retard, adversaire très en avance).
//
// Pourquoi une mesure à part. Comparer le taux de victoire des parties où un objet tardif a été
// acheté ne dit presque rien : on achète un 5e objet surtout dans les parties longues, on se paie
// un objet coûteux ou un Ange gardien surtout quand on mène déjà. Ici, chaque achat est une
// décision comparée aux autres décisions prises au même moment :
// - victoire « attendue » à cet achat, d'après l'écart d'or entre les équipes à cette minute et le
//   rang de l'objet (courbe mesurée sur tout le poste) : l'écart à cette attente (« victoires en
//   plus ») retire l'effet de la situation dans laquelle l'objet est acheté ;
// - écart propre de l'objet pour ce champion (lissé vers son effet tous champions confondus) ;
// - écart propre après chaque objet déjà possédé (un objet qui va bien avec ceux qu'on a), selon
//   la composition adverse et selon qu'on mène ou non : interactions, lissées vers zéro.
// La force de chaque lissage est mesurée sur les données (méthode des moments, voir stats.mjs).
// L'app calcule la même estimation (nextEstimate) avec ce qui est publié dans build.next, et le
// backtest la vérifie sur les parties du lendemain (evaluateNext).

import { momPrior, posterior } from './stats.mjs'

/**
 * Rangs évalués (0 = 1er objet légendaire) : du 3e au 6e objet. Le 3e objet complète le cœur ; le
 * mesurer ici permet de le remplacer quand la partie l'exige (adversaire très en avance…).
 */
export const NEXT_RANKS = [2, 3, 4, 5]
/**
 * Contextes : composition adverse et alliée, avance ou retard au moment de l'achat, et adversaire
 * très en avance à ce moment, selon ses dégâts (fedAp : surtout magiques, fedAd : physiques).
 */
export const NEXT_CONTEXTS = [
  'ap',
  'ad',
  'heal',
  'tank',
  'cc',
  'allyAp',
  'allyAd',
  'ahead',
  'behind',
  'fedAp',
  'fedAd'
]

/**
 * Contexte « adversaire très en avance » de chaque achat (rec.itemFed : son champion) : 'fedAp' si
 * ses dégâts sont surtout magiques, 'fedAd' s'ils sont surtout physiques (profils mesurés).
 */
export function fedContexts(profiles, fed) {
  return (fed ?? []).map((champ) => {
    const p = champ ? profiles?.[champ] : null
    const dmg = p ? (p.phys ?? 0) + (p.magic ?? 0) : 0
    if (!p || !(dmg > 0) || (p.g ?? 0) < 20) return null
    const ap = p.magic / dmg
    return ap >= 0.6 ? 'fedAp' : ap <= 0.4 ? 'fedAd' : null
  })
}
/** Bornes des tranches d'écart d'or entre les équipes (part de l'or adverse). */
export const LEAD_EDGES = [-0.15, -0.07, -0.025, 0.025, 0.07, 0.15]
/** Poids de la popularité essayés par le backtest (1 : la popularité décide presque seule). */
export const GAMMAS = [0, 0.02, 0.05, 0.15, 1]
/** Modèle par défaut tant que le backtest n'a pas assez de décisions. */
export const DEFAULT_MODEL = { gamma: 0.05, slope: 1, measured: false }
const MIN_MODEL_DECISIONS = 1000
/** Écart-type a priori de la pente de calibration autour de 1 (voir tuning.mjs). */
const SLOPE_PRIOR_SD = 0.5

const r3 = (x) => Math.round(x * 1000) / 1000
const r4 = (x) => Math.round(x * 10000) / 10000

export function leadBucket(lead) {
  let b = 0
  while (b < LEAD_EDGES.length && lead > LEAD_EDGES[b]) b++
  return b
}

/** Victoire attendue d'un compteur [achats, victoires] (rapprochée de 50 % s'il est petit). */
const expected = (cell) => ((cell?.[1] ?? 0) + 10) / ((cell?.[0] ?? 0) + 20)

const STATE_CTX = { a: 'ahead', b: 'behind' }

function addCell(map, key, win, e) {
  const cell = (map[key] ??= [0, 0, 0])
  cell[0] += 1
  if (win) cell[1] += 1
  cell[2] = Math.round((cell[2] + e) * 1000) / 1000
}

/**
 * Ajoute les achats d'une partie : courbe de victoire du poste par rang et tranche d'écart d'or
 * (state.lead), et décisions du 3e au 6e objet du champion (c.nx : '*' tous achats, a[objet
 * possédé], x[contexte]), chacune avec sa victoire attendue (cellules [achats, victoires,
 * victoires attendues]).
 */
export function addNext(state, c, rec, contexts) {
  const items = rec.items ?? []
  const leads = rec.itemLead ?? []
  const nx = (c.nx ??= {})
  nx['*'] ??= {}
  nx.a ??= {}
  nx.x ??= {}
  state.lead ??= {}
  for (let k = 0; k < items.length; k++) {
    const lead = leads[k]
    if (typeof lead !== 'number' || !Number.isFinite(lead)) continue
    const curve = (state.lead[k] ??= {})
    const bucket = leadBucket(lead)
    const cell = (curve[bucket] ??= [0, 0])
    const e = expected(cell)
    cell[0] += 1
    if (rec.win) cell[1] += 1
    if (!NEXT_RANKS.includes(k)) continue
    const id = String(items[k])
    addCell(nx['*'], id, rec.win, e)
    for (const owned of items.slice(0, k)) addCell((nx.a[owned] ??= {}), id, rec.win, e)
    const ctx = contexts.filter((x) => x !== 'all' && NEXT_CONTEXTS.includes(x))
    const st = STATE_CTX[rec.itemState?.[k]]
    if (st) ctx.push(st)
    const fed = rec.itemFedCtx?.[k]
    if (fed) ctx.push(fed)
    for (const x of ctx) addCell((nx.x[x] ??= {}), id, rec.win, e)
  }
}

/** Courbe publiée : victoire attendue par rang (3 à 5) et tranche d'écart d'or. */
export function publishLead(state) {
  const p = {}
  for (const k of NEXT_RANKS) {
    const curve = state.lead?.[k]
    if (!curve) continue
    p[k] = Array.from({ length: LEAD_EDGES.length + 1 }, (_, b) => r3(expected(curve[b])))
  }
  return Object.keys(p).length ? { edges: LEAD_EDGES, p } : null
}

/** Achats d'un groupe et victoires en plus par achat (écart à l'attente). */
function groupOf(map) {
  let n = 0
  let ex = 0
  let w = 0
  for (const [g, wins, e] of Object.values(map ?? {})) {
    n += g
    ex += wins - e
    w += wins
  }
  return { n, mean: n > 0 ? ex / n : 0, p: n > 0 ? w / n : 0.5 }
}

/** Écart d'un objet dans un groupe (victoires en plus par achat, comparé au groupe). */
const devOf = ([g, w, e], group) => (w - e) / g - group.mean

/** Variance due au hasard d'un écart sur g achats parmi N (même calcul que partitionCells). */
const noiseOf = (g, group) => ((group.p * (1 - group.p)) / g) * (1 - g / Math.max(group.n, g))

/** Effet de chaque objet tous champions confondus (au 4e objet et après), lissé : { id: lift }. */
export function pooledNext(state) {
  const acc = {}
  for (const c of Object.values(state.champs ?? {})) {
    const all = c.nx?.['*']
    if (!all) continue
    const group = groupOf(all)
    if (group.n < 30) continue
    for (const [id, cell] of Object.entries(all)) {
      const a = (acc[id] ??= [0, 0, 0])
      a[0] += cell[0]
      a[1] += cell[0] * devOf(cell, group)
      a[2] += cell[0] * noiseOf(cell[0], group)
    }
  }
  const rows = Object.entries(acc)
    .filter(([, [n]]) => n >= 100)
    .map(([id, [n, s, v]]) => [id, n, s / n, v / (n * n)])
  const { k } = momPrior(
    rows.map(([, n, lift, v]) => [n, lift, v]),
    { fallback: 3000, minCells: 20, minGames: 10000 }
  )
  const out = {}
  for (const [id, n, lift] of rows) out[id] = posterior(n, lift, k)
  return out
}

/**
 * Cellules de la méthode des moments : écart propre de l'objet pour le champion (nx0 : par
 * rapport à son effet tous champions), après un objet possédé (nxJ) et selon le contexte (nxC) :
 * écart à celui de l'objet pour le champion.
 */
export function nextCells(state, pooled = pooledNext(state)) {
  const cells = { nx0: [], nxJ: [], nxC: [] }
  for (const c of Object.values(state.champs ?? {})) {
    const all = c.nx?.['*']
    if (!all) continue
    const group = groupOf(all)
    if (group.n < 300) continue
    const raw = {}
    for (const [id, cell] of Object.entries(all)) {
      if (cell[0] < 5) continue
      raw[id] = devOf(cell, group)
      if (cell[0] >= 20)
        cells.nx0.push([cell[0], raw[id] - (pooled[id] ?? 0), noiseOf(cell[0], group)])
    }
    for (const [kind, maps] of [
      ['nxJ', c.nx.a],
      ['nxC', c.nx.x]
    ])
      for (const map of Object.values(maps ?? {})) {
        const g = groupOf(map)
        if (g.n < 100) continue
        for (const [id, cell] of Object.entries(map))
          if (cell[0] >= 15 && raw[id] !== undefined)
            cells[kind].push([cell[0], devOf(cell, g) - raw[id], noiseOf(cell[0], g)])
      }
  }
  return cells
}

/** Achats minimaux du champion (3e au 6e objet) pour publier ses mesures. */
const MIN_NEXT_GAMES = 60
/** Achats minimaux d'un objet après un autre (ou dans un contexte) pour être publié. */
const MIN_LISTED = 5

/**
 * Mesures publiées pour un champion (build.next), noms d'objets anglais :
 * - base : { objet: [achats, écart lissé, part des achats] } ;
 * - after : { objet possédé: { t: achats après lui, i: { objet: [achats, interaction, part] } } } ;
 * - ctx : { contexte: { objet: [achats, interaction] } }.
 * Écarts en victoires en plus par achat (0,01 = 1 point), à avance égale.
 */
export function buildNext(c, dd, priors, pooled) {
  const all = c?.nx?.['*']
  if (!all) return null
  const group = groupOf(all)
  if (group.n < MIN_NEXT_GAMES) return null
  const name = (id) => dd.items.get(Number(id))?.name ?? null
  const k0 = priors?.nx0 ?? 3000
  const kJ = priors?.nxJ ?? 5000
  const kC = priors?.nxC ?? 5000
  const base = {}
  const lift = {}
  for (const [id, cell] of Object.entries(all)) {
    const n = name(id)
    if (!n || cell[0] < 3) continue
    lift[id] = posterior(cell[0], devOf(cell, group), k0, pooled?.[id] ?? 0)
    base[n] = [Math.round(cell[0]), r4(lift[id]), r3(cell[0] / group.n)]
  }
  const after = {}
  for (const [owned, map] of Object.entries(c.nx.a ?? {})) {
    const on = name(owned)
    const g = groupOf(map)
    if (!on || g.n < 30) continue
    // (tous les objets pris au moins 5 fois : un objet absent de la liste ne l'est presque jamais.)
    const i = {}
    for (const [id, cell] of Object.entries(map)) {
      const n = name(id)
      if (!n || cell[0] < MIN_LISTED || lift[id] === undefined) continue
      i[n] = [
        Math.round(cell[0]),
        r4(posterior(cell[0], devOf(cell, g) - lift[id], kJ)),
        r3(cell[0] / g.n)
      ]
    }
    if (Object.keys(i).length) after[on] = { t: Math.round(g.n), i }
  }
  const ctx = {}
  for (const [x, map] of Object.entries(c.nx.x ?? {})) {
    const g = groupOf(map)
    if (g.n < 30) continue
    const i = {}
    for (const [id, cell] of Object.entries(map)) {
      const n = name(id)
      if (!n || cell[0] < MIN_LISTED || lift[id] === undefined) continue
      i[n] = [Math.round(cell[0]), r4(posterior(cell[0], devOf(cell, g) - lift[id], kC))]
    }
    if (Object.keys(i).length) ctx[x] = i
  }
  return { n: Math.round(group.n), base, after, ctx }
}

/**
 * Estimation pour un objet candidat (même calcul dans l'app, engine/nextItems.ts) : écart de
 * l'objet, interactions moyennes avec les objets possédés (pondérées : voir plus bas) et avec les
 * contextes de la partie
 * ([contexte, poids de 0 à 1]), et part des joueurs qui le prennent après ces objets. `excluded` :
 * presque jamais pris avec l'un des objets possédés (effet unique en double, rôle incompatible…).
 */
export function nextEstimate(next, item, owned, contexts = []) {
  const b = next?.base?.[item]
  if (!b) return null
  // Interactions pondérées par ce que chaque objet possédé distingue : un objet que presque tous
  // les joueurs ont déjà (le cœur du build) ne dit rien de plus que la moyenne.
  let inter = 0
  let weight = 0
  let shareSum = 0
  let shared = 0
  let excluded = false
  for (const j of owned) {
    const grp = next.after?.[j]
    if (!grp) continue
    const w = Math.max(0, Math.min(1, 1 - grp.t / Math.max(1, next.n ?? grp.t)))
    const cell = grp.i?.[item]
    inter += w * (cell ? cell[1] : 0)
    weight += w
    if (grp.t >= 30) {
      shareSum += cell ? cell[2] : 0
      shared++
    }
    // (absent de la liste : moins de 5 achats après lui, alors qu'on en attendrait au moins 12.)
    if (!cell && grp.t >= 300 && b[2] >= 0.04) excluded = true
  }
  let ctxSum = 0
  let ctxWeight = 0
  for (const [x, w] of contexts) {
    const byItem = next.ctx?.[x]
    if (!byItem || !(w > 0)) continue
    ctxSum += w * (byItem[item]?.[1] ?? 0)
    ctxWeight += w
  }
  return {
    lift: b[1] + (weight >= 0.05 ? inter / weight : 0) + ctxSum / Math.max(1, ctxWeight),
    share: shared ? shareSum / shared : b[2],
    games: b[0],
    excluded
  }
}

/** Candidats après les objets possédés, du meilleur au moins bon (score = pente × (écart + γ × part)). */
export function rankNext(next, owned, contexts, model = DEFAULT_MODEL) {
  const out = []
  for (const item of Object.keys(next?.base ?? {})) {
    if (owned.includes(item)) continue
    const est = nextEstimate(next, item, owned, contexts)
    if (!est || est.excluded) continue
    out.push({ item, ...est, score: model.slope * (est.lift + model.gamma * est.share) })
  }
  return out.sort((a, b) => b.score - a.score)
}

// --- Backtest : les conseils de la veille face aux parties du jour ---------------------------

export function emptyNextBacktest() {
  return {
    n: 0,
    // Par poids de popularité : achats conformes au meilleur conseil / autres, [achats, victoires en plus].
    g: GAMMAS.map(() => ({ f: [0, 0], o: [0, 0] })),
    // Calibration : écart prévu de l'objet acheté (par rapport aux autres candidats) et victoires
    // en plus observées : [n, Σx, Σy, Σx², Σxy].
    cal: [0, 0, 0, 0, 0],
    // Ancien conseil (objets les plus construits selon le contexte), à avance égale.
    old: { f: [0, 0], o: [0, 0] }
  }
}

/**
 * Juge chaque achat du 3e au 6e objet d'une partie avec la méta de la veille : victoire en plus
 * (écart à l'attente selon l'avance), selon que l'objet acheté était le premier conseil ou non.
 * `oldRecommend(build, contexts, owned)` : ancien conseil (3 objets) pour comparaison.
 */
export function evaluateNext(meta, contexts, rec, bt, dd, oldRecommend) {
  const build = meta?.builds?.find((b) => b.id === rec.champ)
  const next = build?.next
  const curve = meta?.lead?.p
  if (!next || !curve) return false
  const names = (rec.items ?? []).map((id) => dd.items.get(Number(id))?.name ?? null)
  const comp = contexts.filter((x) => x !== 'all' && NEXT_CONTEXTS.includes(x)).map((x) => [x, 1])
  let counted = false
  for (const k of NEXT_RANKS) {
    const actual = names[k]
    const lead = rec.itemLead?.[k]
    const p = curve[k]?.[typeof lead === 'number' ? leadBucket(lead) : -1]
    if (!actual || typeof p !== 'number') continue
    const owned = names.slice(0, k).filter(Boolean)
    const st = STATE_CTX[rec.itemState?.[k]]
    const fed = rec.itemFedCtx?.[k]
    const ctx = [...comp, ...(st ? [[st, 1]] : []), ...(fed ? [[fed, 1]] : [])]
    const ranked = rankNext(next, owned, ctx, { gamma: 0, slope: 1 })
    const mine = ranked.find((x) => x.item === actual)
    if (ranked.length < 3 || !mine) continue
    const ex = (rec.win ? 1 : 0) - p
    bt.n++
    counted = true
    GAMMAS.forEach((gamma, i) => {
      let best = ranked[0]
      for (const x of ranked)
        if (x.lift + gamma * x.share > best.lift + gamma * best.share) best = x
      const cell = best.item === actual ? bt.g[i].f : bt.g[i].o
      cell[0] += 1
      cell[1] += ex
    })
    let sw = 0
    let sp = 0
    for (const x of ranked) {
      sw += x.share
      sp += x.share * x.lift
    }
    const x = mine.lift - (sw > 0 ? sp / sw : 0)
    bt.cal[0] += 1
    bt.cal[1] += x
    bt.cal[2] += ex
    bt.cal[3] += x * x
    bt.cal[4] += x * ex
    // (ancien conseil : objets après le cœur seulement, comme son backtest d'origine.)
    if (oldRecommend && k >= 3) {
      const wanted = oldRecommend(build, st ? [...contexts, st] : contexts, owned)
      if (wanted.length >= 3) {
        const cell = wanted.includes(actual) ? bt.old.f : bt.old.o
        cell[0] += 1
        cell[1] += ex
      }
    }
  }
  return counted
}

/** Gain mesuré : victoires en plus des achats conformes moins celles des autres, et son erreur. */
function gainOf({ f, o }) {
  if (!(f[0] > 0) || !(o[0] > 0)) return null
  const gain = f[1] / f[0] - o[1] / o[0]
  return {
    followed: f[0],
    other: o[0],
    gain: r4(gain),
    se: r4(Math.sqrt(0.25 / f[0] + 0.25 / o[0]))
  }
}

/** Pente de calibration (victoires en plus par point d'écart prévu) et son erreur. */
function slopeOf(cal) {
  const [n, sx, sy, sxx, sxy] = cal
  if (n < 30) return null
  const vx = sxx - (sx * sx) / n
  if (!(vx > 0)) return null
  const slope = (sxy - (sx * sy) / n) / vx
  return { slope: r3(slope), se: r3(Math.sqrt(0.25 / vx)) }
}

/** Résumé publié (meta.backtest.next). */
export function nextBacktestSummary(bt) {
  if (!bt?.n) return null
  return {
    decisions: bt.n,
    gammas: GAMMAS.map((gamma, i) => ({ gamma, ...(gainOf(bt.g[i]) ?? {}) })),
    calibration: slopeOf(bt.cal),
    old: gainOf(bt.old)
  }
}

/**
 * Modèle utilisé par l'app (meta.nextModel) : poids de la popularité qui a le mieux réussi hors
 * échantillon, et pente de calibration des écarts (rapprochée de 1 selon son incertitude, bornée
 * entre 0 et 2). Valeurs par défaut tant que le backtest n'a pas assez de décisions.
 */
export function nextModel(bt) {
  if (!bt || bt.n < MIN_MODEL_DECISIONS) return { ...DEFAULT_MODEL, decisions: bt?.n ?? 0 }
  let best = null
  GAMMAS.forEach((gamma, i) => {
    const g = gainOf(bt.g[i])
    if (g && (!best || g.gain > best.gain)) best = { gamma, gain: g.gain }
  })
  const cal = slopeOf(bt.cal)
  let slope = 1
  if (cal) {
    const wp = 1 / SLOPE_PRIOR_SD ** 2
    const wd = 1 / Math.max(1e-6, cal.se ** 2)
    slope = Math.max(0, Math.min(2, (wp + wd * cal.slope) / (wp + wd)))
  }
  return {
    gamma: best?.gamma ?? DEFAULT_MODEL.gamma,
    slope: r3(slope),
    measured: true,
    decisions: bt.n
  }
}
