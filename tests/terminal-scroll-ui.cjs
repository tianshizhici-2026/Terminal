const {chromium,expect}=require('@playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
(async()=>{
 const root=path.resolve('src/Mist.Terminal/www');
 const server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  for(const dpi of [1,1.5]){
   const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:dpi});
   await page.addInitScript(()=>{const listeners=[];window.testBridge={calls:[],emit:data=>listeners.forEach(fn=>fn({data}))};window.chrome={webview:{addEventListener:(_,fn)=>listeners.push(fn),postMessage:m=>{testBridge.calls.push(m);if(m.request)queueMicrotask(()=>testBridge.emit({request:m.request,ok:true,result:m.action==='load'?{fontSize:14,profiles:[{id:'fixture',name:'fixture',host:'fixture',username:'test',port:22,rememberPassword:true}]}:null}));}}};});
   await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
   await page.locator('#recent-profiles .profile-connect').click();await expect(page.locator('#status')).toHaveText('test@fixture');
   const emit=data=>page.evaluate(data=>testBridge.emit({type:'output',id:document.querySelector('.terminal-pane').dataset.session,data}),data);
   const rows=page.locator('.xterm-rows');
   await emit(Array.from({length:300},(_,i)=>`\r\nLINE_${i} ${'long text '.repeat(25)}`).join(''));
   await expect(rows).toContainText('LINE_299');await page.locator('.xterm-screen').hover();
   const zoom=async delta=>{await page.keyboard.down('Control');await page.mouse.wheel(0,delta);await page.keyboard.up('Control');await page.waitForTimeout(100);};
   for(const delta of [-120,-120,120,120]){await zoom(delta);await expect(rows).toContainText('LINE_299');}
   await page.mouse.wheel(0,-2400);await page.waitForTimeout(100);
   const line=async()=>Number((await rows.textContent()).match(/LINE_(\d+)/)[1]);
   const anchor=await line();expect(anchor).toBeGreaterThan(0);expect(anchor).toBeLessThan(290);
   for(const delta of [-120,-120,120,120]){await zoom(delta);expect(Math.abs(await line()-anchor)).toBeLessThanOrEqual(1);}
   await page.setViewportSize({width:1000,height:650});await page.waitForTimeout(100);expect(Math.abs(await line()-anchor)).toBeLessThanOrEqual(1);
   await emit('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[HAPPLICATION');await expect(rows).toContainText('APPLICATION');
   await page.evaluate(()=>testBridge.calls=testBridge.calls.filter(m=>m.action!=='input'));
   await zoom(-120);await zoom(120);
   expect(await page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input'))).toEqual([]);
   await page.mouse.wheel(0,-120);
   await expect.poll(()=>page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').length)).toBeGreaterThan(0);
   await emit('\x1b[?1049l\x1b[?1000l\x1b[?1006l');
   await expect(page.locator('.terminal-app-scroll')).toHaveCount(0);
   console.log(`PASS DPI ${dpi}: bottom/reading anchor retained on zoom and resize; Ctrl wheel never reaches TUI; normal wheel still works`);
   await page.close();
  }
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
