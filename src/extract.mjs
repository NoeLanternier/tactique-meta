// Extraction des informations de build des deux junglers d'une partie classée.
import { patchOf } from './ddragon.mjs'

export const RANKED_SOLO = 420
const MIN_DURATION = 15 * 60 // en dessous : remake / abandon précoce, peu représentatif
const SKILLS = ['', 'Q', 'W', 'E', 'R']

/** Contrôle rapide avant de télécharger la timeline (qui coûte une requête de plus). */
export function precheck(match, patch) {
  const info = match?.info
  if (!info) return 'invalide'
  if (info.queueId !== RANKED_SOLO) return 'file'
  if (patchOf(info.gameVersion) !== patch) return 'ancien patch'
  if ((info.gameDuration ?? 0) < MIN_DURATION) return 'trop courte'
  const junglers = info.participants.filter((p) => p.teamPosition === 'JUNGLE')
  if (junglers.length !== 2) return 'postes'
  return 'ok'
}

function eventsByParticipant(timeline) {
  const map = new Map()
  for (const frame of timeline?.info?.frames ?? []) {
    for (const e of frame.events ?? []) {
      if (!e.participantId) continue
      if (!map.has(e.participantId)) map.set(e.participantId, [])
      map.get(e.participantId).push(e)
    }
  }
  for (const list of map.values()) list.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
  return map
}

/** Achats dans l'ordre, en tenant compte des annulations. */
function purchases(events) {
  const bought = []
  for (const e of events) {
    if (e.type === 'ITEM_PURCHASED') bought.push(e.itemId)
    else if (e.type === 'ITEM_UNDO' && e.beforeId > 0) {
      const idx = bought.lastIndexOf(e.beforeId)
      if (idx >= 0) bought.splice(idx, 1)
    }
  }
  return bought
}

/** Ordre de montée des compétences : ordre dans lequel Q, W et E atteignent leur rang maximal. */
export function skillOrder(events) {
  const points = { Q: 0, W: 0, E: 0 }
  const maxedAt = {}
  let step = 0
  for (const e of events) {
    if (e.type !== 'SKILL_LEVEL_UP' || e.levelUpType === 'EVOLVE') continue
    const key = SKILLS[e.skillSlot]
    if (!key || key === 'R') continue
    step++
    points[key]++
    if (points[key] === 5 && maxedAt[key] === undefined) maxedAt[key] = step
  }
  const total = points.Q + points.W + points.E
  if (total < 9) return null
  return ['Q', 'W', 'E']
    .sort((a, b) => (maxedAt[a] ?? 1000 - points[a]) - (maxedAt[b] ?? 1000 - points[b]))
    .join('>')
}

/**
 * Repères de jeu d'un jungler : farm, or et niveau à 10/15 min, minute des deux premiers objets
 * légendaires, participation aux éliminations, vision et balises de contrôle.
 */
export function benchOf(info, p, timeline, events, dd) {
  const frames = timeline?.info?.frames ?? []
  const at = (min) => frames[min]?.participantFrames?.[String(p.participantId)] ?? null
  const cs = (f) => (f ? (Number(f.minionsKilled) || 0) + (Number(f.jungleMinionsKilled) || 0) : null)
  const f10 = at(10)
  const f15 = at(15)
  const legendaryTimes = []
  const seen = new Set()
  for (const e of events) {
    if (e.type !== 'ITEM_PURCHASED' || seen.has(e.itemId)) continue
    if (!dd.items.get(e.itemId)?.isLegendary) continue
    seen.add(e.itemId)
    legendaryTimes.push((e.timestamp ?? 0) / 60000)
    if (legendaryTimes.length === 2) break
  }
  const minutes = (info.gameDuration ?? 0) / 60
  const teamKills = info.participants
    .filter((x) => x.teamId === p.teamId)
    .reduce((s, x) => s + (Number(x.kills) || 0), 0)
  return {
    cs10: cs(f10),
    cs15: cs(f15),
    gold15: f15 ? Number(f15.totalGold) || 0 : null,
    level15: f15 ? Number(f15.level) || 0 : null,
    firstItem: legendaryTimes[0] ?? null,
    secondItem: legendaryTimes[1] ?? null,
    kp: teamKills > 0 ? ((Number(p.kills) || 0) + (Number(p.assists) || 0)) / teamKills : null,
    visionPerMin: minutes > 0 ? (Number(p.visionScore) || 0) / minutes : null,
    controlWardsPer10: minutes > 0 ? ((Number(p.visionWardsBoughtInGame) || 0) / minutes) * 10 : null
  }
}

