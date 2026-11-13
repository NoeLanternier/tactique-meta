// Agrégation des parties et choix des builds.
//
// Pour éviter qu'une option jouée 3 fois avec 3 victoires passe devant tout le monde, le taux de
// victoire est « lissé » vers celui du champion (moyenne bayésienne) et une option doit représenter
// une part minimale des parties du champion pour être retenue.
import { TUNING_VERSION, emptyTuning, solveTuning } from './tuning.mjs'
import { ARCHETYPES, guessArchetype } from './archetypes.mjs'
import { bestOption, momPrior, posterior } from './stats.mjs'
import {
  DEFAULT_PRIORS,
  STATES,
  championItemLift,
  measureFit,
  measurePriors,
  pooledItemLifts
} from './priors.mjs'
import { legendaryOn } from './ddragon.mjs'
import { MODES } from './modes.mjs'

export const STATE_VERSION = 7
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
    backtest: emptyBacktest(),
    tuning: emptyTuning(),
    bans: { games: 0, champs: {} }
  }
}

/**
 * Compteurs du backtest. Famille : parties où le joueur a commencé (ou non) par la famille
 * conseillée. Objets : achats du 4e au 6e objet qui font partie (high) ou non (low) des objets
 * conseillés, comparés au même rang (v : 2).
 */
export function emptyBacktest() {
  return {
    v: 2,
    games: 0,
    variant: { followed: [0, 0], other: [0, 0] },
    items: { high: [0, 0], low: [0, 0] }
  }
}

/**
 * Version 6 : contextes adverses tirés de la composition (profils des champions) et non plus de ce
 * qui s'est passé dans la partie. Les compteurs par contexte d'avant sont retirés (ils se
 * remplissent à nouveau en quelques collectes) ; 'all' et tout le reste sont gardés. Le réglage du
 * moteur repart de zéro (ses critères ont changé).
 */
function dropOldContexts(state) {
  const keepAll = (m) => {
    if (!m || typeof m !== 'object') return
    for (const k of Object.keys(m)) if (k !== 'all') delete m[k]
  }
  for (const c of Object.values(state.champs ?? {})) {
    keepAll(c.ctxBase)
    keepAll(c.ctxItems)
    keepAll(c.ctxSlots)
    for (const kind of Object.values(c.opt ?? {})) keepAll(kind)
    for (const f of Object.values(c.fam ?? {})) {
      keepAll(f.ctxBase)
      keepAll(f.ctxRunes)
    }
  }
  state.ctxStats = {}
  state.tuning = emptyTuning()
}

/**
 * Version 7 : lissage mesuré sur les données, objets comparés au même rang et dans le même état de
 * la partie (compteurs `sl`). Les anciens compteurs par rang et par contexte (`ctxSlots`), dont les
 * écarts n'étaient que du hasard, sont retirés ; le backtest et le réglage du moteur repartent de
 * zéro (leurs calculs ont changé).
 */
function toVersion7(state) {
  for (const c of Object.values(state.champs ?? {})) delete c.ctxSlots
  state.backtest = emptyBacktest()
  state.tuning = emptyTuning()
}

