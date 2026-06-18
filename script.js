/* =========================================
   SOLPAY - Core Logic
   Vanilla JS, Zero Frameworks
========================================= */

// --- INITIAL STATE ---
const DEFAULT_STATE = {
    balances: {
        main: { cash: 0, dana: 0 },
        fashion: { cash: 0, dana: 0 },
        skincare: { cash: 0, dana: 0 },
        business: { cash: 0, dana: 0 }
    },

    debt: {
    f_to_s: 0,
    s_to_f: 0,
    business_to_fashion: 0,
    business_to_skincare: 0,
    skincare_to_fashion: 0,
    fashion_to_skincare: 0
},

businessDebt: {
    fashion: 0,
    skincare: 0
},

goals: [],
    receivables: [],
    businessLoans: [],
    history: [],
    streak: { count: 0, lastDate: null },
    recapDoneWeekId: null,
    weeklyHistory: [],
    statsWeekId: null
};

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
let activeDayIndex = getTodayIndex(); 
let tempUndoTransaction = null;
let currentTrxType = 'expense';
let currentAdjType = 'add';
let isDebtMode = false;

// --- UTILS ---
function formatIDR(amount) {
    const sign = amount < 0 ? '-' : '';
    return sign + 'Rp' + Math.abs(amount).toLocaleString('id-ID');
}
function formatSignedIDR(amount) {
    if (amount === 0) return 'Rp0';
    return (amount > 0 ? '+' : '-') + 'Rp' + Math.abs(amount).toLocaleString('id-ID');
}
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}
function getTodayIndex() {
    let day = new Date().getDay();
    return day === 0 ? 6 : day - 1;
}

function getWeekId() {
    let d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    let week1 = new Date(d.getFullYear(), 0, 4);
    return d.getFullYear() + '-W' + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

function getMonday(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

function formatDateShort(d) {
    const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
    return `${d.getDate()} ${months[d.getMonth()]}`;
}

function checkWeeklyReset() {
    const currentWeekId = getWeekId();

    if (!state.statsWeekId) {
        state.statsWeekId = currentWeekId;
        return;
    }

    if (state.statsWeekId === currentWeekId) return;

    // Minggu berganti → archive data minggu lalu
    const todayMonday = getMonday(new Date());
    const lastWeekMonday = new Date(todayMonday);
    lastWeekMonday.setDate(lastWeekMonday.getDate() - 7);
    const lastWeekSunday = new Date(todayMonday);
    lastWeekSunday.setDate(lastWeekSunday.getDate() - 1);

    let weekIncome = 0, weekExpense = 0, weekProfit = 0;
    state.history.forEach(h => {
        if (h.cat === 'main') {
            if (h.isBusinessProfit) weekProfit += h.amount;
            else if (h.type === 'income') weekIncome += h.amount;
            else if (h.type === 'expense') weekExpense += h.amount;
        }
    });

    state.weeklyHistory.unshift({
        id: generateId(),
        label: `${formatDateShort(lastWeekMonday)} - ${formatDateShort(lastWeekSunday)} ${lastWeekSunday.getFullYear()}`,
        income: weekIncome,
        expense: weekExpense,
        profit: weekProfit
    });

    if (state.weeklyHistory.length > 12) state.weeklyHistory = state.weeklyHistory.slice(0, 12);

    state.history = [];
    state.statsWeekId = currentWeekId;
}

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

// --- BUSINESS AUTO BORROW ---
function ensureBusinessCapital(requiredAmount) {
    let current = state.balances.business.dana;

    if (current >= requiredAmount) return true;

    let shortage = requiredAmount - current;

    // Pinjam dari Fashion dulu
    const fashionAvail = state.balances.fashion.dana;

    if (fashionAvail > 0) {
        const borrow = Math.min(shortage, fashionAvail);

        state.balances.fashion.dana -= borrow;
        state.balances.business.dana += borrow;
        state.businessDebt.fashion += borrow;

        shortage -= borrow;
    }

    // Kalau masih kurang → pinjam skincare
    if (shortage > 0) {
        const skinAvail = state.balances.skincare.dana;

        if (skinAvail > 0) {
            const borrow = Math.min(shortage, skinAvail);

            state.balances.skincare.dana -= borrow;
            state.balances.business.dana += borrow;
            state.businessDebt.skincare += borrow;

            shortage -= borrow;
        }
    }

    // Kalau tetap kurang modal
    if (shortage > 0) {
        showSnackbar("Modal semua pos tidak cukup 😭");
        return false;
    }

    showSnackbar("Business auto pinjam modal ✨");
    return true;
}


// --- SPEND FROM POS (dengan auto-borrow jika kurang) ---
function spendFromPos(cat, wallet, amount) {
    const current = state.balances[cat][wallet];

    if (amount <= current) {
        state.balances[cat][wallet] -= amount;
        return true;
    }

    let shortage = amount - current;
    const other = cat === 'fashion' ? 'skincare' : 'fashion';
    const otherAvail = state.balances[other][wallet];

    if (shortage <= otherAvail) {
        state.balances[other][wallet] -= shortage;
        state.balances[cat][wallet] += shortage;

        const debtKey = `${cat}_to_${other}`;
        if (state.debt[debtKey] !== undefined) {
            state.debt[debtKey] += shortage;
        }

        state.balances[cat][wallet] -= amount;
        showSnackbar(`⚠️ ${cat} pinjam ${formatIDR(shortage)} dari ${other}`);
        return true;
    }

    showSnackbar(`❌ Saldo ${cat} tidak cukup`);
    return false;
}

// --- AUTO REPAY BUSINESS DEBT ---
function repayBusinessDebt() {
    const targetModal = 150000;

    let excess = state.balances.business.dana - targetModal;

    if (excess <= 0) return;

    // Balikin ke Fashion dulu
    if (state.businessDebt.fashion > 0) {
        const repay = Math.min(excess, state.businessDebt.fashion);

        state.balances.business.dana -= repay;
        state.balances.fashion.dana += repay;

        state.businessDebt.fashion -= repay;
        excess -= repay;
    }

    // Balikin ke Skincare
    if (excess > 0 && state.businessDebt.skincare > 0) {
        const repay = Math.min(excess, state.businessDebt.skincare);

        state.balances.business.dana -= repay;
        state.balances.skincare.dana += repay;

        state.businessDebt.skincare -= repay;
    }
}

// --- STORAGE & INIT ---
function loadData() {
    const saved = localStorage.getItem('solpay_data');
    if (saved) state = JSON.parse(saved);

    // Safety untuk data lama yang belum punya field baru
    if (!state.weeklyHistory) state.weeklyHistory = [];
    if (state.statsWeekId === undefined) state.statsWeekId = null;

    checkWeeklyReset();

    // Auto-migrate old standalone receivables to grouped customer layout
    state.receivables = state.receivables.map(r => {
        if (r.capReimburse !== undefined) {
            return {
                id: r.id,
                name: r.desc.split('-')[1]?.trim() || 'Unknown Customer',
                items: [{ desc: r.desc.split('-')[0]?.trim() || 'Biz', cap: r.capReimburse, profit: r.profit }],
                totalDebt: r.amount,
                totalCapital: r.capReimburse,
                totalProfit: r.profit,
                paidAmount: 0,
                status: 'pending',
                paymentWallets: []
            };
        }
        return r;
    });

    checkStreak();
    renderAll();
    checkRecapReminder();
}
function saveData() {
    localStorage.setItem('solpay_data', JSON.stringify(state));
    renderAll();
}

function renderAll() {
    renderBalances();
    renderTracker();
    renderActivity();
    renderGoals();
    renderBusiness();
    renderWeeklyHistory();
    
    // Memastikan Lucide hanya dipanggil jika library sudah siap
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }
}


// --- MODAL UTILS (Single Queue System) ---
let modalTimeout = null;
function openModal(id) {
    const targetModal = document.getElementById(id);
    
    // PENGAMAN: Jika modal yang dipanggil gak ada di HTML, stop di sini secara elegan!
    if (!targetModal) {
        console.error(`Gagal membuka modal: Elemen dengan ID "${id}" tidak ditemukan di HTML!`);
        return; 
    }

    const activeModal = document.querySelector('.modal-overlay.active');
    if (activeModal && activeModal.id !== id) {
        activeModal.classList.remove('active');
        clearTimeout(modalTimeout);
        modalTimeout = setTimeout(() => {
            targetModal.classList.add('active');
        }, 300);
    } else {
        targetModal.classList.add('active');
    }
}

function closeModal(id, event) {
    if (event && event.target.id !== id) return;
    const targetModal = document.getElementById(id);
    if (targetModal) {
        targetModal.classList.remove('active');
    }
}


// --- CUSTOM SELECT (Pill System) ---
function selectPill(inputId, value) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.value = value;
    
    const group = document.getElementById('group_' + inputId);
    if (group) {
        group.querySelectorAll('.select-pill').forEach(el => el.classList.remove('active'));
        const target = group.querySelector(`[data-val="${value}"]`);
        if (target) target.classList.add('active');
    }

    if (inputId === 'bizProduct') updateBizProfit();
    if (inputId === 'bizStatus') {
        const isReceivable = value === 'receivable';
        document.getElementById('bizNameGroup').style.display = isReceivable ? 'block' : 'none';
        document.getElementById('bizToWalletGroup').style.display = isReceivable ? 'none' : 'block';
        updateBizProfit();
    }
}
function setPillValue(inputId, value) { selectPill(inputId, value); }

