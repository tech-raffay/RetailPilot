import http from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {randomBytes,scrypt as derive,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {api} from '../src/api.js';
import {openDatabase} from './local-db.mjs';
const dir=resolve(process.env.RETAILPILOT_DATA_DIR||'.retailpilot');await mkdir(dir,{recursive:true});
const DB=openDatabase(resolve(dir,'retail.sqlite')),sql=DB.raw;
sql.exec('CREATE TABLE IF NOT EXISTS local_accounts (email TEXT PRIMARY KEY, name TEXT, salt TEXT, verifier TEXT, recovery TEXT); CREATE TABLE IF NOT EXISTS local_logins (token TEXT PRIMARY KEY,email TEXT,expires INTEGER);');
const scrypt=promisify(derive),digest=s=>createHash('sha256').update(s).digest('hex');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const port=Number(process.argv[process.argv.indexOf('--port')+1])||Number(process.env.PORT)||4173;
const host=process.argv.includes('--host')?process.argv[process.argv.indexOf('--host')+1]:process.env.HOST||'127.0.0.1';
const mime={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.webp':'image/webp','.zip':'application/zip'};
const page=(title,body)=>'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>'+esc(title)+' · RetailPilot</title><main style="max-width:460px;margin:8vh auto"><a href="/" class="brand"><img width="36" src="/mark.svg" alt="">RetailPilot</a><section class="panel settings"><h1>'+esc(title)+'</h1><div class="modal-body">'+body+'</div></section></main></html>';
const input=(key,label,type='text')=>'<label class="field">'+label+'<input required type="'+type+'" name="'+key+'"></label>';
const attempts=new Map();
async function auth(req,url,body,headers){
 const path=url.pathname.split('/').pop(),param=new URLSearchParams(body),email=(param.get('email')||'').trim().toLowerCase(),pw=param.get('password')||'';
 const target=url.searchParams.get('return_to')||'/';const back=target.startsWith('/')&&!target.startsWith('//')&&!target.includes('\\')?target:'/';
 const action='/local/'+(path==='signin-with-chatgpt'?'signin':path)+'?return_to='+encodeURIComponent(back);
 const link=(p,l)=>'<a class="btn text" href="/local/'+p+'?return_to='+encodeURIComponent(back)+'">'+l+'</a>';
 if(req.method==='GET'){
 const create=path==='signup',reset=path==='reset';return page(create?'Create account':reset?'Reset password':'Sign in','<form method="post" action="'+esc(action)+'">'+(create?input('name','Your name'):'')+input('email','Email','email')+(reset?input('recovery','Recovery code'):'')+input('password',reset?'New password':'Password','password')+'<button class="btn primary">'+(create?'Create account':reset?'Reset password':'Sign in')+'</button></form><div class="form-foot">'+link(create||reset?'signin':'signup',create||reset?'Sign in':'Create account')+(path==='signin'||path==='signin-with-chatgpt'?link('reset','Reset password'):'')+'</div>');
 }
 const fail=msg=>page('Account access',esc(msg)+'<div class="form-foot">'+link('signin','Back to sign in')+'</div>');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>250||pw.length>1024)return fail('Enter a valid email and password.');
 const k=req.socket.remoteAddress,window=attempts.get(k)||{count:0,time:Date.now()};if(Date.now()-window.time>60000){window.count=0;window.time=Date.now()}attempts.set(k,window);if(++window.count>30)return fail('Please try again in a minute.');
 const account=sql.prepare('SELECT * FROM local_accounts WHERE email=?').get(email);
 if(path==='signup'||path==='reset'){
 if(pw.length<10)return fail('Use at least 10 characters for your password.');
 if(path==='signup'&&account)return fail('This account already exists.');
 if(path==='reset'&&(!account||account.recovery!==digest(param.get('recovery')||'')))return fail('Invalid recovery code.');
 const salt=randomBytes(24).toString('hex'),verifier=(await scrypt(pw,salt,64)).toString('hex'),recovery=randomBytes(24).toString('hex');
 if(path==='signup')sql.prepare('INSERT INTO local_accounts VALUES(?,?,?,?,?)').run(email,(param.get('name')||'').slice(0,120),salt,verifier,digest(recovery));
 else{sql.prepare('UPDATE local_accounts SET salt=?,verifier=?, recovery=? WHERE email=?').run(salt,verifier,digest(recovery),email);sql.prepare('DELETE FROM local_logins WHERE email=?').run(email)}
 return page('Save your recovery code','<p class="dialog-desc">Store this code privately. You can use it to reset your password.</p><input class="full" readonly value="'+recovery+'"><div class="form-foot">'+link('signin','Continue to sign in')+'</div>');
 }
 if(!account||!timingSafeEqual(await scrypt(pw,account.salt,64),Buffer.from(account.verifier,'hex')))return fail('Email or password is incorrect.');
 const token=randomBytes(32).toString('hex');sql.prepare('INSERT INTO local_logins VALUES(?,?,?)').run(digest(token),email,Date.now()+14*86400000);headers['Set-Cookie']='rp_local='+token+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600'+(process.env.RETAILPILOT_HTTPS==='1'?'; Secure':'');headers.Location=back;return '';
}
http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://'+req.headers.host);const hdr=new Headers(req.headers);hdr.delete('oai-authenticated-user-id');hdr.delete('oai-authenticated-user-email');
 const origin=hdr.get('origin');if(req.method==='POST'&&origin&&new URL(origin).host!==url.host){res.writeHead(403).end();return}
 const token=(hdr.get('cookie')||'').match(/(?:^|;\s*)rp_local=([a-f0-9]+)/)?.[1];
 const account=token&&sql.prepare('SELECT a.email FROM local_logins l JOIN local_accounts a ON l.email=a.email WHERE token=? AND expires>?').get(digest(token),Date.now());
 if(account){hdr.set('oai-authenticated-user-id','local:'+account.email);hdr.set('oai-authenticated-user-email',account.email)}
 const chunks=[];let length=0;for await(const c of req){length+=c.length;if(length>2e6){res.writeHead(413).end();return}chunks.push(c)}const body=Buffer.concat(chunks).toString();
 if(url.pathname.startsWith('/api/')){const response=await api(new Request(url,{method:req.method,headers:hdr,...(req.method==='GET'||req.method==='HEAD'?{}:{body})}),{...process.env,DB});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return}
 if(url.pathname.startsWith('/local/')||url.pathname==='/signin-with-chatgpt'){const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'};const ret=await auth(req,url,body,headers);res.writeHead(headers.Location?303:200,headers).end(ret);return}
 const root=resolve('public'),path=resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));if(!path.startsWith(root+sep)){res.writeHead(404).end();return}
 const file=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(file)
 }catch(e){res.writeHead(e.code==='ENOENT'?404:500).end('Request could not be completed.')}}).listen(port,host,()=>console.log('RetailPilot available on http://'+host+':'+port));
