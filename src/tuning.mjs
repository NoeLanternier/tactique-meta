// Réglage automatique du moteur de l'app.
//
// Chaque nouvelle partie est d'abord évaluée avec la méta de la veille (hors échantillon, comme le
// backtest) : pour le jungler, on calcule les écarts de taux de victoire que le moteur de l'app
// attribuerait à chacun de ses critères (force du champion, affrontement de junglers, alliés et
// adversaires, famille de build, runes / bottes / familier / compétences, objets face aux
// adversaires). On cumule ensuite les statistiques suffisantes d'une régression linéaire
// « victoire ~ critères » (XᵀX, Xᵀy) : quelques nombres, mis à jour partie par partie.
//
// Le coefficient de chaque critère dit combien son écart prédit réellement la victoire : 1 = le
// moteur a le bon poids, 0,5 = il le surestime de moitié, 1,4 = il le sous-estime. L'app multiplie
// chaque critère par son coefficient. Les coefficients sont rapprochés de 1 selon leur
// incertitude (un critère mal mesuré garde son poids actuel) et bornés entre 0 et 2.
//
// Le moteur de l'app (TypeScript) est reproduit ici au plus près. Seule différence : les contextes
// adverses viennent de ce qui a été observé dans la partie (l'app les estime pendant la draft).

import { runesFromSig } from './aggregate.mjs'
import { DEFAULT_PRIORS } from './priors.mjs'

export const TUNING_KEYS = [
  'pick', // force du champion (taux de victoire du patch)
  'vs', // affrontement avec le jungler adverse
  'pairs', // alliés et adversaires (hors jungler)
  'famBase', // famille de build : son taux propre
  'famCtx', // famille de build : selon les contextes adverses
  'choiceBase', // runes, bottes, familier, compétences : taux propre
  'choiceCtx', // … selon les contextes adverses (et le jungler adverse pour le familier)
  'counter' // objets face aux adversaires et à leurs objets
]
const P = TUNING_KEYS.length + 1 // + constante

const CONTEXT_KEYS = ['ap', 'ad', 'heal', 'tank', 'cc']
/** Effet cumulé maximal des alliés et adversaires, en points de taux de victoire. */
const PAIR_CAP = 0.06
/**
 * Version des critères : 2 = écarts lissés avec les forces mesurées (meta.priors) ; 3 = affrontement
 * et paires réduits à l'écart propre au champion (effet général du partenaire retiré).
 */
export const TUNING_VERSION = 3
/** Écart-type a priori des coefficients autour de 1 (rapprochement selon l'incertitude). */
const PRIOR_SD = 0.5
export const MIN_TUNING_GAMES = 2000

const smooth = (games, wr, prior, k) => (wr * games + prior * k) / (games + k)
const logit = (p) => Math.log(p / (1 - p))
const sigmoid = (z) => 1 / (1 + Math.exp(-z))
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

export function emptyTuning() {
  return {
    v: TUNING_VERSION,
    n: 0,
    sy: 0,
    A: Array.from({ length: P }, () => new Array(P).fill(0)),
    b: new Array(P).fill(0)
  }
}

/** Écart de contexte d'une option : moyenne sur les contextes de la partie (comme l'app). */
function contextShift(cells, base, contexts, k) {
  let sum = 0
  let n = 0
  for (const ctx of contexts) {
    if (!CONTEXT_KEYS.includes(ctx)) continue
    const cell = cells?.[ctx]
    if (!cell) continue
    sum += smooth(cell[0], cell[1], base, k) - base
    n++
  }
  return sum / Math.max(1, n)
}

/**
 * Effet « général » de chaque partenaire, commun à tous les champions du poste : écart moyen de
 * leur taux de victoire face à lui (vs), avec lui (with) ou contre lui (against). Un champion fort
 * fait perdre tous ses adversaires : cela ne distingue aucun pick, l'app le retire pour ne garder
 * que l'écart propre à chaque champion (l'interaction).
 */
export function generalEffects(meta, prior) {
  const out = { vs: new Map(), with: new Map(), against: new Map() }
  for (const side of ['vs', 'with', 'against']) {
    const acc = new Map()
    for (const j of Object.values(meta.junglers ?? {})) {
      const base = smooth(j.games, j.winRate, prior.mean, prior.k)
      for (const [champ, pair] of Object.entries(j[side] ?? {})) {
        const a = acc.get(champ) ?? [0, 0]
        a[0] += pair[0]
        a[1] += pair[0] * (pair[1] - base)
        acc.set(champ, a)
      }
    }
    for (const [champ, [w, sum]] of acc) out[side].set(champ, w > 0 ? sum / w : 0)
  }
  return out
}

