import {newWorkspace,uid,plans} from './catalog.js';
import {change,fail,permit,required,str,refund} from './business.js';
import {stripeReady,stripe,verifyEvent} from './payments.js';
import {planCatalogImport,commitCatalogImport} from './catalog-import.js';
const json=(v,status=200,headers={})=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...headers}});
const hash=async token=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),x=>x.toString(16).padStart(2,'0')).join('');
const query=(db,sql,...args)=>db.prepare(sql).bind(...args);
async function doc(db,id){return await query(db,'SELECT * FROM organizations WHERE id=?',id).first()||fail('Workspace not found.',404)}
async function write(db,id,fn){
  for(let i=0;i<7;i++){
    const row=await doc(db,id),s=JSON.parse(row.document),v=fn(s);
    const r=await query(db,'UPDATE organizations SET document=?,revision=revision+1 WHERE id=? AND revision=?',JSON.stringify(s),id,row.revision).run();
    if(r.meta.changes)return v;
  }
  fail('Another sale is being saved. Please retry.',409);
}
function principal(req){return req.headers.get('oai-authenticated-user-id')}
function mail(req){return req.headers.get('oai-authenticated-user-email')?.trim().toLowerCase()||''}
async function session(req,db){
  const t=(req.headers.get('Cookie')||'').match(/(?:^|;\s*)rp_session=([a-f0-9-]+)/)?.[1];
  if(!t)return null;
  const row=await query(db,'SELECT m.*,s.expires FROM sessions s JOIN members m ON m.org_id=s.org_id AND m.principal=s.principal WHERE s.token=? AND s.expires>?',await hash(t),Date.now()).first();
  if(row&&!row.principal.startsWith('demo:')&&row.principal!==principal(req))return null;
  return row;
}
async function login(db,m,req,isDemo){
  const token=uid()+uid(),duration=isDemo?Math.max(1,Math.ceil((86400000-Date.now()%86400000)/1000)):86400*14;
  await query(db,'INSERT INTO sessions VALUES(?,?,?,?)',await hash(token),m.org_id,m.principal,Date.now()+duration*1000).run();
  return json({ok:true},200,{'Set-Cookie':'rp_session='+token+'; HttpOnly; SameSite=Lax; Path=/; Max-Age='+duration+(new URL(req.url).protocol==='https:'?'; Secure':'')});
}
async function start(db,req,b,demo){
  if(demo){
    // A demo lives until UTC midnight. Sweep expired demos on the next demo launch.
    const old=(await query(db,"SELECT DISTINCT s.org_id FROM sessions s WHERE s.expires<=? AND s.principal LIKE 'demo:%' LIMIT 12",Date.now()).all()).results;
    for(const row of old) await db.batch(['members','invites','sessions','organizations'].map(t=>query(db,'DELETE FROM '+t+' WHERE '+(t==='organizations'?'id':'org_id')+'=?',row.org_id)));
  }
  if(!demo&&!principal(req))fail('Sign in with ChatGPT to create a business workspace.',401);
  const id=uid(),person=demo?'demo:'+uid():principal(req),role=demo&&b.role==='Cashier'?'Cashier':'Owner';
  const name=demo?'Northline Outfitters':required(b.name,'your business name'),m={org_id:id,principal:person,name:demo?(role==='Owner'?'Jamie Parker':'Alex Morgan'):required(b.owner,'your name'),email:demo?'jamie@example.com':mail(req),role};
  const s=newWorkspace(name,demo?'London':required(b.store,'your first store name'),demo);
  const statements=[query(db,'INSERT INTO organizations VALUES(?,0,?)',id,JSON.stringify(s)),query(db,'INSERT INTO members VALUES(?,?,?,?,?)',id,person,m.name,m.email,role)];
  if(demo)for(const [i,n,r] of [[1,'Sam Rivera','Manager'],[2,'Emma Reed','Cashier'],[3,'Ben Morris','Cashier']])statements.push(query(db,'INSERT INTO members VALUES(?,?,?,?,?)',id,'demo:'+uid(),n,'staff'+i+'@example.com',r));
  await db.batch(statements);return await login(db,m,req,demo);
}
async function members(db,id){return (await query(db,'SELECT principal,name,email,role FROM members WHERE org_id=? ORDER BY rowid',id).all()).results}
async function retailCheckoutUrl(env,origin,id,order,account){
 const fields={mode:'payment','line_items[0][price_data][currency]':'gbp','line_items[0][price_data][product_data][name]':order.id,'line_items[0][price_data][unit_amount]':String(order.total),'line_items[0][quantity]':'1','metadata[org]':id,'metadata[order]':order.id,'metadata[flow]':'retail',success_url:origin+'/#orders',cancel_url:origin+'/#orders'};
 return stripe(env,'checkout/sessions',fields,id+order.id,account);
}
async function webhook(req,env){
  const raw=await req.text(),signature=req.headers.get('Stripe-Signature');
  let event;try{event=await verifyEvent(raw,signature,env.STRIPE_WEBHOOK_SECRET)}catch(e){if(!env.STRIPE_CONNECT_WEBHOOK_SECRET)throw e;event=await verifyEvent(raw,signature,env.STRIPE_CONNECT_WEBHOOK_SECRET);if(!event.account)fail('Expected a connected-account event.')}
  if(event.livemode)fail('Only test events are accepted.');
  const o=event.data.object,meta=o.metadata||{},id=meta.org;
  if(!id)return json({received:true});
  await write(env.DB,id,s=>{
    if(s.events.includes(event.id))return;
    if(meta.flow==='retail'){
      if(!s.stripeAccount||event.account!==s.stripeAccount)fail('Merchant mismatch.');
      const order=s.orders.find(x=>x.id===meta.order)||fail('Unknown order.');
      if(event.type==='checkout.session.completed'&&o.payment_status==='paid'&&o.amount_total===order.total&&o.currency==='gbp'&&order.status==='Pending'){order.status='Paid';order.intent=o.payment_intent}
      if(event.type==='checkout.session.expired'&&order.status==='Pending'){order.status='Cancelled';for(const l of order.items){const p=s.products.find(p=>p.id===l.id);p.stock[order.store]+=l.qty;s.movements.push({id:uid(),date:Date.now(),name:p.name,product:p.id,store:order.store,delta:l.qty,after:p.stock[order.store],reason:'Expired checkout',ref:order.id,actor:'Stripe'})}}
    }else if(meta.flow==='billing'&&!event.account){
      if(event.type==='checkout.session.completed'&&o.payment_status==='paid'&&plans[meta.plan]){s.plan=meta.plan;s.billing='active';s.stripeCustomer=o.customer;s.subscription=o.subscription}
      if(event.type.startsWith('customer.subscription.')&&o.id===s.subscription){const subPlan=Object.keys(plans).find(p=>env['STRIPE_PRICE_'+p.toUpperCase()]===o.items?.data?.[0]?.price?.id&&o.items?.data?.[0]?.price?.id);if(subPlan)s.plan=subPlan;s.billing=o.status;s.graceEnd=s.graceEnd||Date.now()+3*86400000;if(o.status==='active')s.graceEnd=null}
    }
    s.events.push(event.id);
  });return json({received:true});
}
export async function api(req,env){
 try{
  const u=new URL(req.url),path=u.pathname.slice('/api/'.length),db=env.DB;
  if(!db)fail('Workspace storage is unavailable.',503);
  if(path==='stripe/webhook'&&req.method==='POST')return await webhook(req,env);
  if(req.method==='POST'&&req.headers.get('Origin')&&req.headers.get('Origin')!==u.origin)fail('Invalid request origin.',403);
  const b=req.method==='POST'?await req.json():{};
  if(req.method==='POST'&&path==='demo')return await start(db,req,b,true);
  if(req.method==='POST'&&path==='onboard')return await start(db,req,b,false);
  let m=await session(req,db);
  if(path==='identity')return json({localSignOut:env.LOCAL_AUTH===true&&!!principal(req),signedIn:!!principal(req),email:mail(req),workspaces:principal(req)?(await query(db,'SELECT m.org_id,json_extract(o.document,\'$.name\') as name FROM members m JOIN organizations o ON m.org_id=o.id WHERE principal=?',principal(req)).all()).results:[]});
  if(path==='switch'&&req.method==='POST'){
    const member=await query(db,'SELECT * FROM members WHERE org_id=? AND principal=?',String(b.org),principal(req)||'').first()||fail('Workspace not found.',404);
    return await login(db,member,req,false);
  }
  if(path==='join'&&req.method==='POST'){
    if(!principal(req))fail('Sign in before accepting an invitation.',401);
    const inv=await query(db,'SELECT * FROM invites WHERE token=? AND expires>?',await hash(str(b.token)),Date.now()).first();
    if(!inv||inv.email!==mail(req))fail('This invitation is invalid or belongs to a different email.',403);
    const s=JSON.parse((await doc(db,inv.org_id)).document),name=required(b.name,'your name');
    const stmt=query(db,'INSERT OR IGNORE INTO members SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM members WHERE org_id=?)<?',inv.org_id,principal(req),name,mail(req),inv.role,inv.org_id,plans[s.plan].staff);
    const result=await stmt.run();if(!result.meta.changes)fail('This invitation cannot add another member.',409);
    await query(db,'DELETE FROM invites WHERE token=?',inv.token).run();
    return await login(db,{org_id:inv.org_id,principal:principal(req)},req,false);
  }
  if(!m)fail('Choose a workspace to continue.',401);
  const id=m.org_id;
  if(path==='customer/export'&&req.method==='GET'){
    permit(m.role,['Owner']);
    const workspace=JSON.parse((await doc(db,id)).document);
    const customer=workspace.customers.find(c=>c.id===u.searchParams.get('id'));
    if(!customer)fail('Customer not found.',404);
    const purchases=workspace.orders.filter(o=>o.customer===customer.id).map(o=>({
      order:o.id,date:new Date(o.date).toISOString(),store:workspace.stores.find(s=>s.id===o.store)?.name||o.store,
      channel:o.channel,method:o.method,status:o.status,totalPence:o.total,vatPence:o.tax,discountPercent:o.discount,
      items:o.items.map(i=>({sku:i.sku,name:i.name,size:i.size,quantity:i.qty,unitPricePence:i.price})),
      ...(o.refund?{refund:{date:new Date(o.refund.date).toISOString(),reason:o.refund.reason}}:{})
    }));
    const report={business:workspace.name,currency:'GBP',customer:{id:customer.id,name:customer.name,
      email:customer.email,phone:customer.phone,marketingConsent:customer.consent===true},purchases};
    return new Response(JSON.stringify(report,null,2),{headers:{
      'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
      'Content-Disposition':'attachment; filename="customer-export.json"'
    }});
  }
  if(path==='state'&&req.method==='GET'){
    const s=JSON.parse((await doc(db,id)).document);
    if(m.role==='Cashier'){s.orders=s.orders.filter(o=>Date.now()-o.date<86400000*30);s.products=s.products.map(({cost,...p})=>p);s.orders.forEach(o=>o.items.forEach(i=>{delete i.cost}));s.movements=[];s.suppliers=[];s.purchaseOrders=[];delete s.stripeCustomer;delete s.subscription;delete s.plan;delete s.billing}
    delete s.events;delete s.audit;delete s.catalogImports;
    return json({workspace:s,member:{name:m.name,email:m.email,role:m.role},members:m.role==='Owner'?await members(db,id):[],cardEnabled:!!(stripeReady(env)&&s.stripeAccount),billingEnabled:stripeReady(env),signedIn:!!principal(req)});
  }
  if(req.method!=='POST')fail('Route not found.',404);
  if(path==='logout'){const t=(req.headers.get('Cookie')||'').match(/rp_session=([a-f0-9-]+)/)?.[1];if(t)await query(db,'DELETE FROM sessions WHERE token=?',await hash(t)).run();return json({ok:true},200,{'Set-Cookie':'rp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'})}
  const current=JSON.parse((await doc(db,id)).document);
  if(!current.demo&&!['stripe/billing','stripe/portal'].includes(path)&&((current.billing==='trial'&&current.trialEnd<Date.now())||(['past_due','canceled','unpaid'].includes(current.billing)&&current.graceEnd<Date.now())))fail('Your workspace is read-only. Update billing to continue.',403);
  if(path==='products/import/preview'||path==='products/import'){
    permit(m.role,['Owner','Manager']);
    if(typeof b.csv!=='string'||b.csv.length>262144||typeof b.store!=='string')fail('Choose a store and a CSV file up to 256 KiB.');
    const key=await hash(JSON.stringify([id,b.store,b.csv]));
    const previous=current.catalogImports?.[key];
    if(previous)return json({alreadyImported:true,count:previous.count});
    const preview=await hash(key+'|'+current.vat);
    if(path.endsWith('/preview')){
      return json({...planCatalogImport(current,b.csv,b.store),preview});
    }
    if(b.preview!==preview)fail('Preview this file for the selected store before importing.',409);
    return json(await write(db,id,s=>commitCatalogImport(s,b.csv,b.store,m,key,current.vat)));
  }
  if(path==='invite'){
    permit(m.role,['Owner']);const email=str(b.email).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!['Manager','Cashier'].includes(b.role))fail('Enter a valid email and role.');
    if(current.demo)fail('Create a business workspace before inviting real staff.');
    if((await members(db,id)).length>=plans[current.plan].staff)fail('Upgrade your plan to invite more staff.',403);
    const token=uid()+uid();await query(db,'INSERT INTO invites VALUES(?,?,?,?,?)',await hash(token),id,email,b.role,Date.now()+7*86400000).run();
    const link=u.origin+'/?invite='+token;let sent=false;
    if(env.RESEND_API_KEY&&env.RETAILPILOT_FROM_EMAIL){try{const delivery=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:env.RETAILPILOT_FROM_EMAIL,to:[email],subject:'Your RetailPilot team invitation',text:m.name+' invited you to '+current.name+' as a '+b.role+'. Sign in with this email to accept within seven days: '+link})});sent=delivery.ok}catch{}}
    return json({link,sent});
  }
  if(path==='member'){
    permit(m.role,['Owner']);const member=await query(db,'SELECT * FROM members WHERE org_id=? AND principal=?',id,str(b.principal,240)).first();
    if(!member)fail('Member not found.',404);if(member.role==='Owner')fail('The owner keeps access to this workspace.',403);
    if(b.remove===true){await db.batch([query(db,'DELETE FROM members WHERE org_id=? AND principal=?',id,member.principal),query(db,'DELETE FROM sessions WHERE org_id=? AND principal=?',id,member.principal)])}
    else{if(!['Cashier','Manager'].includes(b.role))fail('Select a staff role.');await query(db,'UPDATE members SET role=? WHERE org_id=? AND principal=?',b.role,id,member.principal).run()}
    return json({ok:true});
  }
  if(path==='payment/resume'){
    const order=current.orders.find(o=>o.id===b.id)||fail('Order not found.',404);
    if(order.status!=='Pending'||order.method!=='Stripe')fail('This order is not awaiting payment.');
    const session=await retailCheckoutUrl(env,u.origin,id,order,current.stripeAccount);return json({url:session.url});
  }
  if(path==='stripe/account'){
    permit(m.role,['Owner']);if(current.demo||!/^acct_[A-Za-z0-9]+$/.test(b.account))fail('Enter a connected test account.');
    if(!env.STRIPE_ACCOUNTS||!env.STRIPE_ACCOUNTS.split(',').includes(id+'='+b.account))fail('This merchant account must first be assigned to this workspace on the server.',403);
    await write(db,id,s=>{s.stripeAccount=b.account});return json({ok:true});
  }
  if(path==='stripe/billing'||path==='stripe/portal'){
    permit(m.role,['Owner']);if(current.demo)fail('Use the demo plan selector.');
    if(path.endsWith('portal')){if(!current.stripeCustomer)fail('No billing account is connected.');return json(await stripe(env,'billing_portal/sessions',{customer:current.stripeCustomer,return_url:u.origin+'/#billing'}))}
    const plan=plans[b.plan];if(!plan)fail('Select a plan.');
    if(current.stores.length>plan.stores||(await members(db,id)).length>plan.staff)fail('Your workspace exceeds this plan’s limits.');
    if(current.subscription&&current.billing==='active')fail('Manage the existing subscription in the billing portal.');
    const price=env['STRIPE_PRICE_'+b.plan.toUpperCase()];if(!price)fail('This test billing price has not been configured.',503);
    return json(await stripe(env,'checkout/sessions',{mode:'subscription','line_items[0][price]':price,'line_items[0][quantity]':'1','metadata[org]':id,'metadata[plan]':b.plan,'metadata[flow]':'billing','subscription_data[metadata][org]':id,'subscription_data[metadata][flow]':'billing',success_url:u.origin+'/#billing',cancel_url:u.origin+'/#billing'}));
  }
  if(path==='refund'&&current.orders.find(x=>x.id===b.id)?.method==='Stripe'){
    const o=current.orders.find(x=>x.id===b.id);if(o.status==='Refunded')return json(o);if(o.status!=='Paid'||!o.intent)fail('Payment is not confirmed.');
    if(m.role==='Cashier'&&o.total>10000)fail('Manager approval required.',403);required(b.reason,'a return reason');
    const res=await stripe(env,'refunds',{payment_intent:o.intent},id+o.id+'refund',current.stripeAccount);
    if(res.status!=='succeeded')fail('The refund is awaiting provider confirmation.',409);
    return json(await write(db,id,s=>refund(s,{...b,providerVerified:true},m)));
  }
  if(path==='checkout'&&b.method==='Stripe'){
    if(!current.stripeAccount||!stripeReady(env))fail('Connect a test merchant account first.');
    const o=await write(db,id,s=>change(s,'checkout',b,m));
    if(o.status!=='Pending')return json(o);
    const checkout=await retailCheckoutUrl(env,u.origin,id,o,current.stripeAccount);return json({...o,url:checkout.url});
  }
  if(path==='plan')b.memberCount=(await members(db,id)).length;
  return json(await write(db,id,s=>change(s,path,b,m)));
 }catch(e){return json({error:e.status?e.message:'RetailPilot could not complete this request.'},e.status||500)}
}
