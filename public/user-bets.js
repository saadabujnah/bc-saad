// دالة لعرض سجل رهانات المستخدم
function renderUserBets() {
  const body = $('#userBetsBody');
  const empty = $('#userBetsEmpty');
  const countEl = $('#historyCount');
  body.innerHTML = '';

  // حساب إجمالي عدد الصفحات
  const totalPages = Math.ceil(state.userBets.length / state.betsPerPage);

  // التأكد من أن الصفحة الحالية ضمن النطاق
  if (state.currentPage > totalPages) state.currentPage = totalPages;
  if (state.currentPage < 1) state.currentPage = 1;

  // تحديث معلومات الصفحة
  $('#pageInfo').textContent = `Page ${state.currentPage} of ${totalPages || 1}`;
  $('#prevPage').disabled = state.currentPage <= 1;
  $('#nextPage').disabled = state.currentPage >= totalPages;

  const count = state.userBets.length;
  countEl.textContent = `${count} bet${count === 1 ? '' : 's'}`;
  empty.classList.toggle('hidden', count > 0);

  // حساب الرهانات للعرض في الصفحة الحالية
  const startIndex = (state.currentPage - 1) * state.betsPerPage;
  const endIndex = startIndex + state.betsPerPage;
  const betsToShow = state.userBets.slice(startIndex, endIndex);

  for (const bet of betsToShow) {
    const row = document.createElement('tr');
    row.className = 'border-b border-edge/40';

    let multiplierText = '-';
    let multiplierClass = 'text-amber-300';
    let payoutText = '-';

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
      <td class="px-4 py-2 font-semibold text-slate-300">#${bet.roundNumber || '-'}</td>
      <td class="px-4 py-2 font-mono text-slate-400">$${fmt(bet.amount)}</td>
      <td class="px-4 py-2 font-mono ${multiplierClass}">${multiplierText}</td>
      <td class="px-4 py-2 text-right font-mono ${bet.status === 'won' ? 'text-neon' : 'text-slate-500'}">${payoutText}</td>
    `;
    body.appendChild(row);
  }
}

// دالة لتحديث رهانات المستخدم
function updateUserBets(bets) {
  state.userBets = bets || [];
  state.currentPage = 1; // العودة إلى الصفحة الأولى عند تحديث البيانات
  renderUserBets();
}

// دالة للانتقال إلى الصفحة السابقة
function goToPrevPage() {
  if (state.currentPage > 1) {
    state.currentPage--;
    renderUserBets();
  }
}

// دالة للانتقال إلى الصفحة التالية
function goToNextPage() {
  const totalPages = Math.ceil(state.userBets.length / state.betsPerPage);
  if (state.currentPage < totalPages) {
    state.currentPage++;
    renderUserBets();
  }
}
