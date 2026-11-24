// Backtest : les nouvelles parties de chaque collecte sont comparées aux recommandations de la
// méta précédente (avant d'être ajoutées aux statistiques, pour ne pas se juger soi-même).
//
// - Famille de build : le joueur a-t-il commencé par la famille que la méta recommandait pour
//   le contexte adverse de sa partie ? Taux de victoire de ceux qui l'ont fait vs les autres.
// - Objets après le cœur : chaque achat du 4e au 6e objet est-il l'un des 3 objets que la méta
//   recommandait à ce moment (contexte adverse, avance ou retard, objets déjà achetés) ? Les achats
//   « suivis » et les autres sont comparés au même rang : comparer des parties entières
//   avantagerait ceux qui ont peu d'objets (les parties gagnées vite), ce qui faussait l'ancienne
//   mesure.
//
// - Objet suivant : chaque achat du 3e au 6e objet comparé au premier conseil de la veille, en
//   victoires en plus par rapport à la victoire attendue selon l'écart d'or à cet achat (voir
//   nextItems.mjs), avec l'ancien conseil jugé de la même façon pour comparaison.
//
// - Runes, bottes, départ, ordre des compétences, familier, moment des bottes et sorts : le
//   joueur a-t-il pris l'option que l'app lui aurait conseillée (celle du build, ou une autre si
//   elle gagne nettement plus dans les contextes de sa partie) ? Victoires en plus du taux du
//   champion, conseil suivi moins autres ; et, quand l'app aurait changé d'option, si ce changement
//   a payé (evaluateChoices).
//
// C'est une mesure indirecte (les joueurs qui suivent la méta ne sont pas forcément les mêmes que
// les autres), mais elle permet de vérifier collecte après collecte que les changements vont dans
// le bon sens : l'écart entre « suivi » et « autre » doit rester positif.

import { DEFAULT_PRIORS } from './priors.mjs'
import { posterior } from './stats.mjs'
import { evaluateNext, evaluateSwap, gainOf } from './nextItems.mjs'
import { runesFromSig } from './aggregate.mjs'

/**
 * Famille recommandée pour une partie : meilleur taux estimé dans les contextes de la partie, et
 * face à l'adversaire direct (écart propre publié déjà lissé, `opp`).
 */
export function recommendedVariant(build, contexts, priors = DEFAULT_PRIORS, opponent = null) {
  const variants = build?.variants ?? []
  if (variants.length < 2) return null
  const prior = build.winRate ?? 0.5
  const kFam = priors?.fam ?? DEFAULT_PRIORS.fam
  const kCtx = priors?.famCtx ?? DEFAULT_PRIORS.famCtx
  let best = null
  for (const v of variants) {
    const base = prior + posterior(v.games ?? 0, v.winRate - prior, kFam)
    const specific = contexts.filter((c) => c !== 'all' && v.contexts?.[c])
    const shifts = specific.map((c) => posterior(v.contexts[c][0], v.contexts[c][1] - base, kCtx))
    const vs = opponent ? (v.opp?.[opponent]?.[1] ?? 0) : 0
    const score =
      base + (shifts.length ? shifts.reduce((a, b) => a + b, 0) / shifts.length : 0) + vs
    if (!best || score > best.score) best = { key: v.key, score }
  }
  return best?.key ?? null
}