// --- RENDERERS ---
function renderBalances() {
    const b = state.balances;

    // Hitung income dan expense minggu ini untuk Main
    let weekIncome = 0;
    let weekExpense = 0;
    state.history.forEach(h => {
        if (h.cat === 'main') {
            if (h.type === 'income' || h.isBusinessProfit) weekIncome += h.amount;
            else if (h.type === 'expense') weekExpense += h.amount;
        }
    });
    const weekIncomeEl = document.getElementById('mainWeekIncome');
    const weekExpenseEl = document.getElementById('mainWeekExpense');
    if (weekIncomeEl) weekIncomeEl.textContent = '+' + formatIDR(weekIncome);
    if (weekExpenseEl) weekExpenseEl.textContent = '-' + formatIDR(weekExpense);
    const totals = {
        main: b.main.cash + b.main.dana,
        fashion: b.fashion.cash + b.fashion.dana,
        skincare: b.skincare.cash + b.skincare.dana,
        business: b.business.cash + b.business.dana
    };
    const wealth = totals.main + totals.fashion + totals.skincare + totals.business;

const totalWealthEl = document.getElementById('totalWealth');
if (totalWealthEl) {
    totalWealthEl.textContent = formatIDR(wealth);
}

    
['main', 'fashion', 'skincare', 'business'].forEach(cat => {

    const totalEl =
        document.getElementById(`${cat}BalanceTotal`);

    const cashEl =
        document.getElementById(`${cat}Cash`);

    const danaEl =
        document.getElementById(`${cat}Dana`);

    if (totalEl)
        totalEl.textContent =
            formatIDR(totals[cat]);

    if (cashEl)
        cashEl.textContent =
            formatIDR(b[cat].cash);

    if (danaEl)
        danaEl.textContent =
            formatIDR(b[cat].dana);
});

// Update debt info di kartu
const bd = state.businessDebt;
const fashionDebtEl = document.getElementById('fashionDebtInfo');
const skincareDebtEl = document.getElementById('skincareDebtInfo');
const businessDebtEl = document.getElementById('businessDebtInfo');

let fashionMsg = [];
let skincareMsg = [];
let businessMsg = [];

if (bd.fashion > 0) {
    businessMsg.push(`Hutang ke Fashion: ${formatIDR(bd.fashion)}`);
    fashionMsg.push(`Dipinjam Bisnis: ${formatIDR(bd.fashion)}`);
}
if (bd.skincare > 0) {
    businessMsg.push(`Hutang ke Skincare: ${formatIDR(bd.skincare)}`);
    skincareMsg.push(`Dipinjam Bisnis: ${formatIDR(bd.skincare)}`);
}
if (state.debt.skincare_to_fashion > 0) {
    fashionMsg.push(`Dipinjam Skincare: ${formatIDR(state.debt.skincare_to_fashion)}`);
    skincareMsg.push(`Hutang ke Fashion: ${formatIDR(state.debt.skincare_to_fashion)}`);
}
if (state.debt.fashion_to_skincare > 0) {
    skincareMsg.push(`Dipinjam Fashion: ${formatIDR(state.debt.fashion_to_skincare)}`);
    fashionMsg.push(`Hutang ke Skincare: ${formatIDR(state.debt.fashion_to_skincare)}`);
}

if (fashionDebtEl) fashionDebtEl.textContent = fashionMsg.length ? fashionMsg.join(' | ') : 'Tidak ada pinjaman';
    if (skincareDebtEl) skincareDebtEl.textContent = skincareMsg.length ? skincareMsg.join(' | ') : 'Tidak ada pinjaman';
    if (businessDebtEl) businessDebtEl.textContent = businessMsg.length ? businessMsg.join(' | ') : 'Tidak ada pinjaman';

    // Stat kartu Fashion dan Skincare: goal terdekat
    ['fashion', 'skincare'].forEach(cat => {
        const goals = state.goals.filter(g => g.cat === cat);
        const nameEl = document.getElementById(`${cat}GoalName`);
        const progEl = document.getElementById(`${cat}GoalProgress`);
        if (!nameEl || !progEl) return;
        if (goals.length === 0) {
            nameEl.textContent = 'Belum ada goal';
            progEl.textContent = '—';
        } else {
            const bal = state.balances[cat].cash + state.balances[cat].dana;
            const nearest = goals.reduce((prev, curr) => {
                const prevPct = prev.amount > 0 ? bal / prev.amount : 0;
                const currPct = curr.amount > 0 ? bal / curr.amount : 0;
                return currPct > prevPct ? curr : prev;
            });
            const pct = Math.min((bal / nearest.amount) * 100, 100).toFixed(0);
            nameEl.textContent = nearest.name;
            progEl.textContent = `${pct}%`;
            progEl.style.color = pct == 100 ? 'var(--green)' : 'inherit';
        }
    });

    // Stat kartu Business
    const bizProfitEl = document.getElementById('businessWeekProfit');
    const bizDebtEl = document.getElementById('businessActiveDebt');
    if (bizProfitEl) {
        const weekProfit = state.history.filter(h => h.isBusinessProfit).reduce((s, h) => s + h.amount, 0);
        bizProfitEl.textContent = '+' + formatIDR(weekProfit);
    }
    if (bizDebtEl) {
        const totalDebt = state.receivables.reduce((s, r) => s + (r.totalDebt - r.paidAmount), 0);
        bizDebtEl.textContent = formatIDR(totalDebt);
    }
}

