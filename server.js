const express = require('express');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'store.json');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const BACKUP_DIR = path.join(__dirname, 'backups');
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const LOCKOUT_MS = 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 3;
const AUTOMATION_POLL_MS = 60 * 1000;
const ORDER_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const ORDER_RATE_LIMIT_MAX = 8;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR });

const sessions = new Map();
const loginAttempts = new Map();
const orderRateLimits = new Map();

app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

function loadStore() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function ensureTaxEnvelope(store) {
  if (!store.taxEnvelope) {
    store.taxEnvelope = { balance: 0, transactions: [] };
  }
  if (!Array.isArray(store.taxEnvelope.transactions)) {
    store.taxEnvelope.transactions = [];
  }
}

function ensureGivingEnvelope(store) {
  if (!store.givingEnvelope) {
    store.givingEnvelope = { titheBalance: 0, offeringBalance: 0, transactions: [] };
  }
  if (!Array.isArray(store.givingEnvelope.transactions)) {
    store.givingEnvelope.transactions = [];
  }
  store.givingEnvelope.titheBalance = Number(store.givingEnvelope.titheBalance || 0);
  store.givingEnvelope.offeringBalance = Number(store.givingEnvelope.offeringBalance || 0);
}

function hashPassword(rawPassword) {
  return `sha256:${crypto.createHash('sha256').update(String(rawPassword)).digest('hex')}`;
}

function verifyPassword(inputPassword, savedPassword) {
  if (!savedPassword) return false;
  if (savedPassword.startsWith('sha256:')) return hashPassword(inputPassword) === savedPassword;
  return inputPassword === savedPassword;
}

function addEvent(store, type, message, meta = {}) {
  store.automationEvents = store.automationEvents || [];
  store.automationEvents.unshift({
    id: uuidv4(),
    type,
    message,
    meta,
    createdAt: new Date().toISOString()
  });
  store.automationEvents = store.automationEvents.slice(0, 200);
}

function queueEmail(store, { to, subject, body, template = 'general', orderId = '' }) {
  store.emailQueue = store.emailQueue || [];
  store.emailQueue.unshift({
    id: uuidv4(),
    to,
    subject,
    body,
    template,
    orderId,
    createdAt: new Date().toISOString(),
    status: 'queued'
  });
  store.emailQueue = store.emailQueue.slice(0, 500);
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = orderRateLimits.get(ip) || { count: 0, resetAt: now + ORDER_RATE_LIMIT_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + ORDER_RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  orderRateLimits.set(ip, entry);
  return entry.count > ORDER_RATE_LIMIT_MAX;
}

function sanitizePublicStore(store) {
  return {
    settings: {
      businessName: store.settings.businessName,
      businessEmail: store.settings.businessEmail,
      instagramUrl: store.settings.instagramUrl,
      payment: store.settings.payment,
      editableContent: store.settings.editableContent
    },
    products: store.products.filter((p) => p.visible)
  };
}

function authRequired(req, res, next) {
  const sid = req.cookies.pureSoleAdminSession;
  const session = sid ? sessions.get(sid) : null;

  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  if (Date.now() - session.lastActive > SESSION_TIMEOUT_MS) {
    sessions.delete(sid);
    return res.status(401).json({ error: 'Session expired' });
  }

  session.lastActive = Date.now();
  next();
}

function getOrderMetrics(orders) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - todayStart.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);

  const ranges = {
    today: 0,
    week: 0,
    month: 0,
    year: 0
  };

  let revenue = 0;
  let profit = 0;

  orders.forEach((order) => {
    const created = new Date(order.createdAt);
    if (created >= todayStart) ranges.today += 1;
    if (created >= weekStart) ranges.week += 1;
    if (created >= monthStart) ranges.month += 1;
    if (created >= yearStart) ranges.year += 1;
    revenue += order.total;
    profit += order.profit;
  });

  const taxWithheld = profit * 0.25;
  const spendableProfit = profit - taxWithheld;

  return { ranges, revenue, profit, taxWithheld, spendableProfit };
}

