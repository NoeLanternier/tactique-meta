// Textes et caractéristiques des augments (ARAM Mayhem), tirés des chaînes du jeu (lol.stringtable,
// CommunityDragon). Riot ne publie pas les parties de ARAM Mayhem dans son API : l'app ne peut donc
// pas classer les augments par taux de victoire. Elle les classe selon ce qu'ils renforcent
// (puissance, attaques, résistances, soins…) comparé au build du champion. Ce fichier extrait ces
// caractéristiques du texte de chaque augment.

/** Suffixes des clés de description, du plus court (résumé) au plus détaillé. */
const SUFFIXES = [
  'summary',
  'tooltipdescription',
  'description',
  'tooltip',
  'desc',
  'quest_desc',
  'long_desc',
  'short_desc'
]

/** Index des noms : texte du nom → clés « …_name » (pour retrouver le préfixe des clés). */
export function nameIndex(entries) {
  const out = new Map()
  for (const [k, v] of Object.entries(entries ?? {})) {
    if (!k.endsWith('_name') || typeof v !== 'string') continue
    if (!/^(kiwi|cherry|augment|aram)_/.test(k)) continue
    const list = out.get(v) ?? []
    list.push(k)
    out.set(v, list)
  }
  return out
}

/** Clé de la description d'un augment dans les chaînes du jeu (null : introuvable). */
export function descriptionKey(aug, entries, names) {
  const base = String(aug.nameId ?? '')
    .toLowerCase()
    .replace(/^aram_/, '')
  const prefixes = []
  const fromName = (names.get(aug.name) ?? []).map((k) => k.slice(0, -'_name'.length))
  // Clés du mode d'abord (kiwi_…), puis celles de l'Arène (cherry_…), dont il reprend des augments.
  fromName.sort((a, b) => Number(!a.startsWith('kiwi')) - Number(!b.startsWith('kiwi')))
  prefixes.push(...fromName)
  if (base)
    prefixes.push(
      `kiwi_augment_${base}`,
      `kiwi_${base}`,
      `kiwi_aram_${base}`,
      `cherry_augment_${base}`,
      `cherry_${base}`,
      `cherry_aram_${base}`,
      `augment_${base}`,
      base
    )
  for (const p of prefixes)
    for (const s of SUFFIXES) {
      const k = `${p}_${s}`
      if (typeof entries[k] === 'string' && entries[k].trim()) return k
    }
  return null
}

/** Remplace les renvois {{Clé}} par le texte de la clé (un niveau). */
function resolveRefs(text, entries) {
  return text.replace(/\{\{\s*([^}@]+?)(?:@[^}]*)?\s*\}\}/g, (_, key) => {
    const v = entries[String(key).trim().toLowerCase()]
    return typeof v === 'string' ? v : ''
  })
}

/** Texte lisible : balises retirées, valeurs (@…@) remplacées par « x ». */
export function cleanText(raw) {
  return String(raw ?? '')
    .replace(/<flavorText>[\s\S]*?<\/flavorText>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/%i:[a-zA-Z]+%/g, '')
    .replace(/@[^@]*@/g, 'x')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,:;!?%])/g, '$1')
    .trim()
}

/**
 * Ce que renforce un augment, d'après son texte (balises et mots-clés du jeu) : poids de 0 à 1.
 * ap / ad : puissance ou dégâts d'attaque ; attack : attaques de base ; as : vitesse d'attaque ;
 * crit ; onhit : effets à l'impact ; ability : compétences ; haste : accélération ; ult : ultime ;
 * tank : résistances et PV ; heal / shield ; ally : effet sur les alliés ; vamp : vol de vie ;
 * mana ; ms : vitesse de déplacement ; cc : contrôles ; gold ; summoner : sorts d'invocateur ;
 * melee / ranged : réservé ou meilleur au corps à corps / à distance.
 */
