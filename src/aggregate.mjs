// Agrégation des parties et choix des builds.
//
// Pour éviter qu'une option jouée 3 fois avec 3 victoires passe devant tout le monde, le taux de
// victoire est « lissé » vers celui du champion (moyenne bayésienne) et une option doit représenter
// une part minimale des parties du champion pour être retenue.
import { ARCHETYPES, guessArchetype } from './archetypes.mjs'

export const STATE_VERSION = 3
/** Contextes adverses pour lesquels on mesure la performance des objets. */
export const CONTEXTS = ['all', 'ap', 'ad', 'heal', 'tank', 'cc']
const CONTEXT_METRICS = ['heal', 'tank', 'cc']
/** Un contexte « fort » = au-dessus de ~75 % des parties (z-score > 0,67). */
const HIGH_Z = 0.67
const MIN_CONTEXT_SAMPLES = 150

export function emptyState(patch, patchStart) {
  return {
    version: STATE_VERSION,
    patch,
    patchStart,
    createdAt: new Date().toISOString(),
    processed: [],
    champs: {},
    profiles: {},
    ctxStats: {}
  }
}

/** Ajoute les champs des nouvelles versions à un état plus ancien. */
export function upgradeState(state) {
  state.profiles ??= {}
  state.ctxStats ??= {}
  state.version = STATE_VERSION
  return state
}

/** Compteurs [parties, victoires] tenus pour chaque jungler. with / against : alliés et adversaires
 * (hors jungler adverse, compté dans vs). */
const CHAMP_MAPS = [
  'runes',
  'c1',
  'c2',
  'c3',
  'boots',
  'pet',
  'later',
  'skills',
  'vs',
  'with',
  'against',
  'ctxBase'
]

function inc(map, key, win, weight = 1) {
  if (key === null || key === undefined || key === '') return
  const cell = (map[key] ??= [0, 0])
  cell[0] += weight
  if (win) cell[1] += weight
}

function champState(state, champ) {
  const c = (state.champs[champ] ??= { g: 0, w: 0 })
  for (const k of CHAMP_MAPS)
    c[k] ??= {}
  c.ctxItems ??= {}
  c.bench ??= {}
  return c
}

/** Repères mesurés : somme et nombre de valeurs pour chaque indicateur. */
export const BENCH_KEYS = [
  'cs10',
  'cs15',
  'gold15',
  'level15',
  'firstItem',
  'secondItem',
  'kp',
  'visionPerMin',
  'controlWardsPer10'
]

/** Statistiques glissantes (moyenne/écart-type) d'un indicateur adverse par minute. */
function observe(state, metric, value) {
  const s = (state.ctxStats[metric] ??= { n: 0, sum: 0, sq: 0 })
  s.n++
  s.sum += value
  s.sq += value * value
}

function isHigh(state, metric, value) {
  const s = state.ctxStats[metric]
  if (!s || s.n < MIN_CONTEXT_SAMPLES) return false
  const mean = s.sum / s.n
  const sd = Math.sqrt(Math.max(1e-9, s.sq / s.n - mean * mean))
  return (value - mean) / sd > HIGH_Z
}

