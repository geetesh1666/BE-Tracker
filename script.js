/* ==========================================================
   BETracker Pro - script.js
   Hari Agencies | Frontend logic with login
   ========================================================== */

// ---------- CONFIGURATION ----------
// Your current Google Apps Script web app URL.
const API_URL = 'https://script.google.com/macros/s/AKfycbwmZxBsrB-aTFzs7xy-TOwkTlEplvnDsMIxyMlFgAg1ZOjKM5GHGSWLWf2goAzUAEiEfQ/exec';

const TZ = 'Asia/Kolkata';
const REQUEST_TIMEOUT_MS = 30000;
const TOKEN_KEY = 'betracker-session-token';

const EXPENSE_CATEGORIES = [
  'Transport', 'Fuel', 'Employee Salary', 'Vehicle Maintenance',
  'Electricity', 'Rent', 'Supplies', 'Repairs', 'Other'
];
const PAYMENT_METHODS = ['Cash', 'UPI', 'Bank Transfer', 'Card', 'Other'];

const REPORT_FIELDS = {
  'sales-daily': ['date'],
  'sales-monthly': ['month'],
  'sales-yearly': ['year'],
  'sales-custom': ['range'],
  'sales-paid': ['range'],
  'sales-unpaid': ['range'],
  'exp-daily': ['date'],
  'exp-monthly': ['month'],
  'exp-yearly': ['year'],
  'exp-paid': ['range'],
  'exp-unpaid': ['range'],
  'dealer-outstanding': [],
  'dealer-statement': ['dealer', 'range'],
  'financial': ['range']
};

const ADD_EXPENSE_IDS = {
  date: 'expDate', category: 'expCategory', description: 'expDescription',
  amount: 'expAmount', method: 'expMethod', status: 'expStatus'
};

const EDIT_EXPENSE_IDS = {
  date: 'editDate', category: 'editCategory', description: 'editDescription',
  amount: 'editAmount', method: 'editMethod', status: 'editStatus'
};

// ---------- STATE ----------
const state = {
  sales: [],
  expenses: [],
  charts: {},
  report: null,
  dealerKey: null,
  busy: {},
  pending: 0,
  view: 'dashboard',
  confirmResolve: null,
  loggedIn: false
};

// ---------- SMALL HELPERS ----------
const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function money(n) {
  const v = roundMoney(n);
  return (v < 0 ? '-' : '') + '₹' + Math.abs(v).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function num(n) {
  return (Number(n) || 0).toLocaleString('en-IN');
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function sumBy(list, key) {
  return roundMoney(list.reduce((total, item) => total + (Number(item[key]) || 0), 0));
}

function isPaid(item) {
  return item.paymentStatus === 'Paid';
}

function statusBadge(status) {
  return status === 'Paid'
    ? '<span class="badge badge-paid">Paid</span>'
    : '<span class="badge badge-unpaid">Not Paid</span>';
}

function emptyRow(columns, message) {
  return `<tr><td class="empty" colspan="${columns}">${esc(message)}</td></tr>`;
}

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function setFormMsg(id, text, ok = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', ok && !!text);
}

// ---------- SESSION TOKEN ----------
let memoryToken = '';

function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || memoryToken;
  } catch (err) {
    return memoryToken;
  }
}

function setToken(token) {
  memoryToken = token || '';
  try {
    localStorage.setItem(TOKEN_KEY, memoryToken);
  } catch (err) {
    // Storage blocked: the session lasts until this page is closed.
  }
}

function clearToken() {
  memoryToken = '';
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (err) {
    // Ignore storage errors.
  }
}

// ---------- DATE HELPERS (Asia/Kolkata, stored as YYYY-MM-DD) ----------
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthStart(dateStr) {
  return dateStr.slice(0, 8) + '01';
}

function weekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayIndex = (d.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(dateStr, -dayIndex);
}

function fmtDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(s || '');
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-IN', {
    month: 'long', year: 'numeric', timeZone: 'UTC'
  });
}

function inRange(dateStr, range) {
  if (!range.from) return true;
  return dateStr >= range.from && dateStr <= range.to;
}

function inRangeLoose(dateStr, from, to) {
  return (!from || dateStr >= from) && (!to || dateStr <= to);
}

function getRange(period) {
  const t = todayStr();
  switch (period) {
    case 'today':
      return { from: t, to: t, label: 'Today' };
    case 'yesterday': {
      const y = addDays(t, -1);
      return { from: y, to: y, label: 'Yesterday' };
    }
    case 'week':
      return { from: weekStart(t), to: t, label: 'This Week' };
    case 'month':
      return { from: monthStart(t), to: t, label: 'This Month' };
    case 'prevMonth': {
      const lastDayPrev = addDays(monthStart(t), -1);
      return { from: monthStart(lastDayPrev), to: lastDayPrev, label: 'Previous Month' };
    }
    case 'year':
      return { from: t.slice(0, 4) + '-01-01', to: t, label: 'This Year' };
    case 'custom': {
      const f = $('dashFrom').value;
      const to = $('dashTo').value;
      if (!f || !to) return null;
      const start = f <= to ? f : to;
      const end = f <= to ? to : f;
      return { from: start, to: end, label: 'Custom Range' };
    }
    default:
      return { from: null, to: null, label: 'All Time' };
  }
}

function describeRange(from, to) {
  if (from && to) return `${fmtDate(from)} to ${fmtDate(to)}`;
  if (from) return `From ${fmtDate(from)}`;
  if (to) return `Up to ${fmtDate(to)}`;
  return 'All time';
}

// ---------- DEALER HELPERS ----------
function cleanName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function dealerKey(name) {
  return cleanName(name).toLowerCase();
}

