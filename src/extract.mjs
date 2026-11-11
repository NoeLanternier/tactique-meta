// Extraction des informations de build des deux junglers d'une partie classée.
import { patchOf } from './ddragon.mjs'
import { stateOfLead } from './priors.mjs'

export const RANKED_SOLO = 420
/** Balises (données gratuitement, pas un choix de départ). */
const TRINKETS = new Set([3340, 3363, 3364, 3330])
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

/** Achats dans l'ordre avec leur minute, en tenant compte des annulations. */
function purchases(events) {
  const bought = []
  for (const e of events) {
    if (e.type === 'ITEM_PURCHASED') bought.push({ id: e.itemId, min: (e.timestamp ?? 0) / 60000 })
    else if (e.type === 'ITEM_UNDO' && e.beforeId > 0) {
      let idx = -1
      for (let i = bought.length - 1; i >= 0; i--)
        if (bought[i].id === e.beforeId) {
          idx = i
          break
        }
      if (idx >= 0) bought.splice(idx, 1)
    }
  }
  return bought
}

/**
 * Écart d'or entre l'équipe `team` et l'équipe adverse à une minute donnée, en part de l'or
 * adverse (0,1 = 10 % d'or en plus). Null sans chronologie.
 */
export function leadAt(timeline, teamOf, team, minute) {
  const frames = timeline?.info?.frames ?? []
  if (!frames.length) return null
  const frame = frames[Math.max(0, Math.min(frames.length - 1, Math.floor(minute)))]
  let mine = 0
  let theirs = 0
  for (const [pid, pf] of Object.entries(frame?.participantFrames ?? {})) {
    const gold = Number(pf?.totalGold) || 0
    if (teamOf.get(Number(pid)) === team) mine += gold
    else theirs += gold
  }
  return theirs > 0 && mine > 0 ? (mine - theirs) / theirs : null
}

/**
 * Caractéristiques d'un objet adverse qui changent la valeur de nos objets : anti-soins, dégâts en
 * % des PV, boucliers, protections contre les contrôles et le burst (stase, bouclier anti-sort,
 * purge), pénétration, résistances, vol de vie. Déduites de la description Data Dragon.
 */
export const FOE_TRAITS = [
  'antiheal',
  'pctHp',
  'shield',
  'antiCc',
  'armorPen',
  'magicPen',
  'armor',
  'mr',
  'lifesteal'
]
/** Nombre d'objets adverses (fin de partie) à partir duquel la caractéristique compte. */
export const FOE_TRAIT_MIN = {
  antiheal: 1,
  pctHp: 2,
  shield: 2,
  antiCc: 2,
  armorPen: 2,
  magicPen: 2,
  armor: 3,
  mr: 3,
  lifesteal: 2
}

/** Caractéristiques adverses d'une partie : '#antiheal', '#pctHp'… */
export function foeTagsOf(foes, dd) {
  const count = {}
  for (const f of foes) {
    for (let i = 0; i <= 5; i++) {
      const it = dd.items.get(Number(f[`item${i}`]))
      if (!it?.isLegendary) continue
      for (const t of it.traits ?? []) count[t] = (count[t] ?? 0) + 1
    }
  }
  return FOE_TRAITS.filter((t) => (count[t] ?? 0) >= FOE_TRAIT_MIN[t]).map((t) => `#${t}`)
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
  const cs = (f) =>
    f ? (Number(f.minionsKilled) || 0) + (Number(f.jungleMinionsKilled) || 0) : null
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
    controlWardsPer10:
      minutes > 0 ? ((Number(p.visionWardsBoughtInGame) || 0) / minutes) * 10 : null
  }
}

/** Voie d'un point de la carte (coordonnées 0-15000, base bleue en bas à gauche). */
export function laneOf(pos) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return null
  const { x, y } = pos
  if (Math.abs(x - y) < 2200) return 'mid'
  if (x < 3200 || y > 11800) return 'top'
  if (x > 11800 || y < 3200) return 'bot'
  return 'jungle'
}

/**
 * Combats entre les deux junglers : chaque élimination de l'un où l'autre a participé (auteur ou
 * assistant). won : notre jungler a gagné l'échange. Minute arrondie au dixième.
 */
export function junglerDuels(timeline, me, foe) {
  const out = []
  if (!me || !foe) return out
  for (const frame of timeline?.info?.frames ?? []) {
    for (const e of frame.events ?? []) {
      if (e.type !== 'CHAMPION_KILL') continue
      const involved = (pid) => e.killerId === pid || (e.assistingParticipantIds ?? []).includes(pid)
      const min = Math.round(((e.timestamp ?? 0) / 60000) * 10) / 10
      if (e.victimId === foe && involved(me)) out.push({ min, won: true })
      else if (e.victimId === me && involved(foe)) out.push({ min, won: false })
    }
  }
  return out
}

/**
 * Début de partie d'un jungler : côté de la carte où il est à 2 minutes (premier camp) et sa
 * première participation à une élimination (minute, voie).
 */
export function openingOf(timeline, pid) {
  const frames = timeline?.info?.frames ?? []
  const pos = frames[2]?.participantFrames?.[String(pid)]?.position
  const side = pos && typeof pos.x === 'number' ? (pos.y > pos.x ? 'top' : 'bot') : null
  let first = null
  for (const frame of frames) {
    for (const e of frame.events ?? []) {
      if (e.type !== 'CHAMPION_KILL') continue
      if (e.killerId !== pid && !(e.assistingParticipantIds ?? []).includes(pid)) continue
      first = { min: Math.round(((e.timestamp ?? 0) / 60000) * 10) / 10, lane: laneOf(e.position) }
      break
    }
    if (first) break
  }
  return { side, first }
}

