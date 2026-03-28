let state = null;
let activeTab = 'dashboard';
let lastBackup = null;

const tabsNode = document.getElementById('tabs');

const wealthCards = [
  { title:'Roth IRA', url:'https://www.fidelity.com', text:'A Roth IRA lets your investments grow tax-free. Starting at age 18 with $200/month can potentially grow beyond $900,000 by age 65 depending on return assumptions.' },
  { title:'Whole Life Insurance', url:'https://www.policygenius.com', text:'Locking a policy young can mean lower lifetime rates, cash value growth, and family protection as income grows.' },
  { title:'Get Your EIN Free', url:'https://www.irs.gov/businesses/small-businesses-self-employed/employer-id-numbers', text:'An EIN helps protect your SSN and is useful once revenue grows around $5,000 and vendor paperwork increases.' },
  { title:'Form Your LLC', url:'https://www.ohiosos.gov/businesses/', text:'Ohio LLC filing is commonly around $99 and creates legal separation. Protects personal assets from business liabilities.' },
  { title:'High Yield Savings', url:'https://www.marcus.com', text:'High-yield savings can offer around 4-5% APY versus near-0.01% at many traditional accounts.' },
  { title:'Business Credit Card', url:'https://www.nav.com', text:'Earn rewards on sourcing purchases and build business credit profile for higher limits and financing options.' },
  { title:'S-Corp Election', url:'https://www.irs.gov/businesses/small-businesses-self-employed/s-corporations', text:'At higher profits (often around $50,000+), S-Corp election can reduce self-employment tax, sometimes saving $7,000+ annually around $100,000 income.' }
];

function m(v){return `$${Number(v).toFixed(2)}`}

