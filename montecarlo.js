/* ═══════════════════════════════════════════════════════════
   MONTE CARLO — Previsioni elezioni Cammarata
   Richiede: allData, totals, defSez, N, EL, C1, C2, $, fn, pct, num, view, userRole
═══════════════════════════════════════════════════════════ */

const MC_AFFLUENZA   = 0.725;        // 70–75% → media 72.5%
const MC_SIMS_FULL   = 10000;
const MC_SIMS_FAST   = 5000;
const MC_DEBOUNCE_MS = 500;
const MC_HISTORY_MAX = 120;

let mcResult       = null;
let mcComputing    = false;
let mcDebounceTimer = null;
let mcHistory      = [];
let mcChart        = null;
let mcDisplayPct   = { traina: 50, mang: 50 };
let mcAnimFrame    = null;

/* ── MOTORE STOCASTICO (Bayes & Monte Carlo) ──────────────── */
function randNormal() {
  let u = 0, v = 0;
  while(u === 0) u = Math.random();
  while(v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function randGamma(shape) {
  let d, c, x, v, u;
  if (shape < 1) return randGamma(shape + 1) * Math.pow(Math.random(), 1.0 / shape);
  d = shape - 1.0 / 3.0;
  c = 1.0 / Math.sqrt(9.0 * d);
  while (true) {
    do { x = randNormal(); v = 1.0 + c * x; } while (v <= 0.0);
    v = v * v * v;
    u = Math.random();
    if (u < 1.0 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1.0 - v + Math.log(v))) return d * v;
  }
}

function randBeta(alpha, beta) {
  const g1 = randGamma(alpha);
  const g2 = randGamma(beta);
  return g1 / (g1 + g2);
}

function randBinomial(n, p) {
  if (n === 0) return 0;
  if (n > 30) {
    const mean = n * p;
    const std  = Math.sqrt(n * p * (1 - p));
    const val  = Math.round(randNormal() * std + mean);
    return Math.max(0, Math.min(n, val));
  }
  let k = 0;
  for (let i = 0; i < n; i++) { if (Math.random() < p) k++; }
  return k;
}
/* ────────────────────────────────────────────────────────── */

/* ── Soglie confidenza ───────────────────────────────────── */
function getConfidenceLevel(vt) {
  const v = num(vt);
  if (v < 250) {
    return {
      mode: 'off',
      confidence: 0,
      label: 'Non attivo',
      message: '🔮 Previsioni disponibili a partire da 250 schede scrutinate',
      alertClass: 'gray',
      showProjection: false
    };
  }
  if (v < 400) {
    const conf = 15 + ((v - 250) / 150) * 20;
    return {
      mode: 'preview',
      confidence: Math.round(conf),
      label: 'Anteprima sperimentale',
      message: '⚠️ DATI ANCORA LIMITATI — Attendibilità bassa. La proiezione diventerà affidabile a 500 voti.',
      alertClass: 'red',
      showProjection: true
    };
  }
  if (v < 500) {
    const conf = 40 + ((v - 400) / 100) * 25;
    return {
      mode: 'partial',
      confidence: Math.round(conf),
      label: 'Attendibilità parziale',
      message: '📊 Attendibilità in crescita (40–65%). La proiezione è ancora in fase di stabilizzazione.',
      alertClass: 'yellow',
      showProjection: true
    };
  }
  if (v < 800) {
    const conf = 75 + ((v - 500) / 300) * 15;
    return {
      mode: 'official',
      confidence: Math.round(Math.min(90, conf)),
      label: 'Previsione affidabile',
      message: '',
      alertClass: 'green',
      showProjection: true,
      officialBadge: true
    };
  }
  return {
    mode: 'certain',
    confidence: 95,
    label: 'Alta certezza',
    message: '',
    alertClass: 'green',
    showProjection: true,
    officialBadge: true
  };
}

/* ── Aggiornamento Bayesiano per sezione ─────────────────── */
function calculateTrendsBySezione() {
  const trends     = [];
  const PRIOR_ALPHA = 1.5;
  const PRIOR_BETA  = 1.5;

  for (let i = 1; i <= N; i++) {
    const s  = allData[i] || defSez();
    const el = EL[i - 1];

    const vTraina = num(s.vc2);
    const vMang   = num(s.vc1);
    const votanti = num(s.votanti);

    const alpha = PRIOR_ALPHA + vTraina;
    const beta  = PRIOR_BETA  + vMang;

    const expectedAtPoll  = Math.round(el * MC_AFFLUENZA);
    const remaining       = Math.max(0, expectedAtPoll - votanti);
    const validRate       = votanti > 0 ? (vTraina + vMang) / votanti : 0.95;
    const validRemaining  = Math.round(remaining * validRate);

    trends.push({ sez: i, alpha, beta, remainingValid: validRemaining, expectedAtPoll });
  }
  return trends;
}

/* ── Certezza matematica (senza simulazione) ─────────────── */
/* BUG FIX #2: era tr.remaining (undefined) → corretto in tr.remainingValid */
function mcMathCertainty(trends, vc1, vc2) {
  let rem = 0;
  trends.forEach(tr => { rem += tr.remainingValid; });
  const mangWon  = vc1 > vc2 + rem;
  const trainWon = vc2 > vc1 + rem;
  return { mangWon, trainWon, remaining: rem };
}

/* ── Simulazione Monte Carlo ─────────────────────────────── */
function runMonteCarlo() {
  const t      = totals(allData);
  const conf   = getConfidenceLevel(t.vt);
  const trends = calculateTrendsBySezione();
  const math   = mcMathCertainty(trends, t.vc1, t.vc2);

  if (!conf.showProjection) {
    return {
      active: false,
      conf,
      vt: t.vt,
      expectedTotal: Math.round(t.el * MC_AFFLUENZA),
      trends,
      math
    };
  }

  const sims = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency <= 4)
    ? MC_SIMS_FAST : MC_SIMS_FULL;

  const tvNow        = t.vc1 + t.vc2;
  const pctTrainaNow = tvNow > 0 ? t.vc2 / tvNow * 100 : 50;

  let winsTraina = 0, winsMang = 0, ties = 0;
  const finalPcts      = new Float32Array(sims);
  const decisiveCount  = new Uint32Array(N);
  const sezWonTraina   = new Uint8Array(N);
  const sezWonMang     = new Uint8Array(N);

  const baseVc1 = t.vc1;
  const baseVc2 = t.vc2;

  for (let sim = 0; sim < sims; sim++) {
    let vc1 = baseVc1;
    let vc2 = baseVc2;
    const margins = new Float32Array(N);

    for (let si = 0; si < N; si++) {
      const tr = trends[si];
      if (tr.remainingValid > 0) {
        const thetaTraina = randBeta(tr.alpha, tr.beta);
        const addT = randBinomial(tr.remainingValid, thetaTraina);
        const addM = tr.remainingValid - addT;
        vc1 += addM;
        vc2 += addT;
        margins[si] = addT - addM;
      } else {
        margins[si] = 0;
      }
    }

    const pctT = (vc1 + vc2) > 0 ? vc2 / (vc1 + vc2) * 100 : 50;
    finalPcts[sim] = pctT;

    if      (vc2 > vc1) winsTraina++;
    else if (vc1 > vc2) winsMang++;
    else                ties++;

    let bestSwing = -1, bestSez = 0;
    for (let si = 0; si < N; si++) {
      if (trends[si].remainingValid > 0 && Math.abs(margins[si]) > bestSwing) {
        bestSwing = Math.abs(margins[si]);
        bestSez   = si;
      }
    }
    if (bestSwing >= 0) decisiveCount[bestSez]++;
  }

  finalPcts.sort();
  const pTraina  = winsTraina / sims;
  const pMang    = winsMang  / sims;
  const idx025   = Math.floor(sims * 0.025);
  const idx975   = Math.floor(sims * 0.975);
  const ciLow    = finalPcts[idx025];
  const ciHigh   = finalPcts[idx975];
  const ciMid    = finalPcts[Math.floor(sims * 0.5)];

  let decisiveSez = 1, maxDec = 0;
  for (let i = 0; i < N; i++) {
    if (decisiveCount[i] > maxDec) { maxDec = decisiveCount[i]; decisiveSez = i + 1; }
  }

  for (let i = 0; i < N; i++) {
    const s  = allData[i + 1] || defSez();
    const tv = num(s.vc1) + num(s.vc2);
    if (tv > 0 && num(s.vc2) / tv > 0.55) sezWonTraina[i] = 1;
    if (tv > 0 && num(s.vc1) / tv > 0.55) sezWonMang[i]   = 1;
  }

  const lead            = pctTrainaNow - (100 - pctTrainaNow);
  const mathWinner      = math.trainWon ? 'traina' : math.mangWon ? 'mang' : null;

  return {
    active: true,
    conf,
    vt: t.vt,
    expectedTotal: Math.round(t.el * MC_AFFLUENZA),
    sims,
    pTraina,
    pMang,
    pctTrainaNow,
    lead,
    ciLow,
    ciHigh,
    ciMid,
    decisiveSez,
    decisiveCount: maxDec,
    decisiveSimTotal: sims,
    sezWonTraina: Array.from(sezWonTraina).filter(Boolean).length,
    sezWonMang:   Array.from(sezWonMang).filter(Boolean).length,
    mathematicallyWon: math.trainWon || math.mangWon,
    mathWinner,
    math,
    trends,
    winsTraina,
    winsMang,
    ties
  };
}