export function augmentTags(raw) {
  const t = String(raw ?? '')
  const tags = {}
  const set = (k, w) => {
    if (w > (tags[k] ?? 0)) tags[k] = w
  }
  if (/<scaleAP>|Ability Power/.test(t)) set('ap', 1)
  else if (/<magicDamage>/.test(t)) set('ap', 0.3)
  if (/<scaleAD>|Attack Damage|Lethality/.test(t)) set('ad', 1)
  else if (/<physicalDamage>/.test(t)) set('ad', 0.3)
  if (/Attack Speed|<attackSpeed>/.test(t)) set('as', 1)
  if (/<crit>|Critical/.test(t)) set('crit', 1)
  if (/On-Hit|<OnHit>/.test(t)) set('onhit', 1)
  if (/\b[Aa]ttack(s|ing|ed)?\b(?! (Speed|Damage))/.test(t)) set('attack', 0.6)
  if (/\bAbilit(y|ies)\b(?! (Power|Haste))/.test(t)) set('ability', 0.6)
  if (/Ability Haste|<scaleAbilityHaste>|[Cc]ooldown/.test(t)) set('haste', 1)
  if (/Ultimate/.test(t)) set('ult', 1)
  if (/<scaleArmor>|<scaleMR>|\bArmor\b|Magic Resist|Resists|Resistances|Tenacity/.test(t))
    set('tank', 1)
  // PV gagnés (et non dégâts en % des PV de la cible) : « Gain … bonus Health ».
  else if (/<scaleHealth>|\b(Gain|gain|grants?|Grants?)\b[^.]{0,40}\bHealth\b/.test(t)) set('tank', 0.7)
  if (/<healing>|<health>|\b[Hh]eal(s|ing|ed)?\b/.test(t)) set('heal', 1)
  if (/<shield>|\b[Ss]hield(s|ing|ed)?\b/.test(t)) set('shield', 1)
  if (/\ball(y|ies|ied)\b/i.test(t)) set('ally', 1)
  if (/<lifeSteal>|Omnivamp|Life ?[Ss]teal|Physical Vamp/.test(t)) set('vamp', 1)
  if (/<scaleMana>|\bMana\b/.test(t)) set('mana', 1)
  if (/<speed>|Move(ment)? Speed/.test(t)) set('ms', 1)
  if (/<status>|\b(Stun|Root|Immobiliz|Knock|Taunt|Charm|Fear|Slow)/.test(t)) set('cc', 1)
  if (/<gold>|\b[Gg]old\b/.test(t)) set('gold', 1)
  if (/Summoner Spell/.test(t)) set('summoner', 1)
  if (/\bMelee\b|\bmelee\b/.test(t)) set('melee', 1)
  if (/\bRanged\b|\branged\b/.test(t)) set('ranged', 1)
  // Conversion (ADAPt : dégâts d'attaque convertis en puissance) : seul le résultat compte.
  if (/Convert[^.]*to (<scaleAP>)?Ability Power/.test(t)) delete tags.ad
  if (/Convert[^.]*to (<scaleAD>)?(Bonus )?Attack Damage/.test(t)) delete tags.ap
  return tags
}

/** Objet amélioré par un augment « Upgrade … » (nom anglais tel que dans le nom de l'augment). */
export function upgradeTarget(aug) {
  const m = /^Upgrade (.+)$/i.exec(String(aug.name ?? '').trim())
  return m ? m[1].trim() : null
}

/**
 * Augments des modes avec leur description (anglais, français) et leurs caractéristiques.
 * `ids` : augments à décrire ; `en`, `fr` : entrées des chaînes du jeu (clés en minuscules).
 */
export function describeAugments(augments, ids, en, fr) {
  const enNames = nameIndex(en)
  const out = []
  for (const id of ids) {
    const a = augments.get(id)
    if (!a) continue
    const key = descriptionKey(a, en, enNames)
    const rawEn = key ? resolveRefs(en[key], en) : ''
    const rawFr = key && fr?.[key] ? resolveRefs(fr[key], fr) : ''
    const row = {
      id,
      name: a.name,
      nameFr: a.nameFr,
      rarity: a.rarity,
      icon: a.icon,
      desc: cleanText(rawEn),
      descFr: cleanText(rawFr) || cleanText(rawEn),
      tags: augmentTags(rawEn)
    }
    const up = upgradeTarget(a)
    if (up) row.upgrade = up
    out.push(row)
  }
  return out.sort((x, y) => x.id - y.id)
}
