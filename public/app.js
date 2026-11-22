import {ctx,esc,icon,money,initials,api,load,notify,modal,close,btn,field,form,lowItems,localStore,storeName,orders,date,csv,owner,cashRole,empty} from './core.js';
import {dashboard,best} from './dashboard.js';
import {products,inventory,sales,customers,suppliers,reports,staff,settings,billing,pos,cartLines,totals} from './views.js';
import {showForm,orderDetail} from './dialogs.js';
const nav=[
 ['Workspace',[['overview','Overview','grid',dashboard],['pos','Point of sale','pos',pos],['orders','Orders','receipt',sales],['products','Products','box',products],['inventory','Inventory','layers',inventory],['customers','Customers','users',customers]]],
 ['Management',[['reports','Reports','chart',reports],['suppliers','Suppliers','truck',suppliers],['staff','Team members','team',staff],['billing','Billing & plans','card',billing],['settings','Settings','settings',settings]]]
];
const links=nav.flatMap(n=>n[1]);const app=document.querySelector('#app');let busy=false;
function allowed(id){return (!cashRole()||['pos','orders','products','customers'].includes(id))&&(owner()||!['staff','billing','settings'].includes(id))}
function resetPage(id){ctx.page=id;ctx.q='';ctx.filter='All';ctx.pageNo=0;ctx.tab=id==='inventory'?'Stock levels':id==='suppliers'?'Suppliers':'Overview'}
function go(id){if(!allowed(id))id=cashRole()?'pos':'overview';if(ctx.page!==id)resetPage(id);if(location.hash!=='#'+id)history.pushState(null,'','#'+id);close();render();window.scrollTo(0,0)}
function render(){const r=links.find(x=>x[0]===ctx.page);if(!r)return;
 app.innerHTML=`<div class="shell ${ctx.page==='pos'?'register':''}"><button class="scrim" data-act="menu" aria-label="Close navigation"></button><aside class="sidebar"><a href="#overview" class="brand"><img src="/mark.svg" alt="" width="32" height="32"><span>Retail<span>Pilot</span></span></a><button class="workspace-switch" data-act="workspace"><span class="shop-icon">${icon('store',19)}</span><span class="workspace-name"><b>${esc(ctx.s.name)}</b><small><i></i> ${ctx.s.demo?'Demo workspace':'Business workspace'}</small></span>${icon('switch',14)}</button><nav>${nav.map(([group,items])=>{const a=items.filter(i=>allowed(i[0]));return a.length?`<div class="nav-group"><h3>${group}</h3>${a.map(([id,label,ic])=>`<a href="#${id}" class="nav-link ${id===ctx.page?'active':''}" ${id===ctx.page?'aria-current="page"':''}>${icon(ic,18)}<span>${label}</span>${id==='inventory'&&lowItems().length?`<small class="nav-number">${lowItems().length}</small>`:''}</a>`).join('')}</div>`:''}).join('')}</nav><div class="sidebar-foot"><button class="help-link" data-act="help">${icon('help',17)} Help &amp; shortcuts</button><button class="profile" data-act="workspace"><span class="avatar">${initials(esc(ctx.member.name))}</span><span><b>${esc(ctx.member.name)}</b><small>${esc(ctx.member.role)}</small></span>${icon('switch',15)}</button></div></aside><div class="main-shell"><header class="topbar"><div class="crumb"><button data-act="menu" class="iconbtn mobile-menu" aria-label="Toggle navigation">${icon('menu')}</button><span class="crumb-icon">${icon('panel',17)}</span><span class="crumb-parent">Workspace</span><span class="slash">/</span><strong>${r[1]}</strong></div><div class="top-actions"><button class="global-search" data-act="search">${icon('search',16)}<span>Search anything...</span><kbd>⌘ K</kbd></button><i class="vline"></i><button class="bell iconbtn" data-act="notifications" aria-label="Inventory notifications">${icon('bell',19)}${lowItems().length?'<i></i>':''}</button><span class="top-avatar">${initials(esc(ctx.member.name))}</span></div></header><main><div class="context-row"><span class="location-select">${icon('store',15)}<select aria-label="Store location" data-select="store">${(ctx.page==='pos'?[]:[['all','All stores']]).concat(ctx.s.stores.map(s=>[s.id,s.name])).map(([id,name])=>`<option value="${esc(id)}" ${id===(ctx.page==='pos'?localStore():ctx.store)?'selected':''}>${esc(name)}</option>`).join('')}</select></span><span class="context-sep"></span><span class="today">${date(Date.now(),{weekday:'short',day:'numeric',month:'short',year:'numeric'})}</span></div><div id="pagebody">${r[3]()}</div><footer class="page-foot"><span>RetailPilot</span><span>${esc(ctx.s.name)}</span></footer></main></div></div>`;
 document.title=r[1]+' · RetailPilot';
}
function bodyOnly(){const p=links.find(x=>x[0]===ctx.page);document.querySelector('#pagebody').innerHTML=p[3]()}
function searchGlobal(value=''){const v=value.toLowerCase();const rows=[...links.filter(l=>allowed(l[0])).map(l=>({name:l[1],sub:'Page',action:'go-'+l[0],id:'',icon:l[2]})),...ctx.s.products.map(p=>({name:p.name,sub:p.sku+' · '+p.size,action:'showProduct',id:p.id,icon:'box'})),...orders().map(o=>({name:'#'+o.id,sub:money(o.total),action:'order',id:o.id,icon:'receipt'}))].filter(r=>(r.name+' '+r.sub).toLowerCase().includes(v)).slice(0,10);document.querySelector('#global-results').innerHTML=rows.map(r=>`<button data-act="${r.action}" data-id="${esc(r.id)}" class="result">${icon(r.icon)}<span>${esc(r.name)}</span><small>${esc(r.sub)}</small></button>`).join('')||empty('No results found')}
function resetCart(){ctx.cart={};ctx.customer='';ctx.discount=0;ctx.cartKey=crypto.randomUUID()}
async function refresh(message){await load();render();if(message)notify(message)}
function add(id){const p=ctx.s.products.find(p=>p.id===id),q=(ctx.cart[id]||0)+1;if(!p||q>(p.stock[localStore()]||0)){notify('No more units available at this store.');return}ctx.cart[id]=q;ctx.cartKey=crypto.randomUUID();bodyOnly()}
async function act(action,id=''){
 if(action==='localSignOut'){
   const response=await fetch('/local/logout',{method:'POST'});
   if(!response.ok)throw new Error('Sign out failed. Please try again.');
   try{localStorage.setItem('retailpilot-signout',crypto.randomUUID())}finally{location.replace('/local/signin')}
   return;
 }
 if(action.startsWith('go-'))return go(action.slice(3));
 if(action==='close')return close();
 if(action==='menu')return document.querySelector('.shell').classList.toggle('menu-open');
 if(action==='prev'||action==='next'){ctx.pageNo+=action==='prev'?-1:1;return bodyOnly()}
 if(action==='tab'){ctx.tab=id;ctx.pageNo=0;return bodyOnly()}
 if(action==='low'){go(cashRole()?'products':'inventory');if(!cashRole()){ctx.tab='Low stock';bodyOnly()}return}
 if(action==='cartAdd')return add(id);
 if(action==='cartMinus'){if(--ctx.cart[id]<=0)delete ctx.cart[id];ctx.cartKey=crypto.randomUUID();return bodyOnly()}
 if(action==='addFromProduct'){go('pos');return add(id)}
 if(action==='print')return window.print();
 if(action==='export'){if(ctx.page==='reports'){const start=new Date();start.setUTCHours(0,0,0,0);const rows=best(orders().filter(o=>o.date>=+start-(ctx.days-1)*86400000));csv('retailpilot-product-report',['Product','Units','Sales GBP'],rows.map(x=>[x.p.name,x.qty,(x.total/100).toFixed(2)]))}else{const os=orders().filter(o=>(ctx.filter==='All'||o.status===ctx.filter)&&[o.id,ctx.s.customers.find(c=>c.id===o.customer)?.name||'Walk-in customer',o.method].join(' ').toLowerCase().includes(ctx.q.toLowerCase()));csv('retailpilot-orders',['Order','Date','Store','Status','Amount GBP'],os.map(o=>[o.id,new Date(o.date).toISOString(),storeName(o.store),o.status,(o.total/100).toFixed(2)]))}return notify('CSV exported.')}
 if(action==='receive'){await api('receive',{id});return refresh('Delivery received. Stock updated.')}
 if(action==='choosePlan'){if(ctx.s.demo){await api('plan',{plan:id});return refresh('Demo plan updated.')}const r=await api('stripe/billing',{plan:id});location.assign(r.url);return}
 if(action==='resumePay'){const r=await api('payment/resume',{id});location.assign(r.url);return}
 if(action==='portal'){const r=await api('stripe/portal',{});location.assign(r.url);return}
 if(action==='newDemo'||action==='switchOrg'){await api(action==='newDemo'?'demo':'switch',action==='newDemo'?{role:id}:{org:id});await load();resetCart();ctx.store='all';return go(cashRole()?'pos':'overview')}
 await showForm(action,id);if(action==='search'){searchGlobal();document.querySelector('#global-search').focus()}
}
document.addEventListener('click',async e=>{const a=e.target.closest('a[href^="#"]');if(a&&ctx.s){e.preventDefault();return go(a.hash.slice(1))}const b=e.target.closest('[data-act]');if(!b)return;e.preventDefault();if(b.disabled)return;try{await act(b.dataset.act,b.dataset.id)}catch(err){notify(err.message)}});
document.addEventListener('change',e=>{const t=e.target,key=t.dataset.select;if(key==='store'){if(Object.keys(ctx.cart).length)resetCart();ctx.store=t.value;ctx.pageNo=0;render()}else if(key==='days'){ctx.days=Number(t.value);bodyOnly()}else if(key==='filter'){ctx.filter=t.value;ctx.pageNo=0;bodyOnly()}else if(key==='customer'){ctx.customer=t.value;ctx.cartKey=crypto.randomUUID()}else if(t.name==='method'){const f=document.querySelector('#cash-input');if(f){f.hidden=t.value!=='Cash';f.querySelector('input').disabled=f.hidden}}});
document.addEventListener('input',e=>{if(e.target.id==='filterSearch'){ctx.q=e.target.value;ctx.pageNo=0;const pos=e.target.selectionStart;bodyOnly();const el=document.querySelector('#filterSearch');el.focus();el.setSelectionRange(pos,pos)}if(e.target.id==='global-search')searchGlobal(e.target.value)});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'&&ctx.s){e.preventDefault();act('search')}if(e.key==='Enter'&&ctx.page==='pos'&&e.target.id==='filterSearch'){const p=ctx.s.products.find(x=>x.barcode===ctx.q||x.sku.toLowerCase()===ctx.q.toLowerCase());if(p){e.preventDefault();ctx.q='';add(p.id);document.querySelector('#filterSearch').focus()}}if(e.key==='Enter'&&e.target.matches('tr[data-act]'))e.target.click()});
document.querySelector('#modal').addEventListener('click',e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close()}});
document.addEventListener('submit',async e=>{const f=e.target.closest('form[data-form]');if(!f)return;e.preventDefault();if(busy)return;busy=true;const button=f.querySelector('[type=submit]');button.disabled=true;const b=Object.fromEntries(new FormData(f)),action=f.dataset.form;try{
 if(action==='discount'){ctx.discount=Number(b.discount);ctx.cartKey=crypto.randomUUID();close();bodyOnly();return}
 if(action==='checkout'){const method=b.method==='Decline'?'Demo card':b.method;const r=await api('checkout',{method,decline:b.method==='Decline',received:Math.round((Number(b.received)||0)*100),items:cartLines().map(l=>({id:l.p.id,qty:l.qty})),discount:ctx.discount,customer:ctx.customer,store:localStore(),key:ctx.cartKey});if(r.url){location.assign(r.url);return}resetCart();await refresh('Sale completed. Inventory updated.');orderDetail(r.id);return}
 if(action==='member')b.remove=b.remove==='on';
 if(action==='product'){b.price=Math.round(Number(b.price)*100);b.cost=Math.round(Number(b.cost)*100)}
 if(action==='invite'){const r=await api(action,b);modal(r.sent?'Invitation emailed':'Invitation ready','<p>Share this link with '+esc(b.email)+'.</p><input class="full" readonly value="'+esc(r.link)+'" aria-label="Invitation link">');return}
 const r=await api(action,b);if(action==='onboard'||action==='join'){await load();resetCart();ctx.store='all';go('overview');notify('Workspace ready.');return}
 close();await refresh(action==='refund'?'Return recorded.':'Changes saved.');if(action==='refund')orderDetail(r.id)
 }catch(err){f.querySelector('.form-error').textContent=err.message}finally{busy=false;button.disabled=false}});