function renderTracker() {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const scroll = document.getElementById('trackerScroll');
if (!scroll) return; // <-- TAMBAHKAN BARIS PENGAMAN INI

scroll.innerHTML = '';


    let dailySums = [0,0,0,0,0,0,0];
    state.history.forEach(h => {
        if (h.cat === 'main' && (h.type === 'income' || h.type === 'expense' || h.isBusinessProfit)) {
            let mult = h.type === 'expense' ? -1 : 1;
            dailySums[h.day] += h.amount * mult;
        }
    });

    days.forEach((dayName, idx) => {
        const div = document.createElement('div');
        div.className = `day-pill ${idx === activeDayIndex ? 'active' : ''}`;
        div.onclick = () => { activeDayIndex = idx; renderAll(); };
        let sumStr = formatSignedIDR(dailySums[idx]);
        
div.innerHTML = `
            <div class="day-name">${dayName}</div>
            <div class="day-amount" style="color: ${idx === activeDayIndex ? 'inherit' : (dailySums[idx] < 0 ? 'var(--red)' : (dailySums[idx]>0?'var(--green)':'inherit'))}">${sumStr}</div>
            ${idx === activeDayIndex ? `
            <div class="day-actions">
                <button class="day-action-btn income" onclick="event.stopPropagation(); openPosAction('main','income')">+</button>
                <button class="day-action-btn expense" onclick="event.stopPropagation(); openPosAction('main','expense')">-</button>
            </div>` : ''}
        `;
        
        scroll.appendChild(div);
    });
}

function renderActivity() {
const list = document.getElementById('activityList');
if (!list) return; // <-- TAMBAHKAN BARIS PENGAMAN INI

list.innerHTML = '';

    const dayLogs = state.history.filter(h => h.day === activeDayIndex).reverse();
    
    if (dayLogs.length === 0) {
        list.innerHTML = `<p class="subtext text-center mt-3">No activity recorded for this day ✨</p>`;
        return;
    }

    dayLogs.forEach(log => {
        let icon = 'circle'; let iconClass = ''; let sign = ''; let colorClass = '';
        if (log.type === 'income') { icon = 'arrow-down-left'; iconClass = 'income'; sign = '+'; colorClass = 'text-green'; }
        else if (log.type === 'expense') { icon = 'arrow-up-right'; iconClass = 'expense'; sign = '-'; }
        else if (log.type === 'transfer') { icon = 'refresh-cw'; }
        else if (log.type === 'business') { icon = 'briefcase'; iconClass = 'income'; sign = '+'; colorClass = 'text-green'; }

        const div = document.createElement('div');
        div.className = 'activity-item';
        div.innerHTML = `
            <div class="act-icon ${iconClass}"><i data-lucide="${icon}"></i></div>
            <div class="act-details">
                <div class="act-title">${log.desc}</div>
                <div class="act-sub">${log.wallet ? log.wallet.toUpperCase() : ''} ${log.cat ? '• ' + log.cat : ''}</div>
            </div>
            <div class="act-amount ${colorClass}">${sign}${formatIDR(log.amount)}</div>
            <div class="act-actions">
                <button onclick="deleteLog('${log.id}')"><i data-lucide="trash-2"></i></button>
            </div>
        `;
        list.appendChild(div);
    });
}

