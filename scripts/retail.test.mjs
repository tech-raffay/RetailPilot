import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {api} from '../src/api.js';
import {openDatabase} from './local-db.mjs';
import {verifyEvent} from '../src/payments.js';
import {flushEmail} from '../src/email.js';
const DB=openDatabase();
async function call(path,body,cookie='',person='',email='',env={}){
 const res=await api(new Request('https://retail.test/api/'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,'Content-Type':'application/json',...(person?{'oai-authenticated-user-id':person,'oai-authenticated-user-email':email||person+'@example.com'}:{})},body:body===undefined?undefined:JSON.stringify(body)}),{DB,...env});
 return {status:res.status,body:await res.json(),cookie:res.headers.get('Set-Cookie')?.split(';')[0]};
}
async function demo(role='Owner'){const r=await call('demo',{role});assert.equal(r.status,200);return r.cookie}
const cart=(key,qty=2)=>({key,method:'Cash',store:'london',items:[{id:'JKT-001',qty}],received:200000});
test('platform directory requires an approved identity and only exposes business usage',async t=>{
 const db=openDatabase(); t.after(()=>db.raw.close());
 const env={DB:db,RETAILPILOT_PLATFORM_ADMINS:'ops-two, ops-one, demo:fixture'};
 const directory=(suffix='',person='ops-one',body,cookie='')=>call('platform/businesses'+suffix,body,cookie,person,'',env);
 const owner=(await call('onboard',{name:'100% Cotton',owner:'Private Owner',store:'London'},'','merchant','',env)).cookie;
 const merchant=(path,body)=>call(path,body,owner,'merchant','',env);
 const id=(await merchant('identity')).body.workspaces[0].org_id;
 const product=await merchant('product',{sku:'DIR',name:'Private product',category:'Test',price:100,cost:10,threshold:0,quantity:2,store:'london'});
 assert.equal((await merchant('checkout',{...cart('directory-order',1),items:[{id:product.body.id,qty:1}]})).status,200);
 await call('demo',{role:'Cashier'},'','','',env);
 assert.equal((await directory('','')).status,401);
 assert.equal((await directory('','merchant',undefined,owner)).status,403);
 assert.equal((await directory('','demo:fixture')).status,403);
 assert.equal((await directory('','ops')).status,403);
 assert.equal((await call('platform/businesses',undefined,'','ops-one','',{DB:db})).status,403);
 assert.equal((await directory('','ops-one',{})).status,405);
 assert.equal((await directory('?page=0')).status,400);
 const {workspace}= (await merchant('state')).body;
 const expected={id,name:'100% Cotton',plan:workspace.plan,billing:workspace.billing,stores:1,staff:1,variants:1,orders:1};
 assert.deepEqual((await directory()).body,{businesses:[expected],page:1,hasMore:false});
 assert.deepEqual((await directory('?q='+id)).body.businesses,[expected]);
 const insert=db.raw.prepare('INSERT INTO organizations(id,document) VALUES(?,?)');
 for(let i=0;i<25;i++)insert.run('org-'+i,JSON.stringify({...workspace,name:'Another shop'}));
 assert.deepEqual((await directory('?q=%25')).body.businesses,[expected]);
 assert.deepEqual((await directory('?q=COTTON')).body.businesses,[expected]);
 const first=(await directory()).body,second=(await directory('?page=2')).body;
 assert.equal(first.businesses.length,25);assert.equal(first.hasMore,true);
 assert.equal(second.businesses.length,1);assert.equal(second.hasMore,false);
 assert.equal(new Set([...first.businesses,...second.businesses].map(b=>b.id)).size,26);
});
test('storefront limits public data and shares inventory with the register',async()=>{
 const owner=await demo();
 const state=async()=>(await call('state',undefined,owner)).body.workspace;
 const shopPath='shop/'+new URL((await state()).storefrontUrl,'https://retail.test').searchParams.get('shop');
 const configure=enabled=>call('storefront/settings',{enabled,store:'london'},owner);
 assert.equal((await call(shopPath)).status,404);
 assert.equal((await call('storefront/settings',{enabled:true,store:'london'},await demo('Cashier'))).status,403);
 await configure(true);
 const catalog=(await call(shopPath)).body;
 assert.equal(catalog.name,'Northline Outfitters');
 assert.equal(catalog.customers,undefined);assert.equal(catalog.products[0].cost,undefined);
 const key=crypto.randomUUID();
 const checkout={key,store:'london',items:[{id:'JKT-001',qty:1}],total:5999,discount:99,method:'Cash'};
 assert.equal((await call(shopPath+'/checkout',{...checkout,total:1})).status,409);
 assert.equal((await state()).products[0].stock.london,10);
 const [first,repeat]=await Promise.all([call(shopPath+'/checkout',checkout),call(shopPath+'/checkout',checkout)]);
 assert.deepEqual(first.body,repeat.body);
 assert.equal(first.body.status,'Paid');
 assert.equal((await state()).products[0].stock.london,9);
 const staffOrder=(await state()).orders.find(o=>o.id===first.body.id);
 assert.equal(staffOrder.channel,'Click & collect');
 assert.equal(staffOrder.pickup.code,undefined);
 assert.equal(staffOrder.key,undefined);
 assert.equal((await call(shopPath+'/status',{key:crypto.randomUUID()})).status,404);
 await configure(false);
 assert.equal((await call(shopPath)).status,404);
 assert.equal((await call(shopPath+'/status',{key})).body.code,first.body.code);
 assert.equal((await call('pickup/collect',{id:first.body.id,code:'wrong'},owner)).status,400);
 assert.equal((await call('pickup/collect',{id:first.body.id,code:first.body.code},owner)).status,200);
 assert.equal((await call(shopPath+'/status',{key})).body.collected,true);
 await configure(true);
 await call('adjust',{product:'JKT-001',store:'london',delta:-8,reason:'Count'},owner);
 const results=await Promise.all([call(shopPath+'/checkout',{...checkout,key:crypto.randomUUID()}),call('checkout',cart('last-pos',1),owner)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal((await state()).products[0].stock.london,0);
});
test('storefront checkout uses the merchant and releases stock after a definitive session rejection',async t=>{
 const person='online-owner',env={STRIPE_TEST_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'fixture'};
 const owner=(await call('onboard',{name:'Online shop',store:'London',owner:'Owner'},'',person)).cookie;
 const post=(path,data)=>call(path,data,owner,person,'',env);
 const org=(await post('identity',undefined)).body.workspaces[0].org_id;
 env.STRIPE_ACCOUNTS=org+'=acct_pickup';
 await post('storefront/settings',{enabled:true,store:'london'});
 const p=(await post('product',{sku:'ON',name:'Online item',category:'Test',price:500,cost:100,threshold:0,quantity:2,store:'london'})).body;
 const path='shop/'+org,guest=(action,data)=>call(path+'/'+action,data,'','','',env);
 const payload={key:crypto.randomUUID(),store:'london',total:500,items:[{id:p.id,qty:1}]};
 assert.equal((await guest('checkout',payload)).status,503);
 await post('stripe/account',{account:'acct_pickup'});
 let reject=true;
 t.mock.method(globalThis,'fetch',async(url,{headers,body})=>{
   assert.equal(headers['Stripe-Account'],'acct_pickup');
   assert.equal(body.has('payment_method_types[0]'),false);
   assert.ok(body.get('success_url').includes('/shop.html?shop='+org+'#'));
   return reject?Response.json({error:{type:'invalid_request_error'}},{status:400}):Response.json({url:'https://checkout.example.test/test'});
 });
 assert.equal((await guest('checkout',payload)).status,502);
 assert.equal((await guest('status',payload)).body.status,'Cancelled');
 assert.equal((await call(path)).body.products[0].stock,2);
 reject=false;payload.key=crypto.randomUUID();
 const pending=await guest('checkout',payload);
 assert.equal(pending.body.status,'Pending');assert.equal(pending.body.code,undefined);
 reject=true;
 assert.equal((await guest('checkout',{key:payload.key})).body.url,pending.body.url);
 async function event(order,type,paymentStatus){
   const raw=JSON.stringify({id:order+type,type,account:'acct_pickup',livemode:false,data:{object:{
     metadata:{org,flow:'retail',order},currency:'gbp',amount_total:500,payment_status:paymentStatus,payment_intent:'pi_pickup'}}});
   const time=Math.floor(Date.now()/1000),sig=createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(time+'.'+raw).digest('hex');
   const response=await api(new Request('https://retail.test/api/stripe/webhook',{method:'POST',body:raw,headers:{'Stripe-Signature':'t='+time+',v1='+sig}}),{DB,...env});
   assert.equal(response.status,200);
 }
 await event(pending.body.id,'checkout.session.completed','unpaid');
 const processing=(await guest('checkout',{key:payload.key})).body;
 assert.equal(processing.processing,true);
 assert.equal(processing.code,undefined);assert.equal(processing.url,undefined);
 await event(pending.body.id,'checkout.session.async_payment_succeeded','paid');
 assert.match((await guest('status',payload)).body.code,/^[A-F0-9]{8}$/);
 assert.equal((await call(path)).body.products[0].stock,1);
 reject=false;payload.key=crypto.randomUUID();
 const next=(await guest('checkout',payload)).body;
 await event(next.id,'checkout.session.completed','unpaid');
 for(let i=0;i<2;i++)await event(next.id,'checkout.session.async_payment_failed','unpaid');
 assert.equal((await guest('status',payload)).body.status,'Cancelled');
 assert.equal((await call(path)).body.products[0].stock,1);
});
test('loyalty rewards cannot be spent twice and returns reverse both sides of a sale',async()=>{
 const owner=await demo();
 const post=(path,data)=>call(path,data,owner);
 const buyer=(await post('customer',{name:'Reward buyer'})).body;
 const balance=async()=>(await post('customer/export?id='+buyer.id,undefined)).body.customer.availablePoints;
 const purchase=async(key,qty,extra={})=>post('checkout',{...cart(key,qty),customer:buyer.id,...extra});
 await post('loyalty/settings',{enabled:false});
 assert.equal((await purchase('before',1)).body.loyalty,undefined);
 assert.equal((await call('loyalty/settings',{enabled:true},await demo('Cashier'))).status,403);
 await post('loyalty/settings',{enabled:true});
 const initial=(await purchase('earn',2)).body;
 assert.equal(await balance(),119);
 assert.equal((await purchase('stack',1,{redeemReward:true,discount:5})).status,400);
 const result=await Promise.all(['reward-a','reward-b'].map(key=>purchase(key,1,{redeemReward:true})));
 assert.deepEqual(result.map(r=>r.status).sort(),[200,409]);
 const reward=result.find(r=>r.status===200).body;
 assert.equal(reward.total,5399);
 assert.deepEqual(reward.loyalty,{earned:53,redeemed:100});
 assert.equal((await purchase(reward.key,1,{redeemReward:true})).body.id,reward.id);
 assert.equal(await balance(),72);
 await post('refund',{id:initial.id,reason:'Return',restock:true});
 assert.equal(await balance(),-47);
 for(let i=0;i<2;i++)await post('refund',{id:reward.id,reason:'Return',restock:true});
 assert.equal(await balance(),0);
});
test('an expired Stripe checkout releases reserved loyalty points',async t=>{
 const person='loyalty-expiry';
 const env={STRIPE_TEST_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'fixture'};
 const cookie=(await call('onboard',{name:'Reward shop',store:'London',owner:'Owner'},'',person)).cookie;
 const post=(path,data)=>call(path,data,cookie,person,'',env);
 const org=(await post('identity',undefined)).body.workspaces[0].org_id;
 env.STRIPE_ACCOUNTS=org+'=acct_loyalty';
 await post('stripe/account',{account:'acct_loyalty'});
 await post('loyalty/settings',{enabled:true});
 const customer=(await post('customer',{name:'Buyer'})).body.id;
 const product=(await post('product',{name:'Jacket',sku:'JKT',category:'Clothes',price:5999,cost:0,quantity:3,threshold:0,store:'london'})).body.id;
 t.mock.method(globalThis,'fetch',async()=>Response.json({url:'https://checkout.example.test/reward'}));
 const balance=async()=>(await post('customer/export?id='+customer,undefined)).body.customer.availablePoints;
 await post('checkout',{...cart('points-earn'),customer,items:[{id:product,qty:2}]});
 assert.equal(await balance(),119);
 const pending=await post('checkout',{...cart('points-hold'),customer,items:[{id:product,qty:1}],method:'Stripe',redeemReward:true});
 assert.equal(pending.body.status,'Pending');
 assert.equal(await balance(),19);
 const raw=JSON.stringify({id:'evt_reward_expired',type:'checkout.session.expired',account:'acct_loyalty',
   livemode:false,data:{object:{metadata:{org,order:pending.body.id,flow:'retail'}}}});
 const time=Math.floor(Date.now()/1000);
 const sig=createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(time+'.'+raw).digest('hex');
 const event=await api(new Request('https://retail.test/api/stripe/webhook',{method:'POST',body:raw,
   headers:{'Stripe-Signature':'t='+time+',v1='+sig}}),{DB,...env});
 assert.equal(event.status,200);
 assert.equal(await balance(),119);
});
test('stock check finds ledger drift and incomplete transfers without changing stored records',t=>{
 const dir=mkdtempSync(join(tmpdir(),'retailpilot-stock-'));
 const db=openDatabase(join(dir,'retail.sqlite')).raw;
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const put=db.prepare('INSERT OR REPLACE INTO organizations(id,document) VALUES (?,?)');
 const shop={stores:[{id:'london'},{id:'york'}],products:[{id:'j',sku:'JKT',stock:{london:8,york:2}}],movements:[
   {id:'open',product:'j',store:'london',delta:10,after:10,reason:'Opening stock'},
   {id:'out',product:'j',store:'london',otherStore:'york',delta:-2,after:8,reason:'Transfer out',ref:'TR-1'},
   {id:'in',product:'j',store:'york',otherStore:'london',delta:2,after:2,reason:'Transfer in',ref:'TR-1'}
 ]};
 const run=()=>spawnSync(process.execPath,['scripts/check-stock.mjs'],{encoding:'utf8',env:{...process.env,RETAILPILOT_DATA_DIR:dir}});
 put.run('shop',JSON.stringify(shop));
 put.run('demo',JSON.stringify({demo:true}));
 const clean=run();
 assert.equal(clean.status,0,clean.stderr);
 assert.match(clean.stdout,/Business workspaces checked: 1. Demos skipped: 1/);
 shop.movements.pop();
 shop.movements[1].after=9;
 shop.products[0].stock.london=7;
 const before=JSON.stringify(shop);
 put.run('shop',before);
 const drift=run();
 assert.equal(drift.status,2,drift.stderr);
 assert.match(drift.stderr,/Movement balance mismatch/);
 assert.match(drift.stderr,/Inventory balance mismatch/);
 assert.match(drift.stderr,/Unmatched stock transfer/);
 assert.equal(db.prepare("SELECT document FROM organizations WHERE id='shop'").get().document,before);
 put.run('broken','{}');
 assert.equal(run().status,1);
});
test('Stripe checkout reserves once and a confirmed refund restores stock once',async t=>{
 const person='sandbox-check',account='acct_check',intent='pi_checkout_check';
 const DB=openDatabase();
 t.after(()=>DB.raw.close());
 const env={DB,STRIPE_TEST_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'webhook-fixture',
   RESEND_API_KEY:'mail-fixture',RETAILPILOT_FROM_EMAIL:'shop@example.test'};
 const owner=(await call('onboard',{name:'Sandbox shop',store:'London',owner:'Owner'},'',person,'',env)).cookie;
 const org=(await call('identity',undefined,owner,person,'',env)).body.workspaces[0].org_id;
 env.STRIPE_ACCOUNTS=org+'='+account;
 const post=(path,data)=>call(path,data,owner,person,'',env);
 assert.equal((await post('stripe/account',{account})).status,200);
 await post('loyalty/settings',{enabled:true});
 const product=(await post('product',{name:'Test item',sku:'TEST',category:'Test',price:100,cost:10,quantity:2,threshold:0,store:'london'})).body;
 const customer=(await post('customer',{name:'Buyer',email:'buyer@example.test'})).body;
 const requests=[];
 let refundAvailable=false;
 t.mock.method(globalThis,'fetch',async(url,{headers,body})=>{
   assert.equal(headers['Stripe-Account'],account);
   const path=new URL(url).pathname;
   requests.push({path,key:headers['Idempotency-Key']});
   if(path==='/v1/checkout/sessions'){
     assert.equal(body.get('line_items[0][price_data][unit_amount]'),'100');
     assert.equal(body.get('metadata[org]'),org);
     return Response.json({url:'https://checkout.example.test/session'});
   }
   assert.equal(path,'/v1/refunds');
   assert.equal(body.get('payment_intent'),intent);
   return refundAvailable?Response.json({status:'succeeded'}):Response.json({error:{message:'Temporary failure'}},{status:503});
 });
 const sale={key:'sandbox-sale',store:'london',method:'Stripe',customer:customer.id,emailReceipt:true,items:[{id:product.id,qty:1}]};
 const pending=await post('checkout',sale);
 assert.equal(pending.status,200);
 assert.equal(pending.body.status,'Pending');
 assert.equal((await post('checkout',sale)).body.id,pending.body.id);
 assert.equal(requests[0].key,requests[1].key);
 const state=async()=>(await call('state',undefined,owner,person,'',env)).body.workspace;
 const receipts=()=>DB.raw.prepare("SELECT count(*) AS n FROM email_outbox WHERE org_id=? AND kind='receipt'").get(org).n;
 assert.equal((await state()).products[0].stock.london,1);
 assert.equal(receipts(),0);
 assert.equal((await state()).customers[0].availablePoints,0);
 const raw=JSON.stringify({id:'evt_checkout_check',type:'checkout.session.completed',livemode:false,account,data:{object:{
   metadata:{org,order:pending.body.id,flow:'retail'},currency:'gbp',amount_total:100,payment_status:'paid',payment_intent:intent}}});
 const time=Math.floor(Date.now()/1000),sig=createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(time+'.'+raw).digest('hex');
 for(let i=0;i<2;i++){
   const res=await api(new Request('https://retail.test/api/stripe/webhook',{method:'POST',body:raw,headers:{'Stripe-Signature':'t='+time+',v1='+sig}}),{DB,...env});
   assert.equal(res.status,200);
 }
 assert.equal(receipts(),1);
 assert.equal((await state()).customers[0].availablePoints,1);
 const refund={id:pending.body.id,reason:'Test return',restock:true};
 assert.equal((await post('refund',refund)).status,502);
 const beforeRetry=await state();
 assert.equal(beforeRetry.orders[0].status,'Paid');
 assert.equal(beforeRetry.products[0].stock.london,1);
 refundAvailable=true;
 for(let i=0;i<2;i++)assert.equal((await post('refund',refund)).body.status,'Refunded');
 const after=await state();
 assert.equal(after.customers[0].availablePoints,0);
 assert.equal(after.products[0].stock.london,2);
 assert.equal(after.movements.filter(m=>m.reason==='Return').length,1);
 assert.equal(requests.length,4);
 assert.equal(requests[2].key,requests[3].key);
 assert.notEqual(requests[0].key,requests[2].key);
});
test('Stripe receipt waits for a signed paid event and pending receipt data is removed with its customer',async()=>{
 const env={DB,RESEND_API_KEY:'mock',RETAILPILOT_FROM_EMAIL:'shop@example.test',STRIPE_WEBHOOK_SECRET:'whsec_mock'};
 const owner=(await call('onboard',{name:'Stripe Mail',store:'London',owner:'Owner'},'','stripe-mail')).cookie;
 const org=(await call('identity',undefined,owner,'stripe-mail')).body.workspaces[0].org_id;
 const shop=JSON.parse(DB.raw.prepare('SELECT document FROM organizations WHERE id=?').get(org).document);
 shop.stripeAccount='acct_mail';shop.customers.push({id:'buyer',email:'test@example.test'});
 shop.orders.push({id:'ORD-23',method:'Stripe',status:'Pending',emailReceipt:true,customer:'buyer',date:Date.now(),store:'london',items:[],discount:0,tax:200,total:1200});
 DB.raw.prepare('UPDATE organizations SET document=? WHERE id=?').run(JSON.stringify(shop),org);
 async function event(id,payment_status){
   const raw=JSON.stringify({id,type:'checkout.session.completed',livemode:false,account:'acct_mail',data:{object:{
     currency:'gbp',amount_total:1200,payment_status,payment_intent:'pi_mail',metadata:{org,flow:'retail',order:'ORD-23'}}}});
   const t=Math.floor(Date.now()/1000),signature=createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(t+'.'+raw).digest('hex');
   return api(new Request('https://retail.test/api/stripe/webhook',{method:'POST',headers:{'Stripe-Signature':'t='+t+',v1='+signature},body:raw}),env);
 }
 const count=()=>DB.raw.prepare('SELECT count(*) AS n FROM email_outbox WHERE org_id=?').get(org).n;
 assert.equal((await event('evt_unpaid','unpaid')).status,200);assert.equal(count(),0);
 for(let i=0;i<2;i++)assert.equal((await event('evt_paid','paid')).status,200);
 assert.equal(count(),1);
 await call('customer/remove',{id:'buyer'},owner,'stripe-mail','',env);
 assert.equal(count(),0);
});
test('transactional emails survive provider failure and deduplicate sales, threshold crossings and invites',async()=>{
 const sent=[],env={DB,RESEND_API_KEY:'unit-test',RETAILPILOT_FROM_EMAIL:'shop@example.test',
   MAIL_FETCH:async(url,init)=>{sent.push({key:init.headers['Idempotency-Key'],payload:JSON.parse(init.body)});return new Response(null,{status:503})}};
 const person='mail-owner',owner=(await call('onboard',{name:'Mail Shop',store:'London',owner:'Mail Owner'},'',person)).cookie;
 const org=(await call('identity',undefined,owner,person)).body.workspaces[0].org_id;
 const post=(path,data)=>call(path,data,owner,person,'',env);
 const product=(await post('product',{sku:'MAIL',name:'Jacket',category:'Coats',price:5999,cost:1000,threshold:9,quantity:10,store:'london'})).body;
 const customer=(await post('customer',{name:'Buyer',email:'buyer@example.test'})).body;
 const sale={...cart('email-sale'),items:[{id:product.id,qty:2}],customer:customer.id,emailReceipt:true};
 for(let i=0;i<2;i++)assert.equal((await post('checkout',sale)).body.status,'Paid');
 const jobs=()=>DB.raw.prepare('SELECT * FROM email_outbox WHERE org_id=? ORDER BY kind').all(org);
 assert.deepEqual(jobs().map(j=>j.kind),['receipt','stock']);
 await post('checkout',{...sale,key:'below-threshold',emailReceipt:false});
 assert.equal(jobs().length,2);
 assert.equal(JSON.parse(jobs()[1].payload).to[0],person+'@example.com');
 assert.match(JSON.parse(jobs()[0].payload).text,/£119\.98/);
 await flushEmail(env);
 assert(jobs().every(j=>j.status==='queued'&&j.attempts===1));
 const first=sent.slice();
 DB.raw.prepare('UPDATE email_outbox SET next_attempt=0 WHERE org_id=?').run(org);
 env.MAIL_FETCH=async(url,init)=>{sent.push({key:init.headers['Idempotency-Key'],payload:JSON.parse(init.body)});return new Response('{}')};
 await Promise.all([flushEmail(env),flushEmail(env)]);
 assert.deepEqual(sent.slice(2).sort((a,b)=>a.key.localeCompare(b.key)),first.sort((a,b)=>a.key.localeCompare(b.key)));
 assert(jobs().every(j=>j.status==='accepted'&&j.payload===null));
 const invitation={email:'staff@example.test',role:'Cashier',key:crypto.randomUUID()};
 const invite=await post('invite',invitation);
 assert.equal(invite.body.sent,true);
 assert.equal((await post('invite',invitation)).body.link,invite.body.link);
 assert.equal(sent.length,5);
 assert.match(sent.at(-1).payload.text,/invite=/);
 const status=await post('email/status',undefined);
 assert.equal(status.body.counts.length,3);
 const demoCookie=await demo();
 await call('checkout',cart('demo-no-mail'),demoCookie,'','',env);
 assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM email_outbox WHERE org_id<>?').get(org).n,0);
});
test('a stock transfer is atomic, permission-checked and safe to retry',async()=>{
 const owner=await demo(),cashier=await demo('Cashier'),other=await demo();
 const request={product:'JKT-001',from:'london',to:'manchester',qty:4,key:'shift-1'};
 const state=async cookie=>(await call('state',undefined,cookie)).body.workspace;
 const start=(await state(owner)).products[0].stock;
 for(const invalid of [{to:'london'},{qty:0},{qty:1.5},{qty:-1},{key:''}]){
   assert.equal((await call('transfer',{...request,...invalid},owner)).status,400);
 }
 assert.equal((await call('transfer',{...request,to:'unknown'},owner)).status,404);
 assert.equal((await call('transfer',{...request,qty:11},owner)).status,409);
 assert.equal((await call('transfer',request,cashier)).status,403);
 assert.equal((await state(owner)).movements.length,0);
 const retries=await Promise.all([call('transfer',request,owner),call('transfer',request,owner)]);
 assert.deepEqual(retries.map(r=>r.status),[200,200]);
 assert.equal(retries[0].body.id,retries[1].body.id);
 assert.equal((await call('transfer',{...request,qty:1},owner)).status,409);
 const after=await state(owner);
 assert.deepEqual(after.products[0].stock,{london:start.london-4,manchester:start.manchester+4});
 assert.deepEqual(after.movements.map(m=>[m.ref,m.store,m.otherStore,m.delta,m.after]),[
   ['TR-shift-1','london','manchester',-4,start.london-4],
   ['TR-shift-1','manchester','london',4,start.manchester+4]
 ]);
 assert.deepEqual((await state(other)).products[0].stock,start);
 const remaining=start.london-4;
 const contenders=await Promise.all([call('transfer',{...request,key:'last-transfer',qty:remaining},owner),
   call('checkout',cart('last-sale',remaining),owner)]);
 assert.deepEqual(contenders.map(r=>r.status).sort(),[200,409]);
 assert.equal((await state(owner)).products[0].stock.london,0);
});
test('CSV preview is read-only and concurrent confirmations create one batch in the selected store',async()=>{
 const cookie=await demo(),other=await demo(),cashier=await demo('Cashier');
 const csv='\uFEFFname,price,sku,category,quantity,barcode,cost\r\n"Coat, ""Blue""",19.95,CSV-1,Coats,4,001234,8.40\r\n"Summer\nShirt",12,CSV-2,Shirts,0,,\r\n';
 const batch={store:'manchester',csv};
 const preview=await call('products/import/preview',batch,cookie);
 assert.equal(preview.body.valid,true);
 assert.deepEqual(preview.body.rows.map(r=>r.line),[2,3]);
 assert.equal(preview.body.rows[0].product.name,'Coat, "Blue"');
 const commit={...batch,preview:preview.body.preview};
 assert.equal((await call('state',undefined,cookie)).body.workspace.products.some(p=>p.sku==='CSV-1'),false);
 assert.equal((await call('products/import',commit,other)).status,409);
 assert.equal((await call('products/import',{...commit,store:'london'},cookie)).status,409);
 assert.equal((await call('products/import/preview',batch,cashier)).status,403);
 assert.equal((await call('products/import',commit,cashier)).status,403);
 const results=await Promise.all([call('products/import',commit,cookie),call('products/import',commit,cookie)]);
 assert.deepEqual(results.map(r=>r.body.alreadyImported).sort(),[false,true]);
 assert.equal((await call('products/import/preview',batch,cookie)).body.alreadyImported,true);
 const s=(await call('state',undefined,cookie)).body.workspace;
 const imported=s.products.filter(p=>p.sku.startsWith('CSV-'));
 assert.equal(imported.length,2);
 assert.equal(imported[0].price,1995);assert.equal(imported[0].cost,840);assert.equal(imported[0].barcode,'001234');
 assert.deepEqual(imported[0].stock,{manchester:4});assert.equal(imported[1].name,'Summer\nShirt');
 assert.equal(s.movements.filter(m=>m.product===imported[0].id&&m.delta===4&&m.store==='manchester').length,1);
});

test('CSV import reports bad rows, enforces file limits and rechecks conflicts atomically',async()=>{
 const c=await demo(),header='sku,name,category,price,quantity,barcode';
 const preview=csv=>call('products/import/preview',{store:'london',csv},c);
 const invalid=await preview(header+'\nJKT-001,Existing,Coats,2,1,001\nNEW,X,Tops,-1,2.5,001\nnew,Y,Tops,3,0,\nBAD,X,Tops');
 assert.equal(invalid.body.valid,false);
 assert.deepEqual(invalid.body.rows.map(r=>r.line),[2,3,4,5]);
 assert.match(invalid.body.rows[1].errors.join(' '),/Barcode/);
 assert.match(invalid.body.rows[1].errors.join(' '),/price/);
 assert.match(invalid.body.rows[1].errors.join(' '),/quantity/);
 assert.match(invalid.body.rows[2].errors.join(' '),/SKU/);
 assert.match(invalid.body.rows[3].errors.join(' '),/Column count/);
 for(const csv of ['name,price\nx,2',header+'\n"open',header+',sku\n',header+'\n',header+',mystery\n',header+'\n'+('a,x,c,2,1,\n').repeat(501),'x'.repeat(262145)]){
   assert.equal((await preview(csv)).status,400);
 }
 const csv=header+'\nA-1,One,Tops,2,1,\nA-2,Two,Tops,2,1,';
 const p=await preview(csv);
 await call('product',{sku:'A-2',name:'Manual addition',category:'Tops',price:200,cost:0,quantity:1,threshold:5,store:'london'},c);
 const commit=await call('products/import',{store:'london',csv,preview:p.body.preview},c);
 assert.equal(commit.status,409);
 assert.equal((await call('state',undefined,c)).body.workspace.products.some(row=>row.sku==='A-1'),false);
});
test('manager edits a customer without losing purchases or overwriting a newer consent choice',async()=>{
 const owner=(await call('onboard',{name:'Profile shop',store:'London',owner:'Owner'},'','profile-owner')).cookie;
 const post=(path,data)=>call(path,data,owner,'profile-owner');
 const invite=await post('invite',{email:'profile-manager@example.com',role:'Manager'});
 const token=new URL(invite.body.link).searchParams.get('invite');
 const manager=(await call('join',{token,name:'Manager'},'','profile-manager')).cookie;
 const customer=(await post('customer',{name:'Buyer',email:'old@example.test',consent:true})).body;
 const item=(await post('product',{sku:'EDIT',name:'Shirt',category:'Clothes',price:900,cost:100,threshold:0,quantity:2,store:'london'})).body;
 const sale=await post('checkout',{...cart('edit-profile-order'),items:[{id:item.id,qty:1}],customer:customer.id});
 assert.equal(sale.status,200);
 const edit={id:customer.id,name:'Updated buyer',email:'new@example.test',phone:'',consent:false,revision:0};
 assert.equal((await post('customer/update',{...edit,email:'invalid'})).status,400);
 assert.equal((await call('customer/update',edit,await demo('Cashier'))).status,403);
 assert.equal((await call('customer/update',edit,await demo())).status,404);
 assert.equal((await call('customer/update',edit,manager,'profile-manager')).status,200);
 assert.equal((await post('customer/update',{...edit,consent:true})).status,409);
 const report=(await post('customer/export?id='+customer.id,undefined)).body;
 assert.equal(report.customer.marketingConsent,false);
 assert.equal(report.customer.email,edit.email);
 assert.deepEqual(report.purchases.map(o=>o.order),[sale.body.id]);
});
test('removing a customer detaches only that profile and preserves stock and sale records',async()=>{
 const owner=await demo();
 const {body:customer}=await call('customer',{name:'Removal test',email:'remove@example.test',phone:'123',consent:true},owner);
 const {body:sale}=await call('checkout',{...cart('profile-removal'),customer:customer.id},owner);
 const before=(await call('state',undefined,owner)).body.workspace;
 const request={id:customer.id};
 assert.equal((await call('customer/remove',request,await demo('Cashier'))).status,403);
 assert.equal((await call('customer/remove',request,await demo())).status,404);
 assert.equal((await call('customer/remove',request,owner)).status,200);
 assert.equal((await call('customer/remove',request,owner)).status,404);
 assert.equal((await call('customer/export?id='+customer.id,undefined,owner)).status,404);
 const after=(await call('state',undefined,owner)).body.workspace;
 assert.deepEqual(after.customers,before.customers.filter(c=>c.id!==customer.id));
 assert.deepEqual(after.orders,before.orders.map(o=>o.id===sale.id?{...o,customer:null}:o));
 assert.deepEqual(after.products,before.products);
 assert.deepEqual(after.movements,before.movements);
 assert.equal((await call('refund',{id:sale.id,reason:'Size',restock:true},owner)).body.status,'Refunded');
});
test('customer download is owner-only, tenant-scoped and limited to the requested buyer',async()=>{
 const owner=await demo();
 const {body:customer}=await call('customer',{name:'Export buyer',email:'buyer@example.test',consent:true},owner);
 const path='customer/export?id='+customer.id;
 await call('checkout',cart('walk-in'),owner);
 const {body:sale}=await call('checkout',{...cart('customer-sale'),customer:customer.id},owner);
 await call('refund',{id:sale.id,reason:'Wrong size',restock:true},owner);
 const report=await call(path,undefined,owner);
 assert.equal(report.status,200);
 assert.equal(report.body.customer.marketingConsent,true);
 assert.deepEqual(report.body.purchases.map(o=>o.order),[sale.id]);
 const [purchase]=report.body.purchases;
 assert.equal(purchase.totalPence,11998);
 assert.equal(purchase.refund.reason,'Wrong size');
 assert.equal(purchase.items[0].cost,undefined);
 assert.equal(purchase.key,undefined);
 assert.equal((await call(path,undefined,await demo())).status,404);
 assert.equal((await call(path,undefined,await demo('Cashier'))).status,403);
 assert.equal((await call(path)).status,401);
});
test('cash sale, VAT-inclusive receipt, refund, restock, and duplicate submissions',async()=>{
 const c=await demo(),before=(await call('state',undefined,c)).body.workspace;
 const r=await call('checkout',cart('sale-1'),c);assert.equal(r.status,200);assert.equal(r.body.total,11998);assert.equal(r.body.tax,2000);assert.equal(r.body.received-r.body.total,188002);
 assert.equal((await call('checkout',cart('sale-1'),c)).body.id,r.body.id);
 let after=(await call('state',undefined,c)).body.workspace;assert.equal(after.products[0].stock.london,8);assert.equal(after.orders.length,before.orders.length+1);assert.equal(after.movements.length,1);
 const b={id:r.body.id,reason:'Wrong size',restock:true};assert.equal((await call('refund',b,c)).body.status,'Refunded');await call('refund',b,c);
 after=(await call('state',undefined,c)).body.workspace;assert.equal(after.products[0].stock.london,10);assert.equal(after.movements.length,2);
});
test('competing checkouts and failed cards leave consistent inventory',async()=>{
 const c=await demo();await call('adjust',{product:'JKT-001',store:'london',delta:-9,reason:'Stock count'},c);
 const declined=await call('checkout',{...cart('decline',1),method:'Demo card',decline:true},c);assert.equal(declined.status,402);
 const results=await Promise.all([call('checkout',cart('first',1),c),call('checkout',cart('second',1),c)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const s=(await call('state',undefined,c)).body.workspace;assert.equal(s.products[0].stock.london,0);assert.equal(s.movements.length,2);
});
test('tenant isolation, managed identities, membership invitations and plan limits',async()=>{
 const a=(await call('onboard',{name:'A',store:'Shop A',owner:'Alice'},'','alice')).cookie;
 const b=(await call('onboard',{name:'B',store:'Shop B',owner:'Bob'},'','bob')).cookie;
 assert.equal((await call('state',undefined,a,'bob')).status,401);
 assert.equal((await call('store',{name:'Too many'},a,'alice')).status,403);
 const product=await call('product',{name:'A only',sku:'SKU123',category:'Shirts',price:100,cost:20,threshold:1,store:'london',quantity:4},a,'alice');
 assert.equal((await call('adjust',{product:product.body.id,store:'london',delta:9,reason:'Count'},b,'bob')).status,404);
 const org=(await call('identity',undefined,a,'alice')).body.workspaces[0].org_id;
 assert.equal((await call('switch',{org},b,'bob')).status,404);
 const inv=await call('invite',{email:'lee@example.com',role:'Cashier'},a,'alice');assert.equal(inv.status,200);const token=new URL(inv.body.link).searchParams.get('invite');
 assert.equal((await call('join',{token,name:'Lee'},'','eve')).status,403);
 const joined=await call('join',{token,name:'Lee'},'','lee');assert.equal(joined.status,200);assert.equal((await call('invite',{email:'third@example.com',role:'Manager'},a,'alice')).status,403);
 assert.equal((await call('state',undefined,joined.cookie,'lee')).body.member.role,'Cashier');
});
test('cashier restrictions are enforced by the API',async()=>{const c=await demo('Cashier');for(const [path,b] of [['plan',{plan:'Business'}],['settings',{name:'X'}],['invite',{}],['adjust',{delta:1}],['product',{}]])assert.equal((await call(path,b,c)).status,403);
 const r=await call('checkout',cart('expensive'),c);assert.equal((await call('refund',{id:r.body.id,reason:'Return',restock:true},c)).status,403);
 const state=(await call('state',undefined,c)).body;assert.equal(state.workspace.products[0].cost,undefined);assert.equal(state.members.length,0);});
test('signed Stripe events settle once and reject altered payloads',async()=>{
 const s=await call('onboard',{name:'Pay shop',store:'London',owner:'Owner'},'','merchant');const id=(await call('identity',undefined,s.cookie,'merchant')).body.workspaces[0].org_id;
 const data=JSON.parse(DB.raw.prepare('SELECT document FROM organizations WHERE id=?').get(id).document);data.stripeAccount='acct_test';data.orders.push({id:'ORD-50',status:'Pending',total:1000,items:[]});DB.raw.prepare('UPDATE organizations SET document=? WHERE id=?').run(JSON.stringify(data),id);
 const secret='whsec_unit_test',event={id:'evt_test',type:'checkout.session.completed',livemode:false,account:'acct_test',data:{object:{metadata:{flow:'retail',org:id,order:'ORD-50'},currency:'gbp',amount_total:1000,payment_status:'paid',payment_intent:'pi_test'}}},raw=JSON.stringify(event),t=Math.floor(Date.now()/1000),sig='t='+t+',v1='+createHmac('sha256',secret).update(t+'.'+raw).digest('hex');
 await assert.rejects(verifyEvent(raw+' ',sig,secret));for(let i=0;i<2;i++){const r=await api(new Request('https://retail.test/api/stripe/webhook',{method:'POST',headers:{'Stripe-Signature':sig},body:raw}),{DB,STRIPE_WEBHOOK_SECRET:secret});assert.equal(r.status,200)}
 const after=JSON.parse(DB.raw.prepare('SELECT document FROM organizations WHERE id=?').get(id).document);assert.equal(after.events.length,1);assert.equal(after.orders[0].status,'Paid');});
test('purchase receiving is idempotent and stock is store-specific',async()=>{const c=await demo();const b={product:'JKT-001',store:'london',supplier:'v0',qty:5};const po=await call('purchase',b,c);assert.equal(po.status,200);for(let i=0;i<2;i++)await call('receive',{id:po.body.id},c);
 const s=(await call('state',undefined,c)).body.workspace;assert.equal(s.products[0].stock.london,15);assert.equal(s.products[0].stock.manchester,3);});
test('demo dashboard and all app pages render from persisted records',async()=>{const c=await demo(),{workspace,member,members}= (await call('state',undefined,c)).body;const {ctx}=await import('../public/core.js');Object.assign(ctx,{s:workspace,member,members});const {dashboard}=await import('../public/dashboard.js');assert.match(dashboard(),/Business overview/);const v=await import('../public/views.js');for(const name of ['products','inventory','sales','customers','suppliers','reports','staff','settings','billing','pos'])assert.ok(v[name]().length>200,name);});
test('role changes and removal take effect for an active staff session',async()=>{
 const owner=(await call('onboard',{name:'Staff shop',store:'Manchester',owner:'Mo'},'','mo')).cookie;
 const invite=await call('invite',{email:'rita@example.com',role:'Manager'},owner,'mo');
 const token=new URL(invite.body.link).searchParams.get('invite');const staff=(await call('join',{token,name:'Rita'},'','rita')).cookie;
 const updated=await call('member',{principal:'rita',role:'Cashier'},owner,'mo');assert.equal(updated.status,200);
 assert.equal((await call('state',undefined,staff,'rita')).body.member.role,'Cashier');
 await call('member',{principal:'rita',remove:true},owner,'mo');assert.equal((await call('state',undefined,staff,'rita')).status,401);
});
test('supplier and staff operations cannot cross workspaces',async()=>{const a=await demo(),b=await demo(),p=(await call('purchase',{supplier:'v0',product:'JKT-001',qty:1,store:'london'},a)).body;
 assert.equal((await call('receive',{id:p.id},b)).status,404);
 const who=(await call('state',undefined,a)).body.members.find(m=>m.role==='Manager');assert.equal((await call('member',{principal:who.principal,remove:true},b)).status,404);
});
