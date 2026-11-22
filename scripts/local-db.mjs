import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export function openDatabase(path=':memory:'){
 const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
 if(!db.prepare("SELECT name FROM sqlite_master WHERE name='organizations'").get())db.exec(readFileSync(new URL('../drizzle/0001_retail.sql',import.meta.url),'utf8'));
 db.exec(readFileSync(new URL('../drizzle/0002_email_outbox.sql',import.meta.url),'utf8'));
 function statement(sql,args=[]){return {bind:(...v)=>statement(sql,v),first:async()=>db.prepare(sql).get(...args)||null,all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>({meta:db.prepare(sql).run(...args)}),execute:()=>({meta:db.prepare(sql).run(...args)})}}
 return {raw:db,prepare:sql=>statement(sql),async batch(stmts){db.exec('BEGIN IMMEDIATE');try{const r=stmts.map(s=>s.execute());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}}
}
