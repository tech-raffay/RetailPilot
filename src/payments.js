import {fail} from './business.js';
export function stripeReady(env){return !!(env.STRIPE_TEST_KEY?.startsWith('sk_test_')&&env.STRIPE_WEBHOOK_SECRET)}
export async function stripe(env,path,fields,key,account){
  if(!stripeReady(env))fail('Stripe test payments have not been connected.',503);
  const headers={Authorization:'Bearer '+env.STRIPE_TEST_KEY,'Content-Type':'application/x-www-form-urlencoded'};
  if(account)headers['Stripe-Account']=account;if(key)headers['Idempotency-Key']=key;
  const r=await fetch('https://api.stripe.com/v1/'+path,{method:'POST',headers,body:new URLSearchParams(fields)});
  const v=await r.json();
  if(!r.ok)throw Object.assign(new Error(v.error?.message||'The payment provider could not complete the request.'),{
    status:502, providerRejected:[400,401,403,404].includes(r.status)&&v.error?.type!=='idempotency_error'
  });
  return v;
}
export async function verifyEvent(raw,header,secret){
  if(!secret||!header)fail('Missing webhook signature.',400);
  const parts=header.split(',').map(p=>p.split('='));const t=parts.find(p=>p[0]==='t')?.[1];
  if(!t||Math.abs(Date.now()/1000-Number(t))>300)fail('Expired signature.');
  const enc=new TextEncoder(), key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  for(const [,sig] of parts.filter(p=>p[0]==='v1'&&/^[a-f0-9]{64}$/.test(p[1]))){
    const bytes=Uint8Array.from(sig.match(/../g),x=>parseInt(x,16));
    if(await crypto.subtle.verify('HMAC',key,bytes,enc.encode(t+'.'+raw)))return JSON.parse(raw);
  }
  fail('Invalid signature.');
}