/* ── Storico probabilità ─────────────────────────────────── */
function mcPushHistory(res) {
  if (!res || !res.active) return;
  const t = totals(allData);
  mcHistory.push({ ts: Date.now(), vt: t.vt, pTraina: res.pTraina * 100, pctNow: res.pctTrainaNow });
  if (mcHistory.length > MC_HISTORY_MAX) mcHistory.shift();
  try { localStorage.setItem('cam5_mc_history', JSON.stringify(mcHistory)); } catch(e) {}
}

function mcLoadHistory() {
  try {
    const r = localStorage.getItem('cam5_mc_history');
    if (r) mcHistory = JSON.parse(r);
  } catch(e) {}
}

/* ── Debounce ricalcolo ──────────────────────────────────── */
function scheduleMcUpdate() {
  if (userRole !== 'admin' && userRole !== 'coord') return;
  clearTimeout(mcDebounceTimer);
  mcDebounceTimer = setTimeout(() => {
    mcComputing = true;
    if (view === 'montecarlo') renMonteCarlo(true);
    updateMcHomeBadge();
    requestAnimationFrame(() => {
      const t0    = performance.now();
      mcResult    = runMonteCarlo();
      mcPushHistory(mcResult);
      mcComputing = false;
      animateMcPct(mcResult);
      if (view === 'montecarlo') renMonteCarlo(false);
      updateMcHomeBadge();
      if (performance.now() - t0 > 250 && mcResult && mcResult.active) {
        mcResult._slow = true;
      }
    });
  }, MC_DEBOUNCE_MS);
}

