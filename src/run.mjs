// Point d'entrée : collecte des parties classées du patch en cours, puis calcul des métas.
//
//   node src/run.mjs --minutes 180 --regions euw1,kr,na1,sg2 --gold-regions euw1,na1
//
// Deux niveaux de jeu, collectés en même temps (les limites de la clé sont partagées) :
// - Master+ (meta.json) sur toutes les régions ;
// - Or à Émeraude (meta-gold.json) sur quelques régions : l'app la prend pour les joueurs de ces
//   rangs, et garde la méta Master+ pour ce qui manque.
//
// Variables : RIOT_API_KEY (obligatoire), REGIONS, GOLD_REGIONS (vide : pas de méta Or), MINUTES,
// MIN_GAMES.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FatalError, PLATFORM_TO_REGION, RiotClient, keyKind } from './riot.mjs'
import { loadDdragon } from './ddragon.mjs'
import { ROLES, bansOf, extractPlayers, extractProfiles, precheck } from './extract.mjs'
import {
  addBans,
  addProfiles,
  addRecord,
  buildMeta,
  classifyContexts,
  emptyState,
  expectedEnemy,
  seedFromPrevious,
  upgradeState
} from './aggregate.mjs'
import { evaluateRecord } from './backtest.mjs'
import { addTuning, tuningFeatures } from './tuning.mjs'
import { emptyQuality, qualityIssues, recordQuality } from './quality.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1]
  return fallback
}

const list = (x) =>
  String(x)
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean)

const config = {
  apiKey: (process.env.RIOT_API_KEY ?? '').trim(),
  minutes: Number(arg('minutes', process.env.MINUTES || '90')),
  regions: list(arg('regions', process.env.REGIONS || 'euw1,kr,na1,sg2')),
  goldRegions: list(arg('gold-regions', process.env.GOLD_REGIONS ?? 'euw1,na1')),
  minGames: Number(arg('min-games', process.env.MIN_GAMES || '40')),
  // Postes : une méta par poste (meta.json pour la jungle, meta-top.json, meta-mid.json…).
  roles: list(arg('roles', process.env.ROLES || ROLES.join(','))).filter((r) => ROLES.includes(r)),
  matchesPerPlayer: 20
}

/** Définition des contextes adverses des métas publiées (composition attendue, voir aggregate). */
const CONTEXT_KIND = 'composition'

// --out : dossier de sortie (test local dans un dossier séparé pour ne pas polluer la vraie méta).
const OUT_DIR = arg('out', '.')
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

/** Rangs d'une méta : classements entiers (Master+) ou pages de joueurs par division. */
const BRACKETS = [
  {
    key: 'master',
    label: 'Master+',
    regions: config.regions,
    apex: ['challengerleagues', 'grandmasterleagues', 'masterleagues'],
    stateDir: join(OUT_DIR, 'state'),
    metaFile: join(OUT_DIR, 'meta.json')
  },
  {
    key: 'gold',
    label: 'Or à Émeraude',
    regions: config.goldRegions,
    tiers: ['GOLD', 'PLATINUM', 'EMERALD'],
    // Pages de 205 joueurs par division, tirées au hasard chaque nuit (les joueurs changent).
    pages: 2,
    stateDir: join(OUT_DIR, 'state', 'gold'),
    metaFile: join(OUT_DIR, 'meta-gold.json'),
    // Premier jour : on part des données Master+ du patch avec un faible poids.
    seedFrom: 'master',
    seedFactor: 0.05
  }
].filter((b) => b.regions.length > 0)

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

async function ladder(riot, platform, bracket) {
  const puuids = []
  const add = async (entry) => {
    if (entry.puuid) puuids.push(entry.puuid)
    else if (entry.summonerId) {
      // Anciennes réponses sans puuid : on passe par le profil d'invocateur.
      const s = await riot.get(platform, `/lol/summoner/v4/summoners/${entry.summonerId}`)
      if (s?.puuid) puuids.push(s.puuid)
    }
  }
  for (const tier of bracket.apex ?? []) {
    const league = await riot.get(platform, `/lol/league/v4/${tier}/by-queue/RANKED_SOLO_5x5`)
    for (const entry of league?.entries ?? []) await add(entry)
  }
  for (const tier of bracket.tiers ?? []) {
    for (const division of ['I', 'II', 'III', 'IV']) {
      const first = 1 + Math.floor(Math.random() * 8)
      for (let page = first; page < first + bracket.pages; page++) {
        const entries = await riot.get(
          platform,
          `/lol/league/v4/entries/RANKED_SOLO_5x5/${tier}/${division}?page=${page}`
        )
        for (const entry of entries ?? []) await add(entry)
      }
    }
  }
  return shuffle([...new Set(puuids)])
}

/** Fichiers d'un poste dans un niveau : la jungle garde les noms historiques (meta.json…). */
function slotOf(bracket, role) {
  const jungle = role === 'jungle'
  const metaBase = bracket.metaFile.replace(/\.json$/, '')
  return {
    role,
    label: jungle ? bracket.label : `${bracket.label} · ${role}`,
    stateDir: jungle ? bracket.stateDir : join(bracket.stateDir, role),
    metaFile: jungle ? bracket.metaFile : `${metaBase}-${role}.json`
  }
}