async function api(url, opts={}){
  const r = await fetch(url, opts);
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function login(password){
  await api('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
}

async function bootstrap(){
  state = await api('/api/admin/bootstrap');
}

function card(title, body){return `<div class="card"><h3>${title}</h3>${body}</div>`}

function renderDashboard(){
  const k = state.metrics;
  const recent = state.recentOrders.map(o=>`<tr><td>${o.id.slice(0,8)}</td><td>${o.customer.name}</td><td>${m(o.total)}</td><td>${m(o.profit)}</td><td>${o.status}</td></tr>`).join('');
  const best = state.bestSelling.map(b=>`<li>${b.name}: ${b.qty}</li>`).join('');
  tabsNode.innerHTML = `
    <h1>Dashboard</h1>
    <div class="grid">
      ${card('Orders Today', `<div class="kpi">${k.ranges.today}</div>`)}
      ${card('Orders Week', `<div class="kpi">${k.ranges.week}</div>`)}
      ${card('Orders Month', `<div class="kpi">${k.ranges.month}</div>`)}
      ${card('Orders Year', `<div class="kpi">${k.ranges.year}</div>`)}
      ${card('Revenue', `<div class="kpi">${m(k.revenue)}</div>`)}
      ${card('Profit', `<div class="kpi">${m(k.profit)}</div>`)}
      ${card('Tax Withheld (25%)', `<div class="kpi">${m(k.taxWithheld)}</div>`)}
      ${card('Spendable Profit', `<div class="kpi">${m(k.spendableProfit)}</div>`)}
    </div>
    <div class="section"><h3>Recent Orders</h3><table class="table"><tr><th>ID</th><th>Customer</th><th>Total</th><th>Profit</th><th>Status</th></tr>${recent}</table></div>
    <div class="section"><h3>Best Selling</h3><ul>${best || '<li>No sales yet</li>'}</ul></div>
  `;
}

function renderProducts(){
  const rows = state.store.products.map(p=>`<tr><td>${p.name}</td><td>${p.category}</td><td>${m(p.price)}</td><td>${p.sizes.join(', ')}</td><td>${p.visible ? 'Visible':'Hidden'}</td><td><button onclick="toggleVisible('${p.id}',${!p.visible})">Toggle</button> <button onclick="removeProduct('${p.id}')">Delete</button></td></tr>`).join('');
  tabsNode.innerHTML = `
    <h1>Products</h1>
    <form id="addProductForm" class="card">
      <div class="grid">
        <input class="input" name="name" placeholder="Product name" required />
        <select class="input" name="category">${['Sneakers','Hoodies','Joggers','T-Shirts','Shorts','Hats','Socks','Full Outfits'].map(c=>`<option>${c}</option>`)}</select>
        <input class="input" name="price" placeholder="Price" type="number" step="0.01" required />
        <input class="input" name="cost" placeholder="Cost" type="number" step="0.01" required />
        <input class="input" name="sizes" placeholder="Sizes comma separated" />
        <input class="input" name="image" type="file" accept="image/*" />
      </div>
      <label><input type="checkbox" name="visible" checked /> Visible</label>
      <button>Add Product</button>
    </form>
    <table class="table"><tr><th>Name</th><th>Category</th><th>Price</th><th>Sizes</th><th>Visibility</th><th>Actions</th></tr>${rows}</table>
  `;
  document.getElementById('addProductForm').onsubmit = addProduct;
}

function renderOrders(){
  const rows = state.store.orders.map(o=>`<tr><td>${o.id.slice(0,8)}</td><td>${o.customer.name}<br>${o.customer.email}</td><td>${o.items.map(i=>`${i.name} x${i.quantity} (${i.size})`).join('<br>')}</td><td>${o.status}</td><td>${o.trackingNumber||'-'}</td><td>${m(o.profit)}</td><td><button onclick="setOrderStatus('${o.id}')">Update</button></td></tr>`).join('');
  tabsNode.innerHTML = `<h1>Orders</h1><p>Live order feed with customer details, status tracking, tracking numbers, and profit per order.</p><table class="table"><tr><th>ID</th><th>Customer</th><th>Items</th><th>Status</th><th>Tracking</th><th>Profit</th><th>Action</th></tr>${rows}</table>`;
}

async function renderCRM(){
  const crm = await api('/api/admin/crm');
  tabsNode.innerHTML = `<h1>CRM</h1>
    <p>Simple customer relationship view for repeat buyers and top spenders.</p>
    <div class="card"><strong>Total customers:</strong> ${crm.totalCustomers}</div>
    <h3>Top Spenders</h3>
    <table class="table"><tr><th>Customer</th><th>Email</th><th>Orders</th><th>Total Spend</th><th>Total Profit</th><th>Last Order</th></tr>
      ${(crm.topSpenders || []).map(c=>`<tr><td>${c.customerName}</td><td>${c.email}</td><td>${c.orders}</td><td>${m(c.totalSpend)}</td><td>${m(c.totalProfit)}</td><td>${new Date(c.lastOrderAt).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan=\"6\">No customer data yet</td></tr>'}
    </table>
    <h3>Repeat Customers</h3>
    <ul>${(crm.repeatCustomers || []).map(c=>`<li>${c.customerName} (${c.email}) — ${c.orders} orders, ${m(c.totalSpend)} spent</li>`).join('') || '<li>No repeat customers yet</li>'}</ul>`;
}

function renderRevenue(){
  const orders = state.store.orders;
  const by = (fn) => Object.entries(orders.reduce((acc,o)=>{const k=fn(new Date(o.createdAt));acc[k]=(acc[k]||0)+o.profit;return acc;},{})).map(([k,v])=>`<li>${k}: ${m(v)}</li>`).join('');
  tabsNode.innerHTML = `
    <h1>Revenue & Profit</h1>
    <div class="grid">
      ${card('Daily Profit', `<ul>${by(d=>d.toISOString().slice(0,10)) || '<li>None</li>'}</ul>`)}
      ${card('Weekly Profit', `<ul>${by(d=>`${d.getFullYear()}-W${Math.ceil(((d - new Date(d.getFullYear(),0,1))/86400000 + new Date(d.getFullYear(),0,1).getDay()+1)/7)}`) || '<li>None</li>'}</ul>`)}
      ${card('Monthly Profit', `<ul>${by(d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`) || '<li>None</li>'}</ul>`)}
      ${card('Yearly Profit', `<ul>${by(d=>String(d.getFullYear())) || '<li>None</li>'}</ul>`)}
    </div>
  `;
}

function renderTaxes(){
  api('/api/admin/tax-envelope').then((envelope) => {
    tabsNode.innerHTML = `<h1>Taxes</h1>
      <p>25% is auto-withheld from every profit to keep Pure Sole tax-safe. This section provides plain English guidance and quarterly reminders 30 days before each due date.</p>
      <ul>${state.quarterly.map(q=>`<li>${q.quarter}: deadline ${q.deadline}, reminder ${q.reminderOn}</li>`).join('')}</ul>
      <button id="downloadTaxPdf">Generate Tax PDF</button>
      <h3>IRS Envelope (Do Not Spend)</h3>
      <div class="card">
        <p><strong>Envelope Balance:</strong> ${m(envelope.balance)}</p>
        <p><strong>Recommended Reserve:</strong> ${m(envelope.recommendedReserve)}</p>
        <p><strong>Difference:</strong> ${m(envelope.differenceVsRecommended)} ${envelope.differenceVsRecommended >= 0 ? '(above reserve)' : '(below reserve)'}</p>
        <form id="taxDepositForm" class="row">
          <input class="input" name="amount" type="number" step="0.01" min="0.01" placeholder="Deposit amount" />
          <input class="input" name="note" placeholder="Note (optional)" />
          <button>Deposit to IRS Envelope</button>
        </form>
        <form id="taxWithdrawForm" class="row" style="margin-top:.5rem">
          <input class="input" name="amount" type="number" step="0.01" min="0.01" placeholder="Withdrawal amount" />
          <input class="input" name="note" placeholder="Note (e.g. IRS payment)" />
          <button>Withdraw (IRS Payment)</button>
        </form>
      </div>
      <h4>Envelope Transactions</h4>
      <table class="table"><tr><th>Time</th><th>Type</th><th>Amount</th><th>Note</th></tr>
        ${(envelope.transactions || []).map(t=>`<tr><td>${new Date(t.createdAt).toLocaleString()}</td><td>${t.type}</td><td>${m(t.amount)}</td><td>${t.note || ''}</td></tr>`).join('') || '<tr><td colspan=\"4\">No envelope activity yet</td></tr>'}
      </table>
      <h3>Stored Tax Documents</h3>
      <ul>${state.store.taxDocuments.map(d=>`<li><a href="${d.path}" target="_blank">${d.path}</a></li>`).join('') || '<li>No docs yet</li>'}</ul>
    `;
    document.getElementById('downloadTaxPdf').onclick = ()=> window.open('/api/admin/taxes/pdf','_blank');
    document.getElementById('taxDepositForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await api('/api/admin/tax-envelope/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Number(fd.get('amount')), note: fd.get('note') })
      });
      await refresh();
      activeTab = 'taxes';
      renderTab();
    };
    document.getElementById('taxWithdrawForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await api('/api/admin/tax-envelope/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Number(fd.get('amount')), note: fd.get('note') })
      });
      await refresh();
      activeTab = 'taxes';
      renderTab();
    };
  }).catch((err) => {
    tabsNode.innerHTML = `<h1>Taxes</h1><p>Could not load tax envelope: ${err.message}</p>`;
  });
  tabsNode.innerHTML = `<h1>Taxes</h1>
    <p>25% is auto-withheld from every profit to keep Pure Sole tax-safe. This section provides plain English guidance and quarterly reminders 30 days before each due date.</p>
    <ul>${state.quarterly.map(q=>`<li>${q.quarter}: deadline ${q.deadline}, reminder ${q.reminderOn}</li>`).join('')}</ul>
    <button id="downloadTaxPdf">Generate Tax PDF</button>
    <h3>Stored Tax Documents</h3>
    <ul>${state.store.taxDocuments.map(d=>`<li><a href="${d.path}" target="_blank">${d.path}</a></li>`).join('') || '<li>No docs yet</li>'}</ul>
  `;
  document.getElementById('downloadTaxPdf').onclick = ()=> window.open('/api/admin/taxes/pdf','_blank');
}