function dealerSummaries(sales) {
  const map = new Map();
  sales.forEach((s) => {
    const key = dealerKey(s.dealer);
    if (!key) return;
    if (!map.has(key)) {
      map.set(key, {
        key, name: cleanName(s.dealer), totalSales: 0, paidSales: 0,
        outstanding: 0, count: 0, unpaidCount: 0, lastDate: ''
      });
    }
    const d = map.get(key);
    d.totalSales = roundMoney(d.totalSales + s.total);
    d.count += 1;
    if (isPaid(s)) {
      d.paidSales = roundMoney(d.paidSales + s.total);
    } else {
      d.outstanding = roundMoney(d.outstanding + s.total);
      d.unpaidCount += 1;
    }
    if (s.date > d.lastDate) d.lastDate = s.date;
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- SORTING ----------
function sortList(list, mode, amountKey) {
  const parts = String(mode || 'date-desc').split('-');
  const field = parts[0];
  const dir = parts[1] === 'asc' ? 1 : -1;
  return list.slice().sort((a, b) => {
    const diff = field === 'amount'
      ? (a[amountKey] - b[amountKey])
      : (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    return diff * dir;
  });
}

// ---------- API LAYER ----------
async function apiRequest(method, action, body) {
  const token = getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res;
    try {
      if (method === 'GET') {
        const qs = new URLSearchParams({ action });
        if (token) qs.set('token', token);
        res = await fetch(`${API_URL}?${qs.toString()}`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal
        });
      } else {
        res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ ...body, action, token }),
          signal: controller.signal
        });
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('The server took too long to respond. Please try again.');
      }
      throw new Error('Could not reach the server. Check your internet connection.');
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('Unexpected server response. Check that the Apps Script web app is deployed with "Who has access: Anyone".');
    }

    if (!data.ok) {
      if (data.authRequired) {
        handleSessionExpired(data.error);
        const authErr = new Error(data.error || 'Please log in again.');
        authErr.isAuth = true;
        throw authErr;
      }
      throw new Error(data.error || 'The server returned an error.');
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function apiGet(action) {
  return apiRequest('GET', action);
}

function apiPost(action, body = {}) {
  return apiRequest('POST', action, body);
}

// ---------- LOGIN SCREEN ----------
function buildAuthUi() {
  const overlay = document.createElement('div');
  overlay.id = 'loginOverlay';
  overlay.className = 'login-overlay hidden';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'loginTitle');
  overlay.innerHTML = `
    <form id="loginForm" class="login-card" novalidate>
      <div class="login-logo"><i data-lucide="droplets"></i></div>
      <h2 id="loginTitle">BETracker Pro</h2>
      <p class="muted small">Hari Agencies. Enter the app password to continue.</p>
      <div class="field">
        <label for="loginPassword">Password</label>
        <input type="password" id="loginPassword" class="input" autocomplete="current-password" required>
      </div>
      <p class="form-msg" id="loginMsg" role="status"></p>
      <button type="submit" class="btn btn-primary btn-block" id="loginSubmit"><i data-lucide="log-in"></i> Log in</button>
    </form>`;
  document.body.appendChild(overlay);

  const logout = document.createElement('button');
  logout.id = 'logoutBtn';
  logout.type = 'button';
  logout.className = 'btn btn-top';
  logout.setAttribute('aria-label', 'Log out');
  logout.title = 'Log out';
  logout.innerHTML = '<i data-lucide="log-out"></i><span class="hide-sm">Log out</span>';
  $('refreshBtn').before(logout);
  logout.addEventListener('click', onLogout);

  $('loginForm').addEventListener('submit', onLoginSubmit);
}

function showLogin(message = '') {
  state.loggedIn = false;
  document.body.classList.add('locked');
  $('loginOverlay').classList.remove('hidden');
  setFormMsg('loginMsg', message);
  setTimeout(() => {
    const p = $('loginPassword');
    if (p) p.focus();
  }, 50);
  refreshIcons();
}

function hideLogin() {
  state.loggedIn = true;
  document.body.classList.remove('locked');
  $('loginOverlay').classList.add('hidden');
  $('loginPassword').value = '';
  setFormMsg('loginMsg', '');
}

function handleSessionExpired(message) {
  clearToken();
  state.sales = [];
  state.expenses = [];
  renderAll();
  showLogin(message || 'Your session has expired. Please log in again.');
}

async function onLoginSubmit(e) {
  e.preventDefault();
  const pwd = $('loginPassword').value;
  if (!pwd) {
    setFormMsg('loginMsg', 'Please enter the password.');
    return;
  }
  setFormMsg('loginMsg', '');

  await guarded('login', $('loginSubmit'), async () => {
    const res = await apiPost('login', { password: pwd });
    setToken(res.token);
    hideLogin();
    toast('Logged in successfully.', 'success');
    await loadData({ silent: true });
  }, 'Logging in...', 'loginMsg');
}

async function onLogout() {
  if (getToken()) {
    try {
      await apiPost('logout');
    } catch (err) {
      // Ignore: the local session is cleared either way.
    }
  }
  clearToken();
  state.sales = [];
  state.expenses = [];
  renderAll();
  showLogin('You have been logged out.');
}

async function startApp() {
  if (!getToken()) {
    showLogin();
    return;
  }
  setLoading(true);
  try {
    await apiGet('session');
    hideLogin();
    await loadData({ silent: true });
  } catch (err) {
    if (err.isAuth) return; // Login screen is already showing.
    showGlobalError('Could not reach the server. ' + err.message);
  } finally {
    setLoading(false);
  }
}

// ---------- LOADING AND ERRORS ----------
function setLoading(on) {
  state.pending = Math.max(0, state.pending + (on ? 1 : -1));
  $('loadingBar').classList.toggle('hidden', state.pending === 0);
  $('refreshBtn').disabled = state.pending > 0;
}

function showGlobalError(message) {
  setText('globalErrorText', message);
  $('globalError').classList.remove('hidden');
}

function hideGlobalError() {
  $('globalError').classList.add('hidden');
  setText('globalErrorText', '');
}

function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icon = type === 'error' ? 'alert-circle' : 'check-circle';
  el.innerHTML = `<i data-lucide="${icon}"></i><span>${esc(message)}</span>`;
  $('toastContainer').appendChild(el);
  refreshIcons();
  setTimeout(() => el.classList.add('leave'), 3800);
  setTimeout(() => el.remove(), 4300);
}

/**
 * Runs an action once at a time. The button is disabled and shows a spinner
 * while the request runs, which prevents accidental duplicate submissions.
 */