/** Charge (ou crée) l'état du patch d'un poste dans un niveau. */
function loadState(slot, dd, seed) {
  mkdirSync(slot.stateDir, { recursive: true })
  const statePath = join(slot.stateDir, `${dd.patch}.json`)
  const jsonFiles = () => readdirSync(slot.stateDir).filter((f) => f.endsWith('.json'))
  const previousFiles = jsonFiles().filter((f) => f !== `${dd.patch}.json`)
  if (existsSync(statePath)) return upgradeState(JSON.parse(readFileSync(statePath, 'utf-8')))
  // Début estimé du patch : 36 h avant l'exécution qui le découvre (4 jours au tout premier
  // lancement, pour démarrer avec plus de parties). Les parties d'un autre patch sont ignorées.
  const state = emptyState(
    dd.patch,
    Math.floor(Date.now() / 1000) - (previousFiles.length === 0 ? 96 : 36) * 3600
  )
  // Nouveau patch : on repart des données du patch précédent avec un poids de 25 %, pour avoir
  // des builds stables dès le premier jour ; les nouvelles parties prennent vite le dessus.
  if (previousFiles.length > 0) {
    const prev = upgradeState(JSON.parse(readFileSync(join(slot.stateDir, previousFiles[0]), 'utf-8')))
    seedFromPrevious(state, prev, 0.25)
    log(`[${slot.label}] nouveau patch : reprise pondérée (25 %) du patch ${prev.patch}`)
  } else if (seed?.state) {
    seedFromPrevious(state, seed.state, seed.factor)
    state.seededFrom = `${seed.state.patch} ${seed.from}`
    log(`[${slot.label}] premier lancement : reprise (${seed.factor * 100} %) des données ${seed.from}`)
  }
  return state
}

