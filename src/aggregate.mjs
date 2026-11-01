// Agrégation des parties et choix des builds.
//
// Pour éviter qu'une option jouée 3 fois avec 3 victoires passe devant tout le monde, le taux de
// victoire est « lissé » vers celui du champion (moyenne bayésienne) et une option doit représenter
// une part minimale des parties du champion pour être retenue.
import { ARCHETYPES, guessArchetype } from './archetypes.mjs'

export const STATE_VERSION = 4
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
    ctxStats: {},
    itemAll: {},
    itemFoe: {},
    foeAll: {},
    backtest: emptyBacktest()
  }
}

/** Compteurs du backtest : parties où le joueur a suivi (ou non) nos recommandations. */
export function emptyBacktest() {
  return {
    games: 0,
    variant: { followed: [0, 0], other: [0, 0] },
    items: { high: [0, 0], low: [0, 0] }
  }
}

/** Ajoute les champs des nouvelles versions à un état plus ancien. */
export function upgradeState(state) {
  state.profiles ??= {}
  state.ctxStats ??= {}
  state.itemAll ??= {}
  state.itemFoe ??= {}
  state.foeAll ??= {}
  state.backtest ??= emptyBacktest()
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
  for (const k of CHAMP_MAPS) c[k] ??= {}
  c.ctxItems ??= {}
  c.ctxSlots ??= {}
  c.itemMin ??= {}
  c.fam ??= {}
  c.bench ??= {}
  c.opt ??= {}
  for (const k of CHOICE_KINDS) c.opt[k] ??= {}
  c.petVs ??= {}
  c.duel ??= {}
  c.open ??= { g: 0, top: 0, firstN: 0, firstMin: 0, lanes: {} }
  return c
}

/** Choix mesurés par contexte adverse : page de runes, bottes, familier, ordre des compétences. */
const CHOICE_KINDS = ['runes', 'boots', 'pet', 'skills']
/** Périodes des combats entre junglers (minutes). */
export const DUEL_PERIODS = ['early', 'mid', 'late']
const periodOf = (min) => (min < 6 ? 'early' : min < 14 ? 'mid' : 'late')

