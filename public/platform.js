import {api,esc} from './core.js';

const el=id=>document.getElementById(id);
let page=1,term='',requestId=0;
async function loadBusinesses(){
  const current=++requestId;
  el('results').hidden=el('pager').hidden=el('signin').hidden=true;
  document.querySelector('tbody').replaceChildren();
  el('status').textContent='Loading businesses…';
  try{
    const data=await api('platform/businesses?'+new URLSearchParams({page,q:term}));
    if(current!==requestId)return;
    el('search').hidden=false;
    const rows=data.businesses.map(b=>`<tr><th scope="row">${esc(b.name)}<small>${esc(b.id)}</small></th>
      <td>${esc(b.plan)}</td><td>${esc(b.billing)}</td><td>${b.stores}</td><td>${b.staff}</td><td>${b.variants}</td><td>${b.orders}</td></tr>`);
    document.querySelector('tbody').innerHTML=rows.join('');
    el('status').textContent=rows.length?'':term?'No matching businesses.':'No businesses yet.';
    el('results').hidden=!rows.length;
    el('pager').hidden=page===1&&!data.hasMore;
    el('prev').disabled=page===1;
    el('next').disabled=!data.hasMore;
    el('number').textContent='Page '+page;
  }catch(error){
    if(current!==requestId)return;
    el('status').textContent=error.message;
    el('signin').hidden=error.status!==401;
    if(error.status===401||error.status===403)el('search').hidden=true;
  }
}
el('search').onsubmit=e=>{e.preventDefault();term=el('query').value.trim();page=1;loadBusinesses()};
el('prev').onclick=()=>{page--;loadBusinesses()};
el('next').onclick=()=>{page++;loadBusinesses()};
window.addEventListener('pageshow',e=>{if(e.persisted)loadBusinesses()});
loadBusinesses();
