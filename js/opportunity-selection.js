// Mantém a identidade temporal entre a linha do ranking e a análise aberta.
// Nenhum fetch ou recálculo acontece aqui; atualizar é uma ação separada.
export function rankedOpportunitySnapshot(rows, assetId, tfKey, openedAt = Date.now()) {
  const list = Array.isArray(rows) ? rows : [];
  const rankIndex = list.findIndex(row => row && row.asset && row.asset.id === assetId && row.result && row.result.tfKey === tfKey);
  if (rankIndex < 0) return null;
  const row = list[rankIndex];
  return {
    rank: rankIndex + 1,
    asset: row.asset,
    result: {
      ...row.result,
      openedFromScanner: true,
      scannerRank: rankIndex + 1,
      scannerSnapshotAt: row.result.at || openedAt
    }
  };
}
