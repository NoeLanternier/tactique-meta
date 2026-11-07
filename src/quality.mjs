// Contrôle des données de chaque collecte : part des junglers pour lesquels on a bien trouvé les
// runes, les objets, l'ordre des compétences et la position sur la carte. Si Riot change le format
// de ses réponses, ces parts s'effondrent : mieux vaut alors ne rien publier.

export function emptyQuality() {
  return { records: 0, runes: 0, items: 0, skills: 0, timeline: 0, timelineRecords: 0 }
}

export function recordQuality(q, rec) {
  q.records++
  if (rec.runeSig) q.runes++
  if ((rec.items ?? []).length > 0) q.items++
  if (rec.skills) q.skills++
  // Position à 2 minutes : relevée pour les junglers seulement.
  if (!rec.role || rec.role === 'jungle') {
    q.timelineRecords++
    if (rec.opening?.side) q.timeline++
  }
}

/** Parts minimales observées en temps normal (avec une bonne marge). */
const MIN_SHARE = { runes: 0.8, items: 0.8, skills: 0.6, timeline: 0.8 }
const LABEL = {
  runes: 'pages de runes',
  items: 'objets légendaires',
  skills: 'ordre des compétences',
  timeline: 'positions sur la carte'
}
/** En dessous, trop peu de parties pour conclure. */
const MIN_RECORDS = 200

export function qualityIssues(q) {
  if (q.records < MIN_RECORDS) return []
  const issues = []
  for (const [k, min] of Object.entries(MIN_SHARE)) {
    const total = k === 'timeline' ? (q.timelineRecords ?? q.records) : q.records
    if (total < MIN_RECORDS / 5) continue
    const share = q[k] / total
    if (share < min)
      issues.push(`${LABEL[k]} trouvé(e)s pour ${Math.round(share * 100)} % des junglers (attendu ≥ ${min * 100} %)`)
  }
  return issues
}
