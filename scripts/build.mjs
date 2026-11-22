import {readFile,readdir,writeFile,mkdir,copyFile,cp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,extname,relative,sep} from 'node:path';
const root=process.cwd();
const types={'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.html':'text/html; charset=utf-8','.webp':'image/webp','.zip':'application/zip'};
await rm('dist',{recursive:true,force:true});await mkdir('dist/server',{recursive:true});await mkdir('dist/.openai',{recursive:true});
await copyFile('.openai/hosting.json','dist/.openai/hosting.json');await cp('drizzle','dist/drizzle',{recursive:true});
const assets={};async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory()){await walk(path);continue}assets['/'+relative('public',path).split(sep).join('/')]=[types[extname(path)],(await readFile(path)).toString('base64')]}}await walk('public');
const zip = execFileSync(process.platform==='win32'?'python':'python3',['-c',[
 "import io,zipfile,sys,pathlib",
 "b=io.BytesIO()",
 "with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:",
 " for item in ['README.md','package.json','.gitignore','public','scripts','src','drizzle','.openai']:",
 "  p=pathlib.Path(item)",
 "  for f in ([p] if p.is_file() else sorted(p.rglob('*'))):",
 "   if f.is_file(): z.write(f,'RetailPilot/'+str(f))",
 "sys.stdout.buffer.write(b.getvalue())"
].join('\n')],{maxBuffer:16*1024*1024});
assets['/downloads/RetailPilot-source.zip']=['application/zip',zip.toString('base64')];
let bundle='';for(const file of ['catalog','business','payments','api'])bundle+=(await readFile('src/'+file+'.js','utf8')).replace(/^import .*?;\r?\n/gm,'').replace(/^export /gm,'')+'\n';
bundle+='\nconst assets='+JSON.stringify(assets)+';\n';
bundle+=`export default {async fetch(request,env){
const url=new URL(request.url);
if(url.pathname.startsWith('/api/'))return api(request,env);
if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
const file=assets[url.pathname==='/'?'/index.html':url.pathname];
if(!file)return new Response('Not found',{status:404});
const headers={'Content-Type':file[0],'X-Content-Type-Options':'nosniff','Cache-Control':url.pathname.startsWith('/images/')?'public,max-age=86400':'no-cache'};
return new Response(request.method==='HEAD'?null:Uint8Array.from(atob(file[1]),c=>c.charCodeAt(0)),{headers});}};`;
await writeFile('dist/server/index.js',bundle);
execFileSync(process.execPath,['--check','dist/server/index.js']);
console.log('Built RetailPilot with '+Object.keys(assets).length+' assets.');