/** Compteurs d'une famille de build (même premier objet légendaire). */
const FAMILY_MAPS = ['runes', 'c2', 'c3', 'later', 'boots', 'pet', 'skills', 'ctxBase', 'ctxRunes']
function familyState(c, firstItem) {
  const f = (c.fam[firstItem] ??= { g: 0, w: 0 })
  for (const k of FAMILY_MAPS) f[k] ??= {}
  return f
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

/** Contextes adverses d'une partie, sans mettre à jour les statistiques (lecture seule). */
export function classifyContexts(state, enemy) {
  const ctx = ['all']
  if (!enemy || !enemy.minutes) return ctx
  const dmg = enemy.phys + enemy.magic
  if (dmg > 0) {
    const ap = enemy.magic / dmg
    if (ap >= 0.55) ctx.push('ap')
    else if (ap <= 0.35) ctx.push('ad')
  }
  for (const m of CONTEXT_METRICS) if (isHigh(state, m, enemy[m] / enemy.minutes)) ctx.push(m)
  return ctx
}

/** Contextes adverses d'une partie, à partir de ce qui a été réellement observé. */
export function contextsOf(state, enemy) {
  const ctx = classifyContexts(state, enemy)
  if (enemy?.minutes) for (const m of CONTEXT_METRICS) observe(state, m, enemy[m] / enemy.minutes)
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
  const contexts = contextsOf(state, rec.enemy)
  const items = rec.items ?? []
  for (const ctx of contexts) {
    inc(c.ctxBase, ctx, rec.win)
    const present = (c.ctxItems[ctx] ??= {})
    for (const id of items) inc(present, String(id), rec.win)
    // Objet au k-ième rang : comparé ensuite aux autres objets achetés au même rang.
    const slots = (c.ctxSlots[ctx] ??= {})
    items.forEach((id, k) => inc((slots[k] ??= {}), String(id), rec.win))
  }
  // Runes, bottes, familier et compétences selon le contexte adverse ; familier selon le jungler adverse.
  const choice = {
    runes: rec.runeSig,
    boots: rec.boots === null ? null : String(rec.boots),
    pet: rec.pet === null ? null : String(rec.pet),
    skills: rec.skills
  }
  for (const kind of CHOICE_KINDS)
    for (const ctx of contexts) inc((c.opt[kind][ctx] ??= {}), choice[kind], rec.win)
  if (rec.enemyJungler) inc((c.petVs[rec.enemyJungler] ??= {}), choice.pet, rec.win)

  // Combats contre le jungler adverse, par période.
  for (const d of rec.duels ?? []) {
    const period = periodOf(d.min)
    for (const key of [rec.enemyJungler, '_all']) {
      if (!key) continue
      const cell = ((c.duel[key] ??= {})[period] ??= [0, 0])
      cell[0] += 1
      if (d.won) cell[1] += 1
    }
  }
  // Début de partie : côté de départ et première élimination.
  if (rec.opening?.side) {
    c.open.g += 1
    if (rec.opening.side === 'top') c.open.top += 1
    const first = rec.opening.first
    if (first && first.min < 15) {
      c.open.firstN += 1
      c.open.firstMin += first.min
      if (first.lane) c.open.lanes[first.lane] = (c.open.lanes[first.lane] ?? 0) + 1
    }
  }

  items.forEach((id, k) => {
    const minute = rec.itemMin?.[k]
    if (typeof minute !== 'number') return
    const cell = (c.itemMin[id] ??= [0, 0])
    cell[0] += 1
    cell[1] += minute
  })

  // Famille de build : toutes les parties qui commencent par le même objet légendaire.
  if (rec.core.length >= 1) {
    const f = familyState(c, String(rec.core[0]))
    f.g++
    if (rec.win) f.w++
    inc(f.runes, rec.runeSig, rec.win)
    if (rec.core.length >= 2) inc(f.c2, rec.core.slice(0, 2).join('>'), rec.win)
    if (rec.core.length >= 3) inc(f.c3, rec.core.slice(0, 3).join('>'), rec.win)
    for (const id of rec.later) inc(f.later, String(id), rec.win)
    inc(f.boots, rec.boots === null ? null : String(rec.boots), rec.win)
    inc(f.pet, rec.pet === null ? null : String(rec.pet), rec.win)
    inc(f.skills, rec.skills, rec.win)
    for (const ctx of contexts) {
      inc(f.ctxBase, ctx, rec.win)
      inc((f.ctxRunes[ctx] ??= {}), rec.runeSig, rec.win)
    }
  }

  // Tous junglers confondus : chaque objet face à chaque adversaire et chaque objet adverse.
  const foes = [...(rec.enemies ?? []), rec.enemyJungler, ...(rec.foeTags ?? [])].filter(Boolean)
  for (const foe of foes) inc(state.foeAll, foe, rec.win)
  for (const id of items) {
    inc(state.itemAll, String(id), rec.win)
    const row = (state.itemFoe[id] ??= {})
    for (const foe of foes) inc(row, foe, rec.win)
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

/** Multiplie tous les compteurs (nombres) d'une structure par `factor`. Les moyennes stockées en
 * [nombre, somme] sont conservées. */
function scaleDeep(x, factor) {
  if (typeof x === 'number') return x * factor
  if (Array.isArray(x)) return x.map((v) => scaleDeep(v, factor))
  if (x && typeof x === 'object')
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, scaleDeep(v, factor)]))
  return x
}

/** Reprend les compteurs d'un patch précédent avec un poids réduit (démarrage plus stable). */
export function seedFromPrevious(state, previous, factor = 0.25) {
  state.champs = scaleDeep(previous.champs ?? {}, factor)
  state.profiles = scaleDeep(previous.profiles ?? {}, factor)
  state.itemAll = scaleDeep(previous.itemAll ?? {}, factor)
  state.itemFoe = scaleDeep(previous.itemFoe ?? {}, factor)
  state.foeAll = scaleDeep(previous.foeAll ?? {}, factor)
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
 * Effet d'un objet sur la victoire, comparé aux autres objets achetés AU MÊME RANG (1er, 2e…
 * 6e objet légendaire). Comparer « avec / sans l'objet » avantagerait les objets tardifs : seuls
 * les joueurs qui ont beaucoup d'or les terminent, et ceux-là gagnent plus souvent.
 */
function slotLift(slots, id, prior) {
  if (!slots) return null
  let weight = 0
  let sum = 0
  for (const byItem of Object.values(slots)) {
    const cell = byItem[id]
    if (!cell) continue
    let g = 0
    let w = 0
    for (const [gg, ww] of Object.values(byItem)) {
      g += gg
      w += ww
    }
    if (g <= 0) continue
    const slotRate = bayes(g, w, prior, 20)
    sum += cell[0] * (bayes(cell[0], cell[1], slotRate, 20) - slotRate)
    weight += cell[0]
  }
  return weight >= 10 ? { lift: sum / weight, games: weight } : null
}

