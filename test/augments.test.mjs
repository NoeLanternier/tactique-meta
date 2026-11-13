// Augments des modes : descriptions tirées des chaînes du jeu, et ce qu'ils renforcent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  augmentTags,
  cleanText,
  descriptionKey,
  describeAugments,
  nameIndex
} from '../src/augmentText.mjs'
import { buildAugmentFile, mentionedItems, updateAugmentFile } from '../src/augmentFile.mjs'

// Extraits réels des chaînes du jeu (patch 16.22).
const EN = {
  cherry_goredrink_name: 'Goredrink',
  kiwi_aram_goredrink_name: 'Goredrink',
  cherry_goredrink_summary: 'Gain <lifeSteal>@Omnivamp*100@% Omnivamp</lifeSteal>.',
  kiwi_juiced_name: 'Juiced',
  kiwi_juiced_summary:
    '<OnHit>%i:OnHit% On-Hit</OnHit> deal <magicDamage>@Calc_Damage@ magic damage</magicDamage>, this damage can <crit>Critically Strike</crit>.',
  kiwi_aram_hellbent_name: 'Hellbent',
  kiwi_augment_hellbent_summary:
    'Damaging enemy champions with Attacks or Abilities grants stacks. At max stacks, you <attention>revive empowered</attention> upon death.',
  kiwi_augment_weeewooweewoo_name: 'Wee Woo Wee Woo',
  kiwi_augment_weeewooweewoo_summary:
    'When moving towards allies with <scaleHealing>low Health</scaleHealing>, gain <speed>Movement Speed</speed>.',
  kiwi_aram_multishot_name: 'Multishot',
  multishot_quest_desc:
    "<font color='#F0C200'>QUEST:</font> Hit enemy Champions with @SpellName@ @QuestRequirement@ times.",
  kiwi_augment_upgrade_stormsurge_name: 'Upgrade Stormsurge',
  kiwi_augment_upgrade_stormsurge_description:
    "<passive>Stormsurge's Squall</passive> now always detonates in an area, dealing max Health <magicDamage>magic damage</magicDamage>.",
  cherry_tankengine_name: 'Tank Engine',
  cherry_tankengine_summary: 'Gain increased size and percent bonus Health per takedown.',
  kiwi_upgrade_ie_name: 'Upgrade Infinity Edge',
  kiwi_upgrade_ie_summary:
    'Gain 500 Gold. Having Infinity Edge allows your <crit>Critical Strike Chance</crit> to grant random Critical Strike Damage each Attack.',
  augment_bangbang_name: 'From Downtown',
  augment_bangbang_tooltip: '{{Augment_BangBang_Desc}}<br><br><flavorText>Bang!</flavorText>',
  augment_bangbang_desc: 'Snipe enemy champions with abilities.'
}
const FR = {
  cherry_goredrink_summary: 'Vous gagnez <lifeSteal>@Omnivamp*100@% d’omnivampirisme</lifeSteal>.'
}
const aug = (id, nameId, name, rarity = 'silver') => [
  id,
  { id, nameId, name, nameFr: name, rarity, icon: '' }
]
const AUGS = new Map([
  aug(1138, 'ARAM_Goredrink', 'Goredrink'),
  aug(2016, 'ARAM_Juiced', 'Juiced'),
  aug(2050, 'ARAM_Hellbent', 'Hellbent', 'prismatic'),
  aug(2060, 'ARAM_WeeWooWeeWoo', 'Wee Woo Wee Woo'),
  aug(2070, 'ARAM_Multishot', 'Multishot', 'gold'),
  aug(3150, 'Upgrade_Stormsurge', 'Upgrade Stormsurge', 'gold'),
  aug(1353, 'TankEngine', 'Tank Engine', 'gold'),
  aug(1336, 'ARAM_Upgrade_IE', 'Upgrade Infinity Edge', 'gold'),
  aug(1400, 'ARAM_BangBang', 'From Downtown'),
  aug(1500, 'ARAM_Unknown', 'Unknown Thing')
])

test('clé de description : préfixes du mode, de l’Arène, quêtes et noms mal orthographiés', () => {
  const names = nameIndex(EN)
  const key = (id) => descriptionKey(AUGS.get(id), EN, names)
  assert.equal(key(1138), 'cherry_goredrink_summary')
  assert.equal(key(2050), 'kiwi_augment_hellbent_summary')
  // Clé du jeu mal orthographiée (« weee ») : retrouvée par le nom de l'augment.
  assert.equal(key(2060), 'kiwi_augment_weeewooweewoo_summary')
  assert.equal(key(2070), 'multishot_quest_desc')
  assert.equal(key(1500), null)
})

