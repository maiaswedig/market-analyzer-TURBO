// decision.js — decisão por EXPECTATIVA MATEMÁTICA (substitui o veto rígido de "probabilidade mínima").
//
// Três métricas SEPARADAS, cada uma com origem e amostra:
//   score  → força de confluência técnica (score.js), nunca taxa de acerto
//   pModel → probabilidade do modelo calibrado (ml.js), só quando passa nas travas de validação
//   pHist  → taxa histórica de situações análogas / classe de setup, com N amostras
// Se nenhuma estimativa estatística é elegível, a UI mostra
// "⚠️ Dados insuficientes para estimativa estatística." e a decisão fica com score + travas.

export const INSUFFICIENT = '⚠️ Dados insuficientes para estimativa estatística.';

/** Taxa de acerto de equilíbrio já incluindo custo fixo por operação. */
export function normalizeTiePolicy(value) {
  return ['loss', 'refund', 'win'].includes(value) ? value : 'loss';
}

export function tiePolicyLabel(value) {
  return ({ loss: 'empate contado como perda', refund: 'empate reembolsado', win: 'empate contado como acerto' })[normalizeTiePolicy(value)];
}

/** Resultado líquido de uma operação empatada, já considerando o custo informado. */
export function tieNet(payout, stake = 1, cost = 0, tiePolicy = 'loss') {
  const safeStake = Math.max(0.000001, Number(stake) || 1);
  const safePayout = Math.max(0, Number(payout) || 0);
  const safeCost = Math.max(0, Number(cost) || 0);
  const policy = normalizeTiePolicy(tiePolicy);
  if (policy === 'refund') return -safeCost;
  if (policy === 'win') return safeStake * safePayout - safeCost;
  return -(safeStake + safeCost);
}

/**
 * Taxa de acerto de equilíbrio já incluindo custo e a taxa esperada de empate.
 * `p` é a probabilidade incondicional de a direção escolhida vencer; os empates
 * não são removidos da amostra para não inflar artificialmente o EV em binárias.
 */
export function breakEvenRate(payout, stake = 1, cost = 0, tieProbability = 0, tiePolicy = 'loss') {
  const safeStake = Math.max(0.000001, Number(stake) || 1);
  const safePayout = Math.max(0, Number(payout) || 0);
  const safeCost = Math.max(0, Number(cost) || 0);
  const pTie = Math.max(0, Math.min(1, Number(tieProbability) || 0));
  const win = safeStake * safePayout - safeCost;
  const loss = -(safeStake + safeCost);
  const draw = tieNet(safePayout, safeStake, safeCost, tiePolicy);
  const denominator = win - loss;
  if (denominator <= 0) return 1;
  return Math.max(0, Math.min(1, -(loss + pTie * (draw - loss)) / denominator));
}

/** EV líquido por operação: vitória, perda e empate, menos spread + slippage estimados. */
export function expectancy(p, payout, stake = 1, cost = 0, tieProbability = 0, tiePolicy = 'loss') {
  const safeStake = Math.max(0.000001, Number(stake) || 1);
  const safePayout = Math.max(0, Number(payout) || 0);
  const safeCost = Math.max(0, Number(cost) || 0);
  const pWin = Math.max(0, Math.min(1, Number(p) || 0));
  const pTie = Math.max(0, Math.min(1 - pWin, Number(tieProbability) || 0));
  const pLoss = Math.max(0, 1 - pWin - pTie);
  const win = safeStake * safePayout - safeCost;
  const loss = -(safeStake + safeCost);
  return pWin * win + pTie * tieNet(safePayout, safeStake, safeCost, tiePolicy) + pLoss * loss;
}