function quarterInfo(year = new Date().getFullYear()) {
  const deadlines = [
    `${year}-04-15`,
    `${year}-06-15`,
    `${year}-09-15`,
    `${year + 1}-01-15`
  ];
  return deadlines.map((deadline, index) => ({
    quarter: `Q${index + 1}`,
    deadline,
    reminderOn: new Date(new Date(deadline).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  }));
}

function mockMarketIntelligence(products) {
  const sneakerProducts = products.filter((p) => p.category === 'Sneakers').slice(0, 10);
  return sneakerProducts.map((p, idx) => ({
    rank: idx + 1,
    product: p.name,
    priceTrend: idx % 2 === 0 ? 'Up' : 'Down',
    bestSize: ['8', '9', '10', '11'][idx % 4],
    opportunity: `${Math.round(12 + idx * 1.8)}% margin potential`
  }));
}

app.get('/api/public-store', (req, res) => {
  const store = loadStore();
  res.json(sanitizePublicStore(store));
});

app.get('/api/payment-methods', (req, res) => {
  const store = loadStore();
  const methods = store.settings.paymentMethodCatalog || ['Cash App', 'Bank Transfer', 'Venmo', 'PayPal'];
  res.json({ methods });
});

app.post('/api/orders', (req, res) => {
  const { customer, items, paymentMethod } = req.body;
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many order attempts. Please wait a few minutes and try again.' });
  }
  if (!customer?.name || !customer?.email || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Missing order details' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const store = loadStore();
  const productMap = new Map(store.products.map((p) => [p.id, p]));
  let total = 0;
  let cost = 0;

  const normalizedItems = items.map((item) => {
    const product = productMap.get(item.productId);
    if (!product) throw new Error('Invalid product in cart');
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) throw new Error('Invalid quantity');
    if (item.size && String(item.size).length > 20) throw new Error('Invalid size');
    total += product.price * item.quantity;
    cost += product.cost * item.quantity;
    return {
      ...item,
      name: product.name,
      price: product.price
    };
  });

  const profit = total - cost;
  const order = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    status: 'Pending Payment',
    trackingNumber: '',
    customer,
    items: normalizedItems,
    paymentMethod,
    total,
    cost,
    profit
  };

  store.orders.unshift(order);
  addEvent(store, 'order', `New order received: ${order.id}`, { orderId: order.id, customer: customer.email });
  if (store.settings?.automation?.autoCustomerEmails) {
    addEvent(
      store,
      'email',
      `Automated confirmation prepared for ${customer.email}`,
      { orderId: order.id, template: 'order-confirmation' }
    );
    queueEmail(store, {
      to: customer.email,
      subject: `Order received: ${order.id}`,
      body: `Thanks ${customer.name}, we received your order and are waiting for payment confirmation.`,
      template: 'order-confirmation',
      orderId: order.id
    });
  }
  saveStore(store);

  res.json({ message: 'Order created. Complete payment to confirm.', orderId: order.id, status: order.status });
});

