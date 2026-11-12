// Mesure, sur les compteurs du patch, de la force de lissage de chaque famille de statistiques
// (voir stats.mjs) et des effets d'objets regroupés entre champions.

import {
  K_MAX,
  addSums,
  clamp,
  momPrior,
  momSums,
  partitionCells,
  popularitySlope,
  posterior
} from './stats.mjs'

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
  with: K_MAX,
  against: K_MAX,
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

/**
 * Cellules d'interaction entre les champions du poste et leurs partenaires d'un côté de la partie
 * (`vs` : adversaire direct, `with` : alliés, `against` : autres adversaires) : écart du taux de
 * victoire à celui du champion, une fois retiré l'effet « général » du partenaire (un champion
 * fort fait perdre tous ses adversaires : cela ne dit rien d'un affrontement en particulier).
 * Chaque cellule : [parties, écart, variance due au hasard, champion, partenaire]. La variance tient
 * compte des deux moyennes retirées (celle du champion et celle du partenaire).
 */
export function interactionCells(champs, side, { minGames = 10 } = {}) {
  const partner = {}
  const rows = []
  for (const [id, c] of champs) {
    const b = c.w / c.g
    let n = 0
    for (const [p, [g, w]] of Object.entries(c[side] ?? {})) {
      if (g < minGames) continue
      const a = (partner[p] ??= [0, 0])
      a[0] += g
      a[1] += g * (w / g - b)
      n += g
    }
    rows.push([id, c, b, n])
  }
  const out = []
  for (const [id, c, b, n] of rows) {
    for (const [p, [g, w]] of Object.entries(c[side] ?? {})) {
      if (g < minGames) continue
      const [pn, ps] = partner[p]
      const lost = Math.max(0, 1 - g / pn - g / n)
      out.push([g, w / g - b - ps / pn, binVar(b, g) * lost, id, p])
    }
  }
  return out
}

/**
 * Correction de la variance due au hasard. Les compteurs repris du patch précédent avec un poids
 * réduit (25 %) sont plus précis que leur nombre de parties ne le laisse croire : sans correction,
 * le hasard est surestimé et tous les vrais écarts paraissent nuls en début de patch. Les paires
 * d'alliés servent de témoin : sur les parties tenues à l'écart, une paire d'alliés qui « marchait
 * bien » ne gagne pas plus ensuite, leur écart observé est donc du hasard pur. Le rapport entre leur
 * variance observée et la variance attendue donne la correction (1 = aucune ; jamais plus de 1).
 */
export function noiseScale(withCells) {
  const s = momSums(withCells)
  if (s.cells < 500 || s.sn < 20000 || !(s.noise > 0)) return 1
  return clamp(s.obs / s.noise, 0.2, 1)
}

const FAMILIES = [
  'vs',
  'with',
  'against',
  'comp',
  'fam',
  'famCtx',
  'runes',
  'keystone',
  'boots',
  'skills',
  'start',
  'pet',
  'c1',
  'c2',
  'c3',
  'slot',
  'choiceCtx'
]

