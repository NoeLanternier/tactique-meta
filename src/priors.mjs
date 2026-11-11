// Mesure, sur les compteurs du patch, de la force de lissage de chaque famille de statistiques
// (voir stats.mjs) et des effets d'objets regroupés entre champions.

import { K_MAX, momPrior, partitionCells, popularitySlope, posterior } from './stats.mjs'

/** États de la partie au moment d'un achat : en avance, à égalité, en retard (or des équipes). */
export const STATES = ['a', 'e', 'b']
/** Écart d'or entre les équipes (en part de l'or adverse) au-delà duquel on est en avance / retard. */
export const LEAD_THRESHOLD = 0.05
/** État de la partie pour un écart d'or relatif : 'a' en avance, 'b' en retard, 'e' sinon. */
export const stateOfLead = (lead) =>
  typeof lead !== 'number' || !Number.isFinite(lead)
    ? null
    : lead >= LEAD_THRESHOLD
      ? 'a'
      : lead <= -LEAD_THRESHOLD
        ? 'b'
        : 'e'
const COMP_CONTEXTS = ['ap', 'ad', 'heal', 'tank', 'cc']
const CHOICE_KINDS = ['runes', 'boots', 'pet', 'skills']

/** Valeurs utilisées tant qu'une famille n'a pas assez de données pour être mesurée. */
export const DEFAULT_PRIORS = {
  vs: 1000,
  pair: K_MAX,
  comp: 1500,
  fam: 5000,
  famCtx: 5000,
  runes: 2000,
  keystone: 4000,
  boots: 2000,
  skills: 4000,
  start: 5000,
  pet: 10000,
  c1: 4000,
  c2: 3000,
  c3: 1000,
  slot: 1000,
  choiceCtx: 3000,
  counter: K_MAX,
  trait: K_MAX
}

const rate = ([g, w]) => (g > 0 ? w / g : 0)
const binVar = (p, n) => (p * (1 - p)) / n

/** Effet « général » d'un allié ou adversaire sur tous les champions du poste (retiré des paires). */
function generalEffects(champs, side) {
  const acc = {}
  for (const c of champs) {
    const b = c.w / c.g
    for (const [p, [g, w]] of Object.entries(c[side] ?? {})) {
      const a = (acc[p] ??= [0, 0])
      a[0] += g
      a[1] += g * (w / g - b)
    }
  }
  return Object.fromEntries(Object.entries(acc).map(([p, [g, s]]) => [p, g > 0 ? s / g : 0]))
}

/**
 * Force de lissage (nombre de parties a priori) de chaque famille de statistiques, mesurée sur
 * l'état du patch, et lien popularité → victoire pour les objets, compétences et départs.
 */
