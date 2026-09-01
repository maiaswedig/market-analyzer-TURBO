export const OPERATIONAL_HISTORY_GRADES = Object.freeze(['A+', 'A']);

export function normalizeOperationalGrade(value) {
  const grade = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  return OPERATIONAL_HISTORY_GRADES.includes(grade) ? grade : null;
}

/**
 * The operational dashboard is intentionally selective, but the raw ledger is
 * never deleted. Eligibility is frozen at emission time to prevent choosing a
 * signal after seeing part of its outcome.
 */
export function isOperationalHistoryEntry(entry) {
  if (!entry || !normalizeOperationalGrade(entry.grade)) return false;
  return String(entry.quality || '').toUpperCase() !== 'BAIXA';
}

/**
 * Política exclusivamente visual: mostra toda nota A/A+, inclusive quando a
 * qualidade estatística ficou BAIXA. Ela não deve ser usada para treino,
 * ranking, promoção ou para reescrever a elegibilidade congelada na emissão.
 */
export function isVisibleGradeHistoryEntry(entry) {
  return !!entry && !!normalizeOperationalGrade(entry.grade);
}

export function partitionOperationalHistory(entries = []) {
  const eligible = [];
  const auditOnly = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    (isOperationalHistoryEntry(entry) ? eligible : auditOnly).push(entry);
  }
  return { eligible, auditOnly };
}

export function partitionVisibleGradeHistory(entries = []) {
  const visible = [];
  const internalOnly = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    (isVisibleGradeHistoryEntry(entry) ? visible : internalOnly).push(entry);
  }
  return { visible, internalOnly };
}