/** Écart propre d'une paire [parties, taux], effet général retiré, lissé (points de taux). */
export const interaction = (cell, base, general, k) =>
  cell ? (cell[0] / (cell[0] + k)) * (cell[1] - base - general) : 0

/**
 * Lissage du taux de victoire d'un champion (bayésien empirique, comme dans l'app) : moyenne du
 * poste et nombre de parties « a priori » mesuré sur la méta (méthode des moments), borné.
 */
export function shrinkPrior(junglers) {
  const rows = Object.values(junglers ?? {}).filter((s) => s.games >= 100)
  const total = rows.reduce((t, s) => t + s.games, 0)
  if (rows.length < 10 || total === 0) return { mean: 0.5, k: 600 }
  const mean = rows.reduce((t, s) => t + s.games * s.winRate, 0) / total
  const observed = rows.reduce((t, s) => t + s.games * (s.winRate - mean) ** 2, 0) / total
  const noise = (rows.length * mean * (1 - mean)) / total
  const between = Math.max(observed - noise, 0.0001)
  return { mean, k: clamp((mean * (1 - mean)) / between, 200, 2500) }
}

const cache = new WeakMap()
function prepared(meta) {
  let p = cache.get(meta)
  if (!p) {
    const prior = shrinkPrior(meta.junglers)
    const priors = { ...DEFAULT_PRIORS, ...(meta.priors ?? {}) }
    p = {
      builds: new Map((meta.builds ?? []).map((b) => [b.id, b])),
      prior,
      priors,
      general: generalEffects(meta, prior)
    }
    cache.set(meta, p)
  }
  return p
}

/**
 * Écarts (en taux de victoire) que le moteur attribue à chaque critère pour cette partie, d'après
 * `meta` (méta de la veille). `contexts` : contextes adverses de la partie ('all', 'ap'…).
 */
export function tuningFeatures(meta, rec, contexts, dd) {
  const { builds, general, prior: shrink, priors: P } = prepared(meta)
  const f = Object.fromEntries(TUNING_KEYS.map((k) => [k, 0]))
  const itemName = (id) => (id === null || id === undefined ? null : dd.items.get(Number(id))?.name)

  // Draft : force du champion, jungler adverse, alliés et adversaires.
  const s = meta.junglers?.[rec.champ]
  if (s) {
    const base = smooth(s.games, s.winRate, shrink.mean, shrink.k)
    f.pick = base - shrink.mean
    // Affrontement direct, alliés et autres adversaires : écart propre au champion seulement.
    if (rec.enemyJungler)
      f.vs = interaction(
        s.vs?.[rec.enemyJungler],
        base,
        general.vs.get(rec.enemyJungler) ?? 0,
        P.vs
      )
    let sum = 0
    for (const a of rec.allies ?? [])
      sum += interaction(s.with?.[a], base, general.with.get(a) ?? 0, P.with ?? P.pair)
    for (const e of rec.enemies ?? [])
      sum += interaction(s.against?.[e], base, general.against.get(e) ?? 0, P.against ?? P.pair)
    f.pairs = clamp(sum, -PAIR_CAP, PAIR_CAP)
  }

  const build = builds.get(rec.champ)
  if (!build) return f

  // Famille de build jouée (premier objet légendaire).
  const prior = build.winRate ?? 0.5
  let family = null
  const variants = build.variants ?? []
  if (variants.length >= 2 && rec.core?.length) {
    const first = itemName(rec.core[0])
    family = variants.find((v) => v.key === first) ?? null
    if (family) {
      const base = smooth(family.games, family.winRate, prior, P.fam)
      f.famBase = base - prior
      f.famCtx = contextShift(family.contexts, base, contexts, P.famCtx)
    }
  }

  // Runes, bottes, familier, compétences jouées.
  const played = {
    runes: rec.runeSig ? JSON.stringify(runesFromSig(rec.runeSig, dd)) : null,
    boots: itemName(rec.boots),
    pet: itemName(rec.pet),
    skills: rec.skills ?? null
  }
  const lists = {
    runes: family?.runeChoices ?? build.choices?.runes,
    boots: build.choices?.boots,
    pet: build.choices?.pet,
    skills: build.choices?.skills
  }
  const valueOf = {
    runes: (o) => JSON.stringify(o.runes),
    boots: (o) => o.name,
    pet: (o) => o.name,
    skills: (o) => o.value
  }
  for (const kind of Object.keys(lists)) {
    const list = lists[kind]
    if (!list || list.length < 2 || played[kind] === null) continue
    const o = list.find((x) => valueOf[kind](x) === played[kind])
    if (!o) continue
    // Pages de runes d'une famille : comparées au taux de la famille ; le reste, à celui du champion.
    const ref = kind === 'runes' && family?.runeChoices ? family.winRate : prior
    const base = smooth(o.games, o.winRate, ref, P[kind])
    f.choiceBase += base - ref
    f.choiceCtx += contextShift(o.contexts, base, contexts, P.choiceCtx)
    const vs = kind === 'pet' && rec.enemyJungler ? o.vs?.[rec.enemyJungler] : null
    if (vs) f.choiceCtx += smooth(vs[0], vs[1], base, P.choiceCtx) - base
  }

  // Objets achetés face aux adversaires présents et à leurs objets.
  const foes = [...(rec.enemies ?? []), rec.enemyJungler, ...(rec.foeTags ?? [])].filter(Boolean)
  for (const id of rec.items ?? []) {
    const row = meta.itemCounters?.[itemName(id)]
    if (!row) continue
    for (const foe of foes) if (row[foe]) f.counter += row[foe][1]
  }
  return f
}

