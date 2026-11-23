import {retailPlans,planAllowance} from './plans.js';

document.querySelector('#plans').innerHTML=Object.entries(retailPlans).map(([name,plan])=>
  '<article><h3>'+name+'</h3><strong>£'+plan.price+'</strong> <small>/ month</small><p>'+
  planAllowance(plan.stores,'store')+' · '+planAllowance(plan.staff,'staff')+'</p></article>').join('');
