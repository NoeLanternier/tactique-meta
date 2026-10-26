// Archétype de chaque jungler (utilisé par le moteur de l'app pour choisir les objets situationnels).
// Repris de la base de l'app ; un champion inconnu est classé d'après les objets qu'il achète.

export const ARCHETYPES = {
  Ambessa: 'AD_FIGHTER',
  Amumu: 'TANK',
  Belveth: 'AD_FIGHTER',
  Brand: 'AP_BURST',
  Briar: 'AD_CARRY',
  Chogath: 'TANK',
  Diana: 'AP_FIGHTER',
  DrMundo: 'TANK',
  Ekko: 'AP_BURST',
  Elise: 'AP_BURST',
  Evelynn: 'AP_BURST',
  Fiddlesticks: 'AP_BURST',
  Gragas: 'AP_BURST',
  Graves: 'AD_CARRY',
  Gwen: 'AP_FIGHTER',
  Hecarim: 'AD_FIGHTER',
  Ivern: 'ENCHANTER',
  JarvanIV: 'AD_FIGHTER',
  Jax: 'AD_FIGHTER',
  Karthus: 'AP_BURST',
  Kayn: 'AD_ASSASSIN',
  Khazix: 'AD_ASSASSIN',
  Kindred: 'AD_CARRY',
  LeeSin: 'AD_FIGHTER',
  Lillia: 'AP_FIGHTER',
  Maokai: 'TANK',
  MasterYi: 'AD_CARRY',
  MonkeyKing: 'AD_FIGHTER',
  Mordekaiser: 'AP_FIGHTER',
  Morgana: 'AP_BURST',
  Naafiri: 'AD_ASSASSIN',
  Nidalee: 'AP_BURST',
  Nocturne: 'AD_ASSASSIN',
  Nunu: 'TANK',
  Olaf: 'AD_FIGHTER',
  Pantheon: 'AD_FIGHTER',
  Poppy: 'TANK',
  Qiyana: 'AD_ASSASSIN',
  Rammus: 'TANK',
  RekSai: 'AD_FIGHTER',
  Rengar: 'AD_ASSASSIN',
  Rumble: 'AP_BURST',
  Sejuani: 'TANK',
  Sett: 'AD_FIGHTER',
  Shaco: 'AP_BURST',
  Shyvana: 'AD_FIGHTER',
  Skarner: 'TANK',
  Sylas: 'AP_FIGHTER',
  Taliyah: 'AP_BURST',
  Talon: 'AD_ASSASSIN',
  Trundle: 'AD_FIGHTER',
  Udyr: 'AD_FIGHTER',
  Vi: 'AD_FIGHTER',
  Viego: 'AD_FIGHTER',
  Volibear: 'AD_FIGHTER',
  Warwick: 'AD_FIGHTER',
  XinZhao: 'AD_FIGHTER',
  Zac: 'TANK',
  Zed: 'AD_ASSASSIN',
  Zyra: 'AP_BURST'
}

/** Classe un champion inconnu d'après les statistiques de ses objets du cœur. */
export function guessArchetype(coreItems) {
  let ap = 0
  let crit = 0
  let tank = 0
  for (const it of coreItems) {
    const s = it?.stats ?? {}
    if (s.FlatMagicDamageMod) ap++
    if (s.FlatCritChanceMod) crit++
    if (
      !s.FlatMagicDamageMod &&
      !s.FlatPhysicalDamageMod &&
      (s.FlatArmorMod || s.FlatSpellBlockMod || s.FlatHPPoolMod)
    )
      tank++
  }
  if (tank >= 2) return 'TANK'
  if (ap >= 2) return 'AP_BURST'
  if (crit >= 2) return 'AD_CARRY'
  return 'AD_FIGHTER'
}
