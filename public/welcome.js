import {retailPlans,planAllowance} from './plans.js';

document.querySelector('#plans').innerHTML=Object.entries(retailPlans).map(([name,plan])=>
  '<article><h3>'+name+'</h3><strong>£'+plan.price+'</strong> <small>/ month</small><p>'+
  planAllowance(plan.stores,'store')+' · '+planAllowance(plan.staff,'staff')+'</p></article>').join('');

const buttons=[...document.querySelectorAll('[data-demo]')];
const feedback=document.querySelector('#feedback');
window.addEventListener('pageshow',event=>{
  if(event.persisted){
    for(const control of buttons)control.disabled=false;
    feedback.textContent='';
  }
});
for(const button of buttons){
  button.addEventListener('click',async()=>{
    for(const control of buttons)control.disabled=true;
    const role=button.dataset.demo;
    feedback.textContent='Opening your '+role.toLowerCase()+' demo…';
    try{
      const res=await fetch('/api/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role})});
      if(!res.ok)throw new Error('Demo unavailable');
      location.assign(role==='Cashier'?'/#pos':'/#overview');
    }catch{
      feedback.textContent='The demo could not open. Please try again.';
      for(const control of buttons)control.disabled=false;
    }
  });
}