/**
 * Objets qui gagnent le plus dans chaque contexte adverse : part des parties où l'objet est
 * construit, gain de taux de victoire par rapport aux autres choix au même rang, et minute
 * moyenne d'achat.
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
        // Rang par rang si possible ; sinon (anciennes données) avec / sans l'objet.
        const bySlot = slotLift(c.ctxSlots?.[ctx], id, prior)
        const lift =
          bySlot?.lift ?? bayes(g, w, prior, 20) - bayes(base[0] - g, base[1] - w, prior, 20)
        const minute = c.itemMin?.[id]
        const entry = {
          item: it.name,
          share: round3(share),
          lift: round3(lift),
          games: Math.round(g)
        }
        if (minute && minute[0] >= 5) entry.minute = Math.round((minute[1] / minute[0]) * 10) / 10
        return entry
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

/**
 * Combats contre chaque jungler adverse (et '_all' : tous) : par période, [combats, part gagnée].
 * Seulement les affrontements avec au moins 15 combats au total.
 */
export function duelStats(duel) {
  const out = {}
  for (const [enemy, periods] of Object.entries(duel ?? {})) {
    const total = DUEL_PERIODS.reduce((s, p) => s + (periods[p]?.[0] ?? 0), 0)
    if (total < 15) continue
    const row = {}
    for (const p of DUEL_PERIODS) {
      const cell = periods[p]
      if (cell && cell[0] >= 5) row[p] = [Math.round(cell[0]), round3(cell[1] / cell[0])]
    }
    if (Object.keys(row).length) out[enemy] = row
  }
  return out
}