function renderGoals() {
const list = document.getElementById('goalsList');
if (!list) return; // <-- TAMBAHKAN BARIS PENGAMAN INI

list.innerHTML = '';

    
    if (state.goals.length === 0) {
        list.innerHTML = `<p class="subtext text-center">No goals set yet ✨</p>`;
        return;
    }

    state.goals.forEach((g, idx) => {
        const currentBal = state.balances[g.cat].cash + state.balances[g.cat].dana;
        let percent = Math.min((currentBal / g.amount) * 100, 100).toFixed(0);
        let readyText = percent == 100 ? `<span class="text-green fw-600">Ready to buy ✨</span>` : '';

        const div = document.createElement('div');
        div.className = 'goal-item';
        div.innerHTML = `
            <div class="goal-header">
                <span>${g.name}</span>
                <span>${formatIDR(currentBal)} / ${formatIDR(g.amount)}</span>
            </div>
            <div class="goal-sub">
                <span>From ${g.cat.charAt(0).toUpperCase() + g.cat.slice(1)}</span>
                ${readyText}
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${percent}%"></div>
            </div>
            <div class="text-right mt-2">
                <button class="icon-btn-small" onclick="deleteGoal(${idx})"><i data-lucide="trash-2" style="width:14px"></i></button>
            </div>
        `;
        list.appendChild(div);
    });
}

function renderBusiness() {
    let weekProfit = state.history.filter(h => h.isBusinessProfit).reduce((sum, h) => sum + h.amount, 0);
    
    // Hitung total piutang aktif dari semua customer
    let totalReceivable = state.receivables.reduce((sum, r) => sum + (r.totalDebt - r.paidAmount), 0);

    // RENDER KE UI DENGAN PENGAMAN YANG BENAR
    const bizProfitEl = document.getElementById('bizProfit');
    if (bizProfitEl) {
        bizProfitEl.textContent = '+' + formatIDR(weekProfit);
    }

    const bizReceivableEl = document.getElementById('bizReceivable');
    if (bizReceivableEl) {
        bizReceivableEl.textContent = formatIDR(totalReceivable);
    }

    const rList = document.getElementById('receivablesList');
    if (!rList) return; // Pengaman agar tidak error jika elemen list tidak ada

    rList.innerHTML = '';
    
    if (state.receivables.length === 0) {
        rList.innerHTML = `<p class="subtext text-center mt-3">No pending receivables.</p>`;
        return;
    }

    state.receivables.forEach(r => {
        const rem = r.totalDebt - r.paidAmount;
        const statusText = r.paidAmount > 0 ? '🟠 Partial Payment' : '🔴 Unpaid';
        
        let itemsHtml = r.items.map(i => `• ${i.desc}: ${formatIDR(i.cap + i.profit)}`).join('<br>');

        const div = document.createElement('div');
        div.className = 'customer-debt-card';
        div.innerHTML = `
            <div class="flex-between">
                <div>
                    <div class="fw-600" style="font-size:15px;">${r.name}</div>
                    <div class="subtext">${statusText}</div>
                </div>
                <div class="text-right">
                    <div class="fw-600 text-accent">${formatIDR(r.totalDebt)}</div>
                    <div class="subtext">Rem: <span class="text-red">${formatIDR(rem)}</span></div>
                </div>
            </div>
            <div class="debt-items-list">
                ${itemsHtml}
            </div>
            <div class="flex-between">
                <div style="font-size: 13px;" class="fw-500">Paid: <span class="text-green">${formatIDR(r.paidAmount)}</span></div>
                <button class="btn-primary-small" onclick="openInstallmentModal('${r.id}')">+ Bayar Cicilan</button>
            </div>
        `;
        rList.appendChild(div);
    });
}


function renderWeeklyHistory() {
    const list = document.getElementById('weeklyHistoryList');
    if (!list) return;
    list.innerHTML = '';

    if (!state.weeklyHistory || state.weeklyHistory.length === 0) {
        list.innerHTML = `<p class="subtext text-center">Belum ada history minggu sebelumnya ✨</p>`;
        return;
    }

    state.weeklyHistory.forEach(w => {
        const div = document.createElement('div');
        div.className = 'week-history-item';
        div.innerHTML = `
            <div class="week-history-header fw-600">${w.label}</div>
            <div class="week-history-stats">
                <span class="text-green">+${formatIDR(w.income)}</span>
                <span class="text-red">-${formatIDR(w.expense)}</span>
                <span class="text-accent">Profit +${formatIDR(w.profit)}</span>
            </div>
        `;
        list.appendChild(div);
    });
}

// --- SNACKBAR (UNDO SYSTEM) ---

let snackbarTimeout;
function showSnackbar(msg, onUndo) {
    const sb = document.getElementById('snackbar');
    document.getElementById('snackbarMsg').textContent = msg;
    const btn = document.getElementById('snackbarAction');
    
    if (onUndo) {
        btn.style.display = 'block';
        btn.onclick = () => { onUndo(); sb.classList.remove('show'); clearTimeout(snackbarTimeout); };
    } else {
        btn.style.display = 'none';
    }

    sb.classList.add('show');
    clearTimeout(snackbarTimeout);
    snackbarTimeout = setTimeout(() => {
        sb.classList.remove('show');
        tempUndoTransaction = null; 
    }, 5000);
}

