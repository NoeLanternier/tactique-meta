// Données officielles Riot (Data Dragon) : version du patch, champions, objets, runes.

const DDRAGON = 'https://ddragon.leagueoflegends.com'

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Data Dragon : ${res.status} sur ${url}`)
  return res.json()
}

/** Construit les index à partir des JSON Data Dragon (fonction pure, testable). */
export function buildDdragon(version, championJson, itemJson, runesJson) {
  const patch = version.split('.').slice(0, 2).join('.')

  const champById = new Map()
  for (const c of Object.values(championJson.data)) champById.set(Number(c.key), c.id)

  const items = new Map()
  for (const [idStr, it] of Object.entries(itemJson.data)) {
    const tags = it.tags ?? []
    const into = it.into ?? []
    const total = it.gold?.total ?? 0
    const onRift = Boolean(it.maps?.['11'])
    // Un objet dont les seules évolutions sont réservées à Ornn reste un objet final.
    const intoOnlyOrnn =
      into.length > 0 && into.every((id) => itemJson.data[id]?.requiredAlly === 'Ornn')
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
        (into.length === 0 || intoOnlyOrnn) &&
        total >= 2000 &&
        !tags.includes('Consumable') &&
        !tags.includes('Boots')
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

  return { version, patch, champById, items, runes, trees }
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
  return buildDdragon(version, champions, items, runes)
}

/** "16.21.712.4040" → "16.21" */
export const patchOf = (gameVersion) =>
  String(gameVersion ?? '')
    .split('.')
    .slice(0, 2)
    .join('.')