function renderEditor(){
  const c = state.store.settings.editableContent;
  tabsNode.innerHTML = `<h1>Website Editor</h1><p>Edit text, preview, and publish instantly.</p>
    <form id="contentForm" class="card">
      <label>Hero Title</label><input class="input" name="heroTitle" value="${c.heroTitle}"/>
      <label>Hero Subtitle</label><textarea class="input" name="heroSubtitle">${c.heroSubtitle}</textarea>
      <label>Shipping Notice</label><textarea class="input" name="shippingNotice">${c.shippingNotice}</textarea>
      <label>Final Sale</label><textarea class="input" name="finalSale">${c.finalSale}</textarea>
      <label>Empty State</label><textarea class="input" name="emptyState">${c.emptyState}</textarea>
      <div class="row"><button>Preview Save</button><button type="button" id="publishContent">Publish Instantly</button></div>
    </form>`;
  document.getElementById('contentForm').onsubmit = saveDraft;
  document.getElementById('publishContent').onclick = publishDraft;
}

function renderChat(role,title){
  tabsNode.innerHTML = `<h1>${title}</h1><div class="card"><div id="chatLog" style="max-height:300px;overflow:auto"></div><form id="chatForm"><input class="input" name="msg" placeholder="Ask anything"/><button style="margin-top:.5rem">Send</button></form></div>`;
  document.getElementById('chatForm').onsubmit = async (e)=>{
    e.preventDefault();
    const msg = new FormData(e.target).get('msg');
    const out = await api('/api/admin/ai-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,message:msg})});
    const div = document.getElementById('chatLog');
    div.innerHTML += `<p><strong>You:</strong> ${msg}</p><p><strong>AI:</strong> ${out.reply}</p><ul>${(out.links||[]).map(l=>`<li><a href="${l.url}" target="_blank">${l.label}</a></li>`).join('')}</ul>`;
    div.scrollTop = div.scrollHeight;
    e.target.reset();
  };
}

async function renderCode(){
  const files = await api('/api/admin/code/files');
  tabsNode.innerHTML = `<h1>AI Code Editor</h1>
    <p>View files, describe updates, save with automatic backup, preview by refreshing. One click revert supported.</p>
    <select id="filePick" class="input">${files.map(f=>`<option>${f}</option>`)}</select>
    <textarea id="codeText" class="input" style="min-height:340px;margin-top:.5rem"></textarea>
    <div class="row"><button id="loadFile">Load</button><button id="saveFile">Save with Backup</button><button id="revertFile">Revert Last Backup</button></div>
  `;
  document.getElementById('loadFile').onclick = async ()=>{
    const file = document.getElementById('filePick').value;
    const res = await api(`/api/admin/code/file?file=${encodeURIComponent(file)}`);
    document.getElementById('codeText').value = res.content;
  };
  document.getElementById('saveFile').onclick = async ()=>{
    const file = document.getElementById('filePick').value;
    const content = document.getElementById('codeText').value;
    const res = await api('/api/admin/code/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file,content})});
    lastBackup = { file, backupName: res.backupName };
    alert('Saved with backup: ' + res.backupName);
  };
  document.getElementById('revertFile').onclick = async ()=>{
    if(!lastBackup) return alert('No backup yet in this session');
    await api('/api/admin/code/revert',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(lastBackup)});
    alert('Reverted last backup');
  };
}

async function renderAutomation(){
  const automation = await api('/api/admin/automation');
  const s = automation.settings || {};
  tabsNode.innerHTML = `<h1>Automation Center</h1>
    <p>Run Pure Sole with as much automation as possible. Enable workflows, run automations on demand, and review recent automation events.</p>
    <form id="automationForm" class="card">
      <label><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''} /> Master automation enabled</label><br>
      <label><input type="checkbox" name="autoCustomerEmails" ${s.autoCustomerEmails ? 'checked' : ''} /> Auto customer email events for orders, status, and tracking</label><br>
      <label><input type="checkbox" name="quarterlyReminders" ${s.quarterlyReminders ? 'checked' : ''} /> Auto quarterly tax reminders (30 days before due date)</label><br>
      <label><input type="checkbox" name="dailySummary" ${s.dailySummary ? 'checked' : ''} /> Auto daily revenue/profit summary event</label><br><br>
      <div class="row">
        <button>Save Automation Settings</button>
        <button type="button" id="runAutomationNow">Run Now</button>
      </div>
    </form>
    <h3>Recent Automation Events</h3>
    <table class="table"><tr><th>Time</th><th>Type</th><th>Message</th><th>Details</th></tr>
      ${(automation.events || []).map(e=>`<tr><td>${new Date(e.createdAt).toLocaleString()}</td><td>${e.type}</td><td>${e.message}</td><td><code>${JSON.stringify(e.meta || {})}</code></td></tr>`).join('') || '<tr><td colspan="4">No events yet</td></tr>'}
    </table>`;

  document.getElementById('automationForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api('/api/admin/settings', {
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        automation: {
          enabled: !!fd.get('enabled'),
          autoCustomerEmails: !!fd.get('autoCustomerEmails'),
          quarterlyReminders: !!fd.get('quarterlyReminders'),
          dailySummary: !!fd.get('dailySummary')
        }
      })
    });
    await refresh();
    activeTab = 'automation';
    renderTab();
  };

  document.getElementById('runAutomationNow').onclick = async () => {
    await api('/api/admin/automation/run', { method: 'POST' });
    await refresh();
    activeTab = 'automation';
    renderTab();
  };
}

