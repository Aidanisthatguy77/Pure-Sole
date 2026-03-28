const express = require('express');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'store.json');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const BACKUP_DIR = path.join(__dirname, 'backups');
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const LOCKOUT_MS = 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 3;
const AUTOMATION_POLL_MS = 60 * 1000;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR });

const sessions = new Map();
const loginAttempts = new Map();

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

app.post('/api/orders', (req, res) => {
  const { customer, items, paymentMethod } = req.body;
  if (!customer?.name || !customer?.email || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Missing order details' });
  }

  const store = loadStore();
  const productMap = new Map(store.products.map((p) => [p.id, p]));
  let total = 0;
  let cost = 0;

  const normalizedItems = items.map((item) => {
    const product = productMap.get(item.productId);
    if (!product) throw new Error('Invalid product in cart');
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
    status: 'Payment Confirmed',
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
  }
  saveStore(store);

  res.json({ message: 'Order confirmed once payment is sent.', orderId: order.id });
});

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  const attempts = loginAttempts.get(ip) || { failed: 0, lockedUntil: 0 };
  if (attempts.lockedUntil > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Locked for 1 hour.' });
  }

  const { password } = req.body;
  const store = loadStore();

  if (password !== store.settings.adminPassword) {
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
  res.cookie('pureSoleAdminSession', sid, { httpOnly: true, sameSite: 'strict' });
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
  store.settings = {
    ...store.settings,
    ...req.body,
    payment: { ...store.settings.payment, ...(req.body.payment || {}) },
    apiKeys: { ...store.settings.apiKeys, ...(req.body.apiKeys || {}) },
    automation: { ...store.settings.automation, ...(req.body.automation || {}) }
  };
  saveStore(store);
  res.json(store.settings);
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

  saveStore(store);
}

setInterval(runAutomations, AUTOMATION_POLL_MS);
