import {uid,plans} from './catalog.js';
export function fail(message,status=400){throw Object.assign(new Error(message),{status})}
export function str(value,max=120){return String(value??'').trim().slice(0,max)}
export function num(value,min,max){const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max) fail('Enter a valid number within the allowed range.');return n}
export function required(value,label){const s=str(value);if(!s)fail('Enter '+label+'.');return s}
export function permit(role,allowed){if(!allowed.includes(role))fail('Your role does not have access to this action.',403)}
export function storeFor(s,id){return s.stores.find(x=>x.id===id)||fail('Store not found.',404)}
function productFor(s,id){return s.products.find(p=>p.id===id)||fail('Product not found.',404)}
function movement(s,p,store,delta,reason,actor,ref){
  const after=(p.stock[store]||0)+delta;
  if(after<0)fail('Insufficient stock for '+p.name+'.',409);
  const record={id:uid(),date:Date.now(),product:p.id,name:p.name,store,delta,after,reason,actor,ref};
  p.stock[store]=after;s.movements.push(record);
  return record;
}
export function checkout(s,b,member){
  const known=s.orders.find(o=>o.key===b.key);if(known)return known;
  required(b.key,'a checkout reference');storeFor(s,b.store);
  if(!Array.isArray(b.items)||!b.items.length||b.items.length>100)fail('Add at least one product to the cart.');
  if(b.customer&&!s.customers.some(c=>c.id===b.customer))fail('Customer not found.');
  const qtyById=new Map();
  for(const l of b.items)qtyById.set(l.id,(qtyById.get(l.id)||0)+num(l.qty,1,9999));
  const items=[...qtyById].map(([id,qty])=>{const p=productFor(s,id);return {id,sku:p.sku,name:p.name,size:p.size,price:p.price,cost:p.cost,tax:p.tax??s.vat,qty}});
  const subtotal=items.reduce((t,i)=>t+i.price*i.qty,0);
  const discount=num(b.discount||0,0,100);const net=Math.round(subtotal*(1-discount/100));
  const tax=Math.round(items.reduce((t,i)=>t+i.price*i.qty*(1-discount/100)*i.tax/(s.inclusive?100+i.tax:100),0));
  const total=net+(s.inclusive?0:tax);
  if(!['Cash','Demo card','Stripe'].includes(b.method)||b.method==='Demo card'&&!s.demo)fail('Choose an available payment method.');
  if(b.method==='Demo card'&&b.decline)fail('Test card declined. Choose another payment method.',402);
  const received=b.method==='Cash'?num(b.received??total,total,999999999):total;
  const o={id:'ORD-'+(++s.sequence),key:b.key,date:Date.now(),store:b.store,customer:b.customer||'',operator:member.name,channel:'In-store',items,subtotal,discount,tax,total,received,method:b.method,status:b.method==='Stripe'?'Pending':'Paid'};
  if(b.emailReceipt===true&&!s.demo){
    const customer=s.customers.find(c=>c.id===o.customer);
    if(!customer||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email))fail('Select a customer with a valid email to request a receipt.');
    o.emailReceipt=true;
  }
  for(const i of items)movement(s,productFor(s,i.id),o.store,-i.qty,'Sale',member.name,o.id);
  s.orders.push(o);return o;
}
export function refund(s,b,member){
  const o=s.orders.find(x=>x.id===b.id)||fail('Order not found.',404);
  if(o.status==='Refunded')return o;
  if(o.status!=='Paid')fail('Only a paid sale can be refunded.',409);
  if(member.role==='Cashier'&&o.total>10000)fail('A manager must approve returns above £100.',403);
  if(o.method==='Stripe'&&!b.providerVerified)fail('A verified provider refund is required.',409);
  const reason=required(b.reason,'a return reason');o.status='Refunded';o.refund={date:Date.now(),reason,restock:b.restock,by:member.name};
  if(b.restock)for(const line of o.items)movement(s,productFor(s,line.id),o.store,line.qty,'Return',member.name,o.id);
  return o;
}
export function change(s,action,b,m){
  if(!['checkout','refund','customer'].includes(action))permit(m.role,['Owner','Manager']);
  let out;
  if(action==='checkout')out=checkout(s,b,m);
  else if(action==='refund')out=refund(s,{...b,providerVerified:false},m);
  else if(action==='transfer'){
    const p=productFor(s,b.product);
    const source=storeFor(s,b.from),destination=storeFor(s,b.to);
    if(source.id===destination.id)fail('Choose two different stores.');
    if(!['number','string'].includes(typeof b.qty))fail('Enter a whole number of units.');
    const qty=num(b.qty,1,999999);
    if(typeof b.key!=='string'||!/^[a-zA-Z0-9-]{1,64}$/.test(b.key))fail('Invalid transfer reference.');
    const ref='TR-'+b.key;
    const previous=s.movements.find(row=>row.ref===ref&&row.reason==='Transfer out');
    if(previous){
      if(previous.store!==source.id||previous.product!==p.id||previous.delta!==-qty||previous.otherStore!==destination.id){
        fail('This reference was already used for another transfer.',409);
      }
      return {id:ref};
    }
    movement(s,p,source.id,-qty,'Transfer out',m.name,ref).otherStore=destination.id;
    movement(s,p,destination.id,qty,'Transfer in',m.name,ref).otherStore=source.id;
    out={id:ref};
  }
  else if(action==='adjust'){
    const p=productFor(s,b.product);storeFor(s,b.store);const delta=num(b.delta,-99999,99999);
    if(!delta)fail('Enter a non-zero adjustment.');movement(s,p,b.store,delta,required(b.reason,'an adjustment reason'),m.name,'');out=p;
  }else if(action==='product'){
    const sku=required(b.sku,'a unique SKU');const old=b.id?productFor(s,b.id):null;
    if(s.products.some(p=>p!==old&&(p.sku.toLowerCase()===sku.toLowerCase()||b.barcode&&p.barcode===b.barcode)))fail('This SKU or barcode is already in use.',409);
    const p={id:old?.id||uid(),stock:old?.stock||{},name:required(b.name,'a product name'),sku,barcode:str(b.barcode),category:required(b.category,'a category'),price:num(b.price,0,99999999),cost:num(b.cost,0,99999999),tax:num(b.tax??s.vat,0,100),threshold:num(b.threshold,0,99999),size:str(b.size),color:str(b.color),photo:old?.photo||'',imageUrl:b.imageUrl&&/^https:\/\//.test(b.imageUrl)?str(b.imageUrl,1000):''};
    if(old)Object.assign(old,p);else{s.products.push(p);storeFor(s,b.store);const n=num(b.quantity||0,0,999999);if(n)movement(s,p,b.store,n,'Opening stock',m.name,'')}
    out=p;
  }else if(action==='customer/update'){
    const customer=s.customers.find(row=>row.id===b.id);
    if(!customer)fail('Customer not found.',404);
    if(b.revision!==(customer.revision??0))fail('This profile has changed. Refresh the page and review the latest details.',409);
    if([b.name,b.email,b.phone].some(value=>typeof value!=='string'||value.trim().length>120)){
      fail('Enter up to 120 characters for each contact field.');
    }
    const name=required(b.name,'a name'),email=b.email.trim(),phone=b.phone.trim();
    if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Enter a valid email address.');
    if(typeof b.consent!=='boolean')fail('Choose a marketing preference.');
    Object.assign(customer,{name,email,phone,consent:b.consent,revision:b.revision+1});
    out=customer;
  }else if(action==='customer/remove'){
    permit(m.role,['Owner']);
    const index=s.customers.findIndex(customer=>customer.id===b.id);
    if(index<0)fail('Customer not found.',404);
    s.customers.splice(index,1);
    for(const order of s.orders){
      if(order.customer===b.id)order.customer=null;
    }
    out={id:b.id};
  }else if(action==='customer'||action==='supplier'){
    const row={id:uid(),name:required(b.name,'a name'),email:str(b.email),phone:str(b.phone),consent:!!b.consent};s[action==='customer'?'customers':'suppliers'].push(row);out=row;
  }else if(action==='purchase'){
    const p=productFor(s,b.product);storeFor(s,b.store);if(!s.suppliers.some(x=>x.id===b.supplier))fail('Select a supplier.');
    const row={id:'PO-'+(1001+s.purchaseOrders.length),product:p.id,qty:num(b.qty,1,99999),store:b.store,supplier:b.supplier,date:Date.now(),status:'Ordered'};s.purchaseOrders.push(row);out=row;
  }else if(action==='receive'){
    const po=s.purchaseOrders.find(x=>x.id===b.id)||fail('Purchase order not found.',404);
    if(po.status!=='Received'){movement(s,productFor(s,po.product),po.store,po.qty,'Delivery',m.name,po.id);po.status='Received'}out=po;
  }else if(action==='store'){
    permit(m.role,['Owner']);if(s.stores.length>=plans[s.plan].stores)fail('Upgrade your plan to add another store.',403);
    out={id:uid(),name:required(b.name,'a store name'),address:str(b.address)};s.stores.push(out);
  }else if(action==='settings'){
    permit(m.role,['Owner']);s.name=required(b.name,'a business name');s.vat=num(b.vat,0,100);s.inclusive=!!b.inclusive;out={ok:true};
  }else if(action==='plan'){
    permit(m.role,['Owner']);if(!s.demo)fail('Use Stripe billing to change your subscription.');
    if(!plans[b.plan])fail('Unknown plan.');if(s.stores.length>plans[b.plan].stores||b.memberCount>plans[b.plan].staff)fail('Your current stores or staff exceed this plan.');
    s.plan=b.plan;out={ok:true};
  }else fail('Action not found.',404);
  s.audit.push({action,ref:out?.id||'',actor:m.name,date:Date.now()});return out;
}