test('texte lisible et caractéristiques', () => {
  assert.equal(cleanText(EN.cherry_goredrink_summary), 'Gain x% Omnivamp.')
  assert.equal(cleanText(EN.kiwi_juiced_summary), 'On-Hit deal x magic damage, this damage can Critically Strike.')
  assert.deepEqual(augmentTags(EN.cherry_goredrink_summary), { vamp: 1 })
  assert.deepEqual(augmentTags(EN.kiwi_juiced_summary), { ap: 0.3, crit: 1, onhit: 1 })
  // Dégâts en % des PV de la cible : pas un augment de tank ; PV gagnés : si.
  assert.equal(augmentTags(EN.kiwi_augment_upgrade_stormsurge_description).tank, undefined)
  assert.equal(augmentTags(EN.cherry_tankengine_summary).tank, 0.7)
  const hb = augmentTags(EN.kiwi_augment_hellbent_summary)
  assert.equal(hb.attack, 0.6)
  assert.equal(hb.ability, 0.6)
  // Conversion : seul le résultat compte.
  assert.deepEqual(
    augmentTags('Convert <scaleAD>Bonus Attack Damage</scaleAD> to <scaleAP>Ability Power</scaleAP>.'),
    { ap: 1 }
  )
  assert.equal(augmentTags(EN.kiwi_augment_weeewooweewoo_summary).ally, 1)
})

test('augments décrits : anglais, français, objet amélioré, renvois résolus', () => {
  const rows = describeAugments(AUGS, [...AUGS.keys()], EN, FR)
  const by = new Map(rows.map((r) => [r.id, r]))
  assert.equal(by.get(1138).descFr, 'Vous gagnez x% d’omnivampirisme.')
  // Pas de traduction : texte anglais.
  assert.equal(by.get(2016).descFr, by.get(2016).desc)
  assert.equal(by.get(1336).upgrade, 'Infinity Edge')
  // Renvoi {{…}} résolu, texte d'ambiance retiré.
  assert.equal(by.get(1400).desc, 'Snipe enemy champions with abilities.')
  assert.equal(by.get(1500).desc, '')
  assert.deepEqual(by.get(1500).tags, {})
})

const dd = {
  patch: '16.22',
  augments: AUGS,
  augmentModes: { KIWI: new Set([1138, 1336, 2016]), KIWI_JADE: new Set([1336, 2050]) },
  items: new Map([
    [3031, { name: 'Infinity Edge', isFull: true }],
    [3057, { name: 'Sheen', isFull: false }],
    [6655, { name: "Luden's Echo", isFull: true }]
  ])
}

test('fichier des augments : listes des modes, objets nommés', () => {
  assert.deepEqual(mentionedItems('Having Infinity Edge and Sheen', dd), ['Infinity Edge'])
  const data = buildAugmentFile(dd, EN, FR)
  assert.deepEqual(data.modes, { KIWI: [1138, 1336, 2016], KIWI_JADE: [1336, 2050] })
  assert.deepEqual(Object.keys(data.augmentInfo).map(Number), [1138, 1336, 2016, 2050])
  assert.deepEqual(data.augmentInfo[1336].items, ['Infinity Edge'])
  assert.equal(data.augmentInfo[1138].rarity, 'silver')
})

test('mise à jour : seulement au changement de patch, d’augments, ou sans le français', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tactique-aug-'))
  const file = join(dir, 'meta-augments.json')
  let calls = 0
  let frDown = true
  const getJson = async (url) => {
    calls++
    if (url.includes('fr_fr') && frDown) throw new Error('522')
    return { entries: url.includes('fr_fr') ? FR : EN }
  }
  // Français indisponible : fichier écrit en anglais, nouvel essai la fois suivante.
  assert.match(await updateAugmentFile(file, dd, getJson, 1), /sans le français/)
  assert.equal(calls, 4) // anglais, puis trois essais pour le français
  frDown = false
  assert.match(await updateAugmentFile(file, dd, getJson, 1), /4 augments décrits \(4 avec description\)/)
  calls = 0
  assert.equal(await updateAugmentFile(file, dd, getJson, 1), null)
  assert.equal(calls, 0)
  // Nouvel augment : nouveau fichier.
  dd.augmentModes.KIWI.add(1500)
  assert.ok(await updateAugmentFile(file, dd, getJson, 1))
  const data = JSON.parse(readFileSync(file, 'utf-8'))
  assert.equal(data.fr, true)
  assert.ok(data.augmentInfo[1500])
  rmSync(dir, { recursive: true, force: true })
})