/** Contextes adverses d'une partie, à partir de ce qui a été réellement observé. */
export function contextsOf(state, enemy) {
  const ctx = ['all']
  if (!enemy || !enemy.minutes) return ctx
  const dmg = enemy.phys + enemy.magic
  if (dmg > 0) {
    const ap = enemy.magic / dmg
    if (ap >= 0.55) ctx.push('ap')
    else if (ap <= 0.35) ctx.push('ad')
  }
  for (const m of CONTEXT_METRICS) {
    const perMin = enemy[m] / enemy.minutes
    if (isHigh(state, m, perMin)) ctx.push(m)
    observe(state, m, perMin)
  }
  return ctx
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
  if (rec.enemyJungler) inc(c.vs, rec.enemyJungler, rec.win)
  for (const ally of rec.allies ?? []) inc(c.with, ally, rec.win)
  for (const enemy of rec.enemies ?? []) inc(c.against, enemy, rec.win)
  for (const k of BENCH_KEYS) {
    const v = rec.bench?.[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const cell = (c.bench[k] ??= [0, 0])
    cell[0] += 1
    cell[1] += v
  }
  for (const ctx of contextsOf(state, rec.enemy)) {
    inc(c.ctxBase, ctx, rec.win)
    const items = (c.ctxItems[ctx] ??= {})
    for (const id of rec.items ?? []) inc(items, String(id), rec.win)
  }
}

export function addProfiles(state, profiles) {
  for (const p of profiles) {
    if (!p.champ || !p.minutes) continue
    const s = (state.profiles[p.champ] ??= {
      g: 0,
      minutes: 0,
      phys: 0,
      magic: 0,
      heal: 0,
      shield: 0,
      tank: 0,
      cc: 0,
      crit: 0,
      as: 0
    })
    s.g++
    for (const k of ['minutes', 'phys', 'magic', 'heal', 'shield', 'tank', 'cc', 'crit', 'as'])
      s[k] += p[k]
  }
}

/** Reprend les compteurs d'un patch précédent avec un poids réduit (démarrage plus stable). */
export function seedFromPrevious(state, previous, factor = 0.25) {
  const scale = (x) => (typeof x === 'number' ? x * factor : x)
  const scaleMap = (m) =>
    Object.fromEntries(Object.entries(m ?? {}).map(([k, [g, w]]) => [k, [g * factor, w * factor]]))
  for (const [champ, c] of Object.entries(previous.champs ?? {})) {
    const n = { g: c.g * factor, w: c.w * factor, ctxItems: {} }
    for (const k of CHAMP_MAPS)
      n[k] = scaleMap(c[k])
    for (const [ctx, m] of Object.entries(c.ctxItems ?? {})) n.ctxItems[ctx] = scaleMap(m)
    // Repères : n et somme réduits ensemble, la moyenne est conservée.
    n.bench = scaleMap(c.bench)
    state.champs[champ] = n
  }
  for (const [champ, p] of Object.entries(previous.profiles ?? {})) {
    state.profiles[champ] = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, scale(v)]))
  }
  state.ctxStats = previous.ctxStats ?? {}
  state.seededFrom = previous.patch
  return state
}

const bayes = (g, w, prior, k = 30) => (w + k * prior) / (g + k)
const round3 = (x) => Math.round(x * 1000) / 1000

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

/**
 * Objets qui gagnent le plus dans chaque contexte adverse : part des parties où l'objet est
 * construit, et gain de taux de victoire par rapport aux autres parties du même contexte.
 */
export function situationalStats(c, dd) {
  const out = {}
  for (const ctx of CONTEXTS) {
    const base = c.ctxBase?.[ctx]
    const items = c.ctxItems?.[ctx]
    if (!base || !items || base[0] < 20) continue
    const prior = base[1] / base[0]
    const list = Object.entries(items)
      .map(([id, [g, w]]) => {
        const it = dd.items.get(Number(id))
        if (!it?.isLegendary || g < 5) return null
        const share = g / base[0]
        if (share < 0.04) return null
        // Taux de victoire lissé de l'objet vs celui des parties du contexte sans cet objet.
        const lift = bayes(g, w, prior, 20) - bayes(base[0] - g, base[1] - w, prior, 20)
        return { item: it.name, share: round3(share), lift: round3(lift), games: Math.round(g) }
      })
      .filter(Boolean)
      .sort((a, b) => b.share - a.share)
      .slice(0, 12)
    if (list.length) out[ctx] = { games: Math.round(base[0]), items: list }
  }
  return out
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
    situational: situationalStats(c, dd),
    patch: dd.patch,
    games: Math.round(c.g),
    winRate: round3(prior)
  }
}

/** Rang centile (0..1) de chaque valeur dans la liste. */
function percentiles(entries) {
  const sorted = [...entries].sort((a, b) => a[1] - b[1])
  const out = {}
  sorted.forEach(([k], i) => (out[k] = sorted.length > 1 ? i / (sorted.length - 1) : 0.5))
  return out
}

/**
 * Profils mesurés de tous les champions : part de dégâts magiques, et rang centile (0 = le plus
 * faible, 1 = le plus fort de tous les champions) pour la résistance, les contrôles, les soins
 * et les boucliers alliés. crit / aa = nombre moyen d'objets critiques / de vitesse d'attaque.
 */