// --- CORE ACTIONS ---

function setTrxType(type) {
    currentTrxType = type;
    document.getElementById('btnExpense').classList.remove('active');
    document.getElementById('btnIncome').classList.remove('active');
    document.getElementById(type === 'expense' ? 'btnExpense' : 'btnIncome').classList.add('active');
}

// --- POS ACTION (tombol di kartu) ---
function openPosAction(cat, type) {
    openModal('addTransactionModal');
    setTrxType(type);
    document.getElementById('trxModalTitle').textContent =
        `${type === 'income' ? 'Pemasukan' : 'Pengeluaran'} - ${cat.charAt(0).toUpperCase() + cat.slice(1)}`;
    document.getElementById('addTransactionModal').dataset.poscat = cat;
}

function quickAdd(desc, amount) {
    openModal('addTransactionModal');
    setTrxType('expense');
    document.getElementById('trxDesc').value = '';
document.getElementById('trxAmount').value = '';
document.getElementById('trxModalTitle').textContent = 'Catat Transaksi';
document.getElementById('addTransactionModal').dataset.poscat = 'main';
    if(!amount) document.getElementById('trxAmount').focus();
}

function saveTransaction() {
    const desc = document.getElementById('trxDesc').value;
    const amount = parseInt(document.getElementById('trxAmount').value);
    const wallet = document.getElementById('trxWallet').value;
    
    if (!desc || !amount || amount <= 0) return;

    const poscat = document.getElementById('addTransactionModal').dataset.poscat || 'main';
const log = { id: generateId(), type: currentTrxType, cat: poscat, wallet: wallet, amount: amount, desc: desc, day: activeDayIndex, timestamp: Date.now() };

if (currentTrxType === 'income') {
    state.balances[poscat][wallet] += amount;
} else {
    if (poscat === 'fashion' || poscat === 'skincare') {
        if (!spendFromPos(poscat, wallet, amount)) return;
    } else {
        let currentBalance = state.balances[poscat][wallet];
        if (amount > currentBalance) {
            showSnackbar(`❌ Saldo ${poscat} tidak cukup`);
            return;
        }
        state.balances[poscat][wallet] -= amount;
    }
}

    state.history.push(log);
    updateStreak();
    saveData();
    closeModal('addTransactionModal');
    
    document.getElementById('trxDesc').value = '';
    document.getElementById('trxAmount').value = '';
}

function toggleDebtMode() {
    isDebtMode = !isDebtMode;
    const btn = document.getElementById('debtToggleBtn');
    const subtext = document.getElementById('transferSubtext');
    
    if (isDebtMode) {
        btn.textContent = "Batal Hutang"; btn.classList.add('text-red');
        subtext.innerHTML = "<b class='text-red'>Mode Hutang:</b> Sistem akan mencatat ini sebagai pinjaman.";
        setPillValue('tfFromCat', 'fashion');
        setPillValue('tfToCat', 'skincare');
    } else {
        btn.textContent = "Catat Hutang"; btn.classList.remove('text-red');
        subtext.textContent = "Pindah uang antar dompet / tabungan.";
    }
}

function processTransfer() {
    const fromCat = document.getElementById('tfFromCat').value;
    const fromWal = document.getElementById('tfFromWallet').value;
    const toCat = document.getElementById('tfToCat').value;
    const toWal = document.getElementById('tfToWallet').value;
    const amount = parseInt(document.getElementById('tfAmount').value);

    if (!amount || amount <= 0) return;
    if (fromCat === toCat && fromWal === toWal) return;
    
   if (
    amount >
    state.balances[fromCat][fromWal]
) {
    showSnackbar(
        '❌ Saldo tidak cukup'
    );
    return;
}
  
    state.balances[fromCat][fromWal] -= amount;
    state.balances[toCat][toWal] += amount;

    let desc = `Transfer from ${fromCat} to ${toCat}`;
    if (isDebtMode) {
        if (fromCat === 'fashion' && toCat === 'skincare') { state.debt.s_to_f += amount; desc = `Skincare borrowed from Fashion`; }
        else if (fromCat === 'skincare' && toCat === 'fashion') { state.debt.f_to_s += amount; desc = `Fashion borrowed from Skincare`; }
    }

    state.history.push({ id: generateId(), type: 'transfer', fromCat, fromWal, toCat, toWal, amount, desc, day: activeDayIndex, timestamp: Date.now(), isDebt: isDebtMode });
    
    saveData();
    closeModal('transferModal');
    document.getElementById('tfAmount').value = '';
    if(isDebtMode) toggleDebtMode();
}

function setAdjType(type) {
    currentAdjType = type;
    document.getElementById('btnAdjAdd').classList.remove('active');
    document.getElementById('btnAdjReduce').classList.remove('active');
    document.getElementById(type === 'add' ? 'btnAdjAdd' : 'btnAdjReduce').classList.add('active');
}

function processAdjustment() {
    const cat = document.getElementById('adjCat').value;
    const wallet = document.getElementById('adjWallet').value;
    const amount = parseInt(document.getElementById('adjAmount').value);

    if (!amount || amount <= 0) return;

    if (currentAdjType === 'add') state.balances[cat][wallet] += amount;
    else state.balances[cat][wallet] -= amount;

    state.history.push({ id: generateId(), type: currentAdjType === 'add' ? 'income' : 'expense', cat, wallet, amount, desc: 'Manual Adjustment', day: activeDayIndex, timestamp: Date.now() });
    
    updateStreak();
    saveData();
    closeModal('addExistingModal');
    document.getElementById('adjAmount').value = '';
}

