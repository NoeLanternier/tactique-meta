// Agrégation des parties et choix des builds.
//
// Pour éviter qu'une option jouée 3 fois avec 3 victoires passe devant tout le monde, le taux de
// victoire est « lissé » vers celui du champion (moyenne bayésienne) et une option doit représenter
// une part minimale des parties du champion pour être retenue.
import { ARCHETYPES, guessArchetype } from './archetypes.mjs'

export function emptyState(patch, patchStart) {
  return {
    version: 1,
    patch,
    patchStart,
    createdAt: new Date().toISOString(),
    processed: [],
    champs: {}
  }
}

function inc(map, key, win) {
  if (key === null || key === undefined || key === '') return
  const cell = (map[key] ??= [0, 0])
  cell[0]++
  if (win) cell[1]++
}

function champState(state, champ) {
  return (state.champs[champ] ??= {
    g: 0,
    w: 0,
    runes: {},
    c1: {},
    c2: {},
    c3: {},
    boots: {},
    pet: {},
    later: {},
    skills: {}
  })
}

export function addRecord(state, rec) {
  const c = champState(state, rec.champ)
  c.g++
  if (rec.win) c.w++
  inc(c.runes, rec.runeSig, rec.win)
  if (rec.core.length >= 1) inc(c.c1, String(rec.core[0]), rec.win)
  if (rec.core.length >= 2) inc(c.c2, rec.core.slice(0, 2).join('>'), rec.win)
  if (rec.core.length >= 3) inc(c.c3, rec.core.slice(0, 3).join('>'), rec.win)
  for (const id of rec.later) inc(c.later, String(id), rec.win)
  inc(c.boots, rec.boots === null ? null : String(rec.boots), rec.win)
  inc(c.pet, rec.pet === null ? null : String(rec.pet), rec.win)
  inc(c.skills, rec.skills, rec.win)
}

const bayes = (g, w, prior, k = 30) => (w + k * prior) / (g + k)

/**
 * Meilleure option : parmi celles jouées dans au moins `minShare` des cas, celle au meilleur taux
 * de victoire lissé. À défaut, la plus jouée.
 */
export function pickBest(map, prior, { minShare = 0.1, minGames = 5, filter = () => true } = {}) {
  const entries = Object.entries(map).filter(([k]) => filter(k))
  const total = entries.reduce((s, [, [g]]) => s + g, 0)
  if (total === 0) return null
  const eligible = entries.filter(([, [g]]) => g >= minGames && g / total >= minShare)
  const pool = eligible.length ? eligible : entries
  pool.sort((a, b) =>
    eligible.length
      ? bayes(b[1][0], b[1][1], prior) - bayes(a[1][0], a[1][1], prior)
      : b[1][0] - a[1][0]
  )
  return pool[0][0]
}

const OFFENSE = { 5008: 'AF', 5005: 'AS', 5007: 'AH' }
const FLEX = { 5008: 'AF', 5010: 'MS', 5001: 'HS' }
const DEFENSE = { 5011: 'HP', 5013: 'TN', 5001: 'HS' }

/** Convertit une signature de page en format de l'app (noms anglais). */
export function runesFromSig(sig, dd) {
  const [primaryStr, perksStr, subStr, shardsStr] = sig.split('|')
  const perks = perksStr.split(',').map(Number)
  const shards = shardsStr.split(',').map(Number)
  const names = perks.map((id) => dd.runes.get(id))
  const primaryTree = dd.trees.get(Number(primaryStr))
  const secondaryTree = dd.trees.get(Number(subStr))
  if (names.some((r) => !r) || !primaryTree || !secondaryTree || names[0].row !== 0) return null
  return {
    keystone: names[0].name,
    primary: names.slice(1, 4).map((r) => r.name),
    secondaryTree,
    secondary: names.slice(4, 6).map((r) => r.name),
    shards: [OFFENSE[shards[0]] ?? 'AF', FLEX[shards[1]] ?? 'AF', DEFENSE[shards[2]] ?? 'HS']
  }
}

/** Calcule le build d'un champion, ou null si trop peu de parties. */
export function selectBuild(champ, c, dd, { minGames = 40 } = {}) {
  if (!c || c.g < minGames) return null
  const prior = c.w / c.g
  const itemName = (id) => dd.items.get(Number(id))?.name ?? null

  // Runes : page complète la plus performante parmi les pages courantes (validée contre Data Dragon).
  const validSig = (sig) => runesFromSig(sig, dd) !== null
  const sig = pickBest(c.runes, prior, { minShare: 0.08, filter: validSig })
  const runes = sig ? runesFromSig(sig, dd) : null
  if (!runes) return null

  // Cœur : choix glouton conditionnel (1er objet, puis 2e sachant le 1er, puis 3e).
  const c1 = pickBest(c.c1, prior)
  if (!c1) return null
  const c2key = pickBest(c.c2, prior, { filter: (k) => k.startsWith(`${c1}>`) })
  const c2 = c2key ? c2key.split('>')[1] : null
  const c3key = c2 ? pickBest(c.c3, prior, { filter: (k) => k.startsWith(`${c1}>${c2}>`) }) : null
  const c3 = c3key ? c3key.split('>')[2] : null
  const core = [c1, c2, c3].filter(Boolean)
  if (core.length < 3) return null

  // Objets 4 à 6 : les plus achetés après le cœur (au moins 3 % des parties).
  const options = Object.entries(c.later)
    .filter(([id, [g]]) => !core.includes(id) && g >= Math.max(3, c.g * 0.03))
    .sort((a, b) => b[1][0] - a[1][0])
    .slice(0, 6)
    .map(([id]) => itemName(id))
    .filter(Boolean)

  const boots = pickBest(c.boots, prior)
  const pet = pickBest(c.pet, prior, { minShare: 0.15 })
  const skills = pickBest(c.skills, prior, { minShare: 0.15 }) ?? ''
  const coreItems = core.map((id) => dd.items.get(Number(id)))

  return {
    id: champ,
    archetype: ARCHETYPES[champ] ?? guessArchetype(coreItems),
    pet: (pet && itemName(pet)) || 'Gustwalker Hatchling',
    boots: (boots && itemName(boots)) || 'Plated Steelcaps',
    core: coreItems.map((it) => it.name),
    options,
    skills,
    runes,
    patch: dd.patch,
    games: c.g,
    winRate: Math.round(prior * 1000) / 1000
  }
}

/**
 * Construit meta.json : builds du patch en cours, complétés par les builds du patch précédent pour
 * les champions qui n'ont pas encore assez de parties (ils gardent leur numéro de patch, ce qui
 * permet à l'app de prendre les runes recommandées par Riot pour eux).
 */
export function buildMeta(state, dd, previousMeta, options = {}) {
  const builds = []
  for (const [champ, c] of Object.entries(state.champs)) {
    const b = selectBuild(champ, c, dd, options)
    if (b) builds.push(b)
  }
  const fresh = new Set(builds.map((b) => b.id))
  const kept = (previousMeta?.builds ?? []).filter((b) => b?.id && !fresh.has(b.id) && b.patch)
  const sampleGames = Object.values(state.champs).reduce((s, c) => s + c.g, 0)
  return {
    patch: dd.patch,
    generatedAt: new Date().toISOString(),
    sampleGames,
    freshBuilds: builds.length,
    builds: [...builds, ...kept].sort((a, b) => a.id.localeCompare(b.id))
  }
}