/**
 * @returns {{ champ: string, win: boolean, runeSig: string|null, core: number[], later: number[],
 *   boots: number|null, pet: number|null, skills: string|null, enemyJungler: string|null,
 *   allies: string[], enemies: string[] }[]}
 * `allies` : les 4 autres champions de l'équipe ; `enemies` : les 4 adversaires hors jungler.
 */
export function extractJunglers(match, timeline, dd) {
  const info = match.info
  const events = eventsByParticipant(timeline)
  const records = []
  for (const p of info.participants.filter((x) => x.teamPosition === 'JUNGLE')) {
    const champ = dd.champById.get(p.championId) ?? p.championName
    const styles = p.perks?.styles ?? []
    const primary = styles.find((s) => s.description === 'primaryStyle') ?? styles[0]
    const sub = styles.find((s) => s.description === 'subStyle') ?? styles[1]
    const sp = p.perks?.statPerks ?? {}
    let runeSig = null
    if (primary && sub && primary.selections?.length === 4 && sub.selections?.length === 2) {
      const perks = [...primary.selections, ...sub.selections].map((s) => s.perk)
      runeSig = `${primary.style}|${perks.join(',')}|${sub.style}|${sp.offense},${sp.flex},${sp.defense}`
    }

    const bought = purchases(events.get(p.participantId) ?? [])
    const legendaries = []
    for (const id of bought) {
      const it = dd.items.get(id)
      if (it?.isLegendary && !legendaries.includes(id)) legendaries.push(id)
    }
    const boots = bought.find((id) => dd.items.get(id)?.isBoots) ?? null
    const pet = bought.find((id) => dd.items.get(id)?.isPet) ?? null

    // Contexte adverse réellement observé dans cette partie (dégâts, soins, résistance, contrôles).
    const foes = info.participants.filter((x) => x.teamId !== p.teamId)
    const sum = (f) => foes.reduce((acc, x) => acc + (Number(x[f]) || 0), 0)
    const enemyJungler = foes.find((x) => x.teamPosition === 'JUNGLE')
    const champOf = (x) => dd.champById.get(x.championId) ?? x.championName
    // Composition des deux équipes (synergies avec les alliés, affrontements avec les adversaires).
    const allies = info.participants
      .filter((x) => x.teamId === p.teamId && x.participantId !== p.participantId)
      .map(champOf)
    const enemies = foes.filter((x) => x !== enemyJungler).map(champOf)

    const myEvents = events.get(p.participantId) ?? []
    records.push({
      champ,
      bench: benchOf(info, p, timeline, myEvents, dd),
      win: Boolean(p.win),
      runeSig,
      core: legendaries.slice(0, 3),
      later: legendaries.slice(3, 6),
      items: legendaries.slice(0, 6),
      boots,
      pet,
      skills: skillOrder(events.get(p.participantId) ?? []),
      enemyJungler: enemyJungler ? champOf(enemyJungler) : null,
      allies,
      enemies,
      enemy: {
        minutes: (info.gameDuration ?? 0) / 60,
        phys: sum('physicalDamageDealtToChampions'),
        magic: sum('magicDamageDealtToChampions'),
        heal: sum('totalHeal'),
        tank: sum('damageSelfMitigated') + sum('totalDamageTaken'),
        cc: sum('timeCCingOthers')
      }
    })
  }
  return records
}

/**
 * Profil mesuré de chacun des 10 joueurs d'une partie (tous postes) : sert à connaître le vrai
 * profil de chaque champion (part de dégâts magiques, résistance, contrôles, soins, boucliers…).
 */
export function extractProfiles(match, dd) {
  const info = match.info
  const minutes = (info.gameDuration ?? 0) / 60
  return info.participants.map((p) => {
    let crit = 0
    let as = 0
    for (let i = 0; i <= 6; i++) {
      const it = dd.items.get(p[`item${i}`])
      if (!it?.isLegendary) continue
      if (it.stats?.FlatCritChanceMod) crit++
      if (it.stats?.PercentAttackSpeedMod) as++
    }
    const n = (f) => Number(p[f]) || 0
    return {
      champ: dd.champById.get(p.championId) ?? p.championName,
      minutes,
      phys: n('physicalDamageDealtToChampions'),
      magic: n('magicDamageDealtToChampions'),
      heal: n('totalHeal'),
      shield: n('totalDamageShieldedOnTeammates'),
      tank: n('damageSelfMitigated') + n('totalDamageTaken'),
      cc: n('timeCCingOthers'),
      crit,
      as
    }
  })
}