/** 3 objets recommandés après le cœur pour les contextes d'une partie, hors objets déjà achetés. */
export function recommendedItems(build, contexts, exclude = []) {
  const skip = new Set([...(build?.core ?? []), ...exclude])
  const score = new Map()
  for (const ctx of contexts) {
    const weight = ctx === 'all' ? 0.6 : 1
    for (const e of build?.situational?.[ctx]?.items ?? []) {
      if (skip.has(e.item) || e.share < 0.05) continue
      score.set(e.item, (score.get(e.item) ?? 0) + weight * (e.share * 0.9 + e.lift * 6))
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([item]) => item)
}

function inc(cell, win) {
  cell[0] += 1
  if (win) cell[1] += 1
}

const STATE_CONTEXT = { a: 'ahead', b: 'behind' }

/** Choix vérifiés, comme l'app les adapte (choices.ts adaptChoices). */
export const CHOICE_PROOF = ['runes', 'boots', 'start', 'skills', 'pet', 'bootsT', 'spells']
/** Contextes utilisés par l'app pour adapter ces choix (composition, alliés, adversaire direct). */
const CHOICE_CONTEXTS = ['ap', 'ad', 'heal', 'tank', 'cc', 'allyAp', 'allyAd', 'vsRanged', 'vsMelee', 'vsAp', 'vsAd']
/** Comme l'app : une autre option remplace celle du build si elle gagne 0,3 point de plus ici. */
const MIN_SWITCH = 0.003
const MIN_OPTION_GAMES = 40

const shrunk = (games, rate, prior, k) => (rate * games + prior * k) / (games + k)
const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const sameRunes = (a, b) =>
  !!a &&
  !!b &&
  norm(a.keystone) === norm(b.keystone) &&
  norm(a.secondaryTree) === norm(b.secondaryTree) &&
  (a.primary ?? []).every((r, i) => norm(r) === norm(b.primary?.[i]))
const sameSet = (a, b) =>
  !!a && !!b && a.length === b.length && [...a].map(norm).sort().join() === [...b].map(norm).sort().join()

/**
 * Option conseillée par l'app (choices.ts pick) : celle du build, sauf si une autre gagne nettement
 * plus dans les contextes de la partie (écarts lissés comme l'app, poids du réglage automatique).
 * Renvoie l'option de remplacement, ou null (option du build).
 */
export function recommendedChoice(list, isCurrent, contexts, prior, kBase, kCtx, tuning, opponent) {
  if (!Array.isArray(list) || list.length < 2) return null
  const wBase = tuning?.weights?.choiceBase ?? 1
  const wCtx = tuning?.weights?.choiceCtx ?? 1
  const ctx = contexts.filter((c) => CHOICE_CONTEXTS.includes(c))
  const scored = list.map((c) => {
    const base = prior + wBase * (shrunk(c.games ?? 0, c.winRate ?? prior, prior, kBase) - prior)
    let sum = 0
    let n = 0
    for (const x of ctx) {
      const cell = c.contexts?.[x]
      if (!cell) continue
      sum += shrunk(cell[0], cell[1], base, kCtx) - base
      n++
    }
    const vs = opponent ? (c.opp?.[opponent]?.[1] ?? 0) : 0
    return { c, base, shift: wCtx * (sum / Math.max(1, n) + vs) }
  })
  const cur = scored.find((x) => isCurrent(x.c))
  if (!cur) return null
  const gain = (x) => Math.min(0, x.base - cur.base) + (x.shift - cur.shift)
  const best = scored
    .filter((x) => x !== cur && (x.c.games ?? 0) >= MIN_OPTION_GAMES)
    .sort((a, b) => gain(b) - gain(a))[0]
  return best && gain(best) >= MIN_SWITCH ? best.c : null
}

const mostShared = (list) => [...(list ?? [])].sort((a, b) => (b.share ?? 0) - (a.share ?? 0))[0]

/** Compteurs d'un type de choix : f / o (conseil suivi / autres), s : quand l'app aurait changé d'option. */
const emptyChoiceCell = () => ({ f: [0, 0], o: [0, 0], s: { f: [0, 0], o: [0, 0] } })

/**
 * Runes, bottes, départ, compétences, familier, moment des bottes et sorts : chaque partie est
 * comparée à l'option que l'app aurait conseillée avec la méta de la veille. Victoires en plus du
 * taux du champion (son niveau retiré), conseil suivi moins autres.
 */
export function evaluateChoices(meta, contexts, rec, bt, dd) {
  const build = meta?.builds?.find((b) => b.id === rec.champ)
  if (!build) return false
  const ch = build.choices ?? {}
  const pr = { ...DEFAULT_PRIORS, ...(meta.priors ?? {}) }
  const prior = build.winRate ?? 0.5
  const ex = (rec.win ? 1 : 0) - prior
  const name = (id) => (id ? (dd.items.get(Number(id))?.name ?? null) : null)
  const opponent = rec.enemyJungler ?? null
  let runes = null
  try {
    runes = rec.runeSig ? runesFromSig(rec.runeSig, dd) : null
  } catch {
    runes = null
  }
  const usualT = build.bootsTiming ?? mostShared(ch.bootsT)?.value
  const usualSpells = build.spells ?? mostShared(ch.spells)?.ids
  const kinds = {
    runes: [ch.runes, (o) => sameRunes(o.runes, build.runes), build.runes, (o) => o.runes, runes, sameRunes],
    boots: [ch.boots, (o) => norm(o.name) === norm(build.boots), build.boots, (o) => o.name, name(rec.boots), (a, b) => norm(a) === norm(b)],
    start: [
      ch.start,
      (o) => sameSet(o.items, build.start),
      build.start,
      (o) => o.items,
      rec.start ? String(rec.start).split(',').map(name).filter(Boolean) : null,
      sameSet
    ],
    skills: [ch.skills, (o) => o.value === build.skills, build.skills, (o) => o.value, rec.skills, (a, b) => a === b],
    pet: [ch.pet, (o) => norm(o.name) === norm(build.pet), build.pet, (o) => o.name, name(rec.pet), (a, b) => norm(a) === norm(b)],
    bootsT: [ch.bootsT, (o) => o.value === usualT, usualT, (o) => o.value, rec.bootsT, (a, b) => a === b],
    spells: [
      ch.spells,
      (o) => sameSet((o.ids ?? []).map(String), (usualSpells ?? []).map(String)),
      usualSpells,
      (o) => o.ids,
      rec.spells ? String(rec.spells).split(',') : null,
      (a, b) => sameSet(a.map(String), b.map(String))
    ]
  }
  let counted = false
  for (const kind of CHOICE_PROOF) {
    const [list, isCurrent, usual, valueOf, actual, same] = kinds[kind]
    if (!usual || actual === null || actual === undefined) continue
    const picked = recommendedChoice(
      list,
      isCurrent,
      contexts,
      prior,
      pr[kind] ?? DEFAULT_PRIORS.choiceCtx,
      pr.choiceCtx ?? DEFAULT_PRIORS.choiceCtx,
      meta.tuning,
      opponent
    )
    const wanted = picked ? valueOf(picked) : usual
    if (!wanted) continue
    const cell = (bt[kind] ??= emptyChoiceCell())
    const followed = same(actual, wanted)
    const side = followed ? cell.f : cell.o
    side[0] += 1
    side[1] = Math.round((side[1] + ex) * 10000) / 10000
    if (picked) {
      const sw = followed ? cell.s.f : cell.s.o
      sw[0] += 1
      sw[1] = Math.round((sw[1] + ex) * 10000) / 10000
    }
    counted = true
  }
  return counted
}

/** Résumé publié (meta.backtest.choices) : gain du conseil suivi par type de choix. */
export function choicesSummary(bt) {
  const out = {}
  for (const [kind, cell] of Object.entries(bt ?? {})) {
    const g = gainOf({ f: cell.f, o: cell.o })
    if (!g) continue
    const sw = gainOf({ f: cell.s.f, o: cell.s.o })
    out[kind] = { ...g, ...(sw ? { switched: sw } : {}) }
  }
  return Object.keys(out).length ? out : null
}

/** Compare une partie aux recommandations de `meta` et met à jour les compteurs `bt`. */
export function evaluateRecord(meta, contexts, rec, bt, dd) {
  const build = meta?.builds?.find((b) => b.id === rec.champ)
  if (!build) return
  const name = (id) => dd.items.get(Number(id))?.name
  let counted = false

  const variant = recommendedVariant(build, contexts, meta.priors, rec.enemyJungler)
  if (variant && rec.core.length >= 1) {
    inc(name(rec.core[0]) === variant ? bt.variant.followed : bt.variant.other, rec.win)
    counted = true
  }

  const items = (rec.items ?? []).map(name)
  for (let k = 3; k < items.length; k++) {
    const state = STATE_CONTEXT[rec.itemState?.[k]]
    const wanted = recommendedItems(
      build,
      state ? [...contexts, state] : contexts,
      items.slice(0, k)
    )
    if (wanted.length < 3) continue
    inc(wanted.includes(items[k]) ? bt.items.high : bt.items.low, rec.win)
    counted = true
  }
  // Objet suivant (3e au 6e objet) : conseil de la veille, à avance égale (voir nextItems.mjs).
  if (bt.next && evaluateNext(meta, contexts, rec, bt.next, dd, recommendedItems)) counted = true
  // Échanges en fin de build (vendre un objet, en acheter un autre) : conseil de la veille.
  if (bt.swap && evaluateSwap(meta, contexts, rec, bt.swap, dd)) counted = true
  // Runes, bottes, départ, compétences… : option que l'app aurait conseillée.
  if (bt.choice && evaluateChoices(meta, contexts, rec, bt.choice, dd)) counted = true
  if (counted) bt.games++
}