/** Cellules [parties, écart, variance] de chaque famille de statistiques, et correction du hasard. */
function priorCells(state) {
  const entries = Object.entries(state.champs ?? {}).filter(([, c]) => c.g >= 300)
  const champs = entries.map(([, c]) => c)
  const cells = Object.fromEntries(FAMILIES.map((k) => [k, []]))

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
  for (const side of ['vs', 'with', 'against']) cells[side] = interactionCells(entries, side)

  for (const c of champs) {
    const b = c.w / c.g

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
  return { cells, scale: noiseScale(cells.with) }
}

/**
 * Sommes de la méthode des moments de chaque famille pour ce poste (hasard corrigé). Additionnées
 * sur tous les postes et niveaux (poolEvidence), elles donnent une mesure regroupée bien plus
 * précise, vers laquelle la mesure de chaque poste est rapprochée (voir momPrior).
 */
export function priorEvidence(state) {
  const { cells, scale } = priorCells(state)
  return Object.fromEntries(FAMILIES.map((k) => [k, momSums(cells[k], scale)]))
}

export function poolEvidence(states) {
  const pooled = {}
  for (const state of states) {
    for (const [k, sums] of Object.entries(priorEvidence(state))) pooled[k] = addSums(pooled[k], sums)
  }
  return pooled
}

/**
 * Force de lissage (nombre de parties a priori) de chaque famille de statistiques, mesurée sur
 * l'état du patch, et lien popularité → victoire pour les objets, compétences et départs.
 * `pooled` : mesure regroupée de tous les postes (poolEvidence), facultative.
 */
export function measurePriors(state, pooled = null) {
  const { cells, scale } = priorCells(state)
  const out = {}
  for (const key of FAMILIES)
    out[key] = momPrior(cells[key], {
      fallback: DEFAULT_PRIORS[key],
      scale,
      pooled: pooled?.[key] ?? null
    }).k
  // Apps d'avant la séparation alliés / adversaires : une seule force pour les deux.
  out.pair = Math.max(out.with, out.against)
  out.slope = {
    item: popularitySlope([...cells.c1, ...cells.c3, ...cells.slot]),
    skills: popularitySlope(cells.skills),
    start: popularitySlope(cells.start)
  }
  out.noise = Math.round(scale * 1000) / 1000
  return out
}

/** Effets a priori de l'équilibre de l'équipe (mesurés sur six métas, patch 16.22). */
export const FIT_PRIOR = { ap: [-0.017, 0.008], tank: [-0.02, 0.01] }
const FIT_KEYS = ['ap', 'tank']

/**
 * Équilibre de l'équipe : ce que coûte de ressembler à ses alliés. Régression des écarts des
 * paires d'alliés (effet général retiré) sur le produit des profils centrés : dégâts magiques ×
 * dégâts magiques (une équipe tout magique ou tout physique gagne moins : l'adversaire n'a qu'une
 * résistance à acheter) et résistance × résistance (une deuxième ligne de front apporte moins que
 * la première). Chaque coefficient mesuré est rapproché d'une valeur a priori selon son
 * incertitude et borné à [-0,04 ; 0]. Renvoie { ap, tank, center, games } ou null sans profils.
 * L'effet pour un champion c avec un allié a : coef × (profil(c) − centre[0]) × (profil(a) − centre[1]).
 */
export function measureFit(state, profiles) {
  if (!profiles || Object.keys(profiles).length < 30) return null
  const entries = Object.entries(state.champs ?? {}).filter(([, c]) => c.g >= 300)
  const all = interactionCells(entries, 'with')
  const scale = noiseScale(all)
  const cells = all.filter(([, , , id, p]) => profiles[id] && profiles[p])
  const games = cells.reduce((t, [g]) => t + g, 0)
  const center = {}
  for (const key of FIT_KEYS) {
    const mean = (index) => cells.reduce((t, c) => t + c[0] * profiles[c[index]][key], 0) / games
    center[key] = games > 0 ? [mean(3), mean(4)].map((x) => Math.round(x * 1000) / 1000) : [0.5, 0.5]
  }
  const out = { center, games: Math.round(games) }
  // Deux variables : équations normales 2 × 2.
  let a11 = 0
  let a12 = 0
  let a22 = 0
  let b1 = 0
  let b2 = 0
  for (const [g, dev, , id, p] of cells) {
    const x1 = (profiles[id].ap - center.ap[0]) * (profiles[p].ap - center.ap[1])
    const x2 = (profiles[id].tank - center.tank[0]) * (profiles[p].tank - center.tank[1])
    a11 += g * x1 * x1
    a12 += g * x1 * x2
    a22 += g * x2 * x2
    b1 += g * x1 * dev
    b2 += g * x2 * dev
  }
  const det = a11 * a22 - a12 * a12
  const measured = cells.length >= 1000 && games >= 50000 && det > 0
  const beta = measured ? [(a22 * b1 - a12 * b2) / det, (a11 * b2 - a12 * b1) / det] : [0, 0]
  const variance = measured ? [(0.25 * scale * a22) / det, (0.25 * scale * a11) / det] : [0, 0]
  FIT_KEYS.forEach((key, i) => {
    const [mean, sd] = FIT_PRIOR[key]
    const w = measured ? sd ** 2 / (sd ** 2 + variance[i]) : 0
    out[key] = Math.round(clamp(mean + w * (beta[i] - mean), -0.04, 0) * 10000) / 10000
  })
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