/**
 * @returns {{ champ: string, win: boolean, runeSig: string|null, core: number[], later: number[],
 *   boots: number|null, pet: number|null, skills: string|null, enemyJungler: string|null,
 *   allies: string[], enemies: string[], items: number[], itemMin: number[], foeTags: string[] }[]}
 * `allies` : les 4 autres champions de l'équipe ; `enemies` : les 4 adversaires hors jungler ;
 * `items` / `itemMin` : les 6 premiers objets légendaires et la minute de leur achat ;
 * `foeTags` : caractéristiques des objets adverses (voir FOE_TRAITS).
 */
/** Postes Riot (teamPosition) → clés des métas. */
export const ROLE_OF_POSITION = {
  TOP: 'top',
  JUNGLE: 'jungle',
  MIDDLE: 'mid',
  BOTTOM: 'bot',
  UTILITY: 'support'
}
export const ROLES = Object.values(ROLE_OF_POSITION)

/** Junglers d'une partie (voir extractPlayers). */
export function extractJunglers(match, timeline, dd) {
  return extractPlayers(match, timeline, dd, ['jungle'])
}

/**
 * Joueurs d'une partie aux postes demandés. `enemyJungler` : l'adversaire direct (le jungler
 * adverse pour un jungler, le joueur d'en face sur la même voie sinon) ; `enemies` : les autres
 * adversaires.
 */
export function extractPlayers(match, timeline, dd, roles = ROLES) {
  const info = match.info
  const events = eventsByParticipant(timeline)
  const teamOf = new Map(info.participants.map((x) => [Number(x.participantId), x.teamId]))
  const records = []
  const wanted = (x) => roles.includes(ROLE_OF_POSITION[x.teamPosition])
  for (const p of info.participants.filter(wanted)) {
    const role = ROLE_OF_POSITION[p.teamPosition]
    const jungle = role === 'jungle'
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

    const timed = purchases(events.get(p.participantId) ?? [])
    const bought = timed.map((b) => b.id)
    const legendaries = []
    const legendaryMin = []
    for (const b of timed) {
      const it = dd.items.get(b.id)
      if (it?.isLegendary && !legendaries.includes(b.id)) {
        legendaries.push(b.id)
        legendaryMin.push(Math.round(b.min * 10) / 10)
      }
    }
    const boots = bought.find((id) => dd.items.get(id)?.isBoots) ?? null
    const pet = jungle ? (bought.find((id) => dd.items.get(id)?.isPet) ?? null) : null
    // Objets de départ : achats de la première minute et demie (familier, anneau de Doran…).
    const start = timed
      .filter((b) => b.min < 1.5 && !TRINKETS.has(b.id))
      .map((b) => b.id)
      .sort((a, b) => a - b)

    // Contexte adverse réellement observé dans cette partie (dégâts, soins, résistance, contrôles).
    const foes = info.participants.filter((x) => x.teamId !== p.teamId)
    const sum = (f) => foes.reduce((acc, x) => acc + (Number(x[f]) || 0), 0)
    const enemyJungler = foes.find((x) => x.teamPosition === p.teamPosition)
    const champOf = (x) => dd.champById.get(x.championId) ?? x.championName
    // Composition des deux équipes (synergies avec les alliés, affrontements avec les adversaires).
    const allies = info.participants
      .filter((x) => x.teamId === p.teamId && x.participantId !== p.participantId)
      .map(champOf)
    const enemies = foes.filter((x) => x !== enemyJungler).map(champOf)

    const myEvents = events.get(p.participantId) ?? []
    records.push({
      role,
      champ,
      bench: benchOf(info, p, timeline, myEvents, dd),
      win: Boolean(p.win),
      runeSig,
      core: legendaries.slice(0, 3),
      later: legendaries.slice(3, 6),
      items: legendaries.slice(0, 6),
      itemMin: legendaryMin.slice(0, 6),
      // État de la partie à chaque achat : en avance ('a'), à égalité ('e'), en retard ('b').
      itemState: legendaryMin
        .slice(0, 6)
        .map((min) => stateOfLead(leadAt(timeline, teamOf, p.teamId, min))),
      boots,
      pet,
      start: start.length ? start.join(',') : null,
      skills: skillOrder(events.get(p.participantId) ?? []),
      enemyJungler: enemyJungler ? champOf(enemyJungler) : null,
      allies,
      enemies,
      // Objets adverses de fin de partie qui changent la valeur des nôtres.
      foeTags: foeTagsOf(foes, dd),
      // Combats contre le jungler adverse et début de partie (côté, première élimination).
      duels: junglerDuels(timeline, p.participantId, enemyJungler?.participantId),
      opening: jungle ? openingOf(timeline, p.participantId) : null,
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
/** Champions bannis d'une partie (les deux équipes). */
export function bansOf(match, dd) {
  const out = []
  for (const team of match.info?.teams ?? [])
    for (const b of team.bans ?? []) {
      const champ = b?.championId > 0 ? dd.champById.get(b.championId) : null
      if (champ) out.push(champ)
    }
  return out
}

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
