// Données officielles Riot (Data Dragon) : version du patch, champions, objets, runes.

const DDRAGON = 'https://ddragon.leagueoflegends.com'

export async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Data Dragon : ${res.status} sur ${url}`)
  return res.json()
}

/**
 * Évolution en partie : objet absent de la boutique dont la « recette spéciale » est un autre objet
 * (Étreinte du séraphin ← Bâton de l'archange, Muramana ← Manamune, Fimbulwinter ← Approche de
 * l'hiver…). Null pour un objet qu'on achète.
 */
export function evolutionOf(it) {
  const from = Number(it?.specialRecipe)
  return from > 0 && (it?.inStore === false || it?.gold?.purchasable === false) ? from : null
}

/** Caractéristiques d'un objet tirées de sa description (voir FOE_TRAITS dans extract.mjs). */
export function itemTraits(desc, stats) {
  const t = []
  const offensive =
    (stats.FlatPhysicalDamageMod ?? 0) > 0 ||
    (stats.FlatMagicDamageMod ?? 0) > 0 ||
    (stats.PercentAttackSpeedMod ?? 0) > 0
  if (/grievous wounds/.test(desc)) t.push('antiheal')
  if (offensive && /damage/.test(desc) && /(max(imum)?|current|missing) health/.test(desc))
    t.push('pctHp')
  if (/shield/.test(desc) && !/spell ?shield/.test(desc)) t.push('shield')
  if (/stasis|spell ?shield|remove all crowd control|cleanse|untargetable/.test(desc))
    t.push('antiCc')
  if (/lethality|armor penetration/.test(desc)) t.push('armorPen')
  if (/magic penetration/.test(desc)) t.push('magicPen')
  if ((stats.FlatArmorMod ?? 0) >= 40) t.push('armor')
  if ((stats.FlatSpellBlockMod ?? 0) >= 40) t.push('mr')
  if ((stats.PercentLifeStealMod ?? 0) > 0 || /omnivamp|life ?steal/.test(desc)) t.push('lifesteal')
  return t
}

/** Construit les index à partir des JSON Data Dragon (fonction pure, testable). */
export function buildDdragon(version, championJson, itemJson, runesJson) {
  const patch = version.split('.').slice(0, 2).join('.')

  const champById = new Map()
  for (const c of Object.values(championJson.data)) champById.set(Number(c.key), c.id)

  const items = new Map()
  for (const [idStr, it] of Object.entries(itemJson.data)) {
    const desc = String(it.description ?? '')
      .replace(/<[^>]+>/g, ' ')
      .toLowerCase()
    const tags = it.tags ?? []
    const into = it.into ?? []
    const total = it.gold?.total ?? 0
    const onRift = Boolean(it.maps?.['11'])
    // Cartes où l'objet est disponible (11 Faille, 12 Abîme hurlant…), pour les modes.
    const maps = new Set(
      Object.entries(it.maps ?? {})
        .filter(([, v]) => v)
        .map(([k]) => Number(k))
    )
    // Un objet dont les seules évolutions sont réservées à Ornn reste un objet final, comme un objet
    // qui ne mène qu'à sa propre évolution en partie (Cercle murmurant → Diadème des chants).
    const intoOnlySpecial =
      into.length > 0 &&
      into.every(
        (id) =>
          itemJson.data[id]?.requiredAlly === 'Ornn' ||
          evolutionOf(itemJson.data[id]) === Number(idStr)
      )
    items.set(Number(idStr), {
      id: Number(idStr),
      name: it.name,
      total,
      tags,
      stats: it.stats ?? {},
      isBoots: tags.includes('Boots') && total >= 900,
      isPet: tags.includes('Jungle') && !tags.includes('Consumable') && total >= 300,
      isLegendary:
        onRift &&
        (into.length === 0 || intoOnlySpecial) &&
        total >= 2000 &&
        !tags.includes('Consumable') &&
        !tags.includes('Boots'),
      // Objet final, quelle que soit la carte (voir legendaryOn).
      isFull:
        (into.length === 0 || intoOnlySpecial) &&
        total >= 2000 &&
        !tags.includes('Consumable') &&
        !tags.includes('Boots'),
      maps,
      // Forme évoluée en partie (Étreinte du séraphin ← Bâton de l'archange) : jamais achetée.
      evolvesFrom: evolutionOf(it),
      traits: itemTraits(desc, it.stats ?? {})
    })
  }

  const runes = new Map()
  const trees = new Map()
  for (const tree of runesJson) {
    trees.set(tree.id, tree.name)
    tree.slots.forEach((slot, row) => {
      for (const r of slot.runes) runes.set(r.id, { id: r.id, name: r.name, treeId: tree.id, row })
    })
  }

  return { version, patch, champById, items, runes, trees, augments: new Map(), augmentModes: {} }
}

/** Objet final disponible sur cette carte (0 : carte inconnue, toutes cartes). */
export function legendaryOn(item, mapId) {
  if (!item) return false
  if (mapId === 11 || !mapId) return mapId === 11 ? item.isLegendary : item.isFull
  return item.isFull && (item.maps?.has(mapId) || item.maps?.size === 0)
}

const RARITY = { kSilver: 'silver', kGold: 'gold', kPrismatic: 'prismatic' }

/**
 * Augments (ARAM Mayhem, Arène) à partir des données du jeu : nom anglais et français, rareté,
 * icône, et listes par mode (« KIWI » : ARAM Mayhem, « KIWI_JADE » : Mayhem Classic-ish).
 */
export function buildAugments(en, fr, lists) {
  const augments = new Map()
  const frById = new Map((Array.isArray(fr) ? fr : []).map((a) => [Number(a.id), a]))
  for (const a of Array.isArray(en) ? en : []) {
    const id = Number(a?.id)
    const rarity = RARITY[a?.rarity]
    if (!(id > 0) || !rarity || typeof a.nameTRA !== 'string' || !a.nameTRA) continue
    augments.set(id, {
      id,
      nameId: String(a.augmentNameId ?? ''),
      name: a.nameTRA,
      nameFr: frById.get(id)?.nameTRA || a.nameTRA,
      rarity,
      icon: String(a.augmentSmallIconPath ?? '')
    })
  }
  const byNameId = new Map([...augments.values()].map((a) => [a.nameId.toLowerCase(), a.id]))
  const augmentModes = {}
  for (const l of Array.isArray(lists) ? lists : []) {
    if (typeof l?.modeName !== 'string' || !Array.isArray(l.augmentList)) continue
    const ids = new Set()
    for (const path of l.augmentList) {
      const id = byNameId.get(String(path).split('/').pop().toLowerCase())
      if (id) ids.add(id)
    }
    augmentModes[l.modeName] = ids
  }
  return { augments, augmentModes }
}

const CDRAGON = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global'

/** Augments du jeu (facultatif : sans eux, les augments ne sont simplement pas publiés). */
async function loadAugments() {
  try {
    const [en, fr, lists] = await Promise.all([
      getJson(`${CDRAGON}/default/v1/cherry-augments.json`),
      getJson(`${CDRAGON}/fr_fr/v1/cherry-augments.json`).catch(() => null),
      getJson(`${CDRAGON}/default/v1/augment-lists.json`).catch(() => null)
    ])
    return buildAugments(en, fr, lists)
  } catch (e) {
    console.log(`Augments indisponibles (${e.message}) : pas d'augments dans les métas.`)
    return { augments: new Map(), augmentModes: {} }
  }
}

export async function loadDdragon() {
  const versions = await getJson(`${DDRAGON}/api/versions.json`)
  const version = versions[0]
  const base = `${DDRAGON}/cdn/${version}/data/en_US`
  const [champions, items, runes] = await Promise.all([
    getJson(`${base}/champion.json`),
    getJson(`${base}/item.json`),
    getJson(`${base}/runesReforged.json`)
  ])
  const dd = buildDdragon(version, champions, items, runes)
  Object.assign(dd, await loadAugments())
  return dd
}

/** "16.21.712.4040" → "16.21" */
export const patchOf = (gameVersion) =>
  String(gameVersion ?? '')
    .split('.')
    .slice(0, 2)
    .join('.')