app.post('/api/payments/create-checkout-session', (req, res) => {
  const { orderId, provider } = req.body;
  if (!orderId || !provider) return res.status(400).json({ error: 'orderId and provider are required' });
  const store = loadStore();
  const order = store.orders.find((o) => o.id === orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const keyExists = provider === 'stripe'
    ? Boolean(store.settings.paymentProviders?.stripeSecretKey)
    : Boolean(store.settings.paymentProviders?.paypalClientId);
  const hostedBase = store.settings.hostedBaseUrl || `http://localhost:${PORT}`;
  const paymentUrl = keyExists
    ? `${hostedBase}/pay/${provider}?orderId=${orderId}`
    : `${hostedBase}/checkout?orderId=${orderId}&provider=${provider}`;
  addEvent(store, 'payment', `Checkout session created via ${provider}`, { orderId, provider });
  saveStore(store);
  res.json({ paymentUrl, provider, mode: keyExists ? 'live-configured' : 'sandbox-placeholder' });
});

app.post('/api/webhooks/payment', (req, res) => {
  const { orderId, paymentStatus, transactionId, provider } = req.body;
  const store = loadStore();
  const webhookSecret = req.headers['x-webhook-secret'];
  const expectedSecret = provider === 'paypal' ? store.settings.paymentProviders?.paypalWebhookId : store.settings.paymentProviders?.stripeWebhookSecret;
  if (expectedSecret && webhookSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  const idx = store.orders.findIndex((o) => o.id === orderId);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });
  if (paymentStatus === 'paid') {
    const wasAlreadyPaid = store.orders[idx].status === 'Payment Confirmed';
    store.orders[idx].status = 'Payment Confirmed';
    store.orders[idx].transactionId = transactionId || '';
    store.orders[idx].paidAt = new Date().toISOString();
    addEvent(store, 'payment', `Payment confirmed by webhook (${provider || 'unknown'})`, { orderId, transactionId });
    if (store.settings?.automation?.autoCustomerEmails) {
      queueEmail(store, {
        to: store.orders[idx].customer.email,
        subject: `Payment confirmed: ${orderId}`,
        body: `Your payment was confirmed and your Pure Sole order is now being sourced.`,
        template: 'payment-confirmed',
        orderId
      });
    }
    if (!wasAlreadyPaid) {
      ensureTaxEnvelope(store);
      const taxReserve = Number((store.orders[idx].profit * 0.25).toFixed(2));
      store.taxEnvelope.balance = Number((store.taxEnvelope.balance + taxReserve).toFixed(2));
      store.taxEnvelope.transactions.unshift({
        id: uuidv4(),
        createdAt: new Date().toISOString(),
        type: 'auto-reserve',
        amount: taxReserve,
        note: `Auto reserved 25% from order ${orderId}`,
        orderId
      });
      addEvent(store, 'tax-envelope', `Auto-reserved ${taxReserve} for IRS envelope`, { orderId, taxReserve });
    }
  }
  saveStore(store);
  res.json({ ok: true, order: store.orders[idx] });
});

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  const attempts = loginAttempts.get(ip) || { failed: 0, lockedUntil: 0 };
  if (attempts.lockedUntil > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Locked for 1 hour.' });
  }

  const { password } = req.body;
  const store = loadStore();

  if (!verifyPassword(password, store.settings.adminPassword)) {
    attempts.failed += 1;
    if (attempts.failed >= MAX_FAILED_ATTEMPTS) {
      attempts.lockedUntil = Date.now() + LOCKOUT_MS;
      attempts.failed = 0;
    }
    loginAttempts.set(ip, attempts);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  loginAttempts.delete(ip);
  const sid = uuidv4();
  sessions.set(sid, { createdAt: Date.now(), lastActive: Date.now() });
  res.cookie('pureSoleAdminSession', sid, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
  res.json({ ok: true });
});

app.post('/api/admin/logout', authRequired, (req, res) => {
  const sid = req.cookies.pureSoleAdminSession;
  sessions.delete(sid);
  res.clearCookie('pureSoleAdminSession');
  res.json({ ok: true });
});

app.get('/api/admin/bootstrap', authRequired, (req, res) => {
  const store = loadStore();
  const metrics = getOrderMetrics(store.orders);

  const bestSelling = [...store.orders.reduce((acc, order) => {
    order.items.forEach((item) => {
      const current = acc.get(item.productId) || { name: item.name, qty: 0 };
      current.qty += item.quantity;
      acc.set(item.productId, current);
    });
    return acc;
  }, new Map()).values()].sort((a, b) => b.qty - a.qty).slice(0, 5);

  res.json({
    store,
    metrics,
    recentOrders: store.orders.slice(0, 10),
    bestSelling,
    quarterly: quarterInfo(),
    marketData: mockMarketIntelligence(store.products)
  });
});

app.get('/api/admin/crm', authRequired, (req, res) => {
  const store = loadStore();
  const crm = Object.values(store.orders.reduce((acc, order) => {
    const email = order.customer.email.toLowerCase();
    const current = acc[email] || {
      customerName: order.customer.name,
      email,
      orders: 0,
      totalSpend: 0,
      totalProfit: 0,
      lastOrderAt: ''
    };
    current.orders += 1;
    current.totalSpend += order.total;
    current.totalProfit += order.profit;
    current.lastOrderAt = !current.lastOrderAt || new Date(order.createdAt) > new Date(current.lastOrderAt) ? order.createdAt : current.lastOrderAt;
    acc[email] = current;
    return acc;
  }, {}));
  crm.sort((a, b) => b.totalSpend - a.totalSpend);
  res.json({
    repeatCustomers: crm.filter((c) => c.orders > 1),
    topSpenders: crm.slice(0, 20),
    totalCustomers: crm.length
  });
});