export function measurePriors(state) {
  const champs = Object.values(state.champs ?? {}).filter((c) => c.g >= 300)
  const cells = {
    vs: [],
    pair: [],
    comp: [],
    fam: [],
    famCtx: [],
    runes: [],
    keystone: [],
    boots: [],
    skills: [],
    start: [],
    pet: [],
    c1: [],
    c2: [],
    c3: [],
    slot: [],
    choiceCtx: []
  }

  // Écart moyen de tous les champions dans chaque contexte de composition (retiré : il ne dit rien
  // du champion).
  const ctxMean = {}
  for (const ctx of COMP_CONTEXTS) {
    let g = 0
    let s = 0
    for (const c of champs) {
      const cell = c.ctxBase?.[ctx]
      if (!cell || cell[0] < 30) continue
      g += cell[0]
      s += cell[0] * (rate(cell) - c.w / c.g)
    }
    ctxMean[ctx] = g > 0 ? s / g : 0
  }
  const general = { with: generalEffects(champs, 'with'), against: generalEffects(champs, 'against') }

  for (const c of champs) {
    const b = c.w / c.g
    for (const [, [g, w]] of Object.entries(c.vs ?? {}))
      if (g >= 10) cells.vs.push([g, w / g - b, binVar(b, g)])
    for (const side of ['with', 'against'])
      for (const [p, [g, w]] of Object.entries(c[side] ?? {}))
        if (g >= 10) cells.pair.push([g, w / g - b - (general[side][p] ?? 0), binVar(b, g)])

    // Écart du champion dans chaque contexte (sert aussi aux familles et aux choix).
    const ctxShift = {}
    for (const ctx of COMP_CONTEXTS) {
      const cell = c.ctxBase?.[ctx]
      if (!cell || cell[0] < 30) continue
      const [g] = cell
      ctxShift[ctx] = { shift: rate(cell) - b, v: binVar(b, g) * (1 - g / c.g) }
      cells.comp.push([g, rate(cell) - b - ctxMean[ctx], ctxShift[ctx].v])
    }

    for (const kind of ['runes', 'boots', 'skills', 'start', 'pet', 'c1'])
      cells[kind].push(...partitionCells(c[kind]))
    const keystones = {}
    for (const [sig, [g, w]] of Object.entries(c.runes ?? {})) {
      const cell = (keystones[String(sig).split('|')[1]?.split(',')[0] ?? ''] ??= [0, 0])
      cell[0] += g
      cell[1] += w
    }
    cells.keystone.push(...partitionCells(keystones))
    const fams = Object.fromEntries(Object.entries(c.fam ?? {}).map(([k, f]) => [k, [f.g, f.w]]))
    cells.fam.push(...partitionCells(fams, { minShare: 0.12 }))

    // 2e objet sachant le 1er, 3e sachant les deux premiers.
    for (const [kind, depth] of [
      ['c2', 1],
      ['c3', 2]
    ]) {
      const groups = {}
      for (const [key, cell] of Object.entries(c[kind] ?? {}))
        (groups[key.split('>').slice(0, depth).join('>')] ??= {})[key] = cell
      for (const m of Object.values(groups))
        cells[kind].push(...partitionCells(m, { minShare: 0.1, minTotal: 150 }))
    }

    // Objets achetés au même rang et dans le même état de la partie.
    for (const st of STATES)
      for (const byItem of Object.values(c.sl?.[st] ?? {}))
        cells.slot.push(...partitionCells(byItem, { minGames: 10, minShare: 0.03, minTotal: 50 }))

    // Familles et choix selon le contexte de composition : écart propre (celui du champion retiré).
    for (const f of Object.values(c.fam ?? {})) {
      if (f.g < 100) continue
      const rf = f.w / f.g
      for (const [ctx, cell] of Object.entries(f.ctxBase ?? {})) {
        const s = ctxShift[ctx]
        if (!s || cell[0] < 15) continue
        const [g] = cell
        cells.famCtx.push([g, rate(cell) - rf - s.shift, binVar(rf, g) * (1 - g / f.g) + s.v])
      }
    }
    for (const kind of CHOICE_KINDS) {
      for (const [ctx, byValue] of Object.entries(c.opt?.[kind] ?? {})) {
        const s = ctxShift[ctx]
        if (!s) continue
        for (const [value, cell] of Object.entries(byValue ?? {})) {
          const all = c[kind]?.[value]
          if (!all || all[0] < 100 || cell[0] < 15) continue
          const ro = rate(all)
          const [g] = cell
          cells.choiceCtx.push([g, rate(cell) - ro - s.shift, binVar(ro, g) * (1 - g / all[0]) + s.v])
        }
      }
    }
  }

  const out = {}
  for (const [key, list] of Object.entries(cells))
    out[key] = momPrior(list, { fallback: DEFAULT_PRIORS[key] }).k
  out.slope = {
    item: popularitySlope([...cells.c1, ...cells.c3, ...cells.slot]),
    skills: popularitySlope(cells.skills),
    start: popularitySlope(cells.start)
  }
  return out
}

/**
 * Effet de chaque objet légendaire, tous champions confondus : écart de taux de victoire par
 * rapport aux autres objets achetés au même rang, par le même champion, dans le même état de la
 * partie (en avance, à égalité, en retard). Comparer à état égal évite de confondre l'effet de
 * l'objet avec la situation où on l'achète (un Ange gardien s'achète surtout quand on gagne déjà).
 * Renvoie { id: { games, lift } } avec des écarts déjà lissés.
 */
export function pooledItemLifts(state) {
  const acc = {}
  for (const c of Object.values(state.champs ?? {})) {
    for (const st of STATES) {
      for (const byItem of Object.values(c.sl?.[st] ?? {})) {
        let N = 0
        let W = 0
        for (const [g, w] of Object.values(byItem)) {
          N += g
          W += w
        }
        if (N < 30) continue
        const b = W / N
        for (const [id, [g, w]] of Object.entries(byItem)) {
          const a = (acc[id] ??= [0, 0, 0])
          a[0] += g
          a[1] += g * (w / g - b)
          a[2] += g * b * (1 - b) * (1 - g / N)
        }
      }
    }
  }
  const rows = Object.entries(acc)
    .filter(([, [n]]) => n >= 200)
    .map(([id, [n, s, v]]) => [id, n, s / n, v / (n * n)])
  const { k } = momPrior(
    rows.map(([, n, lift, v]) => [n, lift, v]),
    { fallback: 3000, minCells: 20, minGames: 20000 }
  )
  const out = {}
  for (const [id, n, lift] of rows) out[id] = { games: n, lift: posterior(n, lift, k) }
  return out
}

/**
 * Écart d'un objet pour un champion, lissé vers l'effet regroupé de l'objet : [achats, écart].
 * `states` : états de la partie pris en compte (tous par défaut).
 */
export function championItemLift(c, id, pooled, kSlot, states = STATES) {
  let n = 0
  let s = 0
  for (const st of states) {
    for (const byItem of Object.values(c.sl?.[st] ?? {})) {
      const cell = byItem[id]
      if (!cell) continue
      let N = 0
      let W = 0
      for (const [g, w] of Object.values(byItem)) {
        N += g
        W += w
      }
      if (N < 10) continue
      n += cell[0]
      s += cell[0] * (cell[1] / cell[0] - W / N)
    }
  }
  const prior = pooled?.[id]?.lift ?? 0
  return [n, n > 0 ? posterior(n, s / n, kSlot, prior) : prior]
}