function wilson(hits, n) {
  if (!n) return { low: null, high: null, p: null };
  const z = 1.96, phat = hits / n;
  const denom = 1 + z * z / n;
  const center = (phat + z * z / (2 * n)) / denom;
  const margin = (z * Math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n))) / denom;
  return { p: phat, low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/**
 * Escolhe a melhor estimativa DISPONÍVEL de p (probabilidade de a direção escolhida vencer).
 * Ordem: classe de setup (amostra dedicada) → análogos históricos → modelo calibrado.
 */
export function pickEstimate({ direction, setupStats, hist, ml, cfg }) {
  const minSetup = cfg.minSetupSamples ?? 15;
  const minHist = cfg.minSamples ?? 30;

  if (setupStats && setupStats.samples >= minSetup && setupStats.rate !== null) {
    const ci = wilson(setupStats.hits, setupStats.total);
    return {
      p: setupStats.p, tieP: setupStats.tieP || 0, source: 'classe de setup (sinais reais verificados)',
      samples: setupStats.total, ciLow: ci.low, ciHigh: ci.high, kind: 'setup'
    };
  }
  if (hist && !hist.insufficient) {
    const pDir = direction > 0 ? hist.pUp : hist.pDown;
    const hits = direction > 0 ? hist.up : hist.down;
    const ci = wilson(hits, hist.samples);
    if (hist.samples >= minHist) {
      return {
        p: pDir, tieP: hist.pTie || 0, source: `análogos históricos (distância ≤ ${hist.maxDistance.toFixed(1)})`,
        samples: hist.samples, ciLow: ci.low, ciHigh: ci.high, kind: 'analogo'
      };
    }
  }
  if (ml && ml.usable && ml.p !== null && ml.p !== undefined && Number.isFinite(Number(ml.tieP))) {
    // O modelo binário é treinado somente nas velas não empatadas. Sua saída é
    // portanto condicional; a taxa de empate observada no mesmo treino devolve
    // a probabilidade à escala incondicional usada pelo EV.
    const tieP = Math.max(0, Math.min(0.99, Number(ml.tieP)));
    const conditional = direction > 0 ? ml.p : 1 - ml.p;
    const pDir = conditional * (1 - tieP);
    return {
      p: pDir, tieP, source: `modelo calibrado condicional (Brier ${ml.brier !== null && ml.brier !== undefined ? ml.brier.toFixed(4) : '—'})`,
      samples: ml.validN || null, ciLow: null, ciHigh: null, kind: 'ml'
    };
  }
  return { p: null, tieP: null, source: null, samples: 0, ciLow: null, ciHigh: null, kind: 'nenhuma', insufficient: true };
}

/**
 * Decisão final.
 * @returns { verdict, gates, ev, evPct, estimate, breakEven, reasons, blocked }
 */
export function decide({ score, mtf, cond, hist, ml, setupStats, cfg, brokerDivergence = null, dataFreshness = null, marketGuards = {}, expiry = null }) {
  const payout = (Number(cfg.payout) || 85) / 100;
  const stake = Number(cfg.stake) || 5;
  const operationCost = Math.max(0, Number(cfg.operationCost) || 0);
  const tiePolicy = normalizeTiePolicy(cfg.tiePolicy);
  const direction = score.direction;
  const gates = [];
  const reasons = [];
  const gate = (ok, okText, failText, blocking = true) => {
    gates.push({ ok: !!ok, text: ok ? okText : failText, blocking });
    if (!ok && blocking) reasons.push(failText);
    return !!ok;
  };

  const gDir = gate(direction !== 0, 'direção técnica definida', 'categorias se anulam — sem direção definida');
  const gScore = gate(score.score >= cfg.minScore, `score ${score.score} ≥ mínimo ${cfg.minScore}`, `score ${score.score} abaixo do mínimo ${cfg.minScore}`);
  const gBlock = gate(score.blocking.length === 0, 'nenhum risco técnico crítico', `⚠️ avaliação baixa — risco técnico: ${score.blocking.map(b => b.name).join(', ')}`);
  const gConf = gate(!cfg.minConfluence || !score.confluence.total || score.confluence.agree >= cfg.minConfluence,
    `confluência ${score.confluence.text}`, `confluência ${score.confluence.text} abaixo do mínimo (${cfg.minConfluence})`);
  const gBroker = gate(!brokerDivergence || !brokerDivergence.divergent, 'feed conferido com a corretora',
    `⚠️ RISCO ALTO — avaliação baixa: feed da corretora divergente (${brokerDivergence ? brokerDivergence.reason : ''})`);
  const gData = gate(!dataFreshness || !dataFreshness.blocked,
    'latência do dado dentro do limite do tempo gráfico',
    `⚠️ RISCO ALTO — avaliação baixa: ${dataFreshness && dataFreshness.reason ? dataFreshness.reason : 'dado com atraso acima do limite configurado'}`);

  // Filtros causais calculados pelo mesmo evaluateBar() usado na tela, no Worker
  // e no backtest. Riscos operacionais continuam travas; divergências técnicas
  // correlacionadas viram alertas e são avaliadas em conjunto pelo modo.
  const safetyGate = (key, label, blocking = true) => {
    const risk = marketGuards[key];
    if (!risk || risk.enabled === false) return gate(true, `${label}: não aplicável`, '', false);
    if (risk.historicalUnavailable) return gate(true, `${label}: ${risk.text}`, '', false);
    const ok = gate(
      !risk.blocked,
      `${label}: ${risk.text}`,
      blocking ? `⚠️ RISCO ALTO — avaliação baixa: ${label.toLowerCase()}: ${risk.text}` : `⚠️ cautela — ${label.toLowerCase()}: ${risk.text}`,
      blocking
    );
    if (!ok && !blocking) {
      const last = gates[gates.length - 1];
      if (last) { last.warn = true; last.kind = 'technical-filter'; }
    }
    return ok;
  };

  // Pavio, contexto de zona e VSA são evidências técnicas correlacionadas.
  // Tratá-las como três vetos independentes eliminava quase toda a amostra.
  // Agora os modos controlam quantas divergências menores são toleradas; uma
  // zona forte realmente próxima continua sendo veto em qualquer modo.
  const gWick = safetyGate('wick', 'pavio/rejeição', false);
  const gHtfZone = safetyGate('htfZone', 'zona forte M15/H1', false);
  const gVsa = safetyGate('vsa', 'volume VSA', false);
  const gSession = safetyGate('session', 'sessão/liquidez');
  const newsRisk = marketGuards.news;
  // Uma notícia realmente encontrada continua sendo veto. Falha temporária da
  // agenda pública não apaga todos os pares Forex: o sinal técnico permanece
  // visível, mas perde o selo de confirmado e recebe um aviso explícito.
  const newsUnverified = !!(newsRisk && newsRisk.enabled !== false && newsRisk.unverified);
  let gNews = true;
  if (newsUnverified) {
    const cleaned = String(newsRisk.text || 'agenda econômica sem atualização válida').replace(/^⚠️\s*NÃO OPERAR\s*[—-]\s*/i, '');
    gates.push({ ok: false, text: `⚠️ cautela — notícia econômica: ${cleaned}`, blocking: false, warn: true, kind: 'calendar-unverified' });
  } else gNews = safetyGate('news', 'notícia econômica');
  const mode = cfg.mode === 'agressivo' ? 'agressivo' : cfg.mode === 'normal' || cfg.mode === 'neutro' ? 'normal' : 'conservador';
  const technicalAllowance = mode === 'conservador' ? 2 : 3;
  const zoneRisk = marketGuards.htfZone;
  const strongZoneObstacle = !!(zoneRisk && zoneRisk.enabled !== false && zoneRisk.blocked && !zoneRisk.unavailable);
  const minorTechnicalFailures = [
    !gWick ? 'pavio' : null,
    !gVsa ? 'volume' : null,
    !gHtfZone && zoneRisk && zoneRisk.unavailable ? 'contexto M15/H1' : null
  ].filter(Boolean);
  const gStrongZone = gate(
    !strongZoneObstacle,
    'nenhuma zona forte contrária rebaixando a entrada',
    `⚠️ RISCO ALTO — avaliação baixa: obstáculo forte de ${direction > 0 ? 'resistência' : 'suporte'} em M15/H1`
  );
  const gTechnicalQuality = gate(
    minorTechnicalFailures.length <= technicalAllowance,
    `qualidade técnica: ${minorTechnicalFailures.length} divergência(s), limite ${technicalAllowance} no modo ${mode === 'normal' ? 'neutro' : mode}`,
    `⚠️ avaliação baixa — qualidade técnica insuficiente: ${minorTechnicalFailures.join(', ')}; o modo ${mode === 'normal' ? 'neutro' : mode} aceita no máximo ${technicalAllowance}`
  );

  const estimate = pickEstimate({ direction, setupStats, hist, ml, cfg });
  const tieProbability = estimate.p === null ? 0 : Math.max(0, Number(estimate.tieP) || 0);
  const breakEven = breakEvenRate(payout, stake, operationCost, tieProbability, tiePolicy);
  let ev = null, evOk = true, evText = INSUFFICIENT;
  if (estimate.p !== null) {
    ev = expectancy(estimate.p, payout, stake, operationCost, tieProbability, tiePolicy);
    const evLow = estimate.ciLow !== null ? expectancy(estimate.ciLow, payout, stake, operationCost, tieProbability, tiePolicy) : null;
    const confidentlyNegative = estimate.ciHigh !== null ? estimate.ciHigh < breakEven : ev < 0 && (estimate.samples || 0) >= 60;
    evOk = cfg.evGate === 'bloquear' ? ev > (Number(cfg.minEv) || 0) : !confidentlyNegative;
    const negative = ev <= 0;
    evText = !evOk
      ? `expectativa matemática líquida negativa: p=${(estimate.p * 100).toFixed(1)}% abaixo do equilíbrio de ${(breakEven * 100).toFixed(1)}% para payout ${(payout * 100).toFixed(0)}%, custo de R$ ${operationCost.toFixed(2)} e ${tiePolicyLabel(tiePolicy)} (${estimate.source}, N=${estimate.samples || '—'})`
      : negative
        ? `⚠️ expectativa líquida NEGATIVA de R$ ${ev.toFixed(3)} por operação de R$ ${stake}, após custo de R$ ${operationCost.toFixed(2)} (p=${(estimate.p * 100).toFixed(1)}% · empate ${(tieProbability * 100).toFixed(1)}% · ${tiePolicyLabel(tiePolicy)} · ${estimate.source} · N=${estimate.samples || '—'}) — amostra não conclusiva (IC95% cruza o equilíbrio), sinal mantido só com aviso`
        : `expectativa líquida +R$ ${ev.toFixed(3)} por operação de R$ ${stake}, após custo de R$ ${operationCost.toFixed(2)} (p=${(estimate.p * 100).toFixed(1)}% · empate ${(tieProbability * 100).toFixed(1)}% · ${tiePolicyLabel(tiePolicy)} · ${estimate.source} · N=${estimate.samples || '—'})`;
    gates.push({ ok: evOk, warn: evOk && negative, text: evText, blocking: true, kind: 'ev', evLow });
    if (!evOk) reasons.push(evText);
  } else {
    // NÃO é veto: sem estimativa confiável o sistema decide por score + travas, e avisa.
    gates.push({ ok: true, text: INSUFFICIENT + ' A decisão usa apenas score técnico e travas de risco.', blocking: false, kind: 'ev' });
  }

  const eligibleWithoutScore = gDir && gBlock && gConf && gBroker && gData && gStrongZone && gTechnicalQuality && gSession && gNews && evOk;
  const pass = eligibleWithoutScore && gScore;
  const verdict = pass ? (direction > 0 ? 'CALL' : 'PUT') : 'AGUARDAR';

  return {
    verdict, direction, gates, reasons,
    ev, grossEv: estimate.p === null ? null : expectancy(estimate.p, payout, stake, 0, tieProbability, tiePolicy), evPerReal: ev === null ? null : ev / stake,
    estimate, breakEven, payout, stake, operationCost, tiePolicy, tieProbability,
    netWin: stake * payout - operationCost, netTie: tieNet(payout, stake, operationCost, tiePolicy), netLoss: -(stake + operationCost),
    expiryCandles: expiry && expiry.candles ? expiry.candles : 1,
    expiryReason: expiry && expiry.reason ? expiry.reason : 'projeção para a próxima vela',
    filters: marketGuards,
    eligibleWithoutScore,
    technicalWarnings: minorTechnicalFailures,
    technicalAllowance,
    confirmationEligible: !newsUnverified,
    operationalWarnings: newsUnverified ? ['agenda econômica sem confirmação atual'] : [],
    blocked: !gBlock || !gBroker || !gData || !gStrongZone || !gTechnicalQuality || !gSession || !gNews
  };
}

/** Bullets curtos do "Por quê?" (3 a 5 itens). */
export function whyBullets({ score, decision, cond, snap, mtf }) {
  const bullets = [];
  const dirWord = score.direction > 0 ? 'comprador' : score.direction < 0 ? 'vendedor' : 'indefinido';
  const cats = score.categories.slice().sort((a, b) => Math.abs(b.bias * b.weight) - Math.abs(a.bias * a.weight));
  if (decision.verdict === 'AGUARDAR') {
    for (const m of mtf.filter(x => !x.unavailable)) bullets.push(`${m.tf} ${m.dir > 0 ? 'comprador' : m.dir < 0 ? 'vendedor' : 'lateral'}`);
    const failed = decision.gates.filter(g => !g.ok && g.blocking);
    for (const f of failed.slice(0, 3)) bullets.push(f.text);
    if (cond) bullets.push(`condição: ${cond.label.toLowerCase()}`);
    if (snap.volume.available && snap.volume.rel !== null && snap.volume.rel < 0.9) bullets.push('volume abaixo da média');
    return bullets.slice(0, 6);
  }
  bullets.push(`viés ${dirWord} em ${cats.filter(c => Math.sign(c.bias) === score.direction).length} de ${score.categories.length} categorias`);
  for (const c of cats.slice(0, 2)) bullets.push(`${c.label}: ${c.sub}/100 — ${c.detail}`);
  bullets.push(`confluência multi-TF ${score.confluence.text}${cond ? ` · ${cond.label.toLowerCase()}` : ''}`);
  const cautions = decision.gates.filter(g => !g.ok && !g.blocking && g.warn);
  for (const caution of cautions.slice(0, 2)) bullets.push(caution.text);
  if (decision.ev !== null && decision.ev <= 0) bullets.push(`⚠️ expectativa matemática negativa (R$ ${decision.ev.toFixed(3)} por operação) com o payout configurado — o sinal técnico existe, o retorno esperado não`);
  if (snap.priceAction && snap.priceAction.events.length) bullets.push(snap.priceAction.summary);
  if (decision.estimate.p !== null) bullets.push(`estimativa ${(decision.estimate.p * 100).toFixed(1)}% · empate ${(Math.max(0, Number(decision.estimate.tieP) || 0) * 100).toFixed(1)}% (${decision.estimate.source}, N=${decision.estimate.samples || '—'})`);
  else bullets.push(INSUFFICIENT);
  return bullets.slice(0, 5);
}