app.get('/api/admin/tax-envelope', authRequired, (req, res) => {
  const store = loadStore();
  ensureTaxEnvelope(store);
  const metrics = getOrderMetrics(store.orders);
  const delta = Number((store.taxEnvelope.balance - metrics.taxWithheld).toFixed(2));
  res.json({
    balance: store.taxEnvelope.balance,
    recommendedReserve: Number(metrics.taxWithheld.toFixed(2)),
    differenceVsRecommended: delta,
    transactions: store.taxEnvelope.transactions.slice(0, 100)
  });
});

app.get('/api/admin/giving-envelope', authRequired, (req, res) => {
  const store = loadStore();
  ensureGivingEnvelope(store);
  const metrics = getOrderMetrics(store.orders);
  const suggestedTithe = Number((metrics.profit * 0.10).toFixed(2));
  res.json({
    titheBalance: Number(store.givingEnvelope.titheBalance.toFixed(2)),
    offeringBalance: Number(store.givingEnvelope.offeringBalance.toFixed(2)),
    totalGivingBalance: Number((store.givingEnvelope.titheBalance + store.givingEnvelope.offeringBalance).toFixed(2)),
    suggestedTithe,
    transactions: store.givingEnvelope.transactions.slice(0, 100),
    methods: store.settings.paymentMethodCatalog || []
  });
});

app.post('/api/admin/giving-envelope/deposit', authRequired, (req, res) => {
  const store = loadStore();
  ensureGivingEnvelope(store);
  const amount = Number(req.body.amount || 0);
  const bucket = String(req.body.bucket || '').toLowerCase();
  const method = String(req.body.method || 'Cash App');
  const note = (req.body.note || '').toString();
  if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than 0' });
  if (!['tithe', 'offering'].includes(bucket)) return res.status(400).json({ error: 'Bucket must be tithe or offering' });

  if (bucket === 'tithe') store.givingEnvelope.titheBalance = Number((store.givingEnvelope.titheBalance + amount).toFixed(2));
  if (bucket === 'offering') store.givingEnvelope.offeringBalance = Number((store.givingEnvelope.offeringBalance + amount).toFixed(2));
  store.givingEnvelope.transactions.unshift({
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    type: 'deposit',
    bucket,
    amount,
    method,
    note
  });
  addEvent(store, 'giving-envelope', `Added ${amount.toFixed(2)} to ${bucket} via ${method}`, { bucket, amount, method });
  saveStore(store);
  res.json({
    ok: true,
    titheBalance: store.givingEnvelope.titheBalance,
    offeringBalance: store.givingEnvelope.offeringBalance
  });
});

app.post('/api/admin/giving-envelope/withdraw', authRequired, (req, res) => {
  const store = loadStore();
  ensureGivingEnvelope(store);
  const amount = Number(req.body.amount || 0);
  const bucket = String(req.body.bucket || '').toLowerCase();
  const method = String(req.body.method || 'Bank Transfer');
  const note = (req.body.note || 'Church payout').toString();
  if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than 0' });
  if (!['tithe', 'offering'].includes(bucket)) return res.status(400).json({ error: 'Bucket must be tithe or offering' });

  if (bucket === 'tithe' && amount > store.givingEnvelope.titheBalance) return res.status(400).json({ error: 'Not enough tithe balance' });
  if (bucket === 'offering' && amount > store.givingEnvelope.offeringBalance) return res.status(400).json({ error: 'Not enough offering balance' });
  if (bucket === 'tithe') store.givingEnvelope.titheBalance = Number((store.givingEnvelope.titheBalance - amount).toFixed(2));
  if (bucket === 'offering') store.givingEnvelope.offeringBalance = Number((store.givingEnvelope.offeringBalance - amount).toFixed(2));

  store.givingEnvelope.transactions.unshift({
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    type: 'withdraw',
    bucket,
    amount,
    method,
    note
  });
  addEvent(store, 'giving-envelope', `Withdrew ${amount.toFixed(2)} from ${bucket} via ${method}`, { bucket, amount, method });
  saveStore(store);
  res.json({
    ok: true,
    titheBalance: store.givingEnvelope.titheBalance,
    offeringBalance: store.givingEnvelope.offeringBalance
  });
});

