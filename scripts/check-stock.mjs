import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function checkWorkspace(shop, report) {
  const stores = new Set(shop.stores.map(store => store.id));
  const balances = new Map(shop.products.map(product => [product.id, new Map()]));
  const movements = new Set();
  const transfers = new Map();
  for (const move of shop.movements) {
    const location = {product:move.product, store:move.store, movement:move.id};
    if (!move.id || movements.has(move.id)) report('Missing or duplicate movement ID', location);
    movements.add(move.id);
    const stock = balances.get(move.product);
    if (!stock || !stores.has(move.store)) {
      report('Movement refers to an unknown product or store', location);
      continue;
    }
    if (!Number.isSafeInteger(move.delta)) {
      report('Invalid movement quantity', location);
      continue;
    }
    const expected = (stock.get(move.store) ?? 0) + move.delta;
    if (!Number.isSafeInteger(expected) || expected < 0 || expected !== move.after) {
      report('Movement balance mismatch', {...location, expected, recorded:move.after});
    }
    stock.set(move.store, expected);
    if (move.reason === 'Transfer out' || move.reason === 'Transfer in') {
      const pair = transfers.get(move.ref) ?? [];
      pair.push(move);
      transfers.set(move.ref, pair);
    }
  }
  for (const [ref, pair] of transfers) {
    const outgoing = pair.find(move => move.reason === 'Transfer out');
    const incoming = pair.find(move => move.reason === 'Transfer in');
    if (!ref || pair.length !== 2 || !outgoing || !incoming || outgoing.product !== incoming.product ||
        outgoing.store === incoming.store || outgoing.otherStore !== incoming.store ||
        incoming.otherStore !== outgoing.store || outgoing.delta >= 0 || incoming.delta !== -outgoing.delta) {
      report('Unmatched stock transfer', {ref});
    }
  }
  for (const product of shop.products) {
    const ledger = balances.get(product.id);
    for (const store of new Set([...Object.keys(product.stock), ...ledger.keys()])) {
      const expected = ledger.get(store) ?? 0;
      const recorded = Object.hasOwn(product.stock, store) ? product.stock[store] : 0;
      if (!stores.has(store) || !Number.isSafeInteger(recorded) || recorded < 0 || expected !== recorded) {
        report('Inventory balance mismatch', {product:product.id, sku:product.sku, store, expected, recorded});
      }
    }
  }
}

let db;
try {
  db = new DatabaseSync(resolve(process.env.RETAILPILOT_DATA_DIR || '.retailpilot', 'retail.sqlite'), {readOnly:true});
  let checked = 0, skipped = 0, alerts = 0, errors = 0;
  let variants = 0, movements = 0;
  for (const row of db.prepare('SELECT id, revision, document FROM organizations').iterate()) {
    try {
      const shop = JSON.parse(row.document);
      if (shop.demo === true) { skipped++; continue; }
      checkWorkspace(shop, (issue, details) => {
        console.error(JSON.stringify({workspace:row.id, revision:row.revision, issue, ...details}));
        alerts++;
      });
      checked++;
      variants += shop.products.length;
      movements += shop.movements.length;
    } catch {
      console.error(JSON.stringify({workspace:row.id, revision:row.revision, issue:'Could not read inventory records'}));
      errors++;
    }
  }
  console.log(`Business workspaces checked: ${checked}. Demos skipped: ${skipped}. Variants: ${variants}. Movements: ${movements}. Alerts: ${alerts}. Errors: ${errors}.`);
  process.exitCode = errors ? 1 : alerts ? 2 : 0;
} catch (error) {
  console.error('Stock check failed:', error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
