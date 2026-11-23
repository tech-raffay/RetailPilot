import {esc,money} from './core.js';

const shopId=new URLSearchParams(location.search).get('shop')||'';
const storageKey='retailpilot-basket/'+shopId;
const get=id=>document.getElementById(id);
let shop, cart=new Map(), busy=false, pendingKey='', timer;
const notify=text=>{get('notice').textContent=text};
function saveCart(){
  try{sessionStorage.setItem(storageKey,JSON.stringify({items:[...cart],key:pendingKey}))}catch{}
}
async function request(action='',data){
  const res=await fetch('/api/shop/'+encodeURIComponent(shopId)+action,data?{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)
  }:{});
  const result=await res.json();
  if(!res.ok)throw Object.assign(new Error(result.error||'Shop unavailable.'),{status:res.status});
  return result;
}
function catalog(){
  const groups=new Map(),term=get('search').value.trim().toLowerCase();
  for(const p of shop.products){
    if(![p.name,p.category,p.sku,p.color,p.size].join(' ').toLowerCase().includes(term))continue;
    const group=groups.get(p.name)||[];group.push(p);groups.set(p.name,group);
  }
  const panel=get('catalog');panel.replaceChildren();
  if(!groups.size){panel.textContent='No products found.';return}
  for(const [name,variants] of groups){
    const card=document.createElement('article');
    card.innerHTML='<div class="picture"></div><h3>'+esc(name)+'</h3><select aria-label="Variant for '+esc(name)+'">'+variants.map(p=>
      '<option value="'+esc(p.id)+'">'+esc([p.color,p.size].filter(Boolean).join(' · ')||p.sku)+'</option>').join('')+'</select><p></p><button type="button">Add to basket</button>';
    const select=card.querySelector('select'),btn=card.querySelector('button');
    select.value=(variants.find(p=>p.stock>0)||variants[0]).id;
    const variant=()=>variants.find(p=>p.id===select.value);
    const update=()=>{
      const p=variant(),img=p.image;
      card.querySelector('.picture').innerHTML=img&&(/^(https:\/\/|\/images\/)/.test(img))?'<img loading="lazy" src="'+esc(img)+'" alt="'+esc(p.name)+'">':'<div class="no-photo">Image unavailable</div>';
      card.querySelector('p').textContent=money(p.price)+(shop.inclusive?'':' + VAT')+' · '+(p.stock?p.stock+' available':'Sold out');
      btn.disabled=!p.stock||busy;
    };
    select.onchange=update;btn.onclick=()=>adjust(variant().id,1);update();panel.append(card);
  }
}
function adjust(id,delta){
  if(busy||pendingKey)return;
  const qty=(cart.get(id)||0)+delta,p=shop.products.find(p=>p.id===id);
  if(qty>p.stock){notify('All available units are already in your basket.');return}
  if(qty>0)cart.set(id,qty);else cart.delete(id);
  saveCart();notify('');basket();
}
function totals(){
  let subtotal=0,tax=0;
  for(const [id,qty] of cart){
    const p=shop.products.find(p=>p.id===id);
    subtotal+=p.price*qty;tax+=p.price*qty*p.tax/(shop.inclusive?100+p.tax:100);
  }
  return {total:subtotal+(shop.inclusive?0:Math.round(tax)),tax:Math.round(tax)};
}
function basket(){
  const box=get('basket');box.replaceChildren();
  get('basket-link').textContent='View basket ('+[...cart.values()].reduce((n,q)=>n+q,0)+')';
  if(!cart.size){box.textContent='Your basket is empty.';return}
  for(const [id,qty] of cart){
    const p=shop.products.find(p=>p.id===id),line=document.createElement('div');line.className='item';
    line.innerHTML='<div class="row"><strong>'+esc(p.name)+'</strong><span>'+money(p.price*qty)+'</span></div><small>'+esc([p.color,p.size].filter(Boolean).join(' · ')||p.sku)+'</small><div class="controls"><button aria-label="Remove one">−</button><span>'+qty+'</span><button aria-label="Add one">+</button></div>';
    const [minus,plus]=line.querySelectorAll('button');minus.onclick=()=>adjust(id,-1);plus.onclick=()=>adjust(id,1);
    minus.disabled=busy||!!pendingKey;plus.disabled=busy||!!pendingKey||qty>=p.stock;box.append(line);
  }
  const {total,tax}=totals(),foot=document.createElement('div');
  foot.innerHTML='<p class="row"><span>VAT</span><span>'+money(tax)+'</span></p><p class="row"><b>Total</b><b>'+money(total)+'</b></p>';
  const btn=document.createElement('button');btn.className='primary';
  btn.textContent=shop.demo?'Place demo order':'Pay with Stripe (test)';
  btn.disabled=busy||!shop.checkoutEnabled||total<=0;btn.onclick=checkout;
  box.append(foot,btn);if(!shop.checkoutEnabled)box.insertAdjacentHTML('beforeend','<p>Online checkout is unavailable.</p>');
}
async function checkout(){
  if(busy)return;busy=true;
  pendingKey||=crypto.randomUUID();saveCart();basket();notify('Opening checkout…');
  try{
    const result=await request('/checkout',{key:pendingKey,store:shop.store.id,total:totals().total,items:[...cart].map(([id,qty])=>({id,qty}))});
    history.replaceState(null,'','#'+pendingKey);
    if(result.url){location.assign(result.url);return}
    confirmation(result);
  }catch(error){
    try{
      const order=await request('/status',{key:pendingKey});
      history.replaceState(null,'','#'+pendingKey);confirmation(order);
    }catch(lookup){
      if(lookup.status===404){pendingKey='';saveCart();await loadShop()}
      notify(error.message);
    }
  }finally{busy=false;if(shop)basket()}
}
function confirmation(order){
  clearTimeout(timer);notify('');get('storefront').hidden=true;
  get('basket-link').hidden=true;
  const box=get('confirmation');box.hidden=false;
  const title=order.collected&&order.status==='Paid'?'Order collected':({Paid:'Payment confirmed',Pending:'Awaiting payment',Refunded:'Order refunded',Cancelled:'Checkout cancelled'})[order.status]||'Order status';
  box.innerHTML='<h2>'+title+'</h2><p>'+esc(order.id)+' · '+money(order.total)+'</p><p>Pickup at '+esc([order.location,order.address].filter(Boolean).join(' · '))+'</p>';
  if(order.code&&!order.collected)box.insertAdjacentHTML('beforeend','<p>Show this code at pickup</p><p class="code">'+esc(order.code)+'</p>');
  if(order.status==='Pending'){
    const resume=document.createElement('button');resume.textContent='Resume test payment';
    resume.onclick=async()=>{resume.disabled=true;try{const r=await request('/checkout',{key:pendingKey});if(r.url)location.assign(r.url);else confirmation(r)}catch(e){notify(e.message)}finally{resume.disabled=false}};
    box.append(resume);timer=setTimeout(refreshOrder,5000);
  }else{
    cart.clear();saveCart();
    const again=document.createElement('button');again.textContent='Back to shop';
    again.onclick=()=>{pendingKey='';saveCart();location.hash='';location.reload()};box.append(again);
  }
}
async function refreshOrder(){try{confirmation(await request('/status',{key:pendingKey}))}catch(e){notify(e.message);if(!e.status)timer=setTimeout(refreshOrder,5000)}}
async function loadShop(){
  shop=await request();document.title=shop.name+' · Shop for pickup';get('brand').textContent=shop.name;
  get('location').textContent=[shop.store.name,shop.store.address,shop.demo?'Demo checkout':'Sandbox checkout'].filter(Boolean).join(' · ');
  for(const [id,qty] of cart){
    const p=shop.products.find(p=>p.id===id);
    if(!p?.stock||!Number.isSafeInteger(qty)||qty<=0)cart.delete(id);
    else cart.set(id,Math.min(qty,p.stock));
  }
  notify('');get('storefront').hidden=false;get('basket-link').hidden=false;catalog();basket();
}
get('basket-link').onclick=event=>{event.preventDefault();get('basket-panel').focus();get('basket-panel').scrollIntoView()};
get('search').oninput=catalog;
try{
  if(!shopId)throw new Error('Open the storefront link provided by the shop.');
  let saved;try{saved=JSON.parse(sessionStorage.getItem(storageKey))}catch{}
  cart=new Map(saved?.items||[]);pendingKey=location.hash.slice(1)||saved?.key||'';
  if(pendingKey){
    try{confirmation(await request('/status',{key:pendingKey}))}
    catch(e){if(e.status!==404||location.hash)throw e;pendingKey='';saveCart();await loadShop()}
  }else await loadShop();
}catch(e){notify(e.message)}