app.post('/api/admin/tax-envelope/deposit', authRequired, (req, res) => {
  const store = loadStore();
  ensureTaxEnvelope(store);
  const amount = Number(req.body.amount || 0);
  const note = (req.body.note || 'Manual tax envelope deposit').toString();
  if (!(amount > 0)) return res.status(400).json({ error: 'Deposit amount must be greater than 0' });
  store.taxEnvelope.balance = Number((store.taxEnvelope.balance + amount).toFixed(2));
  store.taxEnvelope.transactions.unshift({
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    type: 'manual-deposit',
    amount,
    note
  });
  addEvent(store, 'tax-envelope', `Manual tax envelope deposit: ${amount}`, { amount, note });
  saveStore(store);
  res.json({ ok: true, balance: store.taxEnvelope.balance });
});

app.post('/api/admin/tax-envelope/withdraw', authRequired, (req, res) => {
  const store = loadStore();
  ensureTaxEnvelope(store);
  const amount = Number(req.body.amount || 0);
  const note = (req.body.note || 'IRS payment or adjustment').toString();
  if (!(amount > 0)) return res.status(400).json({ error: 'Withdrawal amount must be greater than 0' });
  if (amount > store.taxEnvelope.balance) return res.status(400).json({ error: 'Cannot withdraw more than tax envelope balance' });
  store.taxEnvelope.balance = Number((store.taxEnvelope.balance - amount).toFixed(2));
  store.taxEnvelope.transactions.unshift({
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    type: 'withdrawal',
    amount,
    note
  });
  addEvent(store, 'tax-envelope', `Tax envelope withdrawal: ${amount}`, { amount, note });
  saveStore(store);
  res.json({ ok: true, balance: store.taxEnvelope.balance });
});

