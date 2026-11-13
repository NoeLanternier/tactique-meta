// meta-augments.json : les augments des modes (ARAM Mayhem et ses variantes) avec leur nom, leur
// rareté, leur icône, leur description (anglais, français) et ce qu'ils renforcent. Données du jeu
// seulement (CommunityDragon), aucune statistique de parties : Riot ne publie pas les parties de
// ces modes. L'app s'en sert pour la saisie des augments en partie et pour les classer selon le
// build du champion. Recalculé à chaque patch, ou quand un augment apparaît.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describeAugments } from './augmentText.mjs'
import { AUGMENT_LISTS } from './modes.mjs'

export const AUGMENT_FILE_VERSION = 1

/** Chaînes du jeu (≈ 30 Mo par langue). */
export const stringTableUrl = (lang) =>
  `https://raw.communitydragon.org/latest/game/${lang}/data/menu/${lang}/lol.stringtable.json`

/** Lecture avec nouvelles tentatives (CommunityDragon répond parfois « 522 » sur ces gros fichiers). */
async function withRetry(load, tries = 3, delayMs = 10_000) {
  for (let i = 1; ; i++) {
    try {
      return await load()
    } catch (e) {
      if (i >= tries) throw e
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

/** Augments des listes des modes, sans doublon, dans l'ordre des identifiants. */
export function augmentIds(dd) {
  const ids = new Set()
  for (const l of AUGMENT_LISTS) for (const id of dd.augmentModes?.[l] ?? []) ids.add(id)
  return [...ids].sort((a, b) => a - b)
}

/** Objets finaux nommés dans la description (quêtes « Possède … », améliorations). */
export function mentionedItems(text, dd) {
  if (!text) return []
  const out = []
  for (const it of dd.items.values()) {
    if (!it.isFull || it.name.length < 5) continue
    if (text.includes(it.name) && !out.includes(it.name)) out.push(it.name)
  }
  return out.slice(0, 4)
}

/** Contenu du fichier (à partir des chaînes du jeu déjà chargées). */
export function buildAugmentFile(dd, en, fr) {
  const ids = augmentIds(dd)
  const augmentInfo = {}
  for (const row of describeAugments(dd.augments, ids, en ?? {}, fr ?? null)) {
    const { id, ...rest } = row
    const items = mentionedItems(row.desc, dd)
    augmentInfo[id] = { ...rest, ...(items.length ? { items } : {}) }
  }
  const modes = {}
  for (const l of AUGMENT_LISTS)
    if (dd.augmentModes?.[l]?.size) modes[l] = [...dd.augmentModes[l]].sort((a, b) => a - b)
  return {
    v: AUGMENT_FILE_VERSION,
    patch: dd.patch,
    generatedAt: new Date().toISOString(),
    modes,
    augmentInfo
  }
}

/**
 * Met à jour le fichier si besoin (nouveau patch, nouvel augment, nouveau format). `getJson` :
 * lecture d'un JSON distant. Renvoie un résumé pour le journal, ou null si rien n'a changé.
 */
export async function updateAugmentFile(file, dd, getJson, delayMs = 10_000) {
  const ids = augmentIds(dd)
  if (!ids.length) return 'aucun augment dans les données du jeu : fichier inchangé'
  let prev = null
  try {
    prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : null
  } catch {
    prev = null
  }
  const known = new Set(Object.keys(prev?.augmentInfo ?? {}).map(Number))
  if (
    prev?.v === AUGMENT_FILE_VERSION &&
    prev.patch === dd.patch &&
    prev.fr !== false &&
    ids.every((id) => known.has(id))
  )
    return null
  const [en, fr] = await Promise.all([
    withRetry(() => getJson(stringTableUrl('en_us')), 3, delayMs),
    withRetry(() => getJson(stringTableUrl('fr_fr')), 3, delayMs).catch(() => null)
  ])
  const data = buildAugmentFile(dd, en?.entries ?? {}, fr?.entries ?? null)
  // Sans le français : nouvel essai à la prochaine collecte.
  data.fr = !!fr
  writeFileSync(file, JSON.stringify(data) + '\n')
  const rows = Object.values(data.augmentInfo)
  const described = rows.filter((a) => a.desc).length
  return `${rows.length} augments décrits (${described} avec description${fr ? '' : ', sans le français'})`
}