/** Début de partie : part des départs côté haut, minute et voie de la première élimination. */
export function openingStats(open) {
  if (!open || open.g < 30) return null
  const lanes = {}
  if (open.firstN > 0)
    for (const [lane, n] of Object.entries(open.lanes ?? {})) lanes[lane] = round3(n / open.firstN)
  return {
    games: Math.round(open.g),
    top: round3(open.top / open.g),
    firstMinute: open.firstN >= 10 ? Math.round((open.firstMin / open.firstN) * 10) / 10 : null,
    firstLanes: lanes
  }
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
    const duels = duelStats(c.duel)
    if (Object.keys(duels).length) out[champ].duels = duels
    const opening = openingStats(c.open)
    if (opening) out[champ].opening = opening
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

/** [parties, taux] par contexte d'une valeur, à partir des compteurs { ctx: { valeur: [g, w] } }. */
function contextRates(byCtx, value) {
  const out = {}
  for (const [ctx, map] of Object.entries(byCtx ?? {})) {
    const cell = map?.[value]
    if (cell && cell[0] >= 10) out[ctx] = [Math.round(cell[0]), round3(cell[1] / cell[0])]
  }
  return out
}

/**
 * Options courantes d'un choix (au moins 8 % des parties), avec leur taux de victoire par
 * contexte adverse. `describe` transforme la valeur brute (signature de runes, identifiant
 * d'objet…) pour l'app, ou renvoie null si elle n'est pas valide.
 */
function choiceList(totals, byCtx, describe, { minShare = 0.08, minGames = 20, max = 4 } = {}) {
  const entries = Object.entries(totals ?? {})
  const total = entries.reduce((s, [, [g]]) => s + g, 0)
  if (total <= 0) return []
  return entries
    .filter(([, [g]]) => g >= minGames && g / total >= minShare)
    .sort((a, b) => b[1][0] - a[1][0])
    .map(([value, [g, w]]) => {
      const desc = describe(value)
      if (!desc) return null
      return {
        ...desc,
        games: Math.round(g),
        winRate: round3(w / g),
        share: round3(g / total),
        contexts: contextRates(byCtx, value)
      }
    })
    .filter(Boolean)
    .slice(0, max)
}

/**
 * Choix d'un champion mesurés par contexte adverse : pages de runes, bottes, familier (aussi
 * selon le jungler adverse) et ordre des compétences. Un choix n'apparaît que s'il a au moins
 * deux options courantes.
 */
export function buildChoices(c, dd) {
  const itemName = (id) => dd.items.get(Number(id))?.name ?? null
  const out = {}
  const runes = choiceList(c.runes, c.opt?.runes, (sig) => {
    const r = runesFromSig(sig, dd)
    return r ? { runes: r } : null
  })
  if (runes.length >= 2) out.runes = runes
  const boots = choiceList(c.boots, c.opt?.boots, (id) => {
    const n = itemName(id)
    return n ? { name: n } : null
  })
  if (boots.length >= 2) out.boots = boots
  const pet = choiceList(c.pet, c.opt?.pet, (id) => {
    const n = itemName(id)
    if (!n) return null
    const vs = {}
    for (const [enemy, map] of Object.entries(c.petVs ?? {})) {
      const cell = map?.[id]
      if (cell && cell[0] >= 10) vs[enemy] = [Math.round(cell[0]), round3(cell[1] / cell[0])]
    }
    return { name: n, vs }
  })
  if (pet.length >= 2) out.pet = pet
  const skills = choiceList(c.skills, c.opt?.skills, (v) => (v ? { value: v } : null))
  if (skills.length >= 2) out.skills = skills
  return out
}

/**
 * Familles de build d'un champion (même premier objet légendaire) jouées dans au moins 12 % des
 * parties : chacune avec son cœur, ses runes, ses options et son taux de victoire par contexte.
 * Rien si une seule famille ressort.
 */
export function buildVariants(champ, c, dd, { minGames = 40 } = {}) {
  const variants = []
  const fams = Object.entries(c.fam ?? {}).sort((a, b) => b[1].g - a[1].g)
  for (const [first, f] of fams) {
    if (f.g < Math.max(30, minGames * 0.6) || f.g / c.g < 0.12) continue
    const pseudo = { ...f, c1: { [first]: [f.g, f.w] }, ctxItems: {}, ctxSlots: {} }
    const b = selectBuild(champ, pseudo, dd, { minGames: 0 })
    if (!b) continue
    const contexts = {}
    for (const [ctx, [g, w]] of Object.entries(f.ctxBase ?? {}))
      if (g >= 10) contexts[ctx] = [Math.round(g), round3(w / g)]
    const runeChoices = choiceList(f.runes, f.ctxRunes, (sig) => {
      const r = runesFromSig(sig, dd)
      return r ? { runes: r } : null
    })
    variants.push({
      ...(runeChoices.length >= 2 ? { runeChoices } : {}),
      key: b.core[0],
      archetype: b.archetype,
      pet: b.pet,
      boots: b.boots,
      core: b.core,
      options: b.options,
      skills: b.skills,
      runes: b.runes,
      games: Math.round(f.g),
      winRate: round3(f.w / f.g),
      share: round3(f.g / c.g),
      contexts
    })
    if (variants.length === 3) break
  }
  return variants.length >= 2 ? variants : []
}

/**
 * Objets face aux adversaires (tous junglers confondus) : écart de taux de victoire d'un objet
 * quand tel champion (ou tel type d'objet adverse, ex. '#pctHp') est en face, moins l'écart que ce
 * même adversaire provoque pour tout le monde. Ne garde que les effets nets.
 */
export function buildItemCounters(state, dd, { minItemGames = 200, minPairGames = 40 } = {}) {
  let G = 0
  let W = 0
  for (const c of Object.values(state.champs)) {
    G += c.g
    W += c.w
  }
  if (G <= 0) return {}
  const overall = W / G
  const out = {}
  for (const [id, [g, w]] of Object.entries(state.itemAll ?? {})) {
    const it = dd.items.get(Number(id))
    if (!it?.isLegendary || g < minItemGames) continue
    const base = w / g
    const rows = []
    for (const [foe, [pg, pw]] of Object.entries(state.itemFoe?.[id] ?? {})) {
      if (pg < minPairGames) continue
      const fa = state.foeAll?.[foe]
      if (!fa || fa[0] < minPairGames) continue
      const foeShift = bayes(fa[0], fa[1], overall, 50) - overall
      const lift = bayes(pg, pw, base, 50) - base - foeShift
      if (Math.abs(lift) >= 0.015) rows.push([foe, Math.round(pg), round3(lift)])
    }
    rows.sort((a, b) => Math.abs(b[2]) * Math.sqrt(b[1]) - Math.abs(a[2]) * Math.sqrt(a[1]))
    if (rows.length)
      out[it.name] = Object.fromEntries(rows.slice(0, 15).map(([f, pg, l]) => [f, [pg, l]]))
  }
  return out
}

const rateOf = ([g, w]) => (g > 0 ? round3(w / g) : null)

/** Résumé du backtest pour meta.json. */
export function backtestSummary(bt) {
  if (!bt || bt.games === 0) return null
  const cell = (x) => ({ games: Math.round(x[0]), winRate: rateOf(x) })
  return {
    games: bt.games,
    variant: { followed: cell(bt.variant.followed), other: cell(bt.variant.other) },
    items: { high: cell(bt.items.high), low: cell(bt.items.low) }
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
    if (!b) continue
    const variants = buildVariants(champ, c, dd, options)
    if (variants.length) b.variants = variants
    const choices = buildChoices(c, dd)
    if (Object.keys(choices).length) b.choices = choices
    builds.push(b)
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
    itemCounters: buildItemCounters(state, dd),
    backtest: backtestSummary(state.backtest),
    // Début de patch : on garde les repères précédents tant qu'il n'y a pas assez de parties.
    benchmarks: (() => {
      const b = buildBenchmarks(state)
      return b._all ? b : (previousMeta?.benchmarks ?? b)
    })()
  }
}