app.get('/api/admin/tax-envelope/payment-summary', authRequired, (req, res) => {
  const store = loadStore();
  ensureTaxEnvelope(store);
  const metrics = getOrderMetrics(store.orders);
  const recommendedReserve = Number(metrics.taxWithheld.toFixed(2));
  const envelopeBalance = Number(store.taxEnvelope.balance.toFixed(2));
  const amountOwedNow = Number(Math.max(recommendedReserve - envelopeBalance, 0).toFixed(2));
  const now = new Date().toISOString();

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Pure Sole Tax Payment Summary</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
    h1 { margin-bottom: 8px; }
    .box { border: 1px solid #ccc; border-radius: 8px; padding: 12px; margin: 12px 0; }
    .kpi { font-size: 22px; font-weight: bold; }
    @media print { button { display:none; } }
  </style>
</head>
<body>
  <h1>Pure Sole — IRS Payment Summary</h1>
  <p>Generated: ${now}</p>
  <div class="box"><div>Total Profit</div><div class="kpi">$${metrics.profit.toFixed(2)}</div></div>
  <div class="box"><div>Recommended Tax Reserve (25%)</div><div class="kpi">$${recommendedReserve.toFixed(2)}</div></div>
  <div class="box"><div>IRS Envelope Balance</div><div class="kpi">$${envelopeBalance.toFixed(2)}</div></div>
  <div class="box"><div>Amount Owed Now (recommended reserve minus envelope)</div><div class="kpi">$${amountOwedNow.toFixed(2)}</div></div>
  <p>This summary is for planning and recordkeeping. Confirm final obligations with your tax professional if needed.</p>
  <button onclick="window.print()">Print Payment Summary</button>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.post('/api/admin/products', authRequired, upload.single('image'), (req, res) => {
  const store = loadStore();
  const product = {
    id: uuidv4(),
    name: req.body.name,
    category: req.body.category,
    price: Number(req.body.price || 0),
    cost: Number(req.body.cost || 0),
    sizes: req.body.sizes ? req.body.sizes.split(',').map((s) => s.trim()) : [],
    image: req.file ? `/uploads/${path.basename(req.file.path)}` : '',
    visible: req.body.visible === 'true'
  };
  store.products.unshift(product);
  saveStore(store);
  res.json(product);
});

app.put('/api/admin/products/:id', authRequired, (req, res) => {
  const store = loadStore();
  const idx = store.products.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  store.products[idx] = { ...store.products[idx], ...req.body };
  saveStore(store);
  res.json(store.products[idx]);
});

app.delete('/api/admin/products/:id', authRequired, (req, res) => {
  const store = loadStore();
  store.products = store.products.filter((p) => p.id !== req.params.id);
  saveStore(store);
  res.json({ ok: true });
});

app.put('/api/admin/orders/:id', authRequired, (req, res) => {
  const store = loadStore();
  const idx = store.orders.findIndex((o) => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const prev = store.orders[idx];
  store.orders[idx] = { ...store.orders[idx], ...req.body };
  if (store.settings?.automation?.autoCustomerEmails) {
    if (req.body.status && req.body.status !== prev.status) {
      addEvent(store, 'email', `Automated status email prepared for ${prev.customer.email}`, {
        orderId: prev.id,
        status: req.body.status
      });
    }
    if (req.body.trackingNumber && req.body.trackingNumber !== prev.trackingNumber) {
      addEvent(store, 'email', `Tracking email prepared for ${prev.customer.email}`, {
        orderId: prev.id,
        trackingNumber: req.body.trackingNumber
      });
    }
  }
  saveStore(store);
  res.json(store.orders[idx]);
});

app.put('/api/admin/settings', authRequired, (req, res) => {
  const store = loadStore();
  const incomingPassword = req.body.adminPassword;
  const normalizedPassword = incomingPassword
    ? (String(incomingPassword).startsWith('sha256:') ? incomingPassword : hashPassword(incomingPassword))
    : store.settings.adminPassword;
  store.settings = {
    ...store.settings,
    ...req.body,
    adminPassword: normalizedPassword,
    payment: { ...store.settings.payment, ...(req.body.payment || {}) },
    apiKeys: { ...store.settings.apiKeys, ...(req.body.apiKeys || {}) },
    paymentProviders: { ...store.settings.paymentProviders, ...(req.body.paymentProviders || {}) },
    smtp: { ...store.settings.smtp, ...(req.body.smtp || {}) },
    automation: { ...store.settings.automation, ...(req.body.automation || {}) }
  };
  saveStore(store);
  res.json(store.settings);
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'Pure Sole', timestamp: new Date().toISOString() });
});

app.post('/api/admin/content/draft', authRequired, (req, res) => {
  const store = loadStore();
  store.contentDraft = req.body;
  saveStore(store);
  res.json({ ok: true });
});

app.post('/api/admin/content/publish', authRequired, (req, res) => {
  const store = loadStore();
  store.settings.editableContent = { ...store.settings.editableContent, ...store.contentDraft };
  store.contentDraft = null;
  saveStore(store);
  res.json({ ok: true, editableContent: store.settings.editableContent });
});

app.get('/api/admin/taxes/pdf', authRequired, (req, res) => {
  const store = loadStore();
  const metrics = getOrderMetrics(store.orders);

  const doc = new PDFDocument();
  const filename = `tax-summary-${Date.now()}.pdf`;
  const fullPath = path.join(__dirname, 'data', filename);
  const stream = fs.createWriteStream(fullPath);
  doc.pipe(stream);

  doc.fontSize(18).text('Pure Sole Tax Summary');
  doc.moveDown();
  doc.fontSize(12).text(`Generated: ${new Date().toISOString()}`);
  doc.text(`Total Profit: $${metrics.profit.toFixed(2)}`);
  doc.text(`Tax Withheld (25%): $${metrics.taxWithheld.toFixed(2)}`);
  doc.text(`Spendable Profit: $${metrics.spendableProfit.toFixed(2)}`);
  doc.moveDown().text('Quarterly Deadlines:');
  quarterInfo().forEach((q) => {
    doc.text(`${q.quarter} deadline: ${q.deadline} (reminder: ${q.reminderOn})`);
  });
  doc.end();

  stream.on('finish', () => {
    const relativePath = `/data/${filename}`;
    store.taxDocuments.unshift({ id: uuidv4(), createdAt: new Date().toISOString(), path: relativePath });
    saveStore(store);
    res.download(fullPath, filename);
  });
});

app.use('/data', express.static(path.join(__dirname, 'data')));

app.get('/api/admin/code/files', authRequired, (req, res) => {
  const allowed = ['server.js', 'public/index.html', 'public/admin.html', 'public/styles.css', 'public/app.js', 'public/admin.js'];
  res.json(allowed);
});

app.get('/api/admin/code/file', authRequired, (req, res) => {
  const file = req.query.file;
  const fullPath = path.join(__dirname, file);
  if (!fullPath.startsWith(__dirname)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Missing file' });
  res.json({ content: fs.readFileSync(fullPath, 'utf8') });
});

app.post('/api/admin/code/save', authRequired, (req, res) => {
  const { file, content } = req.body;
  const fullPath = path.join(__dirname, file);
  if (!fullPath.startsWith(__dirname)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Missing file' });

  const backupName = `${Date.now()}-${path.basename(file)}.bak`;
  fs.copyFileSync(fullPath, path.join(BACKUP_DIR, backupName));
  fs.writeFileSync(fullPath, content);
  res.json({ ok: true, backupName });
});

app.post('/api/admin/code/revert', authRequired, (req, res) => {
  const { file, backupName } = req.body;
  const fullPath = path.join(__dirname, file);
  const backupPath = path.join(BACKUP_DIR, backupName);
  if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup missing' });
  fs.copyFileSync(backupPath, fullPath);
  res.json({ ok: true });
});

app.post('/api/admin/ai-chat', authRequired, (req, res) => {
  const { role, message } = req.body;
  const store = loadStore();
  const metrics = getOrderMetrics(store.orders);

  let reply = 'I can help optimize Pure Sole operations. Try asking about pricing, taxes, or product strategy.';
  let links = [];

  if (/tax|quarter|withhold/i.test(message)) {
    reply = `Pure Sole has estimated tax withheld of $${metrics.taxWithheld.toFixed(2)} from total profit. Keep 25% reserved for taxes.`;
    links = [
      { label: 'IRS Estimated Taxes', url: 'https://www.irs.gov/businesses/small-businesses-self-employed/estimated-taxes' }
    ];
  } else if (/youtube|video/i.test(message)) {
    reply = 'Here are useful channels for sneaker reselling and business systems:';
    links = [
      { label: 'YouTube: Reselling tips', url: 'https://www.youtube.com/results?search_query=sneaker+reselling+tips' }
    ];
  } else if (/market|trend|price/i.test(message)) {
    reply = 'Market trend insight: focus on sizes 9-11 and limited drops with margin over 15%.';
    links = [
      { label: 'Google News sneaker market', url: 'https://news.google.com/search?q=sneaker%20resale%20market' }
    ];
  } else if (role === 'tax') {
    reply = `Based on stored orders, projected tax reserve is $${metrics.taxWithheld.toFixed(2)}. You can generate the PDF in the Taxes tab.`;
  }

  res.json({ reply, links });
});

app.get('/api/admin/automation', authRequired, (req, res) => {
  const store = loadStore();
  res.json({
    settings: store.settings.automation,
    events: (store.automationEvents || []).slice(0, 50)
  });
});

app.post('/api/admin/automation/run', authRequired, (req, res) => {
  runAutomations();
  const store = loadStore();
  res.json({ ok: true, events: (store.automationEvents || []).slice(0, 25) });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Pure Sole running on http://localhost:${PORT}`);
});

function runAutomations() {
  const store = loadStore();
  const automation = store.settings.automation || {};
  if (!automation.enabled) return;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  if (automation.quarterlyReminders) {
    quarterInfo().forEach((quarter) => {
      if (quarter.reminderOn === today) {
        const alreadySent = (store.automationEvents || []).some((event) =>
          event.type === 'tax-reminder' && event.meta?.quarter === quarter.quarter && event.meta?.date === today
        );
        if (!alreadySent) {
          addEvent(store, 'tax-reminder', `Quarterly tax reminder: ${quarter.quarter} due ${quarter.deadline}`, {
            quarter: quarter.quarter,
            deadline: quarter.deadline,
            date: today
          });
        }
      }
    });
  }

  if (automation.dailySummary) {
    const summaryKey = `daily-summary-${today}`;
    const alreadyLogged = (store.automationEvents || []).some((event) => event.meta?.summaryKey === summaryKey);
    if (!alreadyLogged) {
      const metrics = getOrderMetrics(store.orders);
      addEvent(store, 'daily-summary', `Daily summary generated for ${today}`, {
        summaryKey,
        revenue: metrics.revenue,
        profit: metrics.profit,
        spendableProfit: metrics.spendableProfit
      });
    }
  }

  if (automation.autoCustomerEmails) {
    const queued = (store.emailQueue || []).filter((mail) => mail.status === 'queued').slice(0, 10);
    queued.forEach((mail) => {
      mail.status = 'sent';
      mail.sentAt = new Date().toISOString();
      addEvent(store, 'email', `Auto email sent to ${mail.to}`, { orderId: mail.orderId, template: mail.template });
    });
  }

  saveStore(store);
}

setInterval(runAutomations, AUTOMATION_POLL_MS);