function renderMarket(){
  tabsNode.innerHTML = `<h1>Market Intelligence Dashboard</h1>
    <p>Connected placeholders for KicksDB, Sneaker Database, and Arbit APIs. Real-time panel supports top sneakers, trend direction, best profit opportunities, popular sizes, and upcoming releases.</p>
    <table class="table"><tr><th>Rank</th><th>Sneaker</th><th>Trend</th><th>Best Size</th><th>Opportunity</th></tr>${state.marketData.map(x=>`<tr><td>${x.rank}</td><td>${x.product}</td><td>${x.priceTrend}</td><td>${x.bestSize}</td><td>${x.opportunity}</td></tr>`).join('') || '<tr><td colspan="5">Add sneaker products to populate feed</td></tr>'}</table>`;
}

function renderBlueprint(title, subtitle){
  tabsNode.innerHTML = `<h1>${title}</h1><p>${subtitle}</p>${wealthCards.map(c=>`<details class="accordion"><summary>${c.title}</summary><div class="content"><p>${c.text}</p><a class="btn" href="${c.url}" target="_blank">Visit Official Site</a></div></details>`).join('')}`;
}

function renderSettings(){
  const s = state.store.settings;
  tabsNode.innerHTML = `<h1>Settings</h1>
    <form id="settingsForm" class="card">
      <h3>Admin Security</h3>
      <input class="input" name="adminPassword" type="password" placeholder="Leave blank to keep current password" />
      <input class="input" name="adminPassword" type="password" value="${s.adminPassword}" />
      <h3>Business Info</h3>
      <input class="input" name="businessEmail" value="${s.businessEmail}" />
      <input class="input" name="instagramUrl" value="${s.instagramUrl}" />
      <h3>Payment Usernames</h3>
      <input class="input" name="cashApp" value="${s.payment.cashApp}" />
      <input class="input" name="venmo" value="${s.payment.venmo}" />
      <input class="input" name="paypal" value="${s.payment.paypal}" />
      <h3>API Keys</h3>
      <input class="input" name="kicksdb" value="${s.apiKeys.kicksdb}" />
      <input class="input" name="sneakerDatabase" value="${s.apiKeys.sneakerDatabase}" />
      <input class="input" name="arbit" value="${s.apiKeys.arbit}" />
      <h3>Payment Provider Keys</h3>
      <input class="input" name="stripePublishableKey" placeholder="Stripe publishable key" value="${s.paymentProviders?.stripePublishableKey || ''}" />
      <input class="input" name="stripeSecretKey" placeholder="Stripe secret key" value="${s.paymentProviders?.stripeSecretKey || ''}" />
      <input class="input" name="stripeWebhookSecret" placeholder="Stripe webhook secret" value="${s.paymentProviders?.stripeWebhookSecret || ''}" />
      <input class="input" name="paypalClientId" placeholder="PayPal client ID" value="${s.paymentProviders?.paypalClientId || ''}" />
      <input class="input" name="paypalSecret" placeholder="PayPal secret" value="${s.paymentProviders?.paypalSecret || ''}" />
      <input class="input" name="paypalWebhookId" placeholder="PayPal webhook ID" value="${s.paymentProviders?.paypalWebhookId || ''}" />
      <h3>Email / SMTP</h3>
      <input class="input" name="smtpHost" placeholder="SMTP host" value="${s.smtp?.host || ''}" />
      <input class="input" name="smtpPort" placeholder="SMTP port" value="${s.smtp?.port || ''}" />
      <input class="input" name="smtpUsername" placeholder="SMTP username" value="${s.smtp?.username || ''}" />
      <input class="input" name="smtpPassword" placeholder="SMTP password" value="${s.smtp?.password || ''}" />
      <input class="input" name="smtpFromEmail" placeholder="From email" value="${s.smtp?.fromEmail || ''}" />
      <h3>Hosted Deployment</h3>
      <input class="input" name="hostedBaseUrl" placeholder="https://yourdomain.com" value="${s.hostedBaseUrl || ''}" />
      <h3>Automation</h3>
      <label><input type="checkbox" name="automationEnabled" ${s.automation?.enabled ? 'checked' : ''}/> Master enabled</label><br>
      <label><input type="checkbox" name="automationEmails" ${s.automation?.autoCustomerEmails ? 'checked' : ''}/> Customer email events</label><br>
      <label><input type="checkbox" name="automationQuarterly" ${s.automation?.quarterlyReminders ? 'checked' : ''}/> Quarterly reminders</label><br>
      <label><input type="checkbox" name="automationDaily" ${s.automation?.dailySummary ? 'checked' : ''}/> Daily summaries</label><br><br>
      <button>Save Settings</button>
    </form>`;
  document.getElementById('settingsForm').onsubmit = saveSettings;
}