function saveGoal() {
    const name = document.getElementById('goalName').value;
    const amount = parseInt(document.getElementById('goalAmount').value);
    const cat = document.getElementById('goalCategory').value;

    if (!name || !amount) return;

    state.goals.push({ name, amount, cat });
    saveData();
    closeModal('addGoalModal');
    document.getElementById('goalName').value = '';
    document.getElementById('goalAmount').value = '';
}
function deleteGoal(idx) {
    state.goals.splice(idx, 1);
    saveData();
}

// --- BUSINESS LOGIC ---
function updateBizProfit() {
    const type = document.getElementById('bizProduct').value;
    const status = document.getElementById('bizStatus').value;
    const cap = parseInt(document.getElementById('bizCapital').value) || 0;

    let p = 0;

    if (type === 'quota') {
        p = 3000;
    } else if (type === 'wd') {
        p = cap < 100000 ? 3000 : 5000;
    } else if (type === 'token') {
        p = 4000;
    } else if (type === 'ewallet') {
        if (status === 'paid') {
            if (cap < 50000) p = 3000;
            else if (cap <= 100000) p = 5000;
            else p = 7000;
        } else {
            // Piutang: dibawah 50k = 3k, diatas 50k = 10%
            p = cap < 50000 ? 3000 : Math.round(cap * 0.1);
        }
    }

// Isi field profit dengan angka default, tapi user bisa edit
    document.getElementById('bizProfitInput').value = p;
}

function processBusiness() {
    const type = document.getElementById('bizProduct').value;
    const status = document.getElementById('bizStatus').value;
    const cap = parseInt(document.getElementById('bizCapital').value);

    const fromWal = 'dana'; // bisnis selalu modal dari wallet
    const toWal = document.getElementById('bizToWallet').value;

    if (!cap || cap <= 0) return;


// ==========================
// AUTO BUSINESS LOAN SYSTEM
// ==========================
if (!ensureBusinessCapital(cap)) return;


// ==========================
    // HITUNG PROFIT
    // ==========================

const profit = parseInt(document.getElementById('bizProfitInput').value) || 0;
    if (profit <= 0) {
        showSnackbar('❌ Profit tidak boleh 0');
        return;
    }

    // lanjut kode lama lu di bawah sini...

    if (status === 'paid') {
// Modal keluar
state.balances.business.dana -= cap;
repayBusinessDebt();

// Customer bayar → modal balik
state.balances.business.dana += cap;

// Profit masuk
state.balances.main[toWal] += profit;

// Auto balikin hutang modal
repayBusinessDebt();
        state.history.push({ id: generateId(), type: 'business', amount: profit, cat: 'main', wallet: toWal, desc: `Biz: ${type.toUpperCase()} (Paid)`, day: activeDayIndex, isBusinessProfit: true });
        updateStreak();
    } else {
        const custName = document.getElementById('bizCustomer').value.trim() || 'Unknown Customer';
        state.balances.business.dana -= cap; // Spend capital now. Wait for debt to be fully paid to return it.

        let existingCust = state.receivables.find(r => r.name.toLowerCase() === custName.toLowerCase());
        if (existingCust) {
            existingCust.items.push({ desc: type.toUpperCase(), cap: cap, profit: profit });
            existingCust.totalDebt += (cap + profit);
            existingCust.totalCapital += cap;
            existingCust.totalProfit += profit;
            existingCust.status = existingCust.paidAmount > 0 ? 'partial' : 'pending';
        } else {
            state.receivables.push({
                id: generateId(),
                name: custName,
                items: [{ desc: type.toUpperCase(), cap: cap, profit: profit }],
                totalDebt: cap + profit,
                totalCapital: cap,
                totalProfit: profit,
                paidAmount: 0,
                status: 'pending',
                paymentWallets: []
            });
        }
    }

    saveData();
    closeModal('sideBusinessModal');
    document.getElementById('bizCapital').value = '';
    document.getElementById('bizProfitInput').value = '';
    document.getElementById('bizCustomer').value = '';
}

function openInstallmentModal(id) {
    const r = state.receivables.find(x => x.id === id);
    if (!r) return;

    document.getElementById('instDebtId').value = id;
    document.getElementById('instCustomerName').textContent = `Customer: ${r.name}`;
    document.getElementById('instRemaining').textContent = formatIDR(r.totalDebt - r.paidAmount);
    document.getElementById('instPaid').textContent = formatIDR(r.paidAmount);
    document.getElementById('instAmount').value = '';
    document.getElementById('instEditAmount').value = '';
    setPillValue('instWallet', 'cash');
    setInstMode('new');

    openModal('installmentModal');
}

function setInstMode(mode) {
    const isNew = mode === 'new';
    document.getElementById('btnInstNew').classList.toggle('active', isNew);
    document.getElementById('btnInstEdit').classList.toggle('active', !isNew);
    document.getElementById('instNewGroup').style.display = isNew ? 'block' : 'none';
    document.getElementById('instEditGroup').style.display = isNew ? 'none' : 'block';
    document.getElementById('instSubmitBtn').textContent = isNew ? 'Simpan Pembayaran' : 'Simpan Koreksi';
}