/** Ajoute les champs des nouvelles versions à un état plus ancien. */
export function upgradeState(state) {
  if ((state.version ?? 0) < 6) dropOldContexts(state)
  if ((state.version ?? 0) < 7) toVersion7(state)
  state.profiles ??= {}
  state.ctxStats ??= {}
  state.itemAll ??= {}
  state.itemFoe ??= {}
  state.foeAll ??= {}
  state.backtest ??= emptyBacktest()
  // Critères du réglage changés (voir TUNING_VERSION) : il repart de zéro.
  if (state.tuning?.v !== TUNING_VERSION) state.tuning = emptyTuning()
  state.bans ??= { games: 0, champs: {} }
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
  'start',
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
  // Objets par état de la partie à l'achat, puis par rang : { a|e|b: { rang: { objet: [g, w] } } }.
  c.sl ??= {}
  c.itemMin ??= {}
  c.fam ??= {}
  c.bench ??= {}
  c.opt ??= {}
  for (const k of CHOICE_KINDS) c.opt[k] ??= {}
  c.petVs ??= {}
  c.duel ??= {}
  c.open ??= { g: 0, top: 0, firstN: 0, firstMin: 0, lanes: {} }
  // ARAM Mayhem : augments choisis avec ce champion { augment: [g, w] }.
  c.aug ??= {}
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

/** Repères propres aux modes sans voie (ARAM…), en plus des autres. */
export const MODE_BENCH_KEYS = ['goldPerMin', 'dmgPerMin', 'deathsPer10', 'dmgShare']

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

const ENEMY_KEYS = ['phys', 'magic', 'heal', 'tank', 'cc']

/**
 * Composition adverse attendue avant la partie : somme des profils moyens (par minute) des cinq
 * adversaires, comme l'app les estime pendant la draft. Les valeurs réellement observées dans la
 * partie dépendent de son issue (une équipe qui gagne soigne et encaisse davantage) et faussaient
 * les taux par contexte. Null tant que les profils sont trop peu nombreux (contexte 'all' seul).
 */
export function expectedEnemy(profiles, foes, minGames = 20) {
  const known = Object.values(profiles ?? {}).filter((p) => p.g >= minGames && p.minutes > 0)
  if (known.length < 10 || !foes?.length) return null
  const avg = {}
  for (const k of ENEMY_KEYS) avg[k] = known.reduce((s, p) => s + p[k] / p.minutes, 0) / known.length
  const out = { minutes: 1, phys: 0, magic: 0, heal: 0, tank: 0, cc: 0 }
  for (const champ of foes) {
    const p = profiles[champ]
    const ok = p && p.g >= minGames && p.minutes > 0
    for (const k of ENEMY_KEYS) out[k] += ok ? p[k] / p.minutes : avg[k]
  }
  return out
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

/** Contextes adverses d'une partie (composition attendue, voir expectedEnemy). */
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
  inc(c.start, rec.start ?? null, rec.win)
  inc(c.skills, rec.skills, rec.win)
  if (rec.enemyJungler) inc(c.vs, rec.enemyJungler, rec.win)
  for (const ally of rec.allies ?? []) inc(c.with, ally, rec.win)
  for (const enemy of rec.enemies ?? []) inc(c.against, enemy, rec.win)
  for (const k of [...BENCH_KEYS, ...MODE_BENCH_KEYS]) {
    const v = rec.bench?.[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const cell = (c.bench[k] ??= [0, 0])
    cell[0] += 1
    cell[1] += v
  }
  // Augments (ARAM Mayhem) et usage réel des runes et augments dans les modes.
  const augs = [...new Set(rec.augments ?? [])].map(String)
  for (const id of augs) inc(c.aug, id, rec.win)
  if (augs.length) {
    // Tous champions confondus : objets achetés avec chaque augment, et augments pris ensemble.
    state.augItem ??= {}
    state.augPair ??= {}
    for (const a of augs) {
      const row = (state.augItem[a] ??= {})
      for (const id of rec.items ?? []) inc(row, String(id), rec.win)
    }
    const sorted = [...augs].sort()
    for (let i = 0; i < sorted.length; i++)
      for (let j = i + 1; j < sorted.length; j++)
        inc(state.augPair, `${sorted[i]}|${sorted[j]}`, rec.win)
  }
  if (rec.mode) {
    const f = (state.feat ??= { n: 0, runes: 0, aug: 0 })
    f.n++
    if (rec.runeSig) f.runes++
    if (rec.augments?.length) f.aug++
  }
  const contexts = contextsOf(state, rec.enemy)
  const items = rec.items ?? []
  for (const ctx of contexts) {
    inc(c.ctxBase, ctx, rec.win)
    const present = (c.ctxItems[ctx] ??= {})
    for (const id of items) inc(present, String(id), rec.win)
  }
  // Objet au k-ième rang, selon l'état de la partie à l'achat : comparé ensuite aux autres objets
  // achetés au même rang et dans le même état.
  items.forEach((id, k) => {
    const st = rec.itemState?.[k]
    if (!STATES.includes(st)) return
    inc(((c.sl[st] ??= {})[k] ??= {}), String(id), rec.win)
  })
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

/** Bannissements : nombre de parties, et de parties où chaque champion a été banni. */
export function addBans(state, champs) {
  const b = (state.bans ??= { games: 0, champs: {} })
  b.games++
  for (const c of new Set(champs)) b.champs[c] = (b.champs[c] ?? 0) + 1
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
  state.bans = previous.bans ? scaleDeep(previous.bans, factor) : { games: 0, champs: {} }
  // (le numéro de version n'est pas un compteur : il n'est pas multiplié.)
  state.tuning =
    previous.tuning?.v === TUNING_VERSION
      ? { ...scaleDeep(previous.tuning, factor), v: TUNING_VERSION }
      : emptyTuning()
  state.seededFrom = previous.patch
  return state
}

const round3 = (x) => Math.round(x * 1000) / 1000

/**
 * Meilleure option d'un compteur : celle dont le taux de victoire estimé est le meilleur, parmi
 * celles jouées dans au moins `minShare` des cas (lissage de force `k`, voir stats.mjs). À défaut,
 * la plus jouée.
 */
export function pickBest(map, _prior, { minShare = 0.1, minGames = 5, filter, k, slope } = {}) {
  return bestOption(map, { minShare, minGames, filter, k: k ?? 2000, slope: slope ?? 0 })
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

/** Clé de voûte d'une signature de page de runes. */
export const keystoneOf = (sig) => String(sig).split('|')[1]?.split(',')[0] ?? ''

/** Compteur { clé de voûte: [parties, victoires] } à partir des pages de runes. */
export function keystoneTotals(runes, valid = () => true) {
  const out = {}
  for (const [sig, [g, w]] of Object.entries(runes ?? {})) {
    if (!valid(sig)) continue
    const cell = (out[keystoneOf(sig)] ??= [0, 0])
    cell[0] += g
    cell[1] += w
  }
  return out
}

/** Parties fictives qui ramènent la part d'un objet dans un contexte vers sa part habituelle. */
const SHARE_PRIOR = 40

/**
 * Objets d'un champion après le cœur, pour chaque contexte :
 * - `all` : part des parties où l'objet est construit, et écart de taux de victoire par rapport
 *   aux autres objets achetés au même rang et dans le même état de la partie (lissé, voir
 *   priors.mjs) ;
 * - `ap`, `ad`, `heal`, `tank`, `cc` : part de l'objet face à ce type d'équipe. C'est le signal
 *   fiable d'un contexte : ce que les joueurs construisent davantage dans ces parties. L'écart de
 *   taux de victoire par contexte n'est pas mesurable avec ce volume de parties : celui de `all`
 *   est repris ;
 * - `ahead`, `behind` : part et écart de l'objet quand il est acheté avec de l'avance ou du retard.
 */
export function situationalStats(c, dd, { priors = DEFAULT_PRIORS, pooled = {} } = {}) {
  const out = {}
  const base = c.ctxBase?.all
  const items = c.ctxItems?.all
  if (!base || !items || base[0] < 20) return out
  const kSlot = priors.slot ?? DEFAULT_PRIORS.slot
  const list = Object.entries(items)
    .map(([id, [g]]) => {
      const it = dd.items.get(Number(id))
      if (!it?.isLegendary || g < 5 || g / base[0] < 0.03) return null
      const [, lift] = championItemLift(c, id, pooled, kSlot)
      return { id, name: it.name, games: g, share: g / base[0], lift }
    })
    .filter(Boolean)
    .sort((a, b) => b.share - a.share)
    .slice(0, 14)
  if (!list.length) return out
  out.all = {
    games: Math.round(base[0]),
    items: list.map((x) => {
      const entry = {
        item: x.name,
        share: round3(x.share),
        lift: round3(x.lift),
        games: Math.round(x.games)
      }
      const minute = c.itemMin?.[x.id]
      if (minute && minute[0] >= 5) entry.minute = Math.round((minute[1] / minute[0]) * 10) / 10
      return entry
    })
  }
  for (const ctx of CONTEXTS) {
    if (ctx === 'all') continue
    const n = c.ctxBase?.[ctx]?.[0] ?? 0
    if (n < 30) continue
    out[ctx] = {
      games: Math.round(n),
      items: list.map((x) => {
        const g = c.ctxItems?.[ctx]?.[x.id]?.[0] ?? 0
        return {
          item: x.name,
          share: round3((g + SHARE_PRIOR * x.share) / (n + SHARE_PRIOR)),
          lift: round3(x.lift),
          games: Math.round(g)
        }
      })
    }
  }
  // Achats tardifs (à partir du 3e objet) selon l'état de la partie.
  const late = (st, id) => {
    let n = 0
    for (const [k, byItem] of Object.entries(c.sl?.[st] ?? {})) {
      if (Number(k) < 2) continue
      if (id === undefined) for (const [g] of Object.values(byItem)) n += g
      else n += byItem[id]?.[0] ?? 0
    }
    return n
  }
  const total = STATES.reduce((t, st) => t + late(st), 0)
  for (const [key, st] of [
    ['ahead', 'a'],
    ['behind', 'b']
  ]) {
    const n = late(st)
    if (n < 40 || total <= 0) continue
    out[key] = {
      games: Math.round(n),
      items: list.map((x) => {
        const usual = STATES.reduce((t, s) => t + late(s, x.id), 0) / total
        const g = late(st, x.id)
        const here = (g + SHARE_PRIOR * usual) / (n + SHARE_PRIOR)
        // Écart propre à cet état, lissé deux fois plus fort (moins de parties par état).
        const [ns, raw] = championItemLift(c, x.id, {}, 0, [st])
        const [na, rawAll] = championItemLift(c, x.id, {}, 0)
        const own = ns > 0 && na > 0 ? posterior(ns, raw - rawAll, 2 * kSlot) : 0
        return {
          item: x.name,
          share: round3(usual > 0 ? Math.min(1, (x.share * here) / usual) : x.share),
          lift: round3(x.lift + own),
          games: Math.round(g)
        }
      })
    }
  }
  return out
}

/**
 * Calcule le build d'un champion, ou null si trop peu de parties. Chaque choix (page de runes,
 * objets du cœur, bottes, familier, compétences, départ) est celui dont le taux de victoire estimé
 * est le meilleur, avec un lissage mesuré sur les données (`priors`) : une option peu jouée ne
 * passe devant l'option habituelle que si son avantage est établi.
 */
export function selectBuild(
  champ,
  c,
  dd,
  { minGames = 40, priors = DEFAULT_PRIORS, pooled, allowNoRunes = false } = {}
) {
  if (!c || c.g < minGames) return null
  const prior = c.w / c.g
  const itemName = (id) => dd.items.get(Number(id))?.name ?? null
  const P = { ...DEFAULT_PRIORS, ...priors }
  const itemSlope = priors?.slope?.item ?? 0

  // Runes : d'abord la clé de voûte (toutes ses pages réunies : c'est le choix qui compte le plus
  // et celui que les données mesurent le mieux), puis la meilleure page complète de cette clé
  // (validée contre Data Dragon).
  const validSig = (sig) => runesFromSig(sig, dd) !== null
  const keystone = bestOption(keystoneTotals(c.runes, validSig), { k: P.keystone })
  const sig = bestOption(c.runes, {
    minShare: 0.1,
    filter: (s) => validSig(s) && keystoneOf(s) === keystone,
    k: P.runes
  })
  // Modes sans runes (ARAM Mayhem) : build publié sans page (runes: null).
  const runes = sig ? runesFromSig(sig, dd) : null
  if (!runes && !allowNoRunes) return null

  // Cœur : choix conditionnel (1er objet, puis 2e sachant le 1er, puis 3e).
  const c1 = bestOption(c.c1, { k: P.c1, slope: itemSlope })
  if (!c1) return null
  const c2key = bestOption(c.c2, {
    k: P.c2,
    slope: itemSlope,
    filter: (k) => k.startsWith(`${c1}>`)
  })
  const c2 = c2key ? c2key.split('>')[1] : null
  const c3key = c2
    ? bestOption(c.c3, { k: P.c3, slope: itemSlope, filter: (k) => k.startsWith(`${c1}>${c2}>`) })
    : null
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

  const boots = bestOption(c.boots, { k: P.boots })
  const pet = bestOption(c.pet, { minShare: 0.15, k: P.pet })
  const skills =
    bestOption(c.skills, { minShare: 0.15, k: P.skills, slope: priors?.slope?.skills ?? 0 }) ?? ''
  const startSig = bestOption(c.start ?? {}, {
    minShare: 0.2,
    k: P.start,
    slope: priors?.slope?.start ?? 0
  })
  const start = startSig
    ? startSig.split(',').map((id) => itemName(id)).filter(Boolean)
    : []
  // Départs courants (au moins 8 % des parties), comme les choix proposés par la boutique : l'app
  // les affiche avec leur part et leur taux de victoire.
  const startTotal = Object.values(c.start ?? {}).reduce((t, [g]) => t + g, 0)
  const startOptions = Object.entries(c.start ?? {})
    .filter(([sigKey, [g]]) => sigKey && g >= 10 && g / Math.max(1, startTotal) >= 0.08)
    .sort((x, y) => y[1][0] - x[1][0])
    .slice(0, 3)
    .map(([sigKey, [g, w]]) => ({
      items: sigKey.split(',').map((id) => itemName(id)).filter(Boolean),
      games: Math.round(g),
      share: round3(g / startTotal),
      winRate: round3(prior + posterior(g, w / g - prior, P.start))
    }))
    .filter((o) => o.items.length)
  const coreItems = core.map((id) => dd.items.get(Number(id)))

  return {
    id: champ,
    archetype: ARCHETYPES[champ] ?? guessArchetype(coreItems),
    pet: (pet && itemName(pet)) || 'Gustwalker Hatchling',
    boots: (boots && itemName(boots)) || 'Plated Steelcaps',
    core: coreItems.map((it) => it.name),
    options,
    skills,
    ...(start.length ? { start } : {}),
    ...(startOptions.length ? { startOptions } : {}),
    runes,
    situational: situationalStats(c, dd, { priors: P, pooled }),
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
    // Taux de victoire selon la composition adverse (équipe très AP, très AD, soins…).
    const contexts = {}
    for (const [ctx, [g, w]] of Object.entries(c.ctxBase ?? {}))
      if (ctx !== 'all' && g >= 30) contexts[ctx] = [Math.round(g), round3(w / g)]
    if (Object.keys(contexts).length) out[champ].contexts = contexts
    const bans = state.bans
    if (bans?.games >= 100) out[champ].banRate = round3((bans.champs[champ] ?? 0) / bans.games)
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
export function buildBenchmarks(state, minGames = 30, keys = BENCH_KEYS) {
  const out = {}
  const all = {}
  let allGames = 0
  for (const [champ, c] of Object.entries(state.champs)) {
    const b = c.bench ?? {}
    for (const k of keys) {
      const [n, sum] = b[k] ?? [0, 0]
      const cell = (all[k] ??= [0, 0])
      cell[0] += n
      cell[1] += sum
    }
    allGames += c.g
    if (c.g < minGames) continue
    const row = { games: Math.round(c.g) }
    let ok = true
    for (const k of keys) {
      const [n, sum] = b[k] ?? [0, 0]
      if (n < Math.min(10, minGames)) ok = false
      else row[k] = round3(sum / n)
    }
    if (ok) out[champ] = row
  }
  const total = { games: Math.round(allGames) }
  let ok = allGames >= minGames
  for (const k of keys) {
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
export function buildVariants(champ, c, dd, { minGames = 40, priors, allowNoRunes = false } = {}) {
  const variants = []
  const fams = Object.entries(c.fam ?? {}).sort((a, b) => b[1].g - a[1].g)
  for (const [first, f] of fams) {
    if (f.g < Math.max(30, minGames * 0.6) || f.g / c.g < 0.12) continue
    const pseudo = { ...f, c1: { [first]: [f.g, f.w] }, ctxItems: {}, sl: {} }
    const b = selectBuild(champ, pseudo, dd, { minGames: 0, priors, allowNoRunes })
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
 * Effet d'un objet face à un adversaire précis ou à un type d'objets adverses ('#antiheal'…), tous
 * champions du poste confondus : écart de taux de victoire de l'objet dans ces parties, une fois
 * retirés l'effet habituel de l'objet et celui de l'adversaire. Les écarts sont lissés selon ce que
 * les données permettent de mesurer (voir stats.mjs) et publiés tels quels : l'app les additionne
 * sans autre correction. Seuls les écarts d'au moins 0,4 point sont gardés.
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
  const rows = []
  for (const [id, [g, w]] of Object.entries(state.itemAll ?? {})) {
    const it = dd.items.get(Number(id))
    if (!it?.isLegendary || g < minItemGames) continue
    const base = w / g
    for (const [foe, [pg, pw]] of Object.entries(state.itemFoe?.[id] ?? {})) {
      if (pg < minPairGames) continue
      const fa = state.foeAll?.[foe]
      if (!fa || fa[0] < 200) continue
      const dev = pw / pg - base - (fa[1] / fa[0] - overall)
      rows.push({ item: it.name, foe, n: pg, dev, v: (base * (1 - base)) / pg })
    }
  }
  const kOf = (trait) =>
    momPrior(
      rows.filter((r) => r.foe.startsWith('#') === trait).map((r) => [r.n, r.dev, r.v]),
      { fallback: DEFAULT_PRIORS.counter, minCells: 200, minGames: 50000 }
    ).k
  const k = { champ: kOf(false), trait: kOf(true) }
  const out = {}
  for (const r of rows) {
    const lift = posterior(r.n, r.dev, r.foe.startsWith('#') ? k.trait : k.champ)
    if (Math.abs(lift) < 0.004) continue
    ;(out[r.item] ??= {})[r.foe] = [Math.round(r.n), round3(lift)]
  }
  return out
}

/**
 * Tous les champions vus dans l'équipe adverse, quel que soit leur poste : [parties, taux de
 * victoire de leur équipe, part des parties où ils sont bannis]. Sert aux bans (un champion fort à
 * un autre poste mérite aussi un ban).
 */
export function buildThreats(state, minGames = 100) {
  const out = {}
  const bans = state.bans
  for (const [foe, [g, w]] of Object.entries(state.foeAll ?? {})) {
    if (foe.startsWith('#') || g < minGames) continue
    out[foe] = [Math.round(g), round3(1 - w / g)]
    // Part des parties où le champion est banni (les bans valent pour tous les postes).
    if (bans?.games >= 100) out[foe].push(round3((bans.champs[foe] ?? 0) / bans.games))
  }
  return out
}

const rateOf = ([g, w]) => (g > 0 ? round3(w / g) : null)

/** Résumé du backtest pour meta.json. */
export function backtestSummary(bt) {
  if (!bt || bt.games === 0) return null
  const cell = (x) => ({ games: Math.round(x[0]), winRate: rateOf(x) })
  return {
    v: 2,
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
/**
 * ARAM Mayhem : effet de chaque augment. Effet regroupé (tous champions) : écart du taux de victoire
 * des joueurs qui l'ont pris à celui de leur champion, lissé avec une force mesurée ; puis, pour
 * chaque champion, écart propre lissé vers l'effet regroupé (force mesurée sur les écarts
 * champion × augment). Biais connu : un augment se choisit parmi trois de même rareté, et pas au
 * hasard ; l'écart dit ce que rapporte le choix d'un joueur, ce qui est la question posée.
 */
export function augmentStats(state, { minGames = 30, champMinGames = 10, max = 60 } = {}) {
  const binVar = (p, n) => (p * (1 - p)) / n
  const acc = {}
  const champs = Object.entries(state.champs ?? {}).filter(([, c]) => c.g >= 50)
  for (const [, c] of champs) {
    const b = c.w / c.g
    for (const [id, [g, w]] of Object.entries(c.aug ?? {})) {
      const a = (acc[id] ??= [0, 0, 0, 0])
      a[0] += g
      a[1] += g * (w / g - b)
      a[2] += g * b * (1 - b) * Math.max(0, 1 - g / c.g)
      a[3] += w
    }
  }
  const rows = Object.entries(acc).filter(([, [n]]) => n >= minGames)
  const kPool = momPrior(
    rows.map(([, [n, sd, sv]]) => [n, sd / n, sv / (n * n)]),
    { fallback: 3000, minCells: 20, minGames: 5000 }
  ).k
  const pooled = {}
  for (const [id, [n, sd, , w]] of rows)
    pooled[id] = { games: Math.round(n), winRate: round3(w / n), lift: posterior(n, sd / n, kPool) }
  const cells = []
  for (const [, c] of champs) {
    const b = c.w / c.g
    for (const [id, [g, w]] of Object.entries(c.aug ?? {}))
      if (g >= champMinGames && pooled[id])
        cells.push([g, w / g - b - pooled[id].lift, binVar(b, g) * Math.max(0, 1 - g / c.g)])
  }
  const kChamp = momPrior(cells, { fallback: 2000, minCells: 40, minGames: 5000 }).k
  const perChamp = {}
  for (const [champ, c] of champs) {
    const b = c.w / c.g
    const list = Object.entries(c.aug ?? {})
      .filter(([id, [g]]) => g >= champMinGames && pooled[id])
      .sort((x, y) => y[1][0] - x[1][0])
      .slice(0, max)
      .map(([id, [g, w]]) => {
        const lift = posterior(g, w / g - b, kChamp, pooled[id].lift)
        return { id: Number(id), games: Math.round(g), winRate: round3(b + lift), lift: round3(lift) }
      })
      .sort((x, y) => y.lift - x.lift)
    if (list.length) perChamp[champ] = list
  }
  for (const p of Object.values(pooled)) p.lift = round3(p.lift)
  return { pooled, perChamp, k: { pool: kPool, champ: kChamp } }
}

/**
 * ARAM Mayhem : objets qui vont avec chaque augment, tous champions confondus.
 * - part : à quel point les joueurs qui ont pris l'augment achètent l'objet plus souvent que les
 *   autres joueurs des mêmes champions (part attendue = part de l'objet chez ces champions) ;
 * - écart : taux de victoire avec l'augment et l'objet, comparé à l'augment seul, une fois retiré
 *   l'écart habituel de l'objet (acheté plus souvent quand on gagne), lissé (force mesurée).
 * Renvoie { augment: [{ id, games, uplift, lift }] } (les plus liés d'abord).
 */
export function augmentItemStats(state, dd, { minGames = 20, minUplift = 0.05, max = 8 } = {}) {
  const champs = Object.values(state.champs ?? {}).filter((c) => c.g >= 30)
  let N = 0
  let W = 0
  for (const c of champs) {
    N += c.g
    W += c.w
  }
  if (!N) return {}
  const base = W / N
  const itemRate = (id) => {
    const cell = state.itemAll?.[id]
    return cell && cell[0] >= 50 ? cell[1] / cell[0] : null
  }
  const rows = []
  for (const [a, items] of Object.entries(state.augItem ?? {})) {
    // Joueurs ayant pris l'augment, par champion, et part attendue de chaque objet chez eux.
    let n = 0
    let w = 0
    const expected = {}
    for (const c of champs) {
      const cell = c.aug?.[a]
      if (!cell) continue
      n += cell[0]
      w += cell[1]
      const all = c.ctxItems?.all ?? {}
      for (const [id, [g]] of Object.entries(all)) expected[id] = (expected[id] ?? 0) + cell[0] * (g / c.g)
    }
    if (n < 50) continue
    const rateA = w / n
    for (const [id, [g, wins]] of Object.entries(items)) {
      if (g < minGames || !dd.items.get(Number(id))?.isLegendary) continue
      const ir = itemRate(id)
      if (ir === null) continue
      const dev = wins / g - rateA - (ir - base)
      rows.push({ a, id, g, n, uplift: g / n - (expected[id] ?? 0) / n, dev, v: (rateA * (1 - rateA)) / g })
    }
  }
  const k = momPrior(
    rows.map((r) => [r.g, r.dev, r.v]),
    { fallback: 3000, minCells: 40, minGames: 5000 }
  ).k
  const out = {}
  for (const r of rows) {
    if (r.uplift < minUplift) continue
    ;(out[r.a] ??= []).push({
      id: Number(r.id),
      games: Math.round(r.g),
      uplift: round3(r.uplift),
      lift: round3(posterior(r.g, r.dev, k))
    })
  }
  for (const a of Object.keys(out)) out[a] = out[a].sort((x, y) => y.uplift - x.uplift).slice(0, max)
  return out
}

/**
 * ARAM Mayhem : augments pris ensemble. Écart du taux de victoire des joueurs qui ont pris les deux,
 * une fois retirés l'effet de chacun (regroupé) et le niveau du mode, lissé (force mesurée).
 * Renvoie { 'a|b': [parties, écart] }, seulement les écarts d'au moins 0,4 point.
 */
export function augmentPairStats(state, pooled, { minGames = 30 } = {}) {
  let N = 0
  let W = 0
  for (const c of Object.values(state.champs ?? {})) {
    N += c.g
    W += c.w
  }
  if (!N) return {}
  const base = W / N
  const cells = []
  for (const [key, [g, w]] of Object.entries(state.augPair ?? {})) {
    if (g < minGames) continue
    const [a, b] = key.split('|')
    if (!pooled[a] || !pooled[b]) continue
    const dev = w / g - base - pooled[a].lift - pooled[b].lift
    cells.push([key, g, dev, (base * (1 - base)) / g])
  }
  const k = momPrior(
    cells.map(([, g, dev, v]) => [g, dev, v]),
    { fallback: 5000, minCells: 40, minGames: 5000 }
  ).k
  const out = {}
  for (const [key, g, dev] of cells) {
    const lift = posterior(g, dev, k)
    if (Math.abs(lift) >= 0.004) out[key] = [Math.round(g), round3(lift)]
  }
  return out
}

/** Données Data Dragon vues depuis la carte d'un mode : objets finaux de cette carte. */
function mapView(dd, mapId) {
  const items = new Map()
  for (const [id, it] of dd.items) items.set(id, { ...it, isLegendary: legendaryOn(it, mapId) })
  return { ...dd, items }
}

export function buildMeta(state, dd0, previousMeta, options = {}) {
  const builds = []
  // Mode (ARAM…) : objets finaux de sa carte, repères propres, augments.
  const mode = options.mode && MODES[options.mode] ? options.mode : null
  const dd = mode ? mapView(dd0, MODES[mode].map) : dd0
  // Force de lissage de chaque famille de statistiques, mesurée sur les parties du patch, et
  // effets d'objets regroupés entre champions.
  // (options.evidence : mesure regroupée de tous les postes, voir poolEvidence.)
  const priors = measurePriors(state, options.evidence ?? null)
  const pooled = pooledItemLifts(state)
  // (modes : un build peut se passer de runes, désactivées en ARAM Mayhem.)
  const opts = { ...options, priors, pooled, allowNoRunes: !!mode }
  for (const [champ, c] of Object.entries(state.champs)) {
    const b = selectBuild(champ, c, dd, opts)
    if (!b) continue
    const variants = buildVariants(champ, c, dd, opts)
    if (variants.length) b.variants = variants
    const choices = buildChoices(c, dd)
    if (Object.keys(choices).length) b.choices = choices
    // Hors jungle : pas de familier.
    if (options.role && options.role !== 'jungle') {
      b.pet = null
      for (const v of b.variants ?? []) v.pet = null
      delete b.choices?.pet
    }
    builds.push(b)
  }
  const fresh = new Set(builds.map((b) => b.id))
  const kept = (previousMeta?.builds ?? []).filter((b) => b?.id && !fresh.has(b.id) && b.patch)
  const sampleGames = Math.round(Object.values(state.champs).reduce((s, c) => s + c.g, 0))
  const profiles = buildProfiles(state)
  // Si trop peu de parties (début de patch), on garde les profils précédents.
  const published =
    Object.keys(profiles).length >= 50 ? profiles : (previousMeta?.profiles ?? profiles)
  // Équilibre de l'équipe (dégâts, ligne de front), mesuré avec les profils des champions
  // (options.profiles : ceux du poste principal, les autres postes n'en tiennent pas).
  const fit = measureFit(state, options.profiles ?? published)
  // Modes : augments (ARAM Mayhem) et usage réel des runes et augments dans les parties.
  const extra = {}
  if (mode) {
    const f = state.feat
    if (f?.n >= 50) extra.features = { runes: f.runes / f.n >= 0.5, augments: f.aug / f.n >= 0.3 }
    if (MODES[mode].augments || (f?.n >= 50 && f.aug / f.n >= 0.3)) {
      const aug = augmentStats(state)
      const allowed = dd0.augmentModes?.[MODES[mode].gameMode]
      const info = {}
      for (const [id, a] of dd0.augments ?? []) {
        const stat = aug.pooled[id]
        if (!stat && !(allowed?.has(id))) continue
        info[id] = { name: a.name, nameFr: a.nameFr, rarity: a.rarity, icon: a.icon, ...(stat ?? {}) }
      }
      if (Object.keys(info).length) extra.augmentInfo = info
      for (const b of builds) {
        const list = aug.perChamp[b.id]
        if (list) b.augments = list.filter((x) => info[x.id])
      }
      extra.augmentPriors = aug.k
      // Objets qui vont avec chaque augment, et augments qui vont ensemble.
      const items = augmentItemStats(state, dd)
      const named = {}
      for (const [a, list] of Object.entries(items)) {
        if (!info[a]) continue
        const rows = list
          .map(({ id, ...r }) => ({ item: dd.items.get(id)?.name, ...r }))
          .filter((r) => r.item)
        if (rows.length) named[a] = rows
      }
      if (Object.keys(named).length) extra.augmentItems = named
      const pairs = augmentPairStats(state, aug.pooled)
      const knownPairs = Object.fromEntries(
        Object.entries(pairs).filter(([key]) => key.split('|').every((x) => info[x]))
      )
      if (Object.keys(knownPairs).length) extra.augmentPairs = knownPairs
    }
  }
  return {
    version: 2,
    ...(mode ? { mode } : {}),
    patch: dd.patch,
    generatedAt: new Date().toISOString(),
    sampleGames,
    freshBuilds: builds.length,
    seededFrom: state.seededFrom ?? null,
    builds: [...builds, ...kept].sort((a, b) => a.id.localeCompare(b.id)),
    profiles: published,
    junglers: buildJunglerStats(state),
    // Lissages mesurés : l'app estime chaque écart avec n / (n + k) (voir stats.mjs).
    priors,
    ...(fit ? { fit } : {}),
    threats: buildThreats(state),
    itemCounters: buildItemCounters(state, dd),
    backtest: backtestSummary(state.backtest),
    // Réglage automatique des poids du moteur de l'app (voir tuning.mjs).
    tuning:
      solveTuning(state.tuning) ??
      (previousMeta?.tuning?.v === TUNING_VERSION ? previousMeta.tuning : null),
    // Début de patch : on garde les repères précédents tant qu'il n'y a pas assez de parties.
    benchmarks: (() => {
      const b = buildBenchmarks(
        state,
        30,
        mode ? [...BENCH_KEYS, ...MODE_BENCH_KEYS] : BENCH_KEYS
      )
      return b._all ? b : (previousMeta?.benchmarks ?? b)
    })(),
    ...extra
  }
}