function renderTab(){
  if(activeTab==='dashboard') return renderDashboard();
  if(activeTab==='products') return renderProducts();
  if(activeTab==='orders') return renderOrders();
  if(activeTab==='crm') return renderCRM();
  if(activeTab==='revenue') return renderRevenue();
  if(activeTab==='taxes') return renderTaxes();
  if(activeTab==='editor') return renderEditor();
  if(activeTab==='mentor') return renderChat('business','AI Business Mentor');
  if(activeTab==='taxai') return renderChat('tax','AI Tax Advisor');
  if(activeTab==='code') return renderCode();
  if(activeTab==='automation') return renderAutomation();
  if(activeTab==='market') return renderMarket();
  if(activeTab==='blueprint') return renderBlueprint('The Blueprint','Your complete roadmap for protecting and growing Pure Sole as your business scales');
  if(activeTab==='freedom') return renderBlueprint('Financial Freedom','Complete personal wealth command center focused on long-term independence.');
  if(activeTab==='settings') return renderSettings();
}

async function addProduct(e){
  e.preventDefault();
  const fd = new FormData(e.target);
  fd.set('visible', !!fd.get('visible'));
  await fetch('/api/admin/products',{method:'POST',body:fd});
  await refresh();
  activeTab = 'products';
  renderTab();
}

