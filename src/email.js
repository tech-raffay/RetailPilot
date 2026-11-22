export const mailReady = env => Boolean(env?.RESEND_API_KEY && env?.RETAILPILOT_FROM_EMAIL);
const validEmail = value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export function receiptMessage(shop, order) {
  if (!order?.emailReceipt || order.status !== 'Paid') return;
  const customer = shop.customers.find(c => c.id === order.customer);
  if (!validEmail(customer?.email)) return;
  const pounds = n => '£'+(n/100).toFixed(2);
  const location = shop.stores.find(store => store.id === order.store)?.name || '';
  const lines = order.items.map(i => i.qty+' × '+i.name+' ('+i.sku+')  '+pounds(i.qty*i.price));
  return {key:'receipt/'+order.id, kind:'receipt', customer:customer.id, to:customer.email,
    subject:'Your receipt from '+shop.name+' · '+order.id,
    text:[shop.name+' · '+location, order.id+' · '+new Date(order.date).toISOString(), ...lines,
      'Discount: '+order.discount+'%', 'VAT: '+pounds(order.tax), 'Paid: '+pounds(order.total)+' · '+order.method].join('\n')};
}

export async function stockMessage(db, org, shop, movements) {
  const low = [];
  for (const move of movements) {
    if (move.delta >= 0) continue;
    const product = shop.products.find(p => p.id === move.product);
    if (move.after <= product.threshold && move.after-move.delta > product.threshold) {
      const store = shop.stores.find(s => s.id === move.store);
      low.push(product.name+' ('+product.sku+') · '+store.name+': '+move.after+' left; threshold '+product.threshold+'.');
    }
  }
  if (!low.length) return;
  const owner = await db.prepare("SELECT email FROM members WHERE org_id=? AND role='Owner' LIMIT 1").bind(org).first();
  if (!validEmail(owner?.email)) return;
  return {key:'stock/'+movements[0].id,kind:'stock',to:owner.email,subject:'Low stock at '+shop.name,text:low.join('\n')};
}

export function queueStatement(env,org,job,revision) {
  const payload=JSON.stringify({from:env.RETAILPILOT_FROM_EMAIL,to:[job.to],subject:job.subject,text:job.text});
  const args=[org+'/'+job.key,org,job.kind,job.customer||null,payload];
  let sql='INSERT INTO email_outbox(id,org_id,kind,customer_id,payload) SELECT ?,?,?,?,?';
  if(revision!==undefined){sql+=' WHERE EXISTS (SELECT 1 FROM organizations WHERE id=? AND revision=?)';args.push(org,revision);}
  return env.DB.prepare(sql+' ON CONFLICT(id) DO NOTHING').bind(...args);
}

export async function deliverEmail(env,id) {
  if(!mailReady(env))return false;
  const db=env.DB, now=Date.now();
  // Lease exceeds the request timeout. A crashed sender retries with the same payload and key.
  const claim=await db.prepare("UPDATE email_outbox SET next_attempt=?, attempts=attempts+1, first_attempt=coalesce(first_attempt,?) WHERE id=? AND status='queued' AND next_attempt<=?")
    .bind(now+60000,now,id,now).run();
  if(!claim.meta.changes)return false;
  const job=await db.prepare("SELECT kind,org_id,payload,first_attempt,attempts FROM email_outbox WHERE id=? AND status='queued'").bind(id).first();
  if(!job)return false;
  if(job.kind==='invite'){
    const invite=await db.prepare('SELECT token FROM invites WHERE token=? AND org_id=? AND expires>?').bind(id.split('/').at(-1),job.org_id,now).first();
    if(!invite){
      await db.prepare('DELETE FROM email_outbox WHERE id=?').bind(id).run();
      return false;
    }
  }
  let status='failed';
  // Resend retains idempotency keys for 24 hours. Stop before that window can expire.
  if(now-job.first_attempt<23*3600000){
    try {
      const response=await (env.MAIL_FETCH||fetch)('https://api.resend.com/emails',{method:'POST',
        headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':id},
        body:job.payload,signal:AbortSignal.timeout(8000)});
      if(response.ok)status='accepted';
      else if([408,409,429].includes(response.status)||response.status>=500)status='queued';
    } catch {status='queued';}
  }
  const next=Date.now()+Math.min(3600000,30000*2**Math.min(job.attempts-1,7));
  await db.prepare("UPDATE email_outbox SET status=?, next_attempt=?, payload=CASE WHEN ?='queued' THEN payload ELSE NULL END WHERE id=? AND status='queued' AND attempts=?")
    .bind(status,next,status,id,job.attempts).run();
  return status==='accepted';
}

export async function flushEmail(env) {
  if(!mailReady(env))return;
  const due=await env.DB.prepare("SELECT id FROM email_outbox WHERE status='queued' AND next_attempt<=? ORDER BY next_attempt,rowid LIMIT 5").bind(Date.now()).all();
  for(const row of due.results)await deliverEmail(env,row.id);
}
