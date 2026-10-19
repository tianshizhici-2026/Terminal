const {chromium,expect}=require('@playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
(async()=>{
 const root=path.resolve('src/Mist.Terminal/www');
 const server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:Number(process.env.TEST_DPI||1)});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  const listeners=[];window.testBridge={calls:[],clipboard:'',emit:m=>listeners.forEach(f=>f({data:m}))};window.chrome=window.chrome||{};
  const initial={fontSize:14,fontFamily:'JetBrains Mono',profiles:[{id:'saved',name:'最近服务器',host:'fixture.example',port:22,username:'test',rememberPassword:true,lastUsed:100},{id:'older',name:'旧服务器',host:'old.example',port:22,username:'test',rememberPassword:false,lastUsed:1}],snippets:[]};
  window.chrome.webview={addEventListener:(_,f)=>listeners.push(f),postMessage:m=>{
   testBridge.calls.push(m);let result=null;
   if(m.action==='load')result=JSON.parse(sessionStorage.getItem('settings')||JSON.stringify(initial));
   else if(m.action==='save')sessionStorage.setItem('settings',JSON.stringify(m));
   else if(m.action==='password')result='fixture-only';
   else if(m.action==='copy'){if(testBridge.copyFailure){queueMicrotask(()=>testBridge.emit({request:m.request,ok:false,error:'Clipboard busy'}));return;}testBridge.clipboard=m.text;}
   else if(m.action==='paste')result=testBridge.clipboard;
   else if(m.action==='sftp'&&m.op==='list')result={path:'/home/test',entries:[{name:'sample.bin',path:'/home/test/sample.bin',size:100,directory:false},{name:'folder',path:'/home/test/folder',directory:true},{name:'a'.repeat(60)+'!',path:'/slow',size:2,directory:false}]};
   if(m.request)queueMicrotask(()=>testBridge.emit({request:m.request,ok:true,result}));
  }};
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
 await expect(page.locator('#recent-profiles .profile')).toHaveCount(2);
 await expect(page.locator('#recent-profiles .profile').first()).toContainText('最近服务器');
 await expect(page.locator('.profile-delete')).toHaveCount(0);
 await page.locator('#recent-profiles .profile-connect').first().click();
 await expect(page.locator('#status')).toHaveText('test@fixture.example');
 await expect(page.locator('#connect-dialog')).toBeHidden();
 console.log('PASS recent connections at startup and direct connect');
 await page.keyboard.down('Control');await page.mouse.wheel(0,-100);await page.keyboard.up('Control');await expect(page.locator('#font-size')).toHaveText('15');
 await page.keyboard.down('Shift');await page.mouse.wheel(0,-100);await page.keyboard.up('Shift');await page.waitForTimeout(150);await expect(page.locator('#font-size')).toHaveText('15');
 await page.keyboard.down('Control');await page.mouse.wheel(0,100);await page.keyboard.up('Control');await expect(page.locator('#font-size')).toHaveText('14');
 console.log('PASS Ctrl wheel changes font size; Shift wheel preserves size');
 const active=()=>page.evaluate(()=>document.querySelector('.terminal-pane:not([hidden])').dataset.session);
 const emit=async data=>page.evaluate(({id,data})=>testBridge.emit({type:'output',id,data}),{id:await active(),data});

 await page.locator('.xterm-helper-textarea').focus();
 for(const [sequence,shape] of [['\x1b[2 q','block'],['\x1b[4 q','underline'],['\x1b[6 q','bar'],['\x1b[?1049h\x1b[2 q\x1b[?12l','block'],['\x1b[?1049l\x1b[0 q','bar']]){
  await emit(sequence);
  await expect(page.locator('.xterm-cursor.xterm-cursor-blink')).toHaveCount(1);
  await expect(page.locator('.xterm-cursor')).toHaveClass(new RegExp('xterm-cursor-'+shape));
 }
 console.log('PASS blinking cursor in normal and alternate buffers, all shapes and DEC blink-disable');
 await emit('\x1b[2J\x1b[HCOPY_ME');
 await expect(page.locator('.xterm-rows')).toContainText('COPY_ME');
 const row=await page.locator('.xterm-rows>div').first().boundingBox();
 const cell=await page.evaluate(()=>{const m=testBridge.calls.filter(x=>x.action==='resize').at(-1);return document.querySelector('.xterm-screen').getBoundingClientRect().width/m.cols;});
 const selectCopy=async()=>{await page.evaluate(()=>testBridge.clipboard='');await page.mouse.move(row.x+1,row.y+row.height/2);await page.mouse.down();await page.mouse.move(row.x+7*cell+1,row.y+row.height/2,{steps:8});await page.mouse.up();};
 await selectCopy();await page.waitForTimeout(400);expect(await page.evaluate(()=>testBridge.clipboard)).toBe('');await expect.poll(()=>page.locator('.xterm-selection div').count()).toBeGreaterThan(0);
 await page.mouse.click(row.x+3,row.y+row.height/2,{button:'right'});
 await expect.poll(()=>page.evaluate(()=>testBridge.clipboard)).toBe('COPY_ME');
 await expect(page.locator('.xterm-selection div')).toHaveCount(0);await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
 await page.evaluate(()=>testBridge.copyFailure=true);await selectCopy();await page.keyboard.press('Control+Shift+c');await expect(page.locator('#toast')).toHaveText('Clipboard busy');await expect.poll(()=>page.locator('.xterm-selection div').count()).toBeGreaterThan(0);await page.evaluate(()=>testBridge.copyFailure=false);
 await selectCopy();await page.keyboard.press('Control+c');await expect.poll(()=>page.evaluate(()=>testBridge.clipboard)).toBe('COPY_ME');
 await selectCopy();await page.keyboard.press('Control+Shift+c');
 await expect.poll(()=>page.evaluate(()=>testBridge.clipboard)).toBe('COPY_ME');
 await selectCopy();await page.evaluate(()=>{testBridge.clipboard='';document.querySelector('.terminal-pane:not([hidden]) .xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Process',code:'KeyC',keyCode:229,ctrlKey:true,bubbles:true,cancelable:true}));});
 await expect.poll(()=>page.evaluate(()=>testBridge.clipboard)).toBe('COPY_ME');
 await selectCopy();await page.keyboard.down('Shift');await page.mouse.click(row.x+3,row.y+row.height/2,{button:'right'});await page.keyboard.up('Shift');
 await expect.poll(()=>page.evaluate(()=>testBridge.clipboard)).toBe('COPY_ME');
 await page.keyboard.press('Escape');
 await emit('\x1b[?1000h\x1b[?1006h');
 await page.evaluate(()=>testBridge.clipboard='PASTE_ME');const before=await page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').length);
 await page.mouse.click(row.x+100,row.y+row.height/2,{button:'right'});
 await expect.poll(()=>page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').at(-1)?.data)).toBe('PASTE_ME');
 expect(await page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').length)).toBe(before+1);
 await page.keyboard.press('Control+c');await expect.poll(()=>page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').at(-1)?.data)).toBe('\x03');
 await emit('\x1b[?1000l\x1b[?1006l');
 console.log('PASS selection does not copy; right-click copies and clears selection, CtrlShiftC, Shift-right-copy, right-paste under mouse reporting and CtrlC interrupt');
 await page.locator('.tab').click({button:'right'});await page.locator('#session-menu').getByText('复制会话',{exact:true}).click();await expect(page.locator('.tab')).toHaveCount(2);
 await page.locator('.tab').first().click();
 await emit('\r\nRECONNECT_HISTORY_MARKER\r\n');await expect(page.locator('.terminal-pane:not([hidden]) .xterm-rows')).toContainText('RECONNECT_HISTORY_MARKER');
 await page.evaluate(()=>window.originalReconnectPane=document.querySelector('.terminal-pane:not([hidden])'));
 const old=await active();await page.evaluate(id=>testBridge.emit({type:'exit',id}),old);
 await expect(page.locator('#status')).toHaveText('会话已结束');
 await expect(page.locator('.tab.selected .tab-dot')).toHaveCSS('background-color','rgb(255, 120, 133)');
 await expect(page.locator('.tab.selected .tab-dot')).toHaveAttribute('title','已断开');
 await page.evaluate(id=>testBridge.emit({type:'exit',id}),old);
 await page.locator('.tab.selected').click({button:'right'});await page.locator('#session-menu').getByText('重新连接',{exact:true}).click();
 await expect(page.locator('#status')).toHaveText('test@fixture.example');expect(await active()).not.toBe(old);await expect(page.locator('.tab')).toHaveCount(2);
 await expect(page.locator('.tab').first()).toHaveClass(/selected/);
 expect(await page.evaluate(()=>window.originalReconnectPane===document.querySelector('.terminal-pane:not([hidden])'))).toBe(true);
 await expect(page.locator('.terminal-pane:not([hidden]) .xterm-rows')).toContainText('RECONNECT_HISTORY_MARKER');
 await page.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea').focus();await page.keyboard.type('AFTER_RECONNECT');
 await expect.poll(()=>page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').at(-1)?.id)).toBe(await active());
 await page.evaluate(id=>testBridge.emit({type:'exit',id}),old);await expect(page.locator('#status')).toHaveText('test@fixture.example');
 await page.locator('.tab.selected').click({button:'right'});await page.locator('#session-menu').getByText('关闭',{exact:true}).click();await page.locator('#confirm-yes').click();await expect(page.locator('.tab')).toHaveCount(1);
 console.log('PASS tab duplicate, reconnect preserves history/pane/order, new connection input, stale-exit isolation and close');
 await page.evaluate(()=>window.terminalAction('snippets'));await page.locator('#snippet-add').click();
 await page.locator('#snippet-code').fill('printf 中文');await page.locator('#snippet-form button[type=submit]').click();
 await expect(page.locator('.snippet-row')).toHaveCount(1);await page.locator('.snippet-use').click();await expect.poll(()=>page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').at(-1)?.data)).toBe('printf 中文');

 await page.locator('.snippet-run').click();
 expect(await page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').slice(-2).map(m=>m.data))).toEqual(['printf 中文','\r']);
 await emit('\x1b[?2004h');await page.waitForTimeout(50);await page.locator('.snippet-run').click();
 expect(await page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').slice(-2).map(m=>m.data))).toEqual(['\x1b[200~printf 中文\x1b[201~','\r']);
 await emit('\x1b[?2004l');
 console.log('PASS snippet execute submits Enter outside bracketed paste');
 await expect(page.locator('.snippet-row').getByText('编辑',{exact:true})).toHaveCount(0);
 const codeBox=await page.locator('.snippet-use').boundingBox(),deleteBox=await page.locator('.snippet-actions').boundingBox();expect(deleteBox.x).toBeGreaterThanOrEqual(codeBox.x+codeBox.width-1);
 expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('settings')).snippets[0].code)).toBe('printf 中文');
 for(const code of ['pwd','ls -la']){await page.locator('#snippet-add').click();await page.locator('#snippet-code').fill(code);await page.locator('#snippet-form button[type=submit]').click();}
 const order=()=>page.locator('.snippet-use pre').allTextContents();
 const inputsBeforeSort=await page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').length);
 const drag=async(from,to,cancel=false)=>{
  const source=await page.locator('.snippet-use').nth(from).boundingBox(),target=await page.locator('.snippet-row').nth(to).boundingBox();
  await page.mouse.move(source.x+20,source.y+source.height/2);await page.mouse.down();await page.waitForTimeout(400);
  await expect(page.locator('.snippet-row.sorting')).toHaveCount(1);
  await page.mouse.move(target.x+20,to>from?target.y+target.height-2:target.y+2,{steps:8});
  if(cancel)await page.keyboard.press('Escape');await page.mouse.up();
 };
 await drag(0,2);await expect.poll(order).toEqual(['pwd','ls -la','printf 中文']);
 await expect.poll(()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('settings')).snippets.map(x=>x.code))).toEqual(['pwd','ls -la','printf 中文']);
 await drag(2,0,true);await expect.poll(order).toEqual(['pwd','ls -la','printf 中文']);
 await drag(2,0);await expect.poll(order).toEqual(['printf 中文','pwd','ls -la']);
 expect(await page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').length)).toBe(inputsBeforeSort);
 for(const code of ['pwd','ls -la']){const row=page.locator('.snippet-row').filter({has:page.locator('pre',{hasText:code})});await row.getByText('删除',{exact:true}).click();await page.locator('#confirm-yes').click();await expect(row).toHaveCount(0);}
 await page.locator('.snippet-use').click();await expect.poll(()=>page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').length)).toBe(inputsBeforeSort+1);
 console.log('PASS long-press reorder, persisted order, Escape rollback and no accidental paste');

 await page.locator('#snippets-close').click();
 await page.evaluate(()=>window.terminalAction('files'));await expect(page.locator('.file-row')).toHaveCount(3);
 await page.evaluate(()=>window.terminalAction('snippets'));
 fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/productivity-panels.png'});
 await page.locator('#snippets-close').click();
 await page.locator('#file-filter').fill('^sample\\.bin$');await expect(page.locator('.file-row')).toHaveCount(1);
 await page.locator('#file-filter').fill('[');await expect(page.locator('#file-filter-error')).toContainText('无效');
 await page.locator('#file-filter').fill('(a+)+$');await expect(page.locator('#file-filter-error')).toContainText('耗时');
 await page.locator('#file-filter').fill('');await expect(page.locator('.file-row')).toHaveCount(3);await page.locator('#files-close').click();
 console.log('PASS snippet create/paste persistence and safe regex filtering');
 for(const font of ['JetBrains Mono','Consolas','SimHei','FangSong']){
  await page.evaluate(()=>window.terminalAction('settings'));await page.locator('#terminal-font').selectOption(font);await page.locator('[data-close="settings-dialog"]').click();
  for(const fontSize of [10,14,28]){
   await page.evaluate(n=>{while(Number(document.querySelector('#font-size').textContent)!==n)document.querySelector(Number(document.querySelector('#font-size').textContent)<n?'#font-plus':'#font-minus').click();},fontSize);
  for(const size of [{width:760,height:480},{width:1280,height:800},{width:1536,height:815}]){
   await page.setViewportSize(size);
   await expect.poll(()=>page.evaluate(()=>{const pane=document.querySelector('.terminal-pane:not([hidden])').getBoundingClientRect(),screen=document.querySelector('.terminal-pane:not([hidden]) .xterm-screen').getBoundingClientRect();return screen.right<=pane.right-7&&screen.left>=pane.left&&Math.abs(screen.bottom-pane.bottom)<1;})).toBe(true);
   const cols=await page.evaluate(()=>testBridge.calls.filter(m=>m.action==='resize'&&m.id===document.querySelector('.terminal-pane:not([hidden])').dataset.session).at(-1).cols);
   await emit('\x1b[2J\x1b[H'+'M'.repeat(cols));await expect(page.locator('.terminal-pane:not([hidden]) .xterm-rows>div').first()).toContainText('M'.repeat(cols));
  }
 }
 }
 console.log('PASS all four fonts keep final terminal column in bounds');
 await page.setViewportSize({width:1280,height:800});
 const textarea=page.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea');await textarea.focus();
 const cdp=await page.context().newCDPSession(page);await cdp.send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});await cdp.send('Input.insertText',{text:'中文'});
 await expect.poll(()=>page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').at(-1)?.data)).toContain('中文');
 console.log('PASS Chromium IME composition commits Chinese text (native Shift toggle needs real environment)');
 await page.reload();await expect(page.locator('#recent-profiles .profile')).toHaveCount(2);
 await page.evaluate(()=>window.terminalAction('snippets'));await expect(page.locator('.snippet-row')).toHaveCount(1);await expect(page.locator('.snippet-use pre')).toHaveText('printf 中文');
 const offlineInputs=await page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').length);await page.locator('.snippet-run').click();expect(await page.evaluate(()=>testBridge.calls.filter(m=>m.action==='input').length)).toBe(offlineInputs);await expect(page.locator('#toast')).toHaveText('请先连接终端');
 await page.locator('.snippet-actions').getByText('删除').click();await page.locator('#confirm-yes').click();await expect(page.locator('.snippet-row')).toHaveCount(0);
 await page.locator('#snippets-close').click();await page.locator('#recent-profiles .profile-main').first().click();await expect(page.locator('#delete-profile')).toBeVisible();await page.locator('#delete-profile').click();await page.locator('#confirm-yes').click();await expect(page.locator('#recent-profiles .profile')).toHaveCount(1);
 expect(errors).toEqual([]);fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/recent-connections.png'});
 console.log('PASS restart persistence and deletion only in connection details');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