window.toggleVisible = async (id, visible)=>{
  await api(`/api/admin/products/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({visible})});
  await refresh();activeTab='products';renderTab();
};
window.removeProduct = async (id)=>{
  await api(`/api/admin/products/${id}`,{method:'DELETE'});
  await refresh();activeTab='products';renderTab();
};
window.setOrderStatus = async (id)=>{
  const status = prompt('Status'); if(!status) return;
  const trackingNumber = prompt('Tracking number (optional)','');
  await api(`/api/admin/orders/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status,trackingNumber})});
  await refresh();activeTab='orders';renderTab();
};

async function saveDraft(e){
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/admin/content/draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(fd))});
  alert('Draft saved. Use Publish for live update.');
}
async function publishDraft(){
  await api('/api/admin/content/publish',{method:'POST'});
  await refresh();
  alert('Published live');
}

async function saveSettings(e){
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/admin/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    adminPassword: fd.get('adminPassword'),
    businessEmail: fd.get('businessEmail'),
    instagramUrl: fd.get('instagramUrl'),
    payment: { cashApp: fd.get('cashApp'), venmo: fd.get('venmo'), paypal: fd.get('paypal') },
    apiKeys: { kicksdb: fd.get('kicksdb'), sneakerDatabase: fd.get('sneakerDatabase'), arbit: fd.get('arbit') },
    paymentProviders: {
      stripePublishableKey: fd.get('stripePublishableKey'),
      stripeSecretKey: fd.get('stripeSecretKey'),
      stripeWebhookSecret: fd.get('stripeWebhookSecret'),
      paypalClientId: fd.get('paypalClientId'),
      paypalSecret: fd.get('paypalSecret'),
      paypalWebhookId: fd.get('paypalWebhookId')
    },
    smtp: {
      host: fd.get('smtpHost'),
      port: fd.get('smtpPort'),
      username: fd.get('smtpUsername'),
      password: fd.get('smtpPassword'),
      fromEmail: fd.get('smtpFromEmail')
    },
    hostedBaseUrl: fd.get('hostedBaseUrl'),
    automation: {
      enabled: !!fd.get('automationEnabled'),
      autoCustomerEmails: !!fd.get('automationEmails'),
      quarterlyReminders: !!fd.get('automationQuarterly'),
      dailySummary: !!fd.get('automationDaily')
    }
  })});
  await refresh();
  alert('Saved settings');
}

async function refresh(){ await bootstrap(); }

document.querySelectorAll('[data-tab]').forEach(btn=>btn.onclick=()=>{activeTab=btn.dataset.tab;renderTab();});
document.getElementById('logoutBtn').onclick = async ()=>{try{await api('/api/admin/logout',{method:'POST'})}catch(e){} location.reload();};

document.getElementById('loginForm').onsubmit = async (e)=>{
  e.preventDefault();
  const password = new FormData(e.target).get('password');
  try {
    await login(password);
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('adminView').classList.remove('hidden');
    await refresh();
    renderTab();
  } catch(err){
    document.getElementById('loginError').textContent = err.message;
  }
};

(async ()=>{
  try {
    await refresh();
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('adminView').classList.remove('hidden');
    renderTab();
  } catch {
  }
})();