async function main() {
  for (const r of new Set(BRACKETS.flatMap((b) => b.regions))) {
    if (!PLATFORM_TO_REGION[r]) throw new FatalError(`Région inconnue : "${r}" (ex. euw1, kr, na1)`)
  }
  if (!config.roles.length) throw new FatalError(`Aucun poste valide (ex. ${ROLES.join(',')})`)
  const riot = new RiotClient(config.apiKey)
  const dd = await loadDdragon()
  log(
    `Patch ${dd.patch} (Data Dragon ${dd.version}) — ${config.minutes} min — postes ${config.roles.join(', ')} — ` +
      BRACKETS.map((b) => `${b.label} : ${b.regions.join(', ')}`).join(' ; ')
  )

  const deadline = Date.now() + config.minutes * 60_000
  riot.deadline = deadline + 15_000
  let keyLogged = false
  // Poste principal : garde la liste des parties déjà lues et les profils des champions.
  const mainRole = config.roles.includes('jungle') ? 'jungle' : config.roles[0]
  const states = new Map()
  const runs = []
  for (const bracket of BRACKETS) {
    const roles = new Map()
    for (const role of config.roles) {
      const slot = slotOf(bracket, role)
      const from = bracket.seedFrom ? states.get(`${bracket.seedFrom}:${role}`) : null
      const seed = from ? { state: from, from: `${bracket.seedFrom}`, factor: bracket.seedFactor } : null
      const state = loadState(slot, dd, seed)
      states.set(`${bracket.key}:${role}`, state)
      roles.set(role, {
        ...slot,
        state,
        // Méta de la veille : sert au backtest et au réglage, puis de base à la nouvelle méta.
        previous: existsSync(slot.metaFile) ? JSON.parse(readFileSync(slot.metaFile, 'utf-8')) : null,
        records: 0
      })
    }
    const main = roles.get(mainRole).state
    runs.push({
      bracket,
      roles,
      main,
      processed: new Set(main.processed),
      counters: { matches: 0, kept: 0, skipped: {} },
      quality: emptyQuality()
    })
  }

  async function collect(run, platform) {
    const { bracket, roles, main, processed, counters, quality } = run
    const region = PLATFORM_TO_REGION[platform]
    const players = await ladder(riot, platform, bracket)
    log(`[${bracket.label}] [${platform}] ${players.length} joueurs`)
    if (riot.appLimits && !keyLogged) {
      keyLogged = true
      const fmt = riot.appLimits.map(([max, w]) => `${max}/${w / 1000} s`).join(', ')
      log(`Limites de la clé (par serveur) : ${fmt} → clé ${keyKind(riot.appLimits)}`)
    }
    for (const puuid of players) {
      if (Date.now() > deadline) break
      const ids = await riot.get(
        region,
        `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&type=ranked&startTime=${main.patchStart}&count=${config.matchesPerPlayer}`
      )
      for (const matchId of ids ?? []) {
        if (Date.now() > deadline) break
        if (processed.has(matchId)) continue
        processed.add(matchId)
        const match = await riot.get(region, `/lol/match/v5/matches/${matchId}`)
        counters.matches++
        const check = precheck(match, dd.patch)
        if (check !== 'ok') {
          counters.skipped[check] = (counters.skipped[check] ?? 0) + 1
          continue
        }
        const timeline = await riot.get(region, `/lol/match/v5/matches/${matchId}/timeline`)
        if (!timeline) continue
        for (const rec of extractPlayers(match, timeline, dd, config.roles)) {
          const slot = roles.get(rec.role)
          if (!slot) continue
          // Contexte adverse : composition attendue (profils des champions), pas l'issue de la partie.
          rec.enemy = expectedEnemy(
            main.profiles,
            [rec.enemyJungler, ...(rec.enemies ?? [])].filter(Boolean)
          )
          // Contrôle des données : les supports achètent leur premier objet plus tard, on ne
          // les compte pas (les seuils sont faits pour les autres postes).
          if (rec.role !== 'support') recordQuality(quality, rec)
          // Backtest et réglage : avec la méta précédente, si ses contextes sont du même type.
          if (slot.previous?.patch === dd.patch && slot.previous?.contexts === CONTEXT_KIND) {
            const contexts = classifyContexts(slot.state, rec.enemy)
            evaluateRecord(slot.previous, contexts, rec, slot.state.backtest, dd)
            addTuning(slot.state.tuning, tuningFeatures(slot.previous, rec, contexts, dd), rec.win)
          }
          addRecord(slot.state, rec)
          slot.records++
        }
        addProfiles(main, extractProfiles(match, dd))
        const bans = bansOf(match, dd)
        for (const slot of roles.values()) addBans(slot.state, bans)
        counters.kept++
        if (counters.kept % 100 === 0) {
          log(`[${bracket.label}] ${counters.kept} parties analysées (${riot.stats.requests} requêtes)`)
        }
      }
    }
  }

  await Promise.all(
    runs.flatMap((run) =>
      run.bracket.regions.map((p) =>
        collect(run, p).catch((e) => {
          if (e instanceof FatalError) throw e
          log(`[${run.bracket.label}] [${p}] erreur : ${e.message}`)
        })
      )
    )
  )

  // Contrôle des données avant d'écrire quoi que ce soit : si Riot change le format de ses
  // réponses, la collecte échoue (GitHub prévient par e-mail) au lieu de publier une méta faussée.
  const issues = runs.flatMap((run) =>
    qualityIssues(run.quality).map((i) => `[${run.bracket.label}] ${i}`)
  )
  if (issues.length) {
    throw new FatalError(
      `Données Riot inattendues, rien n'est publié :\n  ${issues.join('\n  ')}\n` +
        'Le format des réponses de Riot a probablement changé : src/extract.mjs est à adapter.'
    )
  }

  for (const { bracket, roles, main, processed, counters, quality } of runs) {
    main.processed = [...processed]
    log(
      `[${bracket.label}] terminé : ${counters.kept} nouvelles parties (${counters.matches} lues, ignorées : ${JSON.stringify(counters.skipped)})`
    )
    log(`[${bracket.label}] contrôle des données : ${JSON.stringify(quality)}`)
    // Poste principal d'abord : ses profils de champions servent aux métas des autres postes.
    const ordered = [...roles.values()].sort((a, b) => (a.role === mainRole ? -1 : b.role === mainRole ? 1 : 0))
    let profiles = null
    for (const slot of ordered) {
      const { state, previous } = slot
      state.updatedAt = new Date().toISOString()
      const json = JSON.stringify(state)
      writeFileSync(join(slot.stateDir, `${dd.patch}.json`), json)
      // On ne garde que l'état du patch en cours.
      for (const f of readdirSync(slot.stateDir))
        if (f.endsWith('.json') && f !== `${dd.patch}.json`) rmSync(join(slot.stateDir, f))

      const meta = buildMeta(state, dd, previous, { minGames: config.minGames, role: slot.role })
      meta.bracket = bracket.key
      meta.role = slot.role
      meta.contexts = CONTEXT_KIND
      if (slot.role === mainRole) profiles = meta.profiles
      else if (profiles) meta.profiles = profiles
      writeFileSync(slot.metaFile, JSON.stringify(meta, null, 2) + '\n')

      const L = `[${slot.label}]`
      const mb = (json.length / 1e6).toFixed(1)
      log(
        `${L} ${slot.records} joueurs ajoutés, ${meta.sampleGames} sur le patch, ${meta.freshBuilds} builds à jour, ${meta.builds.length} au total (état : ${mb} Mo).`
      )
      if (json.length > 80e6) log(`${L} ATTENTION : état de ${mb} Mo, proche de la limite de 100 Mo de GitHub.`)
      if (meta.backtest) log(`${L} backtest : ${JSON.stringify(meta.backtest)}`)
      if (meta.tuning) log(`${L} réglage du moteur : ${JSON.stringify(meta.tuning)}`)
      else log(`${L} réglage du moteur : ${Math.round(state.tuning.n)} parties (il en faut 2000)`)
    }
  }
  log(`Requêtes : ${riot.stats.requests}, limites atteintes : ${riot.stats.rateLimited}.`)
}

main().catch((e) => {
  console.error(e instanceof FatalError ? `ERREUR : ${e.message}` : e)
  process.exit(1)
})