window.addEventListener('popstate',()=>{if(ctx.s){const id=location.hash.slice(1);resetPage(links.some(r=>r[0]===id)&&allowed(id)?id:cashRole()?'pos':'overview');render()}});
async function boot(){try{try{await load()}catch(e){if(e.status!==401)throw e;const who=await api('identity');if(who.workspaces.length)await api('switch',{org:who.workspaces[0].org_id});else await api('demo',{role:'Owner'});await load()}const target=location.hash.slice(1);resetPage(links.some(r=>r[0]===target)&&allowed(target)?target:cashRole()?'pos':'overview');render();const params=new URLSearchParams(location.search);if(params.has('new'))await showForm('onboardForm');if(params.has('invite')){const token=params.get('invite');modal('Accept team invitation',ctx.signedIn?form('join',field('Your name','name')+'<input type="hidden" name="token" value="'+esc(token)+'">','Join workspace'):'<a class="btn primary" target="_top" href="/signin-with-chatgpt?return_to='+encodeURIComponent(location.pathname+location.search)+'">Sign in to accept</a>')}}
 catch(e){app.innerHTML='<div class="startup"><img src="/mark.svg" width="42" alt=""><b>RetailPilot</b><p>'+esc(e.message)+'</p><button class="btn primary" id="retry">Retry connection</button></div>';document.querySelector('#retry').onclick=boot}}
window.addEventListener('storage',event=>{if(event.key==='retailpilot-signout')location.replace('/local/signin')});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload()});
boot();
