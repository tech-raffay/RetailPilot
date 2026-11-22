import {icon} from './icons.js';
export {icon};
export const ctx={s:null,member:null,members:[],page:'overview',store:'all',days:7,q:'',filter:'All',tab:'Overview',cart:{},customer:'',discount:0,cartKey:crypto.randomUUID(),pageNo:0};
export const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const money=(p,dec=2)=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',minimumFractionDigits:dec,maximumFractionDigits:dec}).format(p/100);
export const date=(n,opts={day:'numeric',month:'short'})=>new Intl.DateTimeFormat('en-GB',opts).format(n);
export const initials=n=>n.split(' ').filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase();
export const storeName=id=>ctx.s.stores.find(x=>x.id===id)?.name||'All stores';
export const buyer=id=>ctx.s.customers.find(x=>x.id===id)?.name||'Walk-in customer';
export const localStore=()=>ctx.store==='all'?ctx.s.stores[0].id:ctx.store;
export function stock(p){return ctx.store==='all'?Object.values(p.stock).reduce((a,b)=>a+b,0):(p.stock[ctx.store]||0)}
export function lowItems(){return ctx.s.products.flatMap(p=>ctx.s.stores.filter(s=>(ctx.store==='all'||ctx.store===s.id)&&(p.stock[s.id]||0)<=p.threshold).map(s=>({p,store:s.id,n:p.stock[s.id]||0})))}
export const orders=()=>ctx.s.orders.filter(o=>ctx.store==='all'||ctx.store===o.store).sort((a,b)=>b.date-a.date);
export const startDay=()=>{const d=new Date();d.setUTCHours(0,0,0,0);return +d};
export const dateRange=(arr,days,prior=0)=>{const end=startDay()+86400000-prior*days*86400000;return arr.filter(x=>x.date>=end-days*86400000&&x.date<end)};
export const sum=(arr,fn)=>arr.reduce((a,b)=>a+fn(b),0);
export const net=o=>o.status==='Paid'?o.total:0;
export const margin=o=>o.status==='Paid'?o.total-o.tax-sum(o.items,i=>i.qty*i.cost):0;
export function photo(p,cls='thumb'){const url=p.photo?'/images/'+p.photo+'.webp':p.imageUrl;return url?`<img class="${cls}" src="${esc(url)}" alt="${esc(p.name)}" loading="lazy">`:`<span class="${cls} placeholder">${icon('bag',22)}</span>`}
export const btn=(label,action,i='',kind='secondary',attrs='')=>`<button class="btn ${kind}" data-act="${action}" ${attrs}>${i?icon(i,16):''}${label}</button>`;
export const opt=(val,label,active)=>`<option value="${esc(val)}" ${String(val)===String(active)?'selected':''}>${esc(label)}</option>`;
export const select=(id,options,active,label)=>`<select aria-label="${esc(label)}" data-select="${id}">${options.map(x=>opt(x[0],x[1],active)).join('')}</select>`;
export const field=(label,name,type='text',v='',more='required')=>`<label class="field">${esc(label)}<input name="${name}" type="${type}" value="${esc(v)}" ${more}></label>`;
export const selectField=(label,name,options,active)=>`<label class="field">${esc(label)}<select name="${name}">${options.map(p=>opt(p[0],p[1],active)).join('')}</select></label>`;
export const badge=(text)=>`<span class="badge ${['Paid','In stock','Received','Active'].includes(text)?'green':['Refunded','Cancelled','Out of stock'].includes(text)?'grey':'amber'}"><i></i>${esc(text)}</span>`;
export const pageTitle=(title,sub,actions='')=>`<div class="page-title"><div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div><div class="actions">${actions}</div></div>`;
export const cardTitle=(name,i,aside='')=>`<div class="card-title"><h2>${i?`<span class="card-icon">${icon(i,17)}</span>`:''}${name}</h2>${aside}</div>`;
export const empty=(title,sub='')=>`<div class="empty">${icon('package',28)}<strong>${esc(title)}</strong>${sub?`<p>${esc(sub)}</p>`:''}</div>`;
export const cashRole=()=>ctx.member.role==='Cashier';
export const owner=()=>ctx.member.role==='Owner';
export function filtered(row){return String(row).toLowerCase().includes(ctx.q.toLowerCase())}
export function table(cols,rows,blank='No records found'){return rows.length?`<div class="table-scroll"><table><thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`:empty(blank,'Try another filter or add a record.')}
export function pager(total){const n=Math.ceil(total/20);return n>1?`<div class="pager">${total} results <span>${btn('Previous','prev','','quiet',ctx.pageNo===0?'disabled':'')} ${ctx.pageNo+1} / ${n} ${btn('Next','next','','quiet',ctx.pageNo>=n-1?'disabled':'')}</span></div>`:''}
export const slice=rows=>rows.slice(ctx.pageNo*20,ctx.pageNo*20+20);
export const searchInput=label=>`<label class="searchfield">${icon('search',17)}<input id="filterSearch" value="${esc(ctx.q)}" aria-label="${label}" placeholder="${label}"></label>`;
export async function api(path,data){const r=await fetch('/api/'+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const v=await r.json();if(!r.ok)throw Object.assign(new Error(v.error||'Request failed'),{status:r.status});return v}
export async function load(){const r=await api('state');Object.assign(ctx,{s:r.workspace,member:r.member,members:r.members,cardEnabled:r.cardEnabled,billingEnabled:r.billingEnabled,signedIn:r.signedIn});if(ctx.store!=='all'&&!ctx.s.stores.some(s=>s.id===ctx.store))ctx.store='all'}
export function notify(msg){const t=document.querySelector('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(t.timer);t.timer=setTimeout(()=>t.classList.remove('show'),3200)}
export function close(){const d=document.querySelector('#modal');d.close();d.innerHTML=''}
export function modal(title,body,wide=false){const d=document.querySelector('#modal');d.className=wide?'wide':'';d.innerHTML=`<div class="modal-head"><h2>${esc(title)}</h2><button data-act="close" class="iconbtn" aria-label="Close">${icon('close')}</button></div><div class="modal-body">${body}</div>`;if(!d.open)d.showModal()}
export const form=(name,fields,submit,extra='')=>`<form data-form="${name}">${fields}<p class="form-error" role="alert"></p><div class="form-foot">${extra}${btn('Cancel','close','','secondary','type="button"')}<button type="submit" class="btn primary">${submit}</button></div></form>`;
export function csv(name,headers,rows){const cell=v=>{const s=String(v??'');return '"'+(/^[=+@-]/.test(s)?"'":'')+s.replaceAll('"','""')+'"'};const blob=new Blob(['\uFEFF'+[headers,...rows].map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}