function animateMcPct(res) {
  if (!res || !res.active) return;
  const targetT = res.pTraina * 100;
  const targetM = res.pMang   * 100;
  cancelAnimationFrame(mcAnimFrame);
  const startT = mcDisplayPct.traina;
  const startM = mcDisplayPct.mang;
  const t0 = performance.now();
  const dur = 600;
  function step(now) {
    const p    = Math.min(1, (now - t0) / dur);
    const ease = 1 - Math.pow(1 - p, 3);
    mcDisplayPct.traina = startT + (targetT - startT) * ease;
    mcDisplayPct.mang   = startM + (targetM - startM) * ease;
    if (view === 'montecarlo') applyMcThermoDOM();
    if (p < 1) mcAnimFrame = requestAnimationFrame(step);
  }
  mcAnimFrame = requestAnimationFrame(step);
}

function applyMcThermoDOM() {
  const barM   = $('mc-bar-mang');
  const barT   = $('mc-bar-train');
  const pctEl  = $('mc-thermo-pct');
  if (barM)  barM.style.width  = mcDisplayPct.mang   + '%';
  if (barT)  barT.style.width  = mcDisplayPct.traina + '%';
  if (pctEl) {
    const lead = mcDisplayPct.traina >= mcDisplayPct.mang ? 'Traina' : 'Mangiapane';
    const p    = Math.max(mcDisplayPct.traina, mcDisplayPct.mang).toFixed(1);
    pctEl.textContent = lead + ' ' + p + '%';
  }
}

