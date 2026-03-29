const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataFile = path.join(__dirname, '..', 'data', 'store.json');
const newPassword = process.argv[2] || process.env.NEW_ADMIN_PASSWORD || 'A@070610A@070610';

function hashPassword(rawPassword) {
  return `sha256:${crypto.createHash('sha256').update(String(rawPassword)).digest('hex')}`;
}

const store = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
store.settings.adminPassword = hashPassword(newPassword);
fs.writeFileSync(dataFile, JSON.stringify(store, null, 2));

console.log('Admin password reset complete.');
console.log('Password set to:', newPassword);
