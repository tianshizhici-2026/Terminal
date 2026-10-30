// Requires an isolated test profile on CDP 9240 and the loopback SSH fixture on 22992.
// Seed /native-shared.bin with 32 MiB of repeating bytes 0..255 and trust only the fixture key.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.TEST_CDP||'http://127.0.0.1:9240');
 try{
  const page=browser.contexts()[0].pages()[0];
  const destination=path.resolve(process.env.TEST_DESTINATION||'artifacts/sftp-native-20261030/download.bin');
  if(fs.existsSync(destination))throw new Error('Use a fresh isolated destination for this test');
  await page.evaluate(destination=>{
   const send=chrome.webview.postMessage.bind(chrome.webview);
   window.sftpTestCalls=[];window.sftpTestEvents=[];window.pauseNextProgress=true;window.dropNextProgress=false;
   chrome.webview.postMessage=m=>{if(m.action==='sftp'&&m.op==='prepareDownload')m={...m,destination};sftpTestCalls.push(m);send(m);};
   chrome.webview.addEventListener('message',({data:m})=>{
    if(m.request)sftpTestEvents.push({time:Date.now(),request:m.request,ok:m.ok,error:m.error});
    if(m.type!=='transfer'||!m.done)return;
    if(pauseNextProgress){pauseNextProgress=false;document.querySelector('#transfer-toggle').click();}
    else if(dropNextProgress){dropNextProgress=false;send({action:'input',id:m.id,data:'__TEST_DROP_TRANSPORT__\n'});}
   });
  },destination);
  await page.evaluate(()=>window.terminalAction('connections'));
  await page.locator('#add-profile').click();
  for(const [key,value] of Object.entries({name:'SFTP shared fixture',host:'127.0.0.1',port:'22992',username:'mist-test',password:'test-only'}))await page.locator(`[name=${key}]`).fill(value);
  await page.locator('#remember-password').check();await page.locator('#connect-form button[type=submit]').click();
  await expect(page.locator('#status')).toHaveText('mist-test@127.0.0.1');
  await page.evaluate(()=>window.terminalAction('files'));
  const row=page.locator('.file-row').filter({hasText:'native-shared.bin'});
  await row.locator('.file-open').click();
  await expect(page.locator('#transfer')).toContainText('已暂停');
  const offset=fs.statSync(destination+'.terminal.part').size;expect(offset).toBeGreaterThan(0);
  const firstId=await page.locator('#file-server').inputValue();
  const lists=await page.evaluate(()=>sftpTestCalls.filter(m=>m.op==='list').length);
  await page.evaluate(()=>window.terminalAction('connections'));await page.locator('#new-menu summary').click();await page.locator('#new-local').click();
  await expect(page.locator('#status')).toContainText('本地');
  await expect(page.locator('#file-server')).toHaveValue(firstId);await expect(page.locator('#transfer')).toContainText('已暂停');
  expect(await page.evaluate(()=>sftpTestCalls.filter(m=>m.op==='list').length)).toBe(lists);
  await page.evaluate(()=>window.dropNextProgress=true);await page.locator('#transfer-toggle').click();
  await expect(page.locator('#file-reconnect')).toBeVisible();
  await expect(page.locator('#transfer-toggle')).toBeDisabled();
  const reconnectStarted=Date.now();
  await page.locator('#file-reconnect').click();await expect(page.locator('#file-reconnect')).toBeHidden({timeout:45000});
  console.log(`Native reconnect ready in ${Date.now()-reconnectStarted} ms`);
  await expect(page.locator('#file-server')).not.toHaveValue(firstId);
  await page.locator('#transfer-toggle').click();
  await expect(page.locator('#transfer')).toContainText('已完成',{timeout:60000});
  const expected=createHash('sha256'),chunk=Buffer.from(Array.from({length:256},(_,i)=>i));
  const block=Buffer.concat(Array.from({length:4096},()=>chunk));for(let i=0;i<32;i++)expected.update(block);
  expect(createHash('sha256').update(fs.readFileSync(destination)).digest('hex')).toBe(expected.digest('hex'));
  expect(fs.existsSync(destination+'.terminal.part')).toBe(false);
  console.log('PASS native shared SFTP: local-tab switch, pause, transport drop, reconnect and byte-identical 32 MiB resume');
  await page.screenshot({path:'artifacts/sftp-shared-native.png'});
  await page.evaluate(async()=>{
   await Promise.all([...document.querySelectorAll('.terminal-pane')].map(p=>new Promise(resolve=>{
    const request=crypto.randomUUID();const receive=({data:m})=>{if(m.request===request){chrome.webview.removeEventListener('message',receive);resolve();}};
    chrome.webview.addEventListener('message',receive);chrome.webview.postMessage({action:'close',id:p.dataset.session,request});
   })));
  });
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
