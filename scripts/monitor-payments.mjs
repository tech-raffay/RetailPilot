import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

const watch = process.argv.includes('--watch');
const database = resolve(process.env.RETAILPILOT_DATA_DIR || '.retailpilot', 'retail.sqlite');
const db = new DatabaseSync(database, { readOnly: true });
const assignments = new Set((process.env.STRIPE_ACCOUNTS || '').split(','));
const token = process.env.STRIPE_TEST_KEY || '';

async function check() {
  let alerts = 0;
  let checked = 0;
  for (const { id, document } of db.prepare('SELECT id, document FROM organizations').all()) {
    const workspace = JSON.parse(document);
    if (workspace.demo) continue;
    const pending = workspace.orders.filter(order => order.method === 'Stripe' && order.status === 'Pending');
    if (!pending.length) continue;
    const account = workspace.stripeAccount;
    if (!token.startsWith('sk_test_') || !assignments.has(id + '=' + account)) {
      throw new Error('Cannot verify pending orders for ' + workspace.name + '. Check sandbox credentials and merchant assignment.');
    }
    checked += pending.length;
    const orders = new Map(pending.map(order => [order.id, order]));
    const oldest = pending.reduce((date, order) => Math.min(date, order.date), Date.now());
    const params = new URLSearchParams({ limit: '100', 'created[gte]': String(Math.floor(oldest / 1000) - 300) });
    do {
      const response = await fetch('https://api.stripe.com/v1/checkout/sessions?' + params, {
        headers: { Authorization: 'Bearer ' + token, 'Stripe-Account': account },
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error('Stripe lookup failed for ' + workspace.name + ' (HTTP ' + response.status + ').');
      const page = await response.json();
      for (const session of page.data) {
        const meta = session.metadata || {};
        const order = orders.get(meta.order);
        if (!order || meta.org !== id || meta.flow !== 'retail' || session.livemode || session.payment_status !== 'paid') continue;
        const latest = JSON.parse(db.prepare('SELECT document FROM organizations WHERE id=?').get(id).document);
        if (latest.orders.find(o => o.id === order.id)?.status !== 'Pending') continue;
        const mismatch = session.amount_total !== order.total || session.currency !== 'gbp';
        console.error(JSON.stringify({workspace: workspace.name, order: order.id, session: session.id,
          issue: mismatch ? 'Stripe paid with unexpected amount or currency' : 'Stripe paid, RetailPilot pending'}));
        alerts++;
      }
      if (!page.has_more) break;
      params.set('starting_after', page.data.at(-1).id);
    } while (true);
  }
  console.log(new Date().toISOString(), 'Pending Stripe orders:', checked, 'Alerts:', alerts);
  return alerts;
}

try {
  do {
    try {
      const alerts = await check();
      if (!watch && alerts) process.exitCode = 2;
    } catch (error) {
      console.error(error.message);
      if (!watch) process.exitCode = 1;
    }
    if (watch) await sleep(60000);
  } while (watch);
} finally {
  db.close();
}
