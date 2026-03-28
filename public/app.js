const categories = ['Sneakers','Hoodies','Joggers','T-Shirts','Shorts','Hats','Socks','Full Outfits'];
let products = [];

function money(value){return `$${Number(value).toFixed(2)}`}

async function loadStore(){
  const data = await fetch('/api/public-store').then(r=>r.json());
  products = data.products;
  const content = data.settings.editableContent;

  document.getElementById('heroTitle').textContent = content.heroTitle;
  document.getElementById('heroSubtitle').textContent = content.heroSubtitle;
  document.getElementById('finalSale').textContent = content.finalSale;
  document.getElementById('emptyState').textContent = products.length ? '' : content.emptyState;
  document.getElementById('shippingNotice').textContent = content.shippingNotice;

  document.getElementById('categories').innerHTML = categories.map(c=>`<span class="pill">${c}</span>`).join('');

  const productsNode = document.getElementById('products');
  productsNode.innerHTML = products.map(p => `
    <article class="card">
      <img src="${p.image || 'https://placehold.co/400x400/111/FFF?text=Pure+Sole'}" alt="${p.name}" />
      <h3>${p.name}</h3>
      <p class="muted">${p.category}</p>
      <p><strong>${money(p.price)}</strong></p>
      <p class="muted">Sizes: ${p.sizes.join(', ') || 'Request size'}</p>
    </article>
  `).join('');

  const productSelect = document.querySelector('select[name="product"]');
  productSelect.innerHTML = products.map(p=>`<option value="${p.id}">${p.name} - ${money(p.price)}</option>`).join('') || '<option value="">No products yet</option>';

  const payment = data.settings.payment;
  document.getElementById('paymentUsernames').innerHTML = `
    <strong>Pay instantly:</strong><br>
    Cash App: ${payment.cashApp}<br>
    Venmo: ${payment.venmo}<br>
    PayPal: ${payment.paypal}
  `;
}

function setupDisclaimer(){
  const banner = document.getElementById('disclaimer');
  const seen = sessionStorage.getItem('pureSoleDisclaimerSeen');
  if(!seen){banner.classList.remove('hidden');}
  document.getElementById('dismissDisclaimer').onclick = ()=>{
    sessionStorage.setItem('pureSoleDisclaimerSeen','1');
    banner.classList.add('hidden');
  };
}

document.getElementById('checkoutForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  if (!products.length) return;
  const fd = new FormData(e.target);
  const payload = {
    customer: { name: fd.get('name'), email: fd.get('email'), size: fd.get('size') },
    paymentMethod: fd.get('paymentMethod'),
    items: [{ productId: fd.get('product'), quantity: Number(fd.get('qty')) || 1, size: fd.get('size') }]
  };

  const result = await fetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(r=>r.json());
  const box = document.getElementById('orderResult');
  box.classList.remove('hidden');
  box.textContent = result.message ? `${result.message} Order #${result.orderId}` : (result.error || 'Error');
  e.target.reset();
});

setupDisclaimer();
loadStore();