function processInstallment() {
    const id = document.getElementById('instDebtId').value;
    const wallet = document.getElementById('instWallet').value;
    const isEditMode = document.getElementById('btnInstEdit').classList.contains('active');

    const rIndex = state.receivables.findIndex(x => x.id === id);
    if (rIndex === -1) return;
    const r = state.receivables[rIndex];

    if (isEditMode) {
        const newPaid = parseInt(document.getElementById('instEditAmount').value);
        if (isNaN(newPaid) || newPaid < 0) return;

        if (newPaid > r.totalDebt) {
            showSnackbar(`❌ Tidak bisa melebihi total hutang ${formatIDR(r.totalDebt)}`);
            return;
        }

        const diff = newPaid - r.paidAmount;

        if (diff === 0) {
            showSnackbar('Tidak ada perubahan.');
            closeModal('installmentModal');
            return;
        }

        if (diff < 0) {
            let toTakeBack = Math.abs(diff);
            const fromBiz = Math.min(toTakeBack, state.balances.business[wallet]);
            state.balances.business[wallet] -= fromBiz;
            toTakeBack -= fromBiz;
            if (toTakeBack > 0) state.balances.main[wallet] -= toTakeBack;
            showSnackbar(`✅ Koreksi disimpan. Ditarik balik: ${formatIDR(Math.abs(diff))}`);
        } else {
            const TARGET_MODAL = 150000;
            let remaining = diff;
            const bizNow = state.balances.business.dana;
            if (bizNow < TARGET_MODAL) {
                const fillBiz = Math.min(remaining, TARGET_MODAL - bizNow);
                state.balances.business[wallet] += fillBiz;
                remaining -= fillBiz;
            }
            if (remaining > 0 && state.businessDebt.fashion > 0) {
                const repay = Math.min(remaining, state.businessDebt.fashion);
                state.balances.fashion[wallet] += repay;
                state.businessDebt.fashion -= repay;
                remaining -= repay;
            }
            if (remaining > 0 && state.businessDebt.skincare > 0) {
                const repay = Math.min(remaining, state.businessDebt.skincare);
                state.balances.skincare[wallet] += repay;
                state.businessDebt.skincare -= repay;
                remaining -= repay;
            }
            if (remaining > 0) state.balances.main[wallet] += remaining;
            showSnackbar(`✅ Koreksi disimpan. Ditambah: ${formatIDR(diff)}`);
        }

        r.paidAmount = newPaid;
        r.status = newPaid >= r.totalDebt ? 'paid' : (newPaid > 0 ? 'partial' : 'pending');
        if (r.paidAmount >= r.totalDebt) {
            state.receivables.splice(rIndex, 1);
            showSnackbar('Debt Fully Paid! ✨');
        }

        saveData();
        closeModal('installmentModal');
        return;
    }

    const amt = parseInt(document.getElementById('instAmount').value);
    if (!amt || amt <= 0) return;

    const rem = r.totalDebt - r.paidAmount;
    const payment = Math.min(amt, rem);

    r.paidAmount += payment;
    r.paymentWallets.push({ amount: payment, wallet: wallet });

    const TARGET_MODAL = 150000;
    let remaining = payment;

    const bizNow = state.balances.business.dana;
    if (bizNow < TARGET_MODAL) {
        const fillBiz = Math.min(remaining, TARGET_MODAL - bizNow);
        state.balances.business[wallet] += fillBiz;
        remaining -= fillBiz;
    }
    if (remaining > 0 && state.businessDebt.fashion > 0) {
        const repay = Math.min(remaining, state.businessDebt.fashion);
        state.balances.fashion[wallet] += repay;
        state.businessDebt.fashion -= repay;
        remaining -= repay;
    }
    if (remaining > 0 && state.businessDebt.skincare > 0) {
        const repay = Math.min(remaining, state.businessDebt.skincare);
        state.balances.skincare[wallet] += repay;
        state.businessDebt.skincare -= repay;
        remaining -= repay;
    }
    if (remaining > 0) {
        state.balances.main[wallet] += remaining;
        state.history.push({
            id: generateId(),
            type: 'business',
            amount: remaining,
            cat: 'main',
            wallet: wallet,
            desc: `Cicilan Profit: ${r.name}`,
            day: activeDayIndex,
            isBusinessProfit: true
        });
        updateStreak();
    }

    if (r.paidAmount >= r.totalDebt) {
        state.receivables.splice(rIndex, 1);
        showSnackbar('Debt Fully Paid! ✨');
    } else {
        r.status = 'partial';
        showSnackbar(`Cicilan disimpan 🟠 Sisa: ${formatIDR(r.totalDebt - r.paidAmount)}`);
    }

    saveData();
    closeModal('installmentModal');
}

function deleteLog(id) {
    const idx = state.history.findIndex(h => h.id === id);
    if (idx === -1) return;
    
    const log = state.history[idx];
    tempUndoTransaction = { index: idx, log: deepCopy(log) };

    if (log.type === 'income') state.balances[log.cat][log.wallet] -= log.amount;
    else if (log.type === 'expense') state.balances[log.cat][log.wallet] += log.amount;
    else if (log.type === 'transfer') {
        state.balances[log.fromCat][log.fromWal] += log.amount;
        state.balances[log.toCat][log.toWal] -= log.amount;
        if (log.isDebt) {
            if (log.fromCat === 'fashion' && log.toCat === 'skincare') state.debt.s_to_f -= log.amount;
            if (log.fromCat === 'skincare' && log.toCat === 'fashion') state.debt.f_to_s -= log.amount;
        }
    } else if (log.type === 'business' && log.isBusinessProfit) {
        state.balances.main[log.wallet] -= log.amount;
    }

    state.history.splice(idx, 1);
    saveData();

    showSnackbar("Transaction removed", () => {
        const restored = tempUndoTransaction.log;
        state.history.splice(tempUndoTransaction.index, 0, restored);
        
        if (restored.type === 'income') state.balances[restored.cat][restored.wallet] += restored.amount;
        else if (restored.type === 'expense') state.balances[restored.cat][restored.wallet] -= restored.amount;
        else if (restored.type === 'transfer') {
            state.balances[restored.fromCat][restored.fromWal] -= restored.amount;
            state.balances[restored.toCat][restored.toWal] += restored.amount;
            if (restored.isDebt) {
                if (restored.fromCat === 'fashion' && restored.toCat === 'skincare') state.debt.s_to_f += restored.amount;
                if (restored.fromCat === 'skincare' && restored.toCat === 'fashion') state.debt.f_to_s += restored.amount;
            }
        } else if (restored.type === 'business' && restored.isBusinessProfit) {
            state.balances.main[restored.wallet] += restored.amount;
        }
        
        saveData();
    });
}