/* ── Badge home live ─────────────────────────────────────── */
function mcHomeBadgeHTML() {
  if (userRole !== 'admin' && userRole !== 'coord') return '';
  const t    = totals(allData);
  const conf = getConfidenceLevel(t.vt);
  if (!conf.showProjection) {
    return `<button type="button" class="mc-home-badge inactive" onclick="showMonteCarlo()">
      🔮 ${conf.message}
    </button>`;
  }
  const res  = mcResult;
  const p    = res && res.active ? (res.pTraina * 100).toFixed(0) : '…';
  const arrow = res && res.lead > 0 ? '↑' : res && res.lead < 0 ? '↓' : '→';
  const name  = res && res.pTraina >= 0.5 ? 'Traina' : 'Mangiapane';
  const spin  = mcComputing ? '<span class="mc-spin"></span>' : '';
  return `<button type="button" class="mc-home-badge" onclick="showMonteCarlo()">
    ${spin} 🔮 Prob. ${name}: ${p}% <span class="mc-arr">${arrow}</span>
    <span style="opacity:.6;font-weight:400"> · ${fn(t.vt)} schede</span>
  </button>`;
}

function updateMcHomeBadge() {
  const el = $('mc-home-slot');
  if (el) el.innerHTML = mcHomeBadgeHTML();
}

/* ── Animazione casinò ───────────────────────────────────── */
function mcRunCasinoAnimation() {
  const box = $('mc-casino');
  if (!box) return;
  box.innerHTML = '';
  for (let c = 0; c < 10; c++) {
    const div = document.createElement('div');
    div.className = 'mc-ball';
    div.style.height          = (20 + Math.random() * 70) + 'px';
    div.style.animationDelay  = (c * 0.05) + 's';
    div.style.background      = Math.random() > 0.5 ? '#B84020' : '#1B5299';
    box.appendChild(div);
  }
}

/* ── Vista Monte Carlo ───────────────────────────────────── */
function showMonteCarlo() {
  if (userRole !== 'admin' && userRole !== 'coord') {
    alert('Previsioni riservate ad admin e coordinatore.');
    return;
  }
  view = 'montecarlo';
  if (typeof killCharts === 'function') killCharts();
  document.body.style.background = '#0d1117';
  if (!mcResult) mcResult = runMonteCarlo();
  renMonteCarlo(false);
}

