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
const PAIR_K = 40
const PAIR_CAP = 0.25
/** Écart-type a priori des coefficients autour de 1 (rapprochement selon l'incertitude). */
const PRIOR_SD = 0.5
export const MIN_TUNING_GAMES = 2000

const smooth = (games, wr, prior, k) => (wr * games + prior * k) / (games + k)
const logit = (p) => Math.log(p / (1 - p))
const sigmoid = (z) => 1 / (1 + Math.exp(-z))
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

export function emptyTuning() {
  return {
    n: 0,
    sy: 0,
    A: Array.from({ length: P }, () => new Array(P).fill(0)),
    b: new Array(P).fill(0)
  }
}

/** Écart de contexte d'une option : moyenne sur les contextes de la partie (comme l'app). */
function contextShift(cells, base, contexts) {
  let sum = 0
  let n = 0
  for (const ctx of contexts) {
    if (!CONTEXT_KEYS.includes(ctx)) continue
    const cell = cells?.[ctx]
    if (!cell) continue
    sum += smooth(cell[0], cell[1], base, 30) - base
    n++
  }
  return sum / Math.max(1, n)
}

/** Effet « général » d'un allié ou adversaire, commun à tous les junglers (retiré dans l'app). */
function generalEffects(meta) {
  const out = { with: new Map(), against: new Map() }
  for (const side of ['with', 'against']) {
    const acc = new Map()
    for (const j of Object.values(meta.junglers ?? {})) {
      const base = smooth(j.games, j.winRate, 0.5, 60)
      for (const [champ, pair] of Object.entries(j[side] ?? {})) {
        const d = logit(smooth(pair[0], pair[1], base, PAIR_K)) - logit(base)
        const a = acc.get(champ) ?? [0, 0]
        a[0] += pair[0]
        a[1] += pair[0] * d
        acc.set(champ, a)
      }
    }
    for (const [champ, [w, s]] of acc) out[side].set(champ, w > 0 ? s / w : 0)
  }
  return out
}

const cache = new WeakMap()
function prepared(meta) {
  let p = cache.get(meta)
  if (!p) {
    p = {
      builds: new Map((meta.builds ?? []).map((b) => [b.id, b])),
      general: generalEffects(meta)
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
  const { builds, general } = prepared(meta)
  const f = Object.fromEntries(TUNING_KEYS.map((k) => [k, 0]))
  const itemName = (id) => (id === null || id === undefined ? null : dd.items.get(Number(id))?.name)

  // Draft : force du champion, jungler adverse, alliés et adversaires.
  const s = meta.junglers?.[rec.champ]
  if (s) {
    const base = smooth(s.games, s.winRate, 0.5, 60)
    f.pick = base - 0.5
    const vs = rec.enemyJungler ? s.vs?.[rec.enemyJungler] : null
    if (vs) f.vs = smooth(vs[0], vs[1], base, 25) - base
    let sum = 0
    const pair = (side, champ) => {
      const cell = s[side]?.[champ]
      if (!cell) return
      sum += logit(smooth(cell[0], cell[1], base, PAIR_K)) - logit(base) - (general[side].get(champ) ?? 0)
    }
    for (const a of rec.allies ?? []) pair('with', a)
    for (const e of rec.enemies ?? []) pair('against', e)
    f.pairs = sigmoid(logit(base) + clamp(sum, -PAIR_CAP, PAIR_CAP)) - base
  }

  const build = builds.get(rec.champ)
  if (!build) return f

  // Famille de build jouée (premier objet légendaire).
  let prior = build.winRate ?? 0.5
  let family = null
  const variants = build.variants ?? []
  if (variants.length >= 2 && rec.core?.length) {
    const first = itemName(rec.core[0])
    family = variants.find((v) => v.key === first) ?? null
    if (family) {
      const base = smooth(family.games, family.winRate, prior, 60)
      f.famBase = base - prior
      f.famCtx = contextShift(family.contexts, base, contexts)
      prior = family.winRate
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
    const base = smooth(o.games, o.winRate, prior, 40)
    f.choiceBase += base - prior
    f.choiceCtx += contextShift(o.contexts, base, contexts)
    const vs = kind === 'pet' && rec.enemyJungler ? o.vs?.[rec.enemyJungler] : null
    if (vs) f.choiceCtx += smooth(vs[0], vs[1], base, 30) - base
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
  return { games: Math.round(n), weights, se }
}
