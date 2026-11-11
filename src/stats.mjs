// Lissage bayésien empirique.
//
// Un taux de victoire mesuré sur n parties s'écarte du vrai taux d'environ 50 / √n points : sur
// 100 parties, ±5 points de hasard, alors que les vrais écarts entre deux options (pages de runes,
// objets, affrontements…) sont de l'ordre de 1 point. Choisir « le meilleur taux observé » revient
// donc souvent à choisir l'option la plus chanceuse.
//
// Pour chaque famille de statistiques, on mesure donc sur les données elles-mêmes la taille des
// vrais écarts (méthode des moments : variance observée − variance due au hasard), ce qui donne le
// nombre de parties « a priori » k = p(1 − p) / τ². Un écart observé sur n parties est ensuite
// ramené vers zéro par le facteur n / (n + k) : c'est la meilleure estimation du vrai écart.
// L'app applique le même calcul avec les valeurs de k publiées dans la méta (champ `priors`).

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

/** Bornes du nombre de parties a priori : jamais moins lissé que 150, jamais plus que 20 000. */
export const K_MIN = 150
export const K_MAX = 20000

/**
 * Force du lissage mesurée sur des cellules [parties, écart observé, variance due au hasard].
 * Trop peu de cellules : valeur par défaut. Aucun écart réel détectable : lissage maximal.
 */
export function momPrior(cells, { fallback = 2000, minCells = 40, minGames = 5000 } = {}) {
  let sn = 0
  let obs = 0
  let noise = 0
  for (const [n, dev, v] of cells) {
    if (!(n > 0) || !Number.isFinite(dev) || !Number.isFinite(v)) continue
    sn += n
    obs += n * dev * dev
    noise += n * v
  }
  if (cells.length < minCells || sn < minGames) return { k: fallback, tau: null, cells: cells.length }
  const tau2 = (obs - noise) / sn
  const k = tau2 > 0 ? clamp(0.25 / tau2, K_MIN, K_MAX) : K_MAX
  return { k: Math.round(k), tau: Math.sqrt(Math.max(0, tau2)), cells: cells.length }
}

/**
 * Cellules d'un compteur { option: [parties, victoires] } dont les options se partagent les mêmes
 * parties (pages de runes d'un champion, objets achetés au même rang…) : écart au taux de
 * l'ensemble, et variance due au hasard (corrigée du fait que l'option fait partie de l'ensemble).
 * Chaque cellule : [parties, écart, variance, part].
 */
export function partitionCells(map, { minGames = 30, minShare = 0.05, minTotal = 300 } = {}) {
  const entries = Object.entries(map ?? {})
  let N = 0
  let W = 0
  for (const [, [g, w]] of entries) {
    N += g
    W += w
  }
  if (N < minTotal) return []
  const base = W / N
  const out = []
  for (const [, [g, w]] of entries) {
    if (g < minGames || g / N < minShare) continue
    out.push([g, w / g - base, ((base * (1 - base)) / g) * (1 - g / N), g / N])
  }
  return out
}

/**
 * Lien entre popularité et taux de victoire : points de taux gagnés quand la part d'une option
 * double (régression pondérée sur des cellules [parties, écart, variance, part]). Borné entre 0 et
 * 0,5 point : une option très jouée par les meilleurs joueurs est en moyenne un peu meilleure.
 */
export function popularitySlope(cells, { minCells = 60 } = {}) {
  if (cells.length < minCells) return 0
  let sw = 0
  let sx = 0
  for (const [n, , , share] of cells) {
    sw += n
    sx += n * Math.log2(share)
  }
  const mx = sx / sw
  let sxx = 0
  let sxy = 0
  for (const [n, dev, , share] of cells) {
    const x = Math.log2(share) - mx
    sxx += n * x * x
    sxy += n * x * dev
  }
  if (sxx <= 0) return 0
  return Math.round(clamp(sxy / sxx, 0, 0.005) * 10000) / 10000
}

/** Meilleure estimation d'un écart observé sur n parties (a priori : mu, force k). */
export const posterior = (n, dev, k, mu = 0) => mu + (n / (n + k)) * (dev - mu)

/**
 * Options d'un compteur { option: [parties, victoires] }, de la meilleure à la moins bonne :
 * écart estimé au taux de l'ensemble (lissage de force k, a priori selon la popularité). Seules les
 * options assez jouées sont classées ; s'il n'y en a aucune, la plus jouée.
 */
export function rankOptions(
  map,
  { k = 2000, slope = 0, minShare = 0.1, minGames = 5, filter = () => true } = {}
) {
  const entries = Object.entries(map ?? {}).filter(([key]) => filter(key))
  let N = 0
  let W = 0
  for (const [, [g, w]] of entries) {
    N += g
    W += w
  }
  if (N <= 0) return []
  const base = W / N
  const eligible = entries.filter(([, [g]]) => g >= minGames && g / N >= minShare)
  if (!eligible.length) {
    const [key, [g, w]] = entries.sort((a, b) => b[1][0] - a[1][0])[0]
    return [{ key, games: g, wins: w, share: g / N, estimate: 0, base }]
  }
  const top = Math.max(...eligible.map(([, [g]]) => g / N))
  return eligible
    .map(([key, [g, w]]) => {
      const share = g / N
      const mu = slope * Math.log2(share / top)
      return { key, games: g, wins: w, share, estimate: posterior(g, w / g - base, k, mu), base }
    })
    .sort((a, b) => b.estimate - a.estimate || b.games - a.games)
}

/** Clé de la meilleure option (voir rankOptions), ou null. */
export const bestOption = (map, options) => rankOptions(map, options)[0]?.key ?? null