async function guarded(key, btn, fn, busyText = 'Please wait...', msgId = null) {
  if (state.busy[key]) return;
  state.busy[key] = true;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> ${esc(busyText)}`;
  try {
    await fn();
  } catch (err) {
    if (msgId) setFormMsg(msgId, err.message);
    if (!err.isAuth) toast(err.message, 'error');
  } finally {
    state.busy[key] = false;
    btn.disabled = false;
    btn.innerHTML = original;
    refreshIcons();
  }
}

// ---------- CONFIRM DIALOG ----------
function confirmAction({ title, message, okText = 'Confirm', danger = false }) {
  setText('confirmTitle', title);
  setText('confirmMessage', message);
  const ok = $('confirmOk');
  ok.textContent = okText;
  ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
  $('confirmModal').classList.remove('hidden');
  ok.focus();
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
  });
}

function closeConfirm(result) {
  $('confirmModal').classList.add('hidden');
  if (state.confirmResolve) {
    const resolve = state.confirmResolve;
    state.confirmResolve = null;
    resolve(result);
  }
}

// ---------- DATA LOADING ----------
async function loadData({ silent = false } = {}) {
  setLoading(true);
  try {
    const [salesRes, expRes] = await Promise.all([apiGet('listSales'), apiGet('listExpenses')]);
    state.sales = salesRes.sales || [];
    state.expenses = expRes.expenses || [];
    hideGlobalError();
    renderAll();
    if (!silent) toast('Data refreshed successfully.', 'success');
  } catch (err) {
    if (err.isAuth) return; // Login screen is already showing.
    showGlobalError('Could not load data. ' + err.message);
    toast(err.message, 'error');
  } finally {
    setLoading(false);
  }
}

function renderAll() {
  renderDashboard();
  renderSales();
  renderExpenses();
  renderDealers();
  renderDealerDetail();
  updateDealerOptions();
  refreshIcons();
}

function updateDealerOptions() {
  const dealers = dealerSummaries(state.sales);
  $('dealerList').innerHTML = dealers.map((d) => `<option value="${esc(d.name)}"></option>`).join('');

  const select = $('rDealer');
  const current = select.value;
  select.innerHTML = '<option value="">Choose a dealer</option>' +
    dealers.map((d) => `<option value="${esc(d.key)}">${esc(d.name)}</option>`).join('');
  if (dealers.some((d) => d.key === current)) select.value = current;
}

// ---------- CHARTS ----------
function makeChart(id, config) {
  if (typeof Chart === 'undefined') return;
  const canvas = $(id);
  if (!canvas) return;
  if (state.charts[id]) state.charts[id].destroy();
  state.charts[id] = new Chart(canvas, config);
}

function dailySeries(list, key) {
  const map = {};
  list.forEach((item) => {
    map[item.date] = (map[item.date] || 0) + (Number(item[key]) || 0);
  });
  const dates = Object.keys(map).sort();
  return {
    labels: dates.map(fmtDate),
    values: dates.map((d) => roundMoney(map[d]))
  };
}

function barConfig(series, label, color) {
  return {
    type: 'bar',
    data: {
      labels: series.labels,
      datasets: [{
        label,
        data: series.values,
        backgroundColor: color,
        borderRadius: 6,
        maxBarThickness: 42
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => ` ${label}: ${money(c.parsed.y)}` } }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: (v) => '₹' + Number(v).toLocaleString('en-IN') }
        },
        x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }
      }
    }
  };
}

function donutConfig(paidValue, unpaidValue) {
  return {
    type: 'doughnut',
    data: {
      labels: ['Paid', 'Not Paid'],
      datasets: [{
        data: [paidValue, unpaidValue],
        backgroundColor: ['#12885a', '#d33b3b'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { callbacks: { label: (c) => ` ${c.label}: ${money(c.parsed)}` } }
      }
    }
  };
}

// ---------- DASHBOARD ----------
function renderDashboard() {
  const period = $('dashPeriod').value;
  $('dashCustom').classList.toggle('hidden', period !== 'custom');

  const range = getRange(period);
  if (!range) {
    setText('periodLabel', 'Choose both dates to see the dashboard figures.');
    return;
  }
  setText('periodLabel', range.from
    ? `${range.label}: ${fmtDate(range.from)} to ${fmtDate(range.to)}`
    : range.label);

  const sales = state.sales.filter((s) => inRange(s.date, range));
  const exps = state.expenses.filter((e) => inRange(e.date, range));

  const totalSales = sumBy(sales, 'total');
  const paidSales = sumBy(sales.filter(isPaid), 'total');
  const pendingSales = sumBy(sales.filter((s) => !isPaid(s)), 'total');

  const paidExp = sumBy(exps.filter(isPaid), 'amount');
  const unpaidExp = sumBy(exps.filter((e) => !isPaid(e)), 'amount');
  const totalExp = roundMoney(paidExp + unpaidExp);

  const net = roundMoney(totalSales - totalExp);
  const cans = sumBy(sales, 'quantity');
  const activeDealers = dealerSummaries(sales).length;
  const outstandingDealers = dealerSummaries(state.sales).filter((d) => d.outstanding > 0).length;

  setText('stTotalSales', money(totalSales));
  setText('stPaidSales', money(paidSales));
  setText('stPendingSales', money(pendingSales));
  setText('stTotalExpenses', money(totalExp));
  setText('stPaidExpenses', money(paidExp));
  setText('stUnpaidExpenses', money(unpaidExp));
  setText('stNet', money(net));
  $('stNet').classList.toggle('neg', net < 0);
  setText('stCans', num(cans));
  setText('stDealers', num(activeDealers));
  setText('stOutstandingDealers', num(outstandingDealers));

  makeChart('chartSales', barConfig(dailySeries(sales, 'total'), 'Sales', '#1d6fe0'));
  makeChart('chartExpenses', barConfig(dailySeries(exps, 'amount'), 'Expenses', '#e67e10'));
  makeChart('chartSalesStatus', donutConfig(paidSales, pendingSales));
  makeChart('chartExpenseStatus', donutConfig(paidExp, unpaidExp));
}

// ---------- SALES ----------
function readSale() {
  const date = $('saleDate').value;
  const dealer = cleanName($('saleDealer').value);
  const qtyRaw = $('saleQty').value;
  const priceRaw = $('salePrice').value;
  const status = $('salePayment').value;

  if (!date) return { error: 'Please choose a sale date.' };
  if (!dealer) return { error: 'Please enter the dealer name.' };
  if (dealer.length > 80) return { error: 'Dealer name must be 80 characters or fewer.' };

  const quantity = Number(qtyRaw);
  if (qtyRaw === '' || !Number.isInteger(quantity) || quantity <= 0) {
    return { error: 'Quantity must be a positive whole number.' };
  }

  const price = Number(priceRaw);
  if (priceRaw === '' || !Number.isFinite(price) || price < 0) {
    return { error: 'Price per can must be zero or more.' };
  }

  if (!['Paid', 'Not Paid'].includes(status)) {
    return { error: 'Please choose Paid or Not Paid.' };
  }

  return {
    payload: {
      date,
      dealer,
      quantity,
      price: roundMoney(price),
      paymentStatus: status
    }
  };
}

function updateSaleTotal() {
  const qtyRaw = $('saleQty').value;
  const priceRaw = $('salePrice').value;
  const q = Number(qtyRaw);
  const p = Number(priceRaw);
  const valid = qtyRaw !== '' && Number.isInteger(q) && q > 0 && priceRaw !== '' && p >= 0;
  setText('saleTotalDisplay', valid ? money(q * p) : '₹0.00');
}

function resetSaleForm() {
  $('saleForm').reset();
  $('saleDate').value = todayStr();
  $('salePayment').value = 'Paid';
  setFormMsg('saleMsg', '');
  updateSaleTotal();
}

async function onSaleSubmit(e) {
  e.preventDefault();
  const r = readSale();
  if (r.error) {
    setFormMsg('saleMsg', r.error);
    return;
  }
  setFormMsg('saleMsg', '');

  await guarded('addSale', $('saleSubmit'), async () => {
    await apiPost('addSale', r.payload);
    resetSaleForm();
    toast('Sale saved successfully.', 'success');
    await loadData({ silent: true });
  }, 'Saving...', 'saleMsg');
}

function filterSales() {
  const q = $('saleSearch').value.trim().toLowerCase();
  const from = $('saleFrom').value;
  const to = $('saleTo').value;
  const status = $('saleStatusFilter').value;

  const list = state.sales.filter((s) =>
    (!q || s.dealer.toLowerCase().includes(q)) &&
    (!from || s.date >= from) &&
    (!to || s.date <= to) &&
    (!status || s.paymentStatus === status)
  );
  return sortList(list, $('saleSort').value, 'total');
}

function saleRow(s) {
  const action = s.paymentStatus === 'Not Paid'
    ? `<button class="btn btn-success btn-sm" type="button" data-action="markPaid" data-id="${esc(s.id)}"><i data-lucide="check"></i> Mark Paid</button>`
    : '<span class="muted small">Paid</span>';

  return `<tr>
    <td data-label="Sale ID"><span class="mono">${esc(s.id)}</span></td>
    <td data-label="Date">${fmtDate(s.date)}</td>
    <td data-label="Dealer"><strong>${esc(s.dealer)}</strong></td>
    <td data-label="Qty" class="num">${num(s.quantity)}</td>
    <td data-label="Price" class="num">${money(s.price)}</td>
    <td data-label="Total" class="num"><strong>${money(s.total)}</strong></td>
    <td data-label="Status">${statusBadge(s.paymentStatus)}</td>
    <td data-label="Action" class="actions">${action}</td>
  </tr>`;
}

function renderSales() {
  const list = filterSales();
  setText('saleCount', `${num(list.length)} sale(s) shown`);
  setText('saleFilteredTotal', `Total: ${money(sumBy(list, 'total'))}`);
  $('saleTable').innerHTML = list.length
    ? list.map(saleRow).join('')
    : emptyRow(8, 'No sales found. Try changing the filters or add a new sale.');
}

async function markSalePaid(id, btn) {
  const sale = state.sales.find((s) => s.id === id);
  const detail = sale
    ? `${sale.dealer}, ${fmtDate(sale.date)}, ${money(sale.total)}`
    : `Sale ${id}`;
  const ok = await confirmAction({
    title: 'Mark this sale as Paid?',
    message: `${detail} will change from Not Paid to Paid. The original sale record is updated. No new sale is created.`,
    okText: 'Yes, mark as Paid',
    danger: false
  });
  if (!ok) return;

  await guarded('pay-' + id, btn, async () => {
    await apiPost('updateSalePayment', { id, paymentStatus: 'Paid' });
    toast('Sale marked as Paid.', 'success');
    await loadData({ silent: true });
  }, 'Updating...');
}

// ---------- EXPENSES ----------
function readExpense(ids) {
  const v = {};
  Object.keys(ids).forEach((k) => {
    v[k] = $(ids[k]).value;
  });

  if (!v.date) return { error: 'Please choose an expense date.' };
  if (!EXPENSE_CATEGORIES.includes(v.category)) return { error: 'Please choose an expense category.' };

  const description = cleanName(v.description);
  if (!description) return { error: 'Please enter a description.' };

  const amount = Number(v.amount);
  if (v.amount === '' || !Number.isFinite(amount) || amount <= 0) {
    return { error: 'Amount must be greater than zero.' };
  }

  if (!PAYMENT_METHODS.includes(v.method)) return { error: 'Please choose a payment method.' };
  if (!['Paid', 'Not Paid'].includes(v.status)) return { error: 'Please choose Paid or Not Paid.' };

  return {
    payload: {
      date: v.date,
      category: v.category,
      description,
      amount: roundMoney(amount),
      paymentMethod: v.method,
      paymentStatus: v.status
    }
  };
}

function resetExpenseForm() {
  $('expenseForm').reset();
  $('expDate').value = todayStr();
  $('expCategory').value = '';
  $('expMethod').value = 'Cash';
  $('expStatus').value = 'Paid';
  setFormMsg('expMsg', '');
}

async function onExpenseSubmit(e) {
  e.preventDefault();
  const r = readExpense(ADD_EXPENSE_IDS);
  if (r.error) {
    setFormMsg('expMsg', r.error);
    return;
  }
  setFormMsg('expMsg', '');

  await guarded('addExpense', $('expSubmit'), async () => {
    await apiPost('addExpense', r.payload);
    resetExpenseForm();
    toast('Expense saved successfully.', 'success');
    await loadData({ silent: true });
  }, 'Saving...', 'expMsg');
}

function filterExpenses() {
  const q = $('expSearch').value.trim().toLowerCase();
  const from = $('expFrom').value;
  const to = $('expTo').value;
  const category = $('expCategoryFilter').value;
  const method = $('expMethodFilter').value;
  const status = $('expStatusFilter').value;

  const list = state.expenses.filter((e) =>
    (!q || e.description.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)) &&
    (!from || e.date >= from) &&
    (!to || e.date <= to) &&
    (!category || e.category === category) &&
    (!method || e.paymentMethod === method) &&
    (!status || e.paymentStatus === status)
  );
  return sortList(list, $('expSort').value, 'amount');
}

function expenseRow(e) {
  return `<tr>
    <td data-label="Expense ID"><span class="mono">${esc(e.id)}</span></td>
    <td data-label="Date">${fmtDate(e.date)}</td>
    <td data-label="Category">${esc(e.category)}</td>
    <td data-label="Description">${esc(e.description)}</td>
    <td data-label="Amount" class="num"><strong>${money(e.amount)}</strong></td>
    <td data-label="Method">${esc(e.paymentMethod)}</td>
    <td data-label="Status">${statusBadge(e.paymentStatus)}</td>
    <td data-label="Actions" class="actions">
      <div class="btn-row">
        <button class="btn btn-ghost btn-sm" type="button" data-action="editExp" data-id="${esc(e.id)}"><i data-lucide="pencil"></i> Edit</button>
        <button class="btn btn-danger btn-sm" type="button" data-action="delExp" data-id="${esc(e.id)}"><i data-lucide="trash-2"></i> Delete</button>
      </div>
    </td>
  </tr>`;
}

function renderExpenses() {
  const list = filterExpenses();
  const paid = sumBy(list.filter(isPaid), 'amount');
  const unpaid = sumBy(list.filter((e) => !isPaid(e)), 'amount');
  setText('expPaidTotal', money(paid));
  setText('expUnpaidTotal', money(unpaid));
  setText('expRecordedTotal', money(roundMoney(paid + unpaid)));
  setText('expCount', `${num(list.length)} expense(s) shown`);
  $('expTable').innerHTML = list.length
    ? list.map(expenseRow).join('')
    : emptyRow(8, 'No expenses found. Try changing the filters or add a new expense.');
}

function ensureOption(select, value) {
  if (!value) return;
  const exists = Array.from(select.options).some((o) => o.value === value);
  if (!exists) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  }
}

function openExpenseEdit(id) {
  const e = state.expenses.find((x) => x.id === id);
  if (!e) {
    toast('Expense not found. Please refresh the data.', 'error');
    return;
  }
  ensureOption($('editCategory'), e.category);
  ensureOption($('editMethod'), e.paymentMethod);

  $('editId').value = e.id;
  $('editDate').value = e.date;
  $('editCategory').value = e.category;
  $('editDescription').value = e.description;
  $('editAmount').value = e.amount;
  $('editMethod').value = e.paymentMethod;
  $('editStatus').value = e.paymentStatus;
  setFormMsg('editMsg', '');

  $('expenseModal').classList.remove('hidden');
  $('editDate').focus();
}

function closeExpenseModal() {
  $('expenseModal').classList.add('hidden');
}

async function onEditSubmit(e) {
  e.preventDefault();
  const id = $('editId').value;
  const r = readExpense(EDIT_EXPENSE_IDS);
  if (r.error) {
    setFormMsg('editMsg', r.error);
    return;
  }
  setFormMsg('editMsg', '');

  await guarded('editExp', $('editSave'), async () => {
    await apiPost('updateExpense', { id, ...r.payload });
    closeExpenseModal();
    toast('Expense updated successfully.', 'success');
    await loadData({ silent: true });
  }, 'Saving...', 'editMsg');
}

async function deleteExpenseFlow(id, btn) {
  const e = state.expenses.find((x) => x.id === id);
  const detail = e ? `${e.description} (${money(e.amount)})` : `Expense ${id}`;
  const ok = await confirmAction({
    title: 'Delete this expense?',
    message: `${detail} will be permanently removed from your Google Sheet. This cannot be undone.`,
    okText: 'Delete',
    danger: true
  });
  if (!ok) return;

  await guarded('del-' + id, btn, async () => {
    await apiPost('deleteExpense', { id });
    toast('Expense deleted.', 'success');
    await loadData({ silent: true });
  }, 'Deleting...');
}

// ---------- DEALERS ----------
function renderDealers() {
  const q = $('dealerSearch').value.trim().toLowerCase();
  const list = dealerSummaries(state.sales).filter((d) => !q || d.name.toLowerCase().includes(q));

  $('dealerTable').innerHTML = list.length
    ? list.map((d) => `<tr class="${d.key === state.dealerKey ? 'selected' : ''}">
        <td data-label="Dealer"><strong>${esc(d.name)}</strong></td>
        <td data-label="Total Sales" class="num">${money(d.totalSales)}</td>
        <td data-label="Paid" class="num">${money(d.paidSales)}</td>
        <td data-label="Outstanding" class="num">${d.outstanding > 0
          ? `<span class="badge badge-unpaid">${money(d.outstanding)}</span>`
          : `<span class="badge badge-paid">${money(0)}</span>`}</td>
        <td data-label="Transactions" class="num">${num(d.count)}</td>
        <td data-label="Most Recent Sale">${fmtDate(d.lastDate)}</td>
        <td data-label="Action" class="actions">
          <button class="btn btn-ghost btn-sm" type="button" data-action="viewDealer" data-key="${esc(d.key)}"><i data-lucide="eye"></i> View</button>
        </td>
      </tr>`).join('')
    : emptyRow(7, 'No dealers found. Dealers appear here automatically after you add sales.');
}

function openDealer(key) {
  state.dealerKey = key;
  $('dealerDetail').classList.remove('hidden');
  renderDealers();
  renderDealerDetail();
  $('dealerDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeDealer() {
  state.dealerKey = null;
  $('dealerDetail').classList.add('hidden');
  renderDealers();
}

function getDealerSales() {
  const from = $('dealerFrom').value;
  const to = $('dealerTo').value;
  const list = state.sales.filter((s) =>
    dealerKey(s.dealer) === state.dealerKey && inRangeLoose(s.date, from, to)
  );
  return sortList(list, 'date-desc', 'total');
}

function renderDealerDetail() {
  if (!state.dealerKey) return;
  const summary = dealerSummaries(state.sales).find((d) => d.key === state.dealerKey);
  if (!summary) {
    closeDealer();
    return;
  }
  const list = getDealerSales();
  setText('dealerName', summary.name);
  setText('dTotal', money(sumBy(list, 'total')));
  setText('dPaid', money(sumBy(list.filter(isPaid), 'total')));
  setText('dOutstanding', money(summary.outstanding));
  setText('dCount', num(list.length));
  $('dealerHistoryTable').innerHTML = list.length
    ? list.map(saleRow).join('')
    : emptyRow(8, 'No transactions in the selected dates.');
}

// ---------- REPORT ENGINE ----------
function csvFilename(tag) {
  return `HariAgencies_${tag}_${todayStr()}.csv`;
}

function safeName(text) {
  return String(text || 'Dealer').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 40);
}

function salesReport(title, list, rangeText, tag, customSummary) {
  const rows = list.map((s) => [s.id, fmtDate(s.date), s.dealer, s.quantity, s.price, s.total, s.paymentStatus]);
  const summary = customSummary || [
    { label: 'Number of sales', value: list.length, type: 'num' },
    { label: 'Water cans sold', value: sumBy(list, 'quantity'), type: 'num' },
    { label: 'Total sales', value: sumBy(list, 'total'), type: 'money' },
    { label: 'Paid', value: sumBy(list.filter(isPaid), 'total'), type: 'money' },
    { label: 'Pending (Not Paid)', value: sumBy(list.filter((s) => !isPaid(s)), 'total'), type: 'money' }
  ];
  return {
    title,
    rangeText,
    columns: [
      { label: 'Sale ID' },
      { label: 'Date' },
      { label: 'Dealer' },
      { label: 'Quantity', type: 'num' },
      { label: 'Price (₹)', type: 'money' },
      { label: 'Total (₹)', type: 'money' },
      { label: 'Payment Status', type: 'status' }
    ],
    rows,
    summary,
    note: '',
    filename: csvFilename(tag)
  };
}

function expenseReport(title, list, rangeText, tag) {
  const rows = list.map((e) => [e.id, fmtDate(e.date), e.category, e.description, e.paymentMethod, e.paymentStatus, e.amount]);
  const paid = sumBy(list.filter(isPaid), 'amount');
  const unpaid = sumBy(list.filter((e) => !isPaid(e)), 'amount');
  return {
    title,
    rangeText,
    columns: [
      { label: 'Expense ID' },
      { label: 'Date' },
      { label: 'Category' },
      { label: 'Description' },
      { label: 'Payment Method' },
      { label: 'Payment Status', type: 'status' },
      { label: 'Amount (₹)', type: 'money' }
    ],
    rows,
    summary: [
      { label: 'Number of expenses', value: list.length, type: 'num' },
      { label: 'Total recorded expenses', value: roundMoney(paid + unpaid), type: 'money' },
      { label: 'Paid expenses', value: paid, type: 'money' },
      { label: 'Unpaid expenses', value: unpaid, type: 'money' }
    ],
    note: 'Unpaid expenses are recorded but have not yet been paid out.',
    filename: csvFilename(tag)
  };
}

function dealerOutstandingReport() {
  const list = dealerSummaries(state.sales)
    .filter((d) => d.outstanding > 0)
    .sort((a, b) => b.outstanding - a.outstanding);

  return {
    title: 'Dealer Outstanding Report',
    rangeText: 'Current balances (all time)',
    columns: [
      { label: 'Dealer' },
      { label: 'Unpaid Sales', type: 'num' },
      { label: 'Outstanding (₹)', type: 'money' },
      { label: 'Most Recent Sale' }
    ],
    rows: list.map((d) => [d.name, d.unpaidCount, d.outstanding, fmtDate(d.lastDate)]),
    summary: [
      { label: 'Dealers with balances', value: list.length, type: 'num' },
      { label: 'Total outstanding', value: sumBy(list, 'outstanding'), type: 'money' }
    ],
    note: 'Outstanding balance = total of sales marked Not Paid. Partial payments are not tracked in this system.',
    filename: csvFilename('Dealer_Outstanding')
  };
}

function dealerStatementReport(key, from, to) {
  const dealer = dealerSummaries(state.sales).find((d) => d.key === key);
  if (!dealer) throw new Error('Dealer not found. Please refresh and try again.');

  const list = sortList(
    state.sales.filter((s) => dealerKey(s.dealer) === key && inRangeLoose(s.date, from, to)),
    'date-asc',
    'total'
  );

  return salesReport(
    'Dealer Statement: ' + dealer.name,
    list,
    describeRange(from, to),
    'Dealer_Statement_' + safeName(dealer.name),
    [
      { label: 'Transactions', value: list.length, type: 'num' },
      { label: 'Total purchases', value: sumBy(list, 'total'), type: 'money' },
      { label: 'Paid in selected dates', value: sumBy(list.filter(isPaid), 'total'), type: 'money' },
      { label: 'Outstanding balance (all time)', value: dealer.outstanding, type: 'money' }
    ]
  );
}

function financialReport(from, to) {
  const sales = state.sales.filter((s) => inRangeLoose(s.date, from, to));
  const exps = state.expenses.filter((e) => inRangeLoose(e.date, from, to));

  const totalSales = sumBy(sales, 'total');
  const paidSales = sumBy(sales.filter(isPaid), 'total');
  const pendingSales = sumBy(sales.filter((s) => !isPaid(s)), 'total');
  const paidExp = sumBy(exps.filter(isPaid), 'amount');
  const unpaidExp = sumBy(exps.filter((e) => !isPaid(e)), 'amount');
  const totalExp = roundMoney(paidExp + unpaidExp);

  return {
    title: 'Financial Summary Report',
    rangeText: describeRange(from, to),
    columns: [{ label: 'Item' }, { label: 'Amount (₹)', type: 'money' }],
    rows: [
      ['Total Sales', totalSales],
      ['Paid Sales', paidSales],
      ['Pending Sales (Not Paid)', pendingSales],
      ['Total Recorded Expenses', totalExp],
      ['Paid Expenses', paidExp],
      ['Unpaid Expenses', unpaidExp],
      ['Sales Minus Total Recorded Expenses', roundMoney(totalSales - totalExp)],
      ['Collections Minus Paid Expenses', roundMoney(paidSales - paidExp)]
    ],
    summary: [
      { label: 'Water cans sold', value: sumBy(sales, 'quantity'), type: 'num' },
      { label: 'Number of sales', value: sales.length, type: 'num' },
      { label: 'Number of expenses', value: exps.length, type: 'num' }
    ],
    note: 'Sales Minus Total Recorded Expenses is not actual business profit, because other business costs may not be recorded in this system. Total Recorded Expenses = Paid Expenses + Unpaid Expenses.',
    filename: csvFilename('Financial_Summary')
  };
}

function buildReport(kind) {
  const date = $('rDate').value;
  const month = $('rMonth').value;
  const year = $('rYear').value.trim();
  const dealerValue = $('rDealer').value;
  const from = $('rFrom').value;
  const to = $('rTo').value;

  if (from && to && from > to) {
    throw new Error('The "From" date must be before the "To" date.');
  }

  const rangeText = describeRange(from, to);
  const inR = (d) => inRangeLoose(d, from, to);
  const sales = state.sales;
  const exps = state.expenses;

  switch (kind) {
    case 'sales-daily':
      if (!date) throw new Error('Please choose a date.');
      return salesReport('Daily Sales Report', sales.filter((s) => s.date === date), fmtDate(date), 'Sales_Daily');

    case 'sales-monthly':
      if (!month) throw new Error('Please choose a month.');
      return salesReport('Monthly Sales Report', sales.filter((s) => s.date.startsWith(month)), monthLabel(month), 'Sales_Monthly');

    case 'sales-yearly':
      if (!/^\d{4}$/.test(year)) throw new Error('Please enter a valid year (for example 2026).');
      return salesReport('Yearly Sales Report', sales.filter((s) => s.date.startsWith(year)), 'Year ' + year, 'Sales_Yearly');

    case 'sales-custom':
      return salesReport('Custom Date Range Sales Report', sales.filter((s) => inR(s.date)), rangeText, 'Sales_Custom');

    case 'sales-paid':
      return salesReport('Paid Sales Report', sales.filter((s) => isPaid(s) && inR(s.date)), rangeText, 'Sales_Paid');

    case 'sales-unpaid':
      return salesReport('Unpaid Sales Report', sales.filter((s) => !isPaid(s) && inR(s.date)), rangeText, 'Sales_Unpaid');

    case 'exp-daily':
      if (!date) throw new Error('Please choose a date.');
      return expenseReport('Daily Expense Report', exps.filter((e) => e.date === date), fmtDate(date), 'Expenses_Daily');

    case 'exp-monthly':
      if (!month) throw new Error('Please choose a month.');
      return expenseReport('Monthly Expense Report', exps.filter((e) => e.date.startsWith(month)), monthLabel(month), 'Expenses_Monthly');

    case 'exp-yearly':
      if (!/^\d{4}$/.test(year)) throw new Error('Please enter a valid year (for example 2026).');
      return expenseReport('Yearly Expense Report', exps.filter((e) => e.date.startsWith(year)), 'Year ' + year, 'Expenses_Yearly');

    case 'exp-paid':
      return expenseReport('Paid Expense Report', exps.filter((e) => isPaid(e) && inR(e.date)), rangeText, 'Expenses_Paid');

    case 'exp-unpaid':
      return expenseReport('Unpaid Expense Report', exps.filter((e) => !isPaid(e) && inR(e.date)), rangeText, 'Expenses_Unpaid');

    case 'dealer-outstanding':
      return dealerOutstandingReport();

    case 'dealer-statement':
      if (!dealerValue) throw new Error('Please choose a dealer.');
      return dealerStatementReport(dealerValue, from, to);

    case 'financial':
      return financialReport(from, to);

    default:
      throw new Error('Please choose a report type.');
  }
}

function displayValue(value, type) {
  if (type === 'money') return money(value);
  if (type === 'num') return num(value);
  return String(value);
}

function cellHtml(value, col, label) {
  const type = col && col.type;
  const attr = `data-label="${esc(label)}"`;
  if (type === 'money') return `<td class="num" ${attr}>${money(value)}</td>`;
  if (type === 'num') return `<td class="num" ${attr}>${num(value)}</td>`;
  if (type === 'status') return `<td ${attr}>${statusBadge(value)}</td>`;
  return `<td ${attr}>${esc(value)}</td>`;
}

/** Builds the printable/previewable HTML for a report. */
function reportHtml(rep) {
  const head = rep.columns.map((c) => {
    const numeric = c.type === 'money' || c.type === 'num';
    return `<th class="${numeric ? 'num' : ''}">${esc(c.label)}</th>`;
  }).join('');

  const body = rep.rows.length
    ? rep.rows.map((row) => `<tr>${row.map((v, i) => cellHtml(v, rep.columns[i], rep.columns[i].label)).join('')}</tr>`).join('')
    : emptyRow(rep.columns.length, 'No records match this report.');

  const summary = rep.summary.map((s) =>
    `<div><span>${esc(s.label)}</span><strong>${esc(displayValue(s.value, s.type))}</strong></div>`
  ).join('');

  return `<div class="report-doc">
    <div class="report-head">
      <div>
        <div class="report-biz">Hari Agencies</div>
        <h2>${esc(rep.title)}</h2>
        <div class="muted small">Period: ${esc(rep.rangeText)}</div>
      </div>
      <div class="report-meta">
        Generated: ${esc(fmtDate(todayStr()))}<br>
        BETracker Pro
      </div>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    ${summary ? `<div class="summary-box">${summary}</div>` : ''}
    ${rep.note ? `<p class="report-note">${esc(rep.note)}</p>` : ''}
  </div>`;
}

/** Escapes one CSV cell and protects against spreadsheet formula injection. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@]/.test(s)) {
    s = "'" + s;
  }
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function reportToCsv(rep) {
  const lines = [];
  lines.push(csvCell('Hari Agencies'));
  lines.push(csvCell(rep.title));
  lines.push(csvCell('Period: ' + rep.rangeText));
  lines.push(csvCell('Generated: ' + fmtDate(todayStr())));
  lines.push('');
  lines.push(rep.columns.map((c) => csvCell(c.label)).join(','));
  rep.rows.forEach((row) => lines.push(row.map((v) => csvCell(v)).join(',')));
  lines.push('');
  rep.summary.forEach((s) => lines.push(csvCell(s.label) + ',' + csvCell(s.value)));
  if (rep.note) lines.push(csvCell('Note') + ',' + csvCell(rep.note));
  // BOM so Excel shows the ₹ symbol and special characters correctly
  return '\uFEFF' + lines.join('\r\n');
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadReportCsv(rep) {
  downloadFile(rep.filename, reportToCsv(rep), 'text/csv;charset=utf-8');
  toast('CSV download started.', 'success');
}

function printReport(rep) {
  $('printArea').innerHTML = reportHtml(rep);
  window.print();
}

function setReportButtons(enabled) {
  $('rCsv').disabled = !enabled;
  $('rPrint').disabled = !enabled;
}

function updateReportFields() {
  const kind = $('reportType').value;
  const fields = REPORT_FIELDS[kind] || [];
  $('rf-date').classList.toggle('hidden', !fields.includes('date'));
  $('rf-month').classList.toggle('hidden', !fields.includes('month'));
  $('rf-year').classList.toggle('hidden', !fields.includes('year'));
  $('rf-dealer').classList.toggle('hidden', !fields.includes('dealer'));
  $('rf-range').classList.toggle('hidden', !fields.includes('range'));
  state.report = null;
  setReportButtons(false);
  $('reportOutput').innerHTML = `<div class="empty-state">
    <i data-lucide="file-text"></i>
    <p>Choose a report type above and click Generate Report.</p>
  </div>`;
  refreshIcons();
}

function generateReport() {
  try {
    const rep = buildReport($('reportType').value);
    state.report = rep;
    $('reportOutput').innerHTML = reportHtml(rep);
    setReportButtons(true);
    refreshIcons();
  } catch (err) {
    state.report = null;
    setReportButtons(false);
    toast(err.message, 'error');
  }
}

// ---------- LIST EXPORTS (Sales / Expenses / Dealer statement) ----------
function exportSalesList(mode) {
  const rep = salesReport('Sales History', filterSales(), 'Filtered list (as shown on screen)', 'Sales_History');
  if (mode === 'csv') downloadReportCsv(rep);
  else printReport(rep);
}

function exportExpenseList(mode) {
  const rep = expenseReport('Expense History', filterExpenses(), 'Filtered list (as shown on screen)', 'Expense_History');
  if (mode === 'csv') downloadReportCsv(rep);
  else printReport(rep);
}

function exportDealerStatement(mode) {
  if (!state.dealerKey) return;
  const summary = dealerSummaries(state.sales).find((d) => d.key === state.dealerKey);
  if (!summary) return;
  const from = $('dealerFrom').value;
  const to = $('dealerTo').value;
  const rep = dealerStatementReport(state.dealerKey, from, to);
  if (mode === 'csv') downloadReportCsv(rep);
  else printReport(rep);
}

// ---------- NAVIGATION ----------
function showView(name) {
  if (!['dashboard', 'sales', 'expenses', 'dealers', 'reports'].includes(name)) {
    name = 'dashboard';
  }
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === 'view-' + name);
  });
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  state.view = name;
  history.replaceState(null, '', '#' + name);
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (name === 'dashboard') renderDashboard();
  refreshIcons();
}

function toggleSidebar() {
  document.body.classList.toggle('sidebar-collapsed');
  try {
    localStorage.setItem('betracker-sidebar', document.body.classList.contains('sidebar-collapsed') ? '1' : '0');
  } catch (err) {
    // Storage may be blocked; the toggle still works for this session.
  }
}

function restoreSidebar() {
  try {
    if (localStorage.getItem('betracker-sidebar') === '1') {
      document.body.classList.add('sidebar-collapsed');
    }
  } catch (err) {
    // Ignore storage errors.
  }
}

// ---------- EVENT HANDLERS ----------
async function onDocumentClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const key = btn.dataset.key;

  if (action === 'markPaid') return markSalePaid(id, btn);
  if (action === 'editExp') return openExpenseEdit(id);
  if (action === 'delExp') return deleteExpenseFlow(id, btn);
  if (action === 'viewDealer') return openDealer(key);
}

function bindEvents() {
  // Navigation (sidebar and bottom bar)
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.addEventListener('click', () => showView(b.dataset.view));
  });
  $('sidebarToggle').addEventListener('click', toggleSidebar);
  $('refreshBtn').addEventListener('click', () => loadData());

  // Dashboard
  $('dashPeriod').addEventListener('change', renderDashboard);
  $('dashFrom').addEventListener('change', renderDashboard);
  $('dashTo').addEventListener('change', renderDashboard);

  // Sales
  $('saleQty').addEventListener('input', updateSaleTotal);
  $('salePrice').addEventListener('input', updateSaleTotal);
  $('saleForm').addEventListener('submit', onSaleSubmit);
  $('saleReset').addEventListener('click', resetSaleForm);
  ['saleSearch', 'saleFrom', 'saleTo', 'saleStatusFilter', 'saleSort'].forEach((id) => {
    $(id).addEventListener('input', renderSales);
    $(id).addEventListener('change', renderSales);
  });
  $('saleCsv').addEventListener('click', () => exportSalesList('csv'));
  $('salePrint').addEventListener('click', () => exportSalesList('print'));

  // Expenses
  $('expenseForm').addEventListener('submit', onExpenseSubmit);
  $('expReset').addEventListener('click', resetExpenseForm);
  ['expSearch', 'expFrom', 'expTo', 'expCategoryFilter', 'expMethodFilter', 'expStatusFilter', 'expSort'].forEach((id) => {
    $(id).addEventListener('input', renderExpenses);
    $(id).addEventListener('change', renderExpenses);
  });
  $('expCsv').addEventListener('click', () => exportExpenseList('csv'));
  $('expPrint').addEventListener('click', () => exportExpenseList('print'));

  // Expense edit modal
  $('editForm').addEventListener('submit', onEditSubmit);
  $('editCancel').addEventListener('click', closeExpenseModal);
  $('expenseModalClose').addEventListener('click', closeExpenseModal);
  $('expenseModal').addEventListener('click', (e) => {
    if (e.target === $('expenseModal')) closeExpenseModal();
  });

  // Confirm dialog
  $('confirmOk').addEventListener('click', () => closeConfirm(true));
  $('confirmCancel').addEventListener('click', () => closeConfirm(false));
  $('confirmModal').addEventListener('click', (e) => {
    if (e.target === $('confirmModal')) closeConfirm(false);
  });

  // Dealers
  $('dealerSearch').addEventListener('input', renderDealers);
  ['dealerFrom', 'dealerTo'].forEach((id) => {
    $(id).addEventListener('input', renderDealerDetail);
    $(id).addEventListener('change', renderDealerDetail);
  });
  $('dealerClose').addEventListener('click', closeDealer);
  $('dealerCsv').addEventListener('click', () => exportDealerStatement('csv'));
  $('dealerPrint').addEventListener('click', () => exportDealerStatement('print'));

  // Reports
  $('reportType').addEventListener('change', updateReportFields);
  $('rGenerate').addEventListener('click', generateReport);
  $('rCsv').addEventListener('click', () => {
    if (state.report) downloadReportCsv(state.report);
  });
  $('rPrint').addEventListener('click', () => {
    if (state.report) printReport(state.report);
  });

  // Table action buttons (delegated)
  document.addEventListener('click', onDocumentClick);

  // Escape closes dialogs
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('confirmModal').classList.contains('hidden')) {
      closeConfirm(false);
    } else if (!$('expenseModal').classList.contains('hidden')) {
      closeExpenseModal();
    }
  });
}

// ---------- INITIALISATION ----------
function populateSelect(id, items, placeholder) {
  const select = $(id);
  const first = placeholder !== null ? `<option value="">${esc(placeholder)}</option>` : '';
  select.innerHTML = first + items.map((item) => `<option value="${esc(item)}">${esc(item)}</option>`).join('');
}

function setDefaultDates() {
  const t = todayStr();
  $('dashFrom').value = monthStart(t);
  $('dashTo').value = t;
  $('rDate').value = t;
  $('rMonth').value = t.slice(0, 7);
  $('rYear').value = t.slice(0, 4);
  $('rFrom').value = monthStart(t);
  $('rTo').value = t;
  $('dealerFrom').value = '';
  $('dealerTo').value = '';
  $('todayText').textContent = fmtDate(t);
}

function init() {
  buildAuthUi();

  populateSelect('expCategory', EXPENSE_CATEGORIES, 'Select a category');
  populateSelect('editCategory', EXPENSE_CATEGORIES, 'Select a category');
  populateSelect('expCategoryFilter', EXPENSE_CATEGORIES, 'All categories');
  populateSelect('expMethod', PAYMENT_METHODS, null);
  populateSelect('editMethod', PAYMENT_METHODS, null);
  populateSelect('expMethodFilter', PAYMENT_METHODS, 'All methods');

  setDefaultDates();
  resetSaleForm();
  resetExpenseForm();
  updateReportFields();
  restoreSidebar();
  bindEvents();

  const hashView = location.hash.replace('#', '');
  showView(hashView || 'dashboard');
  refreshIcons();

  startApp();
}

document.addEventListener('DOMContentLoaded', init);