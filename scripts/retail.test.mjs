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
