import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {api} from '../src/api.js';
import {openDatabase} from './local-db.mjs';
import {verifyEvent} from '../src/payments.js';
const DB=openDatabase();
async function call(path,body,cookie='',person='',email='',env={}){
 const res=await api(new Request('https://retail.test/api/'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,'Content-Type':'application/json',...(person?{'oai-authenticated-user-id':person,'oai-authenticated-user-email':email||person+'@example.com'}:{})},body:body===undefined?undefined:JSON.stringify(body)}),{DB,...env});
 return {status:res.status,body:await res.json(),cookie:res.headers.get('Set-Cookie')?.split(';')[0]};
}
async function demo(role='Owner'){const r=await call('demo',{role});assert.equal(r.status,200);return r.cookie}
const cart=(key,qty=2)=>({key,method:'Cash',store:'london',items:[{id:'JKT-001',qty}],received:200000});
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
