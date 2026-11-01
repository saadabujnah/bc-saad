/* ==========================================================================
   Crash Casino - frontend
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  config: null,
  sb: null,
  session: null,
  socket: null,
  user: null,
  balance: 0,
  phase: 'idle',
  multiplier: 1,
  round: null,
  history: [],
  bets: [],
  myBet: null,
  runningStart: 0,
  waitingEndsAt: 0,
  crashPoint: null,
  frozenElapsed: 0,
  growthRate: 0.12,
  waitingMs: 6000,
  crashedMs: 2500,
  busy: false,
  userBets: [], // رهانات المستخدم
  currentPage: 1, // الصفحة الحالية في سجل الرهانات
  betsPerPage: 10, // عدد الرهانات لكل صفحة
};

/* ------------------------------- formatting ------------------------------- */

function fmt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.00';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function pillClass(crashPoint) {
  if (crashPoint < 2) return 'pill-low';
  if (crashPoint >= 10) return 'pill-high';
  return 'pill-mid';
}

/* --------------------------------- toast ---------------------------------- */

let toastTimer = null;

function toast(message, type = 'success') {
  const el = $('#toast');
  el.innerHTML = `<div class="toast-inner ${
    type === 'error' ? 'toast-error' : 'toast-success'
  }">${escapeHtml(message)}</div>`;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* -------------------------------- live math ------------------------------- */

function currentElapsedMs() {
  if (state.phase === 'running') {
    return Math.max(0, Date.now() - state.runningStart);
  }
  if (state.phase === 'crashed') {
    return state.frozenElapsed || 0;
  }
  return 0;
}

function currentMultiplier() {
  if (state.phase === 'running') {
    return Math.exp(state.growthRate * (currentElapsedMs() / 1000));
  }
  if (state.phase === 'crashed') {
    return state.crashPoint ?? state.multiplier;
  }
  return 1;
}

/* --------------------------------- canvas --------------------------------- */

const canvas = $('#crashCanvas');
const ctx = canvas.getContext('2d');
let W = 0;
let H = 0;

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  W = Math.max(1, rect.width);
  H = Math.max(1, rect.height);
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawScene() {
  if (!W || !H) return;

  ctx.clearRect(0, 0, W, H);

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0d1117');
  bg.addColorStop(1, '#06080d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const pad = { l: 54, r: 22, t: 26, b: 34 };
  const plotW = Math.max(10, W - pad.l - pad.r);
  const plotH = Math.max(10, H - pad.t - pad.b);

  const elapsedSec = currentElapsedMs() / 1000;
  const mult = currentMultiplier();
  const maxTime = Math.max(10, elapsedSec * 1.25);
  const maxMult = Math.max(2, mult * 1.25);
  const crashed = state.phase === 'crashed';

  ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';

  // Horizontal grid + multiplier labels
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.t + plotH * (i / 4);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();

    const value = maxMult - (maxMult - 1) * (i / 4);
    ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.textAlign = 'right';
    ctx.fillText(`${value.toFixed(2)}x`, pad.l - 8, y);
  }

  // Vertical grid + time labels
  for (let i = 0; i <= 5; i += 1) {
    const x = pad.l + plotW * (i / 5);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.06)';
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.stroke();

    ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.textAlign = 'center';
    ctx.fillText(`${(maxTime * (i / 5)).toFixed(0)}s`, x, pad.t + plotH + 16);
  }

  if (elapsedSec <= 0.001) {
    // Waiting: subtle baseline pulse
    const pulse = 0.35 + 0.25 * Math.sin(Date.now() / 350);
    ctx.strokeStyle = `rgba(168, 85, 247, ${pulse})`;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t + plotH);
    ctx.lineTo(pad.l + plotW, pad.t + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  const samples = 96;
  const points = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = elapsedSec * (i / samples);
    const m = Math.exp(state.growthRate * t);
    const x = pad.l + plotW * (t / maxTime);
    const y = pad.t + plotH * (1 - (m - 1) / (maxMult - 1));
    points.push([x, y]);
  }

  // Area under the curve
  const fill = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
  if (crashed) {
    fill.addColorStop(0, 'rgba(251, 113, 133, 0.30)');
    fill.addColorStop(1, 'rgba(251, 113, 133, 0)');
  } else {
    fill.addColorStop(0, 'rgba(34, 197, 94, 0.28)');
    fill.addColorStop(1, 'rgba(34, 197, 94, 0)');
  }

  ctx.beginPath();
  ctx.moveTo(points[0][0], pad.t + plotH);
  for (const [x, y] of points) ctx.lineTo(x, y);
  ctx.lineTo(points[points.length - 1][0], pad.t + plotH);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  // Curve line
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points) ctx.lineTo(x, y);
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = crashed ? '#fb7185' : '#4ade80';
  ctx.shadowColor = crashed ? 'rgba(251, 113, 133, 0.8)' : 'rgba(74, 222, 128, 0.8)';
  ctx.shadowBlur = 16;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Tip dot / explosion
  const [tx, ty] = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(tx, ty, crashed ? 7 : 5, 0, Math.PI * 2);
  ctx.fillStyle = crashed ? '#fecdd3' : '#dcfce7';
  ctx.shadowColor = crashed ? 'rgba(251, 113, 133, 0.95)' : 'rgba(74, 222, 128, 0.95)';
  ctx.shadowBlur = 22;
  ctx.fill();
  ctx.shadowBlur = 0;

  if (crashed) {
    ctx.beginPath();
    ctx.arc(tx, ty, 14, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(251, 113, 133, 0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/* ------------------------------- rendering -------------------------------- */

const last = {
  stage: '',
  action: '',
  potential: '',
};

function setTextIfChanged(el, text, key) {
  if (last[key] === text) return;
  last[key] = text;
  el.textContent = text;
}

function updateStageLive() {
  const label = $('#stageLabel');
  const value = $('#stageValue');
  const sub = $('#stageSub');
  const stage = $('#gameStage');

  stage.classList.remove('stage-running', 'stage-crashed');

  if (state.phase === 'waiting') {
    const remain = Math.max(0, (state.waitingEndsAt - Date.now()) / 1000);
    setTextIfChanged(label, 'Next round in', 'stage');
    value.textContent = remain.toFixed(1);
    sub.textContent = 'Place your bets';
  } else if (state.phase === 'running') {
    stage.classList.add('stage-running');
    setTextIfChanged(label, 'Current multiplier', 'stage');
    value.textContent = `${currentMultiplier().toFixed(2)}x`;
    sub.textContent = 'Cash out before it crashes';
  } else if (state.phase === 'crashed') {
    stage.classList.add('stage-crashed');
    setTextIfChanged(label, 'Crashed', 'stage');
    value.textContent = `${(state.crashPoint ?? state.multiplier).toFixed(2)}x`;
    sub.textContent = 'Next round starting soon';
  } else {
    setTextIfChanged(label, 'Connecting', 'stage');
    value.textContent = '…';
    sub.textContent = 'Waiting for the server';
  }
}

function updateActionButton() {
  const btn = $('#actionBtn');
  const canCashout = Boolean(state.myBet) && state.phase === 'running';
  const signature = [
    state.phase,
    state.myBet?.id || '',
    canCashout ? currentMultiplier().toFixed(2) : '',
    state.busy ? 'busy' : '',
  ].join('|');

  if (signature === last.action) return;
  last.action = signature;

  const base =
    'mt-4 w-full rounded-xl py-3.5 text-base font-black uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-40';
  btn.disabled = false;

  if (state.busy) {
    btn.className = `${base} bg-slate-700 text-slate-300`;
    btn.textContent = 'Processing…';
    btn.disabled = true;
    return;
  }

  if (canCashout) {
    btn.className = `${base} bg-neon text-black shadow-lg shadow-neon/25 hover:brightness-110`;
    btn.textContent = `Cash Out @ ${currentMultiplier().toFixed(2)}x`;
    return;
  }

  if (state.myBet && state.phase === 'waiting') {
    btn.className = `${base} bg-slate-700 text-slate-300`;
    btn.textContent = 'Bet Placed';
    btn.disabled = true;
    return;
  }

  if (state.myBet && state.phase === 'crashed') {
    btn.className = `${base} bg-rose-500/15 text-rose-300`;
    btn.textContent = 'Busted';
    btn.disabled = true;
    return;
  }

  if (!state.myBet && state.phase === 'waiting') {
    btn.className = `${base} bg-grape text-white shadow-lg shadow-grape/25 hover:brightness-110`;
    btn.textContent = 'Place Bet';
    return;
  }

  if (state.phase === 'running') {
    btn.className = `${base} bg-slate-700 text-slate-300`;
    btn.textContent = 'Waiting for next round';
    btn.disabled = true;
    return;
  }

  btn.className = `${base} bg-slate-700 text-slate-300`;
  btn.textContent = state.phase === 'crashed' ? 'Next round…' : 'Connecting…';
  btn.disabled = true;
}

function updatePotential() {
  const amount = Number($('#betAmount').value) || 0;
  let value = amount;

  if (state.myBet && state.phase === 'running') {
    value = state.myBet.amount * currentMultiplier();
  } else if (state.myBet && state.phase === 'crashed') {
    value = state.myBet.amount;
  }

  const text = `$${fmt(value)}`;
  if (last.potential === text) return;
  last.potential = text;
  $('#potential').textContent = text;
}

function renderBalance() {
  $('#balance').textContent = `$${fmt(state.balance)}`;
}

function renderHistory() {
  const strip = $('#historyStrip');
  strip.innerHTML = '';

  if (!state.history.length) {
    const span = document.createElement('span');
    span.className = 'px-2 text-xs text-slate-600';
    span.textContent = 'No rounds yet';
    strip.appendChild(span);
    return;
  }

  for (const item of state.history) {
    const btn = document.createElement('button');
    btn.className = `history-pill ${pillClass(item.crashPoint)}`;
    btn.textContent = `${Number(item.crashPoint).toFixed(2)}x`;
    btn.title = `Round #${item.roundNumber} — click to verify`;
    btn.addEventListener('click', () => openFairModal(item));
    strip.appendChild(btn);
  }
}

function renderBets() {
  const body = $('#betsBody');
  const empty = $('#betsEmpty');
  body.innerHTML = '';

  const count = state.bets.length;
  $('#betsCount').textContent = `${count} bet${count === 1 ? '' : 's'}`;
  empty.classList.toggle('hidden', count > 0);

  for (const bet of state.bets) {
    const isMe = state.user && bet.userId === state.user.id;
    const row = document.createElement('tr');
    row.className = `border-b border-edge/40 ${isMe ? 'bg-grape/5' : ''}`;

    const name = isMe ? 'You' : bet.username;

    let multiplierText = '—';
    let multiplierClass = 'text-amber-300';
    let payoutText = '—';

    if (bet.status === 'won') {
      multiplierText = `${Number(bet.cashoutMultiplier).toFixed(2)}x`;
      multiplierClass = 'text-neon';
      payoutText = `$${fmt(bet.payout)}`;
    } else if (bet.status === 'lost') {
      multiplierText = 'Busted';
      multiplierClass = 'text-rose-400';
      payoutText = '$0.00';
    }

    row.innerHTML = `
      <td class="px-4 py-2 font-semibold ${isMe ? 'text-grape' : 'text-slate-300'}">${escapeHtml(name)}</td>
      <td class="px-4 py-2 font-mono text-slate-400">$${fmt(bet.amount)}</td>
      <td class="px-4 py-2 font-mono ${multiplierClass}">${multiplierText}</td>
      <td class="px-4 py-2 text-right font-mono ${bet.status === 'won' ? 'text-neon' : 'text-slate-500'}">${payoutText}</td>
    `;
    body.appendChild(row);
  }
}

function renderFairInfo() {
  const round = state.round;
  $('#fairRound').textContent = round ? `#${round.roundNumber}` : '—';
  $('#fairHash').textContent = round?.serverSeedHash || '—';
  $('#fairClient').textContent = round?.clientSeed || '—';
  $('#fairNonce').textContent = round ? String(round.nonce) : '—';

  $('#roundLabel').textContent = round ? `Round #${round.roundNumber}` : 'Round #—';
  $('#seedHash').textContent = round?.serverSeedHash
    ? `${round.serverSeedHash.slice(0, 18)}…`
    : '—';

  const dot = $('#phaseDot');
  dot.className = 'h-2 w-2 rounded-full';
  if (state.phase === 'running') {
    dot.classList.add('bg-neon', 'pulse');
  } else if (state.phase === 'crashed') {
    dot.classList.add('bg-rose-400');
  } else if (state.phase === 'waiting') {
    dot.classList.add('bg-amber-400', 'pulse');
  } else {
    dot.classList.add('bg-slate-500');
  }

  updateFairModalCurrent();
}

function renderAll() {
  renderBalance();
  renderHistory();
  renderBets();
  renderFairInfo();
  renderUserBets(); // عرض سجل رهانات المستخدم
  last.action = '';
  last.potential = '';
  updateActionButton();
  updatePotential();
  updateStageLive();
}

/* ------------------------------ fair modal -------------------------------- */

function updateFairModalCurrent() {
  const round = state.round;
  $('#mFairRound').textContent = round ? `#${round.roundNumber}` : '—';
  $('#mFairNonce').textContent = round ? String(round.nonce) : '—';
  $('#mFairHash').textContent = round?.serverSeedHash || '—';
  $('#mFairClient').textContent = round?.clientSeed || '—';
}

function populateFairSelect() {
  const select = $('#fairRoundSelect');
  const current = select.value;
  select.innerHTML = '<option value="">— Select a crashed round —</option>';

  for (const item of state.history) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `#${item.roundNumber} — ${Number(item.crashPoint).toFixed(2)}x`;
    select.appendChild(option);
  }

  if (current) select.value = current;
}

function fillFairForm(item) {
  $('#fairServerSeed').value = item?.serverSeed || '';
  $('#fairClientSeed').value = item?.clientSeed || '';
  $('#fairNonceInput').value = item?.nonce != null ? String(item.nonce) : '';
  $('#fairExpectedHash').value = item?.serverSeedHash || '';
}

function openFairModal(item) {
  $('#fairModal').classList.remove('hidden');
  populateFairSelect();
  updateFairModalCurrent();

  if (item) {
    $('#fairRoundSelect').value = item.id;
    fillFairForm(item);
    verifyFair();
  }
}

function verifyFair() {
  const result = $('#fairResult');
  const serverSeed = $('#fairServerSeed').value.trim();
  const clientSeed = $('#fairClientSeed').value.trim();
  const nonce = $('#fairNonceInput').value.trim();
  const expected = $('#fairExpectedHash').value.trim();

  if (!serverSeed || !clientSeed || nonce === '') {
    result.className =
      'mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-300';
    result.textContent = 'Server seed, client seed and nonce are required.';
    return;
  }

  const hmac = CryptoJS.HmacSHA256(`${clientSeed}:${nonce}`, serverSeed).toString();
  const seed = hmac.slice(0, 13);
  const r = parseInt(seed, 16);
  let x = r / Math.pow(2, 52);
  x = 99 / (1 - x);
  const crashPoint = Math.max(1, Math.floor(x) / 100);

  const computedHash = CryptoJS.SHA256(serverSeed).toString();
  const hashOk = !expected || computedHash === expected;

  result.className =
    'mt-4 rounded-xl border border-edge bg-ink/60 p-3 text-xs text-slate-300';
  result.innerHTML = `
    <div class="grid gap-2">
      <div class="flex items-center justify-between">
        <span class="text-slate-500">Computed crash point</span>
        <span class="font-mono text-lg font-black ${hashOk ? 'text-neon' : 'text-amber-300'}">${crashPoint.toFixed(2)}x</span>
      </div>
      <div class="flex items-start justify-between gap-3">
        <span class="text-slate-500">HMAC-SHA256</span>
        <span class="break-all text-right font-mono text-[10px] text-slate-400">${hmac}</span>
      </div>
      <div class="flex items-start justify-between gap-3">
        <span class="text-slate-500">SHA256(server seed)</span>
        <span class="break-all text-right font-mono text-[10px] text-slate-400">${computedHash}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-slate-500">Hash match</span>
        <span class="font-semibold ${hashOk ? 'text-neon' : 'text-rose-400'}">${
          hashOk ? 'VALID ✓' : 'MISMATCH ✕'
        }</span>
      </div>
    </div>
  `;
}

/* -------------------------------- socket ---------------------------------- */

function recomputeMyBet() {
  state.myBet =
    state.bets.find(
      (bet) =>
        bet.status === 'active' && state.user && bet.userId === state.user.id
    ) || null;
}

function connect(token) {
  if (state.socket) {
    state.socket.removeAllListeners();
    state.socket.disconnect();
  }

  const socket = io({ auth: token ? { token } : {} });
  state.socket = socket;

  socket.on('connect_error', (error) => {
    console.error('[socket]', error.message);
    toast(
      error.message === 'UNAUTHORIZED'
        ? 'Session expired. Please sign in again.'
        : 'Connection error. Retrying…',
      'error'
    );
  });

  socket.on('me', (me) => {
    state.user = me;
    $('#username').textContent = me.username || 'player';
    const chip = $('#userChip');
    chip.classList.remove('hidden');
    chip.classList.add('flex');
    recomputeMyBet();
    renderBets();
    updateActionButton();
  });

  socket.on('balance', ({ balance }) => {
    state.balance = Number(balance);
    renderBalance();
  });

  socket.on('state', applyState);

  socket.on('round:waiting', (payload) => {
    state.phase = 'waiting';
    state.multiplier = 1;
    state.round = payload;
    state.myBet = null;
    state.crashPoint = null;
    state.frozenElapsed = 0;
    state.runningStart = 0;
    state.waitingEndsAt = payload.startsAt || Date.now() + state.waitingMs;
    renderAll();
  });

  socket.on('round:running', (payload) => {
    state.phase = 'running';
    state.multiplier = 1;
    state.runningStart = payload.startedAt || Date.now();
    state.crashPoint = null;
    state.frozenElapsed = 0;
    renderAll();
  });

  socket.on('tick', (payload) => {
    if (state.phase !== 'running') return;
    state.multiplier = payload.multiplier;
    // Calibrate the local clock against the authoritative server clock.
    state.runningStart = Date.now() - payload.elapsed;
  });

  socket.on('round:crashed', (payload) => {
    state.phase = 'crashed';
    state.multiplier = payload.crashPoint;
    state.crashPoint = payload.crashPoint;
    state.frozenElapsed =
      (Math.log(Math.max(1, payload.crashPoint)) / state.growthRate) * 1000;
    state.round = { ...(state.round || {}), ...payload };
    state.myBet = null;

    if (state.history[0]?.id !== payload.id) {
      state.history = [payload, ...state.history].slice(0, 20);
    }

    renderAll();
  });

  socket.on('history', (history) => {
    state.history = history || [];
    renderHistory();
    populateFairSelect();
  });

  socket.on('bets:list', (bets) => {
    state.bets = bets || [];
    recomputeMyBet();
    renderBets();
    updateActionButton();
    updatePotential();
  });

  socket.on('bet:placed', (bet) => {
    const index = state.bets.findIndex((b) => b.id === bet.id);
    if (index >= 0) state.bets[index] = bet;
    else state.bets.push(bet);
    recomputeMyBet();
    renderBets();
    updateActionButton();
    
    // إضافة الرهان إلى سجل رهانات المستخدم
    if (state.user && bet.userId === state.user.id) {
      state.userBets.unshift(bet);
      renderUserBets();
    }
  });

  socket.on('bet:cashout', (bet) => {
    const index = state.bets.findIndex((b) => b.id === bet.id);
    if (index >= 0) state.bets[index] = bet;
    recomputeMyBet();
    renderBets();
    updateActionButton();
    updatePotential();
    
    // تحديث الرهان في سجل رهانات المستخدم
    if (state.user && bet.userId === state.user.id) {
      const userBetIndex = state.userBets.findIndex((b) => b.id === bet.id);
      if (userBetIndex >= 0) {
        state.userBets[userBetIndex] = bet;
        renderUserBets();
      }
    }
  });

  socket.on('fatal', ({ error }) => toast(error || 'Fatal error', 'error'));
}

function applyState(snapshot) {
  state.phase = snapshot.phase;
  state.multiplier = snapshot.multiplier;
  state.round = snapshot.round;
  state.history = snapshot.history || [];
  state.bets = snapshot.bets || [];
  state.growthRate = snapshot.growthRate ?? state.growthRate;
  state.waitingMs = snapshot.waitingMs ?? state.waitingMs;
  state.crashedMs = snapshot.crashedMs ?? state.crashedMs;

  if (snapshot.phase === 'waiting') {
    state.waitingEndsAt = snapshot.startsAt || Date.now() + state.waitingMs;
    state.runningStart = 0;
    state.crashPoint = null;
    state.frozenElapsed = 0;
  } else if (snapshot.phase === 'running') {
    state.runningStart = snapshot.startedAt || Date.now();
    state.crashPoint = null;
    state.frozenElapsed = 0;
  } else if (snapshot.phase === 'crashed') {
    state.crashPoint = snapshot.round?.crashPoint ?? snapshot.multiplier;
    state.frozenElapsed =
      (Math.log(Math.max(1, state.crashPoint)) / state.growthRate) * 1000;
  }

  recomputeMyBet();
  renderAll();
  populateFairSelect();
}

/* --------------------------------- actions -------------------------------- */

function emitAck(event, payload) {
  return new Promise((resolve) => {
    if (!state.socket || !state.socket.connected) {
      resolve({ ok: false, error: 'Not connected to the server.' });
      return;
    }
    state.socket.emit(event, payload ?? {}, (response) => {
      resolve(response || { ok: false, error: 'No response from server.' });
    });
  });
}

async function onActionClick() {
  if (state.busy) return;

  if (state.myBet && state.phase === 'running') {
    state.busy = true;
    updateActionButton();
    const response = await emitAck('cashout');
    state.busy = false;

    if (!response.ok) {
      toast(response.error || 'Cashout failed.', 'error');
    } else {
      toast(
        `Cashed out at ${Number(response.bet.cashoutMultiplier).toFixed(2)}x for $${fmt(
          response.bet.payout
        )}`,
        'success'
      );
    }
    updateActionButton();
    updatePotential();
    return;
  }

  if (!state.myBet && state.phase === 'waiting') {
    const amount = Number($('#betAmount').value);

    if (!Number.isFinite(amount) || amount <= 0) {
      toast('Enter a valid bet amount.', 'error');
      return;
    }
    if (amount > state.balance) {
      toast('Insufficient balance.', 'error');
      return;
    }

    state.busy = true;
    updateActionButton();
    const response = await emitAck('bet', { amount });
    state.busy = false;

    if (!response.ok) {
      toast(response.error || 'Bet failed.', 'error');
    } else {
      toast(`Bet placed: $${fmt(response.bet.amount)}`, 'success');
    }
    updateActionButton();
    updatePotential();
  }
}

/* --------------------------------- auth ----------------------------------- */

function showAuthError(message) {
  const el = $('#authError');
  el.textContent = message;
  el.classList.remove('hidden');
}

function clearAuthError() {
  const el = $('#authError');
  el.textContent = '';
  el.classList.add('hidden');
}

let authMode = 'signup';

function setAuthMode(mode) {
  authMode = mode === 'signin' ? 'signin' : 'signup';
  const isSignup = authMode === 'signup';

  $('#tabSignIn').classList.toggle('active', !isSignup);
  $('#tabSignUp').classList.toggle('active', isSignup);
  $('#usernameField').classList.toggle('hidden', !isSignup);
  $('#authSubmit').textContent = isSignup ? 'Create Account' : 'Sign In';
  $('#authTitle').textContent = isSignup ? 'Create your account' : 'Welcome back';
  $('#authSubtitle').textContent = isSignup
    ? 'Your balance is stored in Supabase and starts at $1,000.'
    : 'Sign in to continue playing Crash.';
  $('#authPassword').setAttribute(
    'autocomplete',
    isSignup ? 'new-password' : 'current-password'
  );
}

function handleAuthSubmit() {
  return authMode === 'signup' ? signUp() : signIn();
}

async function signIn() {
  clearAuthError();
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;

  if (!email || !password) return showAuthError('Enter your email and password.');

  const { data, error } = await state.sb.auth.signInWithPassword({ email, password });
  if (error) return showAuthError(error.message);

  state.session = data.session;
  $('#authModal').classList.add('hidden');
  connect(data.session.access_token);
}

async function signUp() {
  clearAuthError();
  const username = $('#authUsername').value.trim();
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return showAuthError(
      'Username must be 3-20 characters (letters, numbers or underscore).'
    );
  }
  if (!email) return showAuthError('Enter your email address.');
  if (password.length < 6) {
    return showAuthError('Password must be at least 6 characters.');
  }

  const { data, error } = await state.sb.auth.signUp({
    email,
    password,
    options: { data: { username } },
  });
  if (error) return showAuthError(error.message);

  if (!data.session) {
    setAuthMode('signin');
    showAuthError('Account created. Check your email to confirm it, then sign in.');
    return;
  }

  state.session = data.session;
  $('#authModal').classList.add('hidden');
  connect(data.session.access_token);
}

async function signInGuest() {
  clearAuthError();
  const { data, error } = await state.sb.auth.signInAnonymously();
  if (error) {
    return showAuthError(
      `${error.message} — enable "Anonymous sign-ins" in Supabase Auth settings.`
    );
  }

  state.session = data.session;
  $('#authModal').classList.add('hidden');
  connect(data.session.access_token);
}

async function logout() {
  try {
    await state.sb?.auth.signOut();
  } catch {
    /* ignore */
  }
  state.socket?.disconnect();
  state.socket = null;
  state.user = null;
  state.session = null;
  $('#userChip').classList.add('hidden');
  $('#logoutBtn').classList.add('hidden');
  setAuthMode('signin');
  $('#authModal').classList.remove('hidden');
}

/* ---------------------------------- UI ------------------------------------ */

function bindUI() {
  $('#actionBtn').addEventListener('click', onActionClick);

  $('#betAmount').addEventListener('input', () => {
    last.potential = '';
    updatePotential();
  });

  // ربط أزرار التنقل بين صفحات سجل الرهانات
  $('#prevPage').addEventListener('click', goToPrevPage);
  $('#nextPage').addEventListener('click', goToNextPage);

  $$('[data-quick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const quick = btn.dataset.quick;
      let value = Number($('#betAmount').value) || 0;

      if (quick === 'half') value = Math.max(0.1, Math.round((value / 2) * 100) / 100);
      else if (quick === 'double') value = Math.round(value * 2 * 100) / 100;
      else if (quick === 'max') value = Math.round(state.balance * 100) / 100;
      else value = Number(quick);

      $('#betAmount').value = String(value);
      last.potential = '';
      updatePotential();
    });
  });

  $('#fairBtn').addEventListener('click', () => openFairModal());
  $('#fairBtn2').addEventListener('click', () => openFairModal());

  $$('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#' + btn.dataset.close).classList.add('hidden');
    });
  });

  $('#fairModal').addEventListener('click', (event) => {
    if (event.target.id === 'fairModal') $('#fairModal').classList.add('hidden');
  });

  $('#fairRoundSelect').addEventListener('change', (event) => {
    const item = state.history.find((r) => r.id === event.target.value);
    if (item) {
      fillFairForm(item);
      verifyFair();
    }
  });

  $('#fairVerifyBtn').addEventListener('click', verifyFair);

  $('#tabSignIn').addEventListener('click', () => setAuthMode('signin'));
  $('#tabSignUp').addEventListener('click', () => setAuthMode('signup'));
  $('#authSubmit').addEventListener('click', handleAuthSubmit);
  $('#authGuest').addEventListener('click', signInGuest);
  $('#logoutBtn').addEventListener('click', logout);

  ['authUsername', 'authEmail', 'authPassword'].forEach((id) => {
    $('#' + id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleAuthSubmit();
      }
    });
  });

  window.addEventListener('resize', resizeCanvas);
}

