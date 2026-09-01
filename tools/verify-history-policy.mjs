import {
  isOperationalHistoryEntry,
  isVisibleGradeHistoryEntry,
  normalizeOperationalGrade,
  partitionOperationalHistory,
  partitionVisibleGradeHistory,
} from '../js/history-policy.js';

const checks = [];
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks.push(message);
}

check(normalizeOperationalGrade('A +') === 'A+', 'normaliza A+ sem alterar a classificação');
check(normalizeOperationalGrade('a') === 'A', 'normaliza A');
check(normalizeOperationalGrade('B') === null, 'rejeita B no histórico operacional');
check(isOperationalHistoryEntry({ grade: 'A+', quality: 'CONFIRMADO' }), 'A+ confirmado entra na visão operacional');
check(isOperationalHistoryEntry({ grade: 'A', quality: 'TECNICO' }), 'A técnico entra na visão operacional');
check(!isOperationalHistoryEntry({ grade: 'A', quality: 'BAIXA' }), 'avaliação baixa não entra mesmo com nota A');
check(isVisibleGradeHistoryEntry({ grade: 'A', quality: 'BAIXA' }), 'nota A baixa aparece na amostragem visual');
check(isVisibleGradeHistoryEntry({ grade: 'A+', quality: 'BAIXA' }), 'nota A+ baixa aparece na amostragem visual');
check(!isVisibleGradeHistoryEntry({ grade: 'B', quality: 'CONFIRMADO' }), 'amostragem visual continua restrita a A/A+');
check(!isOperationalHistoryEntry({ grade: 'B', quality: 'CONFIRMADO' }), 'nota B permanece apenas no ledger bruto');
check(!isOperationalHistoryEntry({ quality: 'CONFIRMADO' }), 'registro legado sem nota congelada não é inferido depois');

const raw = [
  { id: 1, grade: 'A+', quality: 'CONFIRMADO' },
  { id: 2, grade: 'C', quality: 'BAIXA' },
  { id: 3, grade: 'A', quality: 'TECNICO' },
];
const partition = partitionOperationalHistory(raw);
check(partition.eligible.map(row => row.id).join(',') === '1,3', 'particiona A/A+ sem apagar registros');
check(partition.auditOnly.map(row => row.id).join(',') === '2', 'preserva níveis menores para auditoria e treino');
check(raw.length === 3, 'não modifica o ledger bruto');

const visualRaw = [...raw, { id: 4, grade: 'A', quality: 'BAIXA' }];
const visual = partitionVisibleGradeHistory(visualRaw);
check(visual.visible.map(row => row.id).join(',') === '1,3,4', 'histórico visível inclui A/A+ de qualquer qualidade');
check(visual.internalOnly.map(row => row.id).join(',') === '2', 'níveis B/C/D continuam somente internos');
check(!isOperationalHistoryEntry(visual.visible.at(-1)), 'mostrar A baixo não o torna elegível para ranking');

console.log(`History operational policy: ${checks.length}/${checks.length} verificações passaram.`);
