#!/usr/bin/env node
/* Minimal static server for self-hosting truthai-mini.
   Serves ./www with correct MIME types, HTTP Range support for model shards,
   and the cross-origin-isolation headers WebGPU + multithreaded wasm want.
   Usage: PORT=8080 node serve.js   (put app/, models/, release/, vendor/ under ./www) */
const http=require('http'), fs=require('fs'), path=require('path');
const ROOT=path.join(__dirname,'www');
const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript','.mjs':'application/javascript','.json':'application/json','.webmanifest':'application/manifest+json','.wasm':'application/wasm','.bin':'application/octet-stream','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.css':'text/css; charset=utf-8','.txt':'text/plain','.hex':'text/plain','.torrent':'application/x-bittorrent'};
http.createServer((req,res)=>{ try{
  const u=new URL(req.url,'http://x'); let p;
  try{ p=decodeURIComponent(u.pathname); }catch(e){ res.writeHead(400); return res.end('bad path'); }
  if(p.includes('\0')){ res.writeHead(400); return res.end('bad path'); }
  if(p==='/'||p==='/app'){ res.writeHead(302,{'Location':'/app/'}); return res.end(); }   /* the app is the site; a bare root 404 was a real trap for self-hosters */
  if(p.endsWith('/')) p+='index.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT+path.sep)||!fs.existsSync(f)||!fs.statSync(f).isFile()){ res.writeHead(404); return res.end('not found'); }
  if(!fs.realpathSync(f).startsWith(fs.realpathSync(ROOT)+path.sep)){ res.writeHead(404); return res.end('not found'); }   /* symlinks may not escape the web root */
  const st=fs.statSync(f), type=MIME[path.extname(f).toLowerCase()]||'application/octet-stream';
  const H={'Content-Type':type,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':p.includes('/models/')||p.includes('/vendor/')?'public, max-age=31536000, immutable':'no-cache'};
  const r=(req.headers.range||'').match(/bytes=(\d*)-(\d*)/);   /* suffix range longer than the file serves the whole body as 206 — RFC 7233 satisfiable suffix, by design */
  if(r&&(r[1]||r[2])){ const a=r[1]?parseInt(r[1]):Math.max(0,st.size-parseInt(r[2])), b=r[2]&&r[1]?Math.min(parseInt(r[2]),st.size-1):st.size-1;
    if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||a>=st.size||a>b){ res.writeHead(416,{'Content-Range':`bytes */${st.size}`}); return res.end(); }
    res.writeHead(206,{...H,'Content-Range':`bytes ${a}-${b}/${st.size}`,'Content-Length':b-a+1}); return fs.createReadStream(f,{start:a,end:b}).pipe(res); }
  res.writeHead(200,{...H,'Content-Length':st.size}); fs.createReadStream(f).pipe(res);
 }catch(e){ try{ res.writeHead(500); res.end('server error'); }catch(_){} }
}).listen(Number(process.env.PORT||8080),()=>console.log('truthai-mini on :'+(process.env.PORT||8080)));