/** Ajoute une partie aux statistiques de la régression. */
export function addTuning(t, features, win) {
  const x = [1, ...TUNING_KEYS.map((k) => features[k] ?? 0)]
  const y = win ? 1 : 0
  t.n += 1
  t.sy += y
  for (let i = 0; i < P; i++) {
    t.b[i] += x[i] * y
    for (let j = 0; j < P; j++) t.A[i][j] += x[i] * x[j]
  }
}

/** Inverse d'une matrice symétrique définie positive (Gauss-Jordan). Null si singulière. */
function invert(M) {
  const n = M.length
  const a = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let c = 0; c < n; c++) {
    let pivot = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r
    if (Math.abs(a[pivot][c]) < 1e-12) return null
    ;[a[c], a[pivot]] = [a[pivot], a[c]]
    const d = a[c][c]
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const k = a[r][c]
      if (k !== 0) for (let j = 0; j < 2 * n; j++) a[r][j] -= k * a[c][j]
    }
  }
  return a.map((row) => row.slice(n))
}

const round2 = (x) => Math.round(x * 100) / 100

/**
 * Coefficients de chaque critère (1 = poids actuel du moteur). Null s'il n'y a pas assez de
 * parties. Un critère sans variation (ex. aucune famille de build mesurée) garde 1.
 */
export function solveTuning(t, { minGames = MIN_TUNING_GAMES } = {}) {
  if (!t || t.n < minGames) return null
  const n = t.n
  // Critères qui varient assez pour être mesurés (écart-type > 0,2 point).
  const active = [0]
  TUNING_KEYS.forEach((_, k) => {
    const i = k + 1
    const mean = t.A[0][i] / n
    const variance = t.A[i][i] / n - mean * mean
    if (variance > 4e-6) active.push(i)
  })
  const A = active.map((i) => active.map((j) => t.A[i][j]))
  const b = active.map((i) => t.b[i])
  const inv = invert(A)
  if (!inv) return null
  const w = inv.map((row) => row.reduce((s, v, j) => s + v * b[j], 0))
  // Variance résiduelle : yᵀy − 2wᵀXᵀy + wᵀXᵀXw (yᵀy = nombre de victoires).
  let rss = t.sy
  for (let i = 0; i < active.length; i++) {
    rss -= 2 * w[i] * b[i]
    for (let j = 0; j < active.length; j++) rss += w[i] * w[j] * A[i][j]
  }
  const sigma2 = Math.max(1e-6, rss / Math.max(1, n - active.length))

  const weights = {}
  const se = {}
  TUNING_KEYS.forEach((key, k) => {
    const pos = active.indexOf(k + 1)
    if (pos < 0) {
      weights[key] = 1
      se[key] = null
      return
    }
    const s = Math.sqrt(sigma2 * Math.max(0, inv[pos][pos]))
    const shrink = (PRIOR_SD * PRIOR_SD) / (PRIOR_SD * PRIOR_SD + s * s)
    weights[key] = round2(clamp(1 + (w[pos] - 1) * shrink, 0, 2))
    se[key] = round2(s)
  })
  return { v: TUNING_VERSION, games: Math.round(n), weights, se }
}