function renMonteCarlo(spinnerOnly) {
  const res       = mcResult || runMonteCarlo();
  const conf      = res.conf || getConfidenceLevel(totals(allData).vt);
  const t         = totals(allData);
  const mangName  = C1.nome.split(' ').slice(-1)[0];
  const trainName = C2.nome.split(' ').slice(-1)[0];

  $('root').className     = 'mc-wrap wide';
  $('root').style.maxWidth = '1100px';

  if (spinnerOnly) {
    const sp = $('mc-spinner-slot');
    if (sp) sp.innerHTML = '<div></div>';
    return;
  }

  const pT = res.active ? res.pTraina * 100 : 0;
  const pM = res.active ? res.pMang   * 100 : 0;
  mcDisplayPct.traina = pT;
  mcDisplayPct.mang   = pM;

  let alertHTML = '';
  if (conf.message) {
    alertHTML = `<div class="mc-alert ${conf.alertClass}">${conf.message}</div>`;
  }
  if (conf.officialBadge && res.active) {
    alertHTML += `<div class="mc-badge-xl official">✓ PREVISIONE AFFIDABILE · Confidenza ${conf.confidence}%</div>`;
  }

  let certaintyHTML = '';
  if (res.active) {
    if (res.pTraina > 0.995 || res.mathWinner === 'traina') {
      certaintyHTML = `<div class="mc-badge-xl win">✓ MATEMATICAMENTE VINTO — ${C2.nome}</div>`;
    } else if (res.pMang > 0.995 || res.mathWinner === 'mang') {
      certaintyHTML = `<div class="mc-badge-xl win">✓ MATEMATICAMENTE VINTO — ${C1.nome}</div>`;
    } else if (res.pTraina >= 0.45 && res.pTraina <= 0.55) {
      certaintyHTML = `<div class="mc-badge-xl tie">⚖️ ANCORA IN BILICO</div>`;
    }
  }

  const ciW    = res.active ? (res.ciHigh - res.ciLow)  : 0;
  const ciLeft = res.active ? res.ciLow                 : 45;
  const ciDot  = res.active ? res.pctTrainaNow           : 50;

  const summary     = res.active ? buildMcSummary(res, t) : conf.message;
  const decisiveTxt = res.active
    ? `Sezione decisiva: <span class="mc-sez-decisiva">Sez. ${res.decisiveSez}</span> — in ${fn(res.decisiveCount)} simulazioni su ${fn(res.decisiveSimTotal)} ha influenzato l'esito`
    : '—';

  $('root').innerHTML = `
    <div class="tb" style="border-color:rgba(255,255,255,.1);background:#0d1117;position:sticky;top:0;z-index:10">
      <div style="display:flex;align-items:center;gap:10px">
        <button class="btn" onclick="mcGoHome()" style="background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.15)">← Torna</button>
        <div>
          <div class="tb-t" style="color:#fff">📊 Previsioni Monte Carlo</div>
          <div class="tb-s" style="color:rgba(255,255,255,.4)">${COMUNE} · ${fn(t.vt)} / ~${fn(res.expectedTotal || Math.round(t.el * MC_AFFLUENZA))} schede previste</div>
        </div>
      </div>
      <span class="badge ${mcComputing ? 'bwip' : 'bok'}">${mcComputing ? 'Calcolo…' : conf.label}</span>
    </div>

    <div id="mc-spinner-slot">${mcComputing
      ? `<div class="mc-spinner"><span class="mc-spin"></span> 🔄 Aggiornamento previsioni… (${(res.sims || MC_SIMS_FULL).toLocaleString('it-IT')} scenari)</div>`
      : ''}</div>

    ${alertHTML}

    <div class="mc-hero">
      <h2>Probabilità vittoria sindaco</h2>
      <div class="mc-thermo">
        <div class="mc-bar-mang" id="mc-bar-mang" style="width:${pM}%">${pM > 12 ? mangName : ''}</div>
        <div class="mc-bar-train" id="mc-bar-train" style="width:${pT}%">${pT > 12 ? trainName : ''}</div>
        <span class="mc-thermo-pct" id="mc-thermo-pct">${res.active
          ? (res.pTraina >= res.pMang ? trainName : mangName) + ' ' + Math.max(pT, pM).toFixed(1) + '%'
          : '—'}</span>
      </div>
      <div class="mc-conf-wrap">
        <div class="mc-conf-lbl">
          <span>Affidabilità modello</span>
          <span>${conf.confidence}%</span>
        </div>
        <div class="mc-conf-bar"><div class="mc-conf-fill" id="mc-conf-fill" style="width:${conf.confidence}%"></div></div>
      </div>
      ${certaintyHTML}
    </div>

    <div class="mc-grid2" style="grid-template-columns:1.5fr 1fr;gap:15px">
      <div class="mc-card">
        <span class="ct">Distribuzione Probabilistica (Bayes)</span>
        ${res.active ? `
        <p style="font-size:13px;color:rgba(255,255,255,.6);margin-bottom:12px">
          Margine di incertezza stimato: <strong style="color:#4ADE80">± ${((res.ciHigh - res.ciLow) / 2).toFixed(1)}%</strong>
        </p>
        <div class="mc-ci-band" style="height:12px;background:rgba(255,255,255,.05);border-radius:4px;margin-bottom:15px;position:relative">
          <div class="mc-ci-range" style="position:absolute;left:${ciLeft}%;width:${ciW}%;background:#4ADE80;opacity:.3;height:100%;border-radius:4px"></div>
          <div class="mc-ci-dot"   style="position:absolute;left:${ciDot}%;background:#fff;width:3px;height:20px;top:-4px;border-radius:2px"></div>
        </div>
        <div style="display:flex;gap:8px">
          <div class="mc-data-chip">
            <span class="mc-data-lbl">Min (2.5%)</span>
            <span class="mc-data-val">${res.ciLow.toFixed(1)}%</span>
          </div>
          <div class="mc-data-chip" style="border-color:rgba(74,222,128,.4)">
            <span class="mc-data-lbl">Mediana</span>
            <span class="mc-data-val" style="color:#4ADE80">${res.ciMid.toFixed(1)}%</span>
          </div>
          <div class="mc-data-chip">
            <span class="mc-data-lbl">Max (97.5%)</span>
            <span class="mc-data-val">${res.ciHigh.toFixed(1)}%</span>
          </div>
        </div>` : '<p style="color:var(--tx3)">Dati insufficienti</p>'}
      </div>

      <div class="mc-card">
        <span class="ct">Parametri di Calcolo</span>
        <div style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05)">
            <span style="color:rgba(255,255,255,.5);font-size:12px">Voti totali stimati</span>
            <span style="color:#fff;font-family:monospace">${fn(res.expectedTotal)}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05)">
            <span style="color:rgba(255,255,255,.5);font-size:12px">Scenari vinti Traina</span>
            <span style="color:var(--c2);font-family:monospace">${fn(res.winsTraina)}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:6px 0">
            <span style="color:rgba(255,255,255,.5);font-size:12px">Affidabilità Modello</span>
            <span style="color:#4ADE80;font-weight:700">${conf.confidence}%</span>
          </div>
        </div>
      </div>
    </div>

    <div class="mc-card" style="margin-bottom:10px">
      <span class="ct">Simulazione in corso</span>
      <div class="mc-casino" id="mc-casino"></div>
      <button class="btn bp" style="width:100%"
        onclick="mcResult=runMonteCarlo();mcPushHistory(mcResult);mcRunCasinoAnimation();animateMcPct(mcResult);renMonteCarlo(false)">
        🎲 Rilancia ${(res.sims || 10000).toLocaleString('it-IT')} scenari
      </button>
    </div>

    <div class="mc-card" style="margin-bottom:10px">
      <span class="ct">Evoluzione probabilità Traina</span>
      <canvas id="mc-chart" height="140"></canvas>
    </div>

    <div class="mc-summary">${summary}</div>
  `;

  mcRunCasinoAnimation();
  initMcChart();
}   /* ← fine renMonteCarlo */