export function buildProfiles(state, minGames = 30) {
  const rows = Object.entries(state.profiles).filter(([, p]) => p.g >= minGames && p.minutes > 0)
  const perMin = (k) => rows.map(([champ, p]) => [champ, p[k] / p.minutes])
  const pct = {}
  for (const k of ['tank', 'cc', 'heal', 'shield']) pct[k] = percentiles(perMin(k))
  const out = {}
  for (const [champ, p] of rows) {
    const dmg = p.phys + p.magic
    out[champ] = {
      ap: round3(dmg > 0 ? p.magic / dmg : 0.5),
      tank: round3(pct.tank[champ]),
      cc: round3(pct.cc[champ]),
      heal: round3(pct.heal[champ]),
      shield: round3(pct.shield[champ]),
      crit: round3(Math.min(1, p.crit / p.g / 2)),
      aa: round3(Math.min(1, p.as / p.g / 2)),
      games: Math.round(p.g)
    }
  }
  return out
}

/** [parties, taux de victoire] des entrées assez jouées d'un compteur. */
function rates(map, minPairGames) {
  const out = {}
  for (const [k, [g, w]] of Object.entries(map ?? {})) {
    if (g >= minPairGames) out[k] = [Math.round(g), round3(w / g)]
  }
  return out
}

/**
 * Statistiques des junglers : taux de victoire global, par jungler adverse (vs), avec chaque
 * champion allié (with) et contre chaque adversaire hors jungler (against).
 */
export function buildJunglerStats(state, minGames = 20) {
  const out = {}
  for (const [champ, c] of Object.entries(state.champs)) {
    if (c.g < minGames) continue
    out[champ] = {
      games: Math.round(c.g),
      winRate: round3(c.w / c.g),
      vs: rates(c.vs, 5),
      with: rates(c.with, 10),
      against: rates(c.against, 10)
    }
  }
  return out
}

/**
 * Repères Master+ par champion (moyennes du patch) et pour l'ensemble des junglers ('_all').
 * Utilisés par le bilan d'après-partie de l'app.
 */
export function buildBenchmarks(state, minGames = 30) {
  const out = {}
  const all = {}
  let allGames = 0
  for (const [champ, c] of Object.entries(state.champs)) {
    const b = c.bench ?? {}
    for (const k of BENCH_KEYS) {
      const [n, sum] = b[k] ?? [0, 0]
      const cell = (all[k] ??= [0, 0])
      cell[0] += n
      cell[1] += sum
    }
    allGames += c.g
    if (c.g < minGames) continue
    const row = { games: Math.round(c.g) }
    let ok = true
    for (const k of BENCH_KEYS) {
      const [n, sum] = b[k] ?? [0, 0]
      if (n < Math.min(10, minGames)) ok = false
      else row[k] = round3(sum / n)
    }
    if (ok) out[champ] = row
  }
  const total = { games: Math.round(allGames) }
  let ok = allGames >= minGames
  for (const k of BENCH_KEYS) {
    const [n, sum] = all[k] ?? [0, 0]
    if (n < 10) ok = false
    else total[k] = round3(sum / n)
  }
  if (ok) out._all = total
  return out
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
  const sampleGames = Math.round(Object.values(state.champs).reduce((s, c) => s + c.g, 0))
  const profiles = buildProfiles(state)
  return {
    version: 2,
    patch: dd.patch,
    generatedAt: new Date().toISOString(),
    sampleGames,
    freshBuilds: builds.length,
    seededFrom: state.seededFrom ?? null,
    builds: [...builds, ...kept].sort((a, b) => a.id.localeCompare(b.id)),
    // Si trop peu de parties (début de patch), on garde les profils précédents.
    profiles: Object.keys(profiles).length >= 50 ? profiles : (previousMeta?.profiles ?? profiles),
    junglers: buildJunglerStats(state),
    // Début de patch : on garde les repères précédents tant qu'il n'y a pas assez de parties.
    benchmarks: (() => {
      const b = buildBenchmarks(state)
      return b._all ? b : (previousMeta?.benchmarks ?? b)
    })()
  }
}