/* ---------------------------------- boot ---------------------------------- */

function loop() {
  drawScene();
  updateStageLive();
  updateActionButton();
  updatePotential();
  requestAnimationFrame(loop);
}

async function boot() {
  bindUI();
  resizeCanvas();
  requestAnimationFrame(loop);

  try {
    state.config = await fetch('/api/config').then((response) => response.json());
  } catch {
    toast('Cannot reach the server.', 'error');
    return;
  }

  state.growthRate = state.config.growthRate ?? 0.12;
  state.waitingMs = state.config.waitingMs ?? 6000;
  state.crashedMs = state.config.crashedMs ?? 2500;

  if (state.config.mode === 'supabase') {
    if (!window.supabase) {
      toast('Supabase client failed to load.', 'error');
      return;
    }

    state.sb = window.supabase.createClient(
      state.config.supabaseUrl,
      state.config.supabaseAnonKey
    );

    const wantsRegister =
      window.location.pathname.replace(/\/+$/, '') === '/register' ||
      new URLSearchParams(window.location.search).get('auth') === 'register';

    const { data } = await state.sb.auth.getSession();

    if (data?.session) {
      state.session = data.session;
      $('#logoutBtn').classList.remove('hidden');
      connect(data.session.access_token);

      if (wantsRegister) {
        setAuthMode('signup');
        $('#authModal').classList.remove('hidden');
      } else {
        $('#authModal').classList.add('hidden');
      }
    } else {
      setAuthMode('signup');
      $('#authModal').classList.remove('hidden');
    }
  } else {
    $('#authModal').classList.add('hidden');
    $('#logoutBtn').classList.add('hidden');
    connect(null);
  }
}

boot();