function buildMcSummary(res, t) {
  const trainName = C2.nome.split(' ').slice(-1)[0];
  const mangName  = C1.nome.split(' ').slice(-1)[0];
  const ahead  = res.pctTrainaNow >= 50 ? trainName : mangName;
  const behind = res.pctTrainaNow >= 50 ? mangName  : trainName;
  const margin = Math.abs(res.pctTrainaNow - 50).toFixed(1);
  const prob   = (Math.max(res.pTraina, res.pMang) * 100).toFixed(0);
  return `Con <strong>${fn(res.vt)}</strong> schede scrutinate su ~<strong>${fn(res.expectedTotal)}</strong> previste, ` +
    `<strong>${ahead}</strong> è avanti con il <strong>${Math.max(res.pctTrainaNow, 100 - res.pctTrainaNow).toFixed(1)}%</strong> (+${margin}% su ${behind}). ` +
    `La probabilità di vittoria è <strong>${prob}%</strong>. La sezione decisiva è la <strong>n.${res.decisiveSez}</strong>.`;
}

function initMcChart() {
  const ctx = $('mc-chart');
  if (!ctx || typeof Chart === 'undefined') return;
  if (mcChart) mcChart.destroy();
  const labels = mcHistory.map(h => fn(h.vt));
  const data   = mcHistory.map(h => h.pTraina);
  mcChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Prob. Traina %',
        data,
        borderColor: '#B84020',
        backgroundColor: 'rgba(184,64,32,.15)',
        fill: true,
        tension: 0.35,
        pointRadius: 2
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, font: { size: 10 } } },
        y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }
      },
      animation: { duration: 400 }
    }
  });
}

