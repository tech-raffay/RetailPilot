import {newWorkspace,uid,plans} from './catalog.js';
import {change,fail,permit,required,str,refund,loyaltyReward,loyaltyBalances} from './business.js';
import {stripeReady,stripe,verifyEvent} from './payments.js';
import {planCatalogImport,commitCatalogImport} from './catalog-import.js';
import {mailReady,receiptMessage,stockMessage,queueStatement,deliverEmail} from './email.js';
const json=(v,status=200,headers={})=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...headers}});
const hash=async token=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),x=>x.toString(16).padStart(2,'0')).join('');
const query=(db,sql,...args)=>db.prepare(sql).bind(...args);
async function doc(db,id){return await query(db,'SELECT * FROM organizations WHERE id=?',id).first()||fail('Workspace not found.',404)}
async function write(db,id,fn,env,removedCustomer){
  for(let i=0;i<7;i++){
    const row=await doc(db,id),s=JSON.parse(row.document),jobs=[];
    const moves=s.movements.length,orders=s.orders.length,v=fn(s,jobs);
    const statements=[];
    if(!s.demo&&mailReady(env)){
      if(s.orders.length>orders)jobs.push(receiptMessage(s,s.orders.at(-1)));
      if(s.movements.length>moves)jobs.push(await stockMessage(db,id,s,s.movements.slice(moves)));
      for(const job of jobs.filter(Boolean))statements.push(queueStatement(env,id,job,row.revision));
    }
    if(removedCustomer)statements.push(query(db,"DELETE FROM email_outbox WHERE org_id=? AND customer_id=? AND EXISTS (SELECT 1 FROM organizations WHERE id=? AND revision=?)",id,removedCustomer,id,row.revision));
    const update=query(db,'UPDATE organizations SET document=?,revision=revision+1 WHERE id=? AND revision=?',JSON.stringify(s),id,row.revision);
    const r=statements.length?(await db.batch([...statements,update])).at(-1):await update.run();
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
 if(order.pickup){
   fields.success_url=fields.cancel_url=origin+'/shop.html?shop='+id+'#'+order.key.slice('pickup:'.length);
 }
 return stripe(env,'checkout/sessions',fields,id+order.id,order.pickup?.account||account);
}
function readOnlyBusiness(s){
  return !s.demo&&((s.billing==='trial'&&s.trialEnd<Date.now())||(['past_due','canceled','unpaid'].includes(s.billing)&&s.graceEnd<Date.now()));
}
function cancelReservation(s,order,reason){
  if(order.status!=='Pending')return;
  order.status='Cancelled';
  for(const item of order.items){
    const p=s.products.find(p=>p.id===item.id);
    p.stock[order.store]+=item.qty;
    s.movements.push({id:uid(),date:Date.now(),name:p.name,product:p.id,store:order.store,delta:item.qty,after:p.stock[order.store],reason,ref:order.id,actor:'Stripe'});
  }
}
function publicPickup(order){
  return {id:order.id,status:order.status,total:order.total,location:order.pickup.location,address:order.pickup.address,
    collected:!!order.pickup.collectedAt,processing:order.status==='Pending'&&order.paymentProcessing===true,
    ...(order.status==='Paid'?{code:order.pickup.code}:{})};
}
async function storefront(req,env,u,id,action,b){
  const db=env.DB;
  const shop=JSON.parse((await doc(db,id)).document);
  const available=s=>s.storefront?.enabled&&!readOnlyBusiness(s)&&(!s.demo||s.storefront.expires>Date.now());
  if(!action&&req.method==='GET'){
    if(!available(shop))fail('This storefront is closed.',404);
    const store=shop.stores.find(s=>s.id===shop.storefront.store);
    return json({name:shop.name,store:{id:store.id,name:store.name,address:store.address},demo:shop.demo,
      checkoutEnabled:shop.demo||!!(stripeReady(env)&&shop.stripeAccount),inclusive:shop.inclusive,
      products:shop.products.map(p=>({id:p.id,name:p.name,sku:p.sku,size:p.size,color:p.color,category:p.category,
        price:p.price,tax:p.tax??shop.vat,stock:p.stock[store.id]??0,image:p.photo?'/images/'+p.photo+'.webp':p.imageUrl||''}))});
  }
  if(req.method!=='POST'||!['checkout','status'].includes(action))fail('Route not found.',404);
  if(typeof b.key!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.key))fail('Invalid checkout reference.');
  const key='pickup:'+b.key;
  const findOrder=s=>s.orders.find(o=>o.key===key&&o.pickup);
  let order=findOrder(shop);
  if(action==='status'){
    if(!order)fail('Pickup order not found.',404);
    return json(publicPickup(order));
  }
  if(!order){
    order=await write(db,id,s=>{
      const prior=findOrder(s);if(prior)return prior;
      if(!available(s))fail('This storefront is closed.',404);
      if(s.storefront.store!==b.store)fail('Pickup location changed. Reload the catalog.',409);
      if(!s.demo&&!(stripeReady(env)&&s.stripeAccount))fail('Online payment is unavailable.',503);
      if(s.orders.some(o=>o.key===key))fail('Checkout reference unavailable.',409);
      if(!Array.isArray(b.items)||b.items.some(i=>!i||typeof i.id!=='string'||!Number.isSafeInteger(i.qty)))fail('Invalid basket contents.');
      const o=change(s,'checkout',{key,store:b.store,items:b.items,method:s.demo?'Demo card':'Stripe'},{role:'Cashier',name:'Online storefront'});
      if(o.total!==b.total||o.total<=0)fail('The order total changed. Review the catalog.',409);
      const store=s.stores.find(st=>st.id===o.store);
      o.channel='Click & collect';
      o.pickup={code:uid().slice(0,8).toUpperCase(),location:store.name,address:store.address,account:s.stripeAccount};
      return o;
    },env);
  }
  if(order.status!=='Pending'||order.paymentProcessing)return json(publicPickup(order));
  if(Date.now()-order.date>=24*3600000)fail('Payment session has ended. Check the order status.',409);
  if(order.pickup.checkoutUrl)return json({...publicPickup(order),url:order.pickup.checkoutUrl});
  let session;
  try{session=await retailCheckoutUrl(env,u.origin,id,order,order.pickup.account);}
  catch(error){
    if(error.providerRejected)await write(db,id,s=>{
      const pending=findOrder(s);
      if(!pending.pickup.checkoutUrl)cancelReservation(s,pending,'Checkout unavailable');
    });
    throw error;
  }
  return json(await write(db,id,s=>{
    const saved=findOrder(s);
    if(saved.status!=='Pending'||saved.paymentProcessing)return publicPickup(saved);
    saved.pickup.checkoutUrl=session.url;
    return {...publicPickup(saved),url:session.url};
  }));
}
async function webhook(req,env){
  const raw=await req.text(),signature=req.headers.get('Stripe-Signature');
  let event;try{event=await verifyEvent(raw,signature,env.STRIPE_WEBHOOK_SECRET)}catch(e){if(!env.STRIPE_CONNECT_WEBHOOK_SECRET)throw e;event=await verifyEvent(raw,signature,env.STRIPE_CONNECT_WEBHOOK_SECRET);if(!event.account)fail('Expected a connected-account event.')}
  if(event.livemode)fail('Only test events are accepted.');
  const o=event.data.object,meta=o.metadata||{},id=meta.org;
  if(!id)return json({received:true});
  await write(env.DB,id,(s,jobs)=>{
    if(s.events.includes(event.id))return;
    if(meta.flow==='retail'){
      const order=s.orders.find(x=>x.id===meta.order)||fail('Unknown order.');
      const merchant=order.pickup?.account||s.stripeAccount;
      if(!merchant||event.account!==merchant)fail('Merchant mismatch.');
      const completed=event.type==='checkout.session.completed';
      const matchesTotal=o.amount_total===order.total&&o.currency==='gbp';
      if(completed&&o.payment_status==='unpaid'&&matchesTotal&&order.status==='Pending')order.paymentProcessing=true;
      if((completed||event.type==='checkout.session.async_payment_succeeded')&&o.payment_status==='paid'&&matchesTotal&&order.status==='Pending'){order.status='Paid';order.intent=o.payment_intent;jobs.push(receiptMessage(s,order))}
      if(event.type==='checkout.session.async_payment_failed')cancelReservation(s,order,'Payment failed');
      if(event.type==='checkout.session.expired')cancelReservation(s,order,'Expired checkout');
    }else if(meta.flow==='billing'&&!event.account){
      if(event.type==='checkout.session.completed'&&o.payment_status==='paid'&&plans[meta.plan]){s.plan=meta.plan;s.billing='active';s.stripeCustomer=o.customer;s.subscription=o.subscription}
      if(event.type.startsWith('customer.subscription.')&&o.id===s.subscription){const subPlan=Object.keys(plans).find(p=>env['STRIPE_PRICE_'+p.toUpperCase()]===o.items?.data?.[0]?.price?.id&&o.items?.data?.[0]?.price?.id);if(subPlan)s.plan=subPlan;s.billing=o.status;s.graceEnd=s.graceEnd||Date.now()+3*86400000;if(o.status==='active')s.graceEnd=null}
    }
    s.events.push(event.id);
  },env);return json({received:true});
}
export async function api(req,env){
 try{
  const u=new URL(req.url),path=u.pathname.slice('/api/'.length),db=env.DB;
  if(!db)fail('Workspace storage is unavailable.',503);
  if(path==='stripe/webhook'&&req.method==='POST')return await webhook(req,env);
  if(req.method==='POST'&&req.headers.get('Origin')&&req.headers.get('Origin')!==u.origin)fail('Invalid request origin.',403);
  const b=req.method==='POST'?await req.json():{};
  const shopRoute=path.match(/^shop\/([a-f0-9-]{36})(?:\/(checkout|status))?$/);
  if(shopRoute)return await storefront(req,env,u,shopRoute[1],shopRoute[2],b);
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
  if(path==='email/status'&&req.method==='GET'){
    permit(m.role,['Owner']);
    const counts=(await query(db,'SELECT kind,status,count(*) AS count FROM email_outbox WHERE org_id=? GROUP BY kind,status',id).all()).results;
    return json({configured:mailReady(env),counts});
  }
  if(path==='customer/export'&&req.method==='GET'){
    permit(m.role,['Owner']);
    const workspace=JSON.parse((await doc(db,id)).document);
    const customer=workspace.customers.find(c=>c.id===u.searchParams.get('id'));
    if(!customer)fail('Customer not found.',404);
    const purchases=workspace.orders.filter(o=>o.customer===customer.id).map(o=>({
      order:o.id,date:new Date(o.date).toISOString(),store:workspace.stores.find(s=>s.id===o.store)?.name||o.store,
      channel:o.channel,method:o.method,status:o.status,totalPence:o.total,vatPence:o.tax,discountPercent:o.discount,
      items:o.items.map(i=>({sku:i.sku,name:i.name,size:i.size,quantity:i.qty,unitPricePence:i.price})),
      ...(o.loyalty?{loyalty:o.loyalty}:{}),
      ...(o.refund?{refund:{date:new Date(o.refund.date).toISOString(),reason:o.refund.reason}}:{})
    }));
    const report={business:workspace.name,currency:'GBP',customer:{id:customer.id,name:customer.name,
      email:customer.email,phone:customer.phone,marketingConsent:customer.consent===true,
      availablePoints:loyaltyBalances(workspace.orders).get(customer.id)??0},purchases};
    return new Response(JSON.stringify(report,null,2),{headers:{
      'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
      'Content-Disposition':'attachment; filename="customer-export.json"'
    }});
  }
  if(path==='state'&&req.method==='GET'){
    const s=JSON.parse((await doc(db,id)).document);
    s.loyaltyEnabled=s.loyaltyEnabled??s.demo;
    if(m.role==='Owner')s.storefrontUrl='/shop.html?shop='+id;
    s.loyaltyReward=loyaltyReward;
    const balances=loyaltyBalances(s.orders);
    for(const customer of s.customers)customer.availablePoints=balances.get(customer.id)??0;
    for(const o of s.orders){
      if(!o.pickup)continue;
      delete o.key;
      delete o.pickup.code;
      delete o.pickup.account;
      delete o.pickup.checkoutUrl;
    }
    if(m.role==='Cashier'){s.orders=s.orders.filter(o=>Date.now()-o.date<86400000*30);s.products=s.products.map(({cost,...p})=>p);s.orders.forEach(o=>o.items.forEach(i=>{delete i.cost}));s.movements=[];s.suppliers=[];s.purchaseOrders=[];delete s.stripeCustomer;delete s.subscription;delete s.plan;delete s.billing}
    delete s.events;delete s.audit;delete s.catalogImports;
    return json({workspace:s,member:{name:m.name,email:m.email,role:m.role},members:m.role==='Owner'?await members(db,id):[],cardEnabled:!!(stripeReady(env)&&s.stripeAccount),localAuth:env.LOCAL_AUTH===true,emailEnabled:mailReady(env)&&!s.demo,billingEnabled:stripeReady(env),signedIn:!!principal(req)});
  }
  if(req.method!=='POST')fail('Route not found.',404);
  if(path==='logout'){const t=(req.headers.get('Cookie')||'').match(/rp_session=([a-f0-9-]+)/)?.[1];if(t)await query(db,'DELETE FROM sessions WHERE token=?',await hash(t)).run();return json({ok:true},200,{'Set-Cookie':'rp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'})}
  const current=JSON.parse((await doc(db,id)).document);
  if(path==='checkout'&&b.emailReceipt===true&&!mailReady(env)&&!current.orders.some(o=>o.key===b.key))fail('Email receipts are unavailable. Clear the receipt option to continue.',503);
  if(readOnlyBusiness(current)&&!['stripe/billing','stripe/portal'].includes(path))fail('Your workspace is read-only. Update billing to continue.',403);
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
    let token=uid()+uid();
    if(mailReady(env)&&typeof b.key==='string'&&/^[a-f0-9-]{36}$/.test(b.key)){
      const enc=new TextEncoder();
      const secret=await crypto.subtle.importKey('raw',enc.encode(env.RESEND_API_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
      const bytes=await crypto.subtle.sign('HMAC',secret,enc.encode(JSON.stringify([id,email,b.role,b.key])));
      token=Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
    }
    const digest=await hash(token),link=u.origin+'/?invite='+token;
    if(await query(db,'SELECT principal FROM members WHERE org_id=? AND email=?',id,email).first())fail('This email already belongs to your team.',409);
    const insert=query(db,'INSERT OR IGNORE INTO invites VALUES(?,?,?,?,?)',digest,id,email,b.role,Date.now()+7*86400000);
    if(!mailReady(env)){await insert.run();return json({link,sent:false,queued:false})}
    const job={kind:'invite',key:'invite/'+digest,to:email,subject:'Your RetailPilot team invitation',
      text:m.name+' invited you to '+current.name+' as a '+b.role+'. Sign in with this email to accept within seven days: '+link};
    await db.batch([insert,queueStatement(env,id,job)]);
    const jobId=id+'/'+job.key;
    try{await deliverEmail(env,jobId)}catch{}
    const delivery=await query(db,'SELECT status FROM email_outbox WHERE id=?',jobId).first();
    return json({link,sent:delivery?.status==='accepted',queued:delivery?.status==='queued'});
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
    if(order.pickup)fail('Resume online payment from the shopper’s order page.',409);
    if(order.paymentProcessing&&order.status==='Pending')fail('Stripe is processing the payment.',409);
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
    const res=await stripe(env,'refunds',{payment_intent:o.intent},id+o.id+'refund',o.pickup?.account||current.stripeAccount);
    if(res.status!=='succeeded')fail('The refund is awaiting provider confirmation.',409);
    return json(await write(db,id,s=>refund(s,{...b,providerVerified:true},m)));
  }
  if(path==='checkout'&&b.method==='Stripe'){
    if(!current.stripeAccount||!stripeReady(env))fail('Connect a test merchant account first.');
    const o=await write(db,id,s=>change(s,'checkout',b,m),env);
    if(o.status!=='Pending'||o.paymentProcessing)return json(o);
    const checkout=await retailCheckoutUrl(env,u.origin,id,o,current.stripeAccount);return json({...o,url:checkout.url});
  }
  if(path==='plan')b.memberCount=(await members(db,id)).length;
  return json(await write(db,id,s=>change(s,path,b,m),env,path==='customer/remove'?b.id:null));
 }catch(e){return json({error:e.status?e.message:'RetailPilot could not complete this request.'},e.status||500)}
}
