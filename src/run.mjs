// Point d'entrée : collecte des parties classées Master+ du patch en cours, puis calcul de meta.json.
//
//   node src/run.mjs --minutes 180 --regions euw1,kr,na1,sg2
//
// Variables : RIOT_API_KEY (obligatoire), REGIONS, MINUTES, MIN_GAMES.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FatalError, PLATFORM_TO_REGION, RiotClient } from './riot.mjs'
import { loadDdragon } from './ddragon.mjs'
import { extractJunglers, extractProfiles, precheck } from './extract.mjs'
import {
  addProfiles,
  addRecord,
  buildMeta,
  emptyState,
  seedFromPrevious,
  upgradeState
} from './aggregate.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

const config = {
  apiKey: (process.env.RIOT_API_KEY ?? '').trim(),
  minutes: Number(arg('minutes', process.env.MINUTES || '90')),
  regions: String(arg('regions', process.env.REGIONS || 'euw1,kr,na1,sg2'))
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean),
  minGames: Number(arg('min-games', process.env.MIN_GAMES || '40')),
  tiers: ['challengerleagues', 'grandmasterleagues', 'masterleagues'],
  matchesPerPlayer: 20
}

// --out : dossier de sortie (test local dans un dossier séparé pour ne pas polluer la vraie méta).
const OUT_DIR = arg('out', '.')
const STATE_DIR = join(OUT_DIR, 'state')
const META_FILE = join(OUT_DIR, 'meta.json')
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

async function ladder(riot, platform) {
  const puuids = []
  for (const tier of config.tiers) {
    const league = await riot.get(platform, `/lol/league/v4/${tier}/by-queue/RANKED_SOLO_5x5`)
    for (const entry of league?.entries ?? []) {
      if (entry.puuid) puuids.push(entry.puuid)
      else if (entry.summonerId) {
        // Anciennes réponses sans puuid : on passe par le profil d'invocateur.
        const s = await riot.get(platform, `/lol/summoner/v4/summoners/${entry.summonerId}`)
        if (s?.puuid) puuids.push(s.puuid)
      }
    }
  }
  return shuffle([...new Set(puuids)])
}

async function main() {
  for (const r of config.regions) {
    if (!PLATFORM_TO_REGION[r]) throw new FatalError(`Région inconnue : "${r}" (ex. euw1, kr, na1)`)
  }
  const riot = new RiotClient(config.apiKey)
  const dd = await loadDdragon()
  log(
    `Patch ${dd.patch} (Data Dragon ${dd.version}) — régions ${config.regions.join(', ')} — ${config.minutes} min`
  )

  mkdirSync(STATE_DIR, { recursive: true })
  const statePath = join(STATE_DIR, `${dd.patch}.json`)
  // Début estimé du patch : 36 h avant l'exécution qui le découvre (4 jours au tout premier
  // lancement, pour démarrer avec plus de parties). Les parties d'un autre patch sont ignorées.
  const previousFiles = readdirSync(STATE_DIR).filter((f) => f.endsWith('.json') && f !== `${dd.patch}.json`)
  let state
  if (existsSync(statePath)) {
    state = upgradeState(JSON.parse(readFileSync(statePath, 'utf-8')))
  } else {
    state = emptyState(
      dd.patch,
      Math.floor(Date.now() / 1000) - (previousFiles.length === 0 ? 96 : 36) * 3600
    )
    // Nouveau patch : on repart des données du patch précédent avec un poids de 25 %, pour avoir
    // des builds stables dès le premier jour ; les nouvelles parties prennent vite le dessus.
    if (previousFiles.length > 0) {
      const prev = upgradeState(JSON.parse(readFileSync(join(STATE_DIR, previousFiles[0]), 'utf-8')))
      seedFromPrevious(state, prev, 0.25)
      log(`Nouveau patch : reprise pondérée (25 %) des données du patch ${prev.patch}`)
    }
  }
  const processed = new Set(state.processed)
  const deadline = Date.now() + config.minutes * 60_000
  riot.deadline = deadline + 15_000
  const counters = { matches: 0, kept: 0, skipped: {} }

  async function collect(platform) {
    const region = PLATFORM_TO_REGION[platform]
    const players = await ladder(riot, platform)
    log(`[${platform}] ${players.length} joueurs Master+`)
    for (const puuid of players) {
      if (Date.now() > deadline) break
      const ids = await riot.get(
        region,
        `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&type=ranked&startTime=${state.patchStart}&count=${config.matchesPerPlayer}`
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
        for (const rec of extractJunglers(match, timeline, dd)) addRecord(state, rec)
        addProfiles(state, extractProfiles(match, dd))
        counters.kept++
        if (counters.kept % 100 === 0) {
          log(`${counters.kept} parties analysées (${riot.stats.requests} requêtes)`)
        }
      }
    }
  }

  await Promise.all(
    config.regions.map((p) =>
      collect(p).catch((e) => {
        if (e instanceof FatalError) throw e
        log(`[${p}] erreur : ${e.message}`)
      })
    )
  )

  state.processed = [...processed]
  state.updatedAt = new Date().toISOString()
  writeFileSync(statePath, JSON.stringify(state))
  // On ne garde que l'état du patch en cours.
  for (const f of readdirSync(STATE_DIR)) if (f !== `${dd.patch}.json`) rmSync(join(STATE_DIR, f))

  const previous = existsSync(META_FILE) ? JSON.parse(readFileSync(META_FILE, 'utf-8')) : null
  const meta = buildMeta(state, dd, previous, { minGames: config.minGames })
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + '\n')

  log(
    `Terminé : ${counters.kept} nouvelles parties (${counters.matches} lues, ignorées : ${JSON.stringify(counters.skipped)}), ` +
      `${meta.sampleGames} junglers analysés sur le patch, ${meta.freshBuilds} builds à jour, ${meta.builds.length} au total. ` +
      `Requêtes : ${riot.stats.requests}, limites atteintes : ${riot.stats.rateLimited}.`
  )
}

main().catch((e) => {
  console.error(e instanceof FatalError ? `ERREUR : ${e.message}` : e)
  process.exit(1)
})