function mcGoHome() {
  document.body.style.background = '';
  if (typeof goHome === 'function') goHome();
}

/* ── Integrazione automatica ─────────────────────────────── */
function mcInjectHomeUI() {
  if (userRole !== 'admin' && userRole !== 'coord') return;
  const dash = document.querySelector('.btn.bp.bw.blg');
  if (!dash || !dash.parentNode) return;

  if (!$('mc-nav-btn')) {
    const btn = document.createElement('button');
    btn.id        = 'mc-nav-btn';
    btn.type      = 'button';
    btn.className = 'btn bw';
    btn.style.cssText = 'margin-bottom:8px;padding:14px;font-size:15px;font-weight:700;width:100%;'
      + 'background:linear-gradient(135deg,#1a2332 0%,#0d1117 100%);color:#fff;'
      + 'border:1px solid rgba(255,255,255,.12);letter-spacing:.2px';
    btn.textContent = '📊 Previsioni Monte Carlo';
    btn.onclick = () => showMonteCarlo();
    dash.insertAdjacentElement('afterend', btn);
  }

  if (!$('mc-home-slot')) {
    const slot = document.createElement('div');
    slot.id = 'mc-home-slot';
    const nav = $('mc-nav-btn');
    if (nav) nav.insertAdjacentElement('afterend', slot);
    else dash.parentNode.insertBefore(slot, dash.nextSibling);
  }

  updateMcHomeBadge();
}

/* ── BUG FIX #3: sottoscrizione Firestore robusta ───────────
   Il modulo Firebase spara 'fb-ready' prima che questo script
   possa registrare il listener (race condition). Si controlla
   subito se window.fb esiste già; se no, si aspetta l'evento. */
function mcSubscribeFirestore() {
  if (!window.fb) return;
  window.fb.onSnapshot(
    window.fb.collection(window.fb.db, 'sezioni'),
    () => {
      scheduleMcUpdate();
      if (view === 'montecarlo') mcResult = null;
    }
  );
}

function monteCarloInstall() {
  mcLoadHistory();

  /* Wrapping showHome per iniettare il bottone MC */
  const origShowHome = window.showHome;
  if (origShowHome) {
    window.showHome = function () {
      origShowHome();
      mcInjectHomeUI();
      scheduleMcUpdate();
    };
  }

  /* BUG FIX #3: controlla subito; ascolta l'evento solo se Firebase
     non è ancora pronto (non dovrebbe più accadere, ma copriamo entrambi i casi) */
  if (window.fb) {
    mcSubscribeFirestore();
  } else {
    window.addEventListener('fb-ready', mcSubscribeFirestore, { once: true });
  }

  /* Espone le API globali */
  window.showMonteCarlo          = showMonteCarlo;
  window.renMonteCarlo           = renMonteCarlo;
  window.runMonteCarlo           = runMonteCarlo;
  window.calculateTrendsBySezione = calculateTrendsBySezione;
  window.getConfidenceLevel      = getConfidenceLevel;
  window.scheduleMcUpdate        = scheduleMcUpdate;
  window.mcGoHome                = mcGoHome;
  window.mcRunCasinoAnimation    = mcRunCasinoAnimation;

  if (userRole === 'admin' || userRole === 'coord') {
    setTimeout(scheduleMcUpdate, 800);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(monteCarloInstall, 100));
} else {
  setTimeout(monteCarloInstall, 100);
}