// --- RECAP SYSTEM ---
function checkRecapReminder() {
    const today = new Date().getDay();
    const weekId = getWeekId();
    const recapBannerEl = document.getElementById('recapBanner');

    // Pengaman: Hanya jalankan jika elemen recapBanner ada di HTML
    if (recapBannerEl) {
        if (today === 0 && state.recapDoneWeekId !== weekId) {
            recapBannerEl.classList.remove('hidden');
        } else {
            recapBannerEl.classList.add('hidden');
        }
    }
}


function hideRecapBanner() { document.getElementById('recapBanner').classList.add('hidden'); }

let pendingRecapData = null;

function initRecap() {
    const totalMain = state.balances.main.cash + state.balances.main.dana;
    if (totalMain <= 0) {
        showSnackbar("❌ Tidak ada saldo Main untuk di-recap.");
        return;
    }

    let splitAmount = totalMain / 2;
    let fashionGets = splitAmount;
    let skincareGets = splitAmount;
    let debtStr = "No debts ✨";

    if (state.debt.s_to_f > 0) {
        let repay = Math.min(splitAmount, state.debt.s_to_f);
        fashionGets += repay; skincareGets -= repay;
        debtStr = `Skincare pays Fashion ${formatIDR(repay)}`;
    } else if (state.debt.f_to_s > 0) {
        let repay = Math.min(splitAmount, state.debt.f_to_s);
        skincareGets += repay; fashionGets -= repay;
        debtStr = `Fashion pays Skincare ${formatIDR(repay)}`;
    }

    pendingRecapData = { totalMain, fashionGets, skincareGets };

    document.getElementById('recapCollected').textContent = formatIDR(totalMain);
    document.getElementById('recapBase').textContent = `${formatIDR(splitAmount)} each`;
    
    const debtRow = document.getElementById('recapDebtRow');
    if (debtStr !== "No debts ✨") {
        debtRow.classList.remove('hidden');
        document.getElementById('recapDebtText').textContent = debtStr;
    } else debtRow.classList.add('hidden');

    document.getElementById('recapFinalFashion').textContent = formatIDR(fashionGets);
    document.getElementById('recapFinalSkincare').textContent = formatIDR(skincareGets);

    openModal('recapPreviewModal');
}

function confirmRecap() {
    if (!pendingRecapData) return;
    
    const cashPool = state.balances.main.cash;
    const danaPool = state.balances.main.dana;
    
    let fNeed = pendingRecapData.fashionGets;
    let sNeed = pendingRecapData.skincareGets;

    let fCash = Math.min(fNeed, cashPool); fNeed -= fCash;
    let fDana = Math.min(fNeed, danaPool);
    
    let remCash = cashPool - fCash;
    let remDana = danaPool - fDana;

    let sCash = Math.min(sNeed, remCash); sNeed -= sCash;
    let sDana = Math.min(sNeed, remDana);

    state.balances.main.cash = 0; state.balances.main.dana = 0;
    state.balances.fashion.cash += fCash; state.balances.fashion.dana += fDana;
    state.balances.skincare.cash += sCash; state.balances.skincare.dana += sDana;

    let splitAmount = pendingRecapData.totalMain / 2;
    if (state.debt.s_to_f > 0) state.debt.s_to_f -= Math.min(splitAmount, state.debt.s_to_f);
    if (state.debt.f_to_s > 0) state.debt.f_to_s -= Math.min(splitAmount, state.debt.f_to_s);

    state.recapDoneWeekId = getWeekId();
    
    saveData();
    closeModal('recapPreviewModal');
    hideRecapBanner();
    showSnackbar("Recap Complete ✨");
}

function updateStreak() {
    const todayStr = new Date().toDateString();

    if (state.streak.lastDate !== todayStr) {
        state.streak.count += 1;
        state.streak.lastDate = todayStr;
    }

    checkStreak();
}
function checkStreak() {
    const badge = document.getElementById('streakBadge');
    // kalau element belum ada, stop
    if (!badge) return;
    if (state.streak.count > 0) { badge.textContent = `Consistent ${state.streak.count} Days ✨`; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
}

function processSoftReset() {
    state.history = []; state.recapDoneWeekId = null;
    saveData(); closeModal('settingsModal'); showSnackbar("Tracker & History cleared.");
}

function processFullReset() {
    localStorage.removeItem('solpay_data');
    state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    saveData(); closeModal('fullResetModal');
}


function openWalletAction(cat) {

    const action = prompt(
        `${cat.toUpperCase()}\n\nKetik:\n1 = pemasukan\n2 = pengeluaran`
    );

    if (!action) return;

    const amount = parseInt(
        prompt('Masukkan nominal:')
    );

    if (!amount || amount <= 0) return;

    const wallet =
        prompt('cash atau dana?')
        ?.toLowerCase();

    if (
        wallet !== 'cash' &&
        wallet !== 'dana'
    ) {
        showSnackbar('Wallet tidak valid');
        return;
    }

    const desc =
        prompt('Nama transaksi:');

    if (action === '1') {

        state.balances[cat][wallet] += amount;

        state.history.push({
            id: generateId(),
            type: 'income',
            cat,
            wallet,
            amount,
            desc: desc || `${cat} Income`,
            day: activeDayIndex,
            timestamp: Date.now()
        });

    } else {

        state.balances[cat][wallet] -= amount;

        state.history.push({
            id: generateId(),
            type: 'expense',
            cat,
            wallet,
            amount,
            desc: desc || `${cat} Expense`,
            day: activeDayIndex,
            timestamp: Date.now()
        });
    }

    saveData();
}

window.onload = loadData;

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js')
            .then(() => console.log('Service Worker aktif ✨'))
            .catch((err) => console.log('Gagal daftar Service Worker', err));
    });
}
