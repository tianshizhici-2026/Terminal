// Usage: node tests/native-updates.cjs <old-portable.zip> <new-release-directory>
// Uses a fresh extraction/profile and closes only processes from that extraction.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const archive=path.resolve(process.argv[2]),feed=path.resolve(process.argv[3]);
 const target=JSON.parse(fs.readFileSync(path.join(feed,'releases.lite-win-x64.json'),'utf8')).Assets[0].Version;
 const root=fs.mkdtempSync(path.resolve('artifacts/native-update-')),install=path.join(root,'app'),profile=path.join(root,'profile');
 fs.mkdirSync(profile);fs.writeFileSync(path.join(profile,'updates.json'),JSON.stringify({Automatic:false}));
 fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({profiles:[],fontSize:16,fontFamily:'Consolas',defaultShell:'powershell',snippets:[]}));
 const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const env={...process.env,TERMINAL_DATA_DIR:profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`,TEST_ARCHIVE:archive,TEST_INSTALL:install,TEST_EXE:path.join(install,'current','Terminal.exe')};
 const ps=command=>execFileSync('powershell.exe',['-NoProfile','-Command',command],{env,windowsHide:true,encoding:'utf8'}).trim();
 ps('Expand-Archive -LiteralPath $env:TEST_ARCHIVE -DestinationPath $env:TEST_INSTALL');
 fs.writeFileSync(path.join(install,'current','obsolete-update-test.txt'),'old test-owned content');
 fs.writeFileSync(path.join(install,'keep.txt'),'root file must survive');
 const launch=()=>spawn(path.join(install,'Terminal.exe'),[],{env,cwd:install,windowsHide:true,stdio:'ignore'}).unref();
 const processIds=()=>ps('Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:TEST_EXE } | ForEach-Object { $_.ProcessId }');
 const close=()=>ps('Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:TEST_EXE } | ForEach-Object { (Get-Process -Id $_.ProcessId).CloseMainWindow() | Out-Null }');
 async function connect(){for(let n=0;n<100;n++){try {const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);const page=browser.contexts()[0].pages()[0];await page.waitForFunction(()=>typeof terminalAction==='function',{timeout:5000});return {browser,page};}catch{await pause(300);}}throw Error('Native app did not start');}
 const call=(page,action)=>page.evaluate(action=>new Promise((resolve,reject)=>{const request=crypto.randomUUID();const receive=({data:m})=>{if(m.request!==request)return;chrome.webview.removeEventListener('message',receive);m.ok?resolve(m.result):reject(Error(m.error));};chrome.webview.addEventListener('message',receive);chrome.webview.postMessage({action,request});}),action);
 let browser;
 try{
  launch();let connection=await connect();browser=connection.browser;let page=connection.page;
  expect((await call(page,'updateStatus')).version).toBe('0.0.1');
  await page.evaluate(()=>terminalAction('connections'));await page.locator('#new-menu summary').click();await page.locator('#new-local').click();
  await expect(page.locator('#status')).toContainText('本地');
  const originalPid=processIds();
  execFileSync('dotnet',['run','--project','tests/Updates','--','--prepare',feed,path.join(install,'packages')],{windowsHide:true,stdio:'inherit'});
  await call(page,'updateCheck');
  await expect.poll(async()=>(await call(page,'updateStatus')).state).toBe('ready');
  await page.evaluate(()=>terminalAction('settings'));await expect(page.locator('#update-status')).toContainText('下次启动更新');await expect(page.locator('#check-update')).toBeDisabled();await page.locator('[data-close="settings-dialog"]').click();
  launch();await pause(1200);
  expect(processIds()).toBe(originalPid);await expect(page.locator('#status')).toContainText('本地');
  expect((await call(page,'updateStatus')).version).toBe('0.0.1');
  console.log('PASS staged update and repeated launch preserve the running terminal session');
  await page.evaluate(async()=>{await Promise.all([...document.querySelectorAll('.terminal-pane')].map(p=>new Promise(resolve=>{const request=crypto.randomUUID();const receive=({data:m})=>{if(m.request===request){chrome.webview.removeEventListener('message',receive);resolve();}};chrome.webview.addEventListener('message',receive);chrome.webview.postMessage({action:'close',id:p.dataset.session,request});})));});
  close();await browser.close();browser=null;
  await expect.poll(processIds,{timeout:10000}).toBe('');
  launch();connection=await connect();browser=connection.browser;page=connection.page;
  await expect.poll(async()=>(await call(page,'updateStatus')).version,{timeout:30000}).toBe(target);
  expect((await call(page,'updateStatus')).automatic).toBe(false);
  await page.evaluate(()=>terminalAction('settings'));await expect(page.locator('#font-size')).toHaveText('16');await expect(page.locator('#terminal-font')).toHaveValue('Consolas');
  expect(fs.existsSync(path.join(install,'current','obsolete-update-test.txt'))).toBe(false);
  expect(fs.readFileSync(path.join(install,'keep.txt'),'utf8')).toBe('root file must survive');
  expect(fs.existsSync(path.join(install,'Terminal.exe'))).toBe(true);
  const packages=fs.readdirSync(path.join(install,'packages')).filter(name=>name.endsWith('.nupkg'));
  expect(packages.length).toBeGreaterThan(0);expect(packages.every(name=>name.includes(target))).toBe(true);
  await page.screenshot({path:path.join(root,'updated.png')});
  console.log(`PASS native ZIP update 0.0.1 -> ${target}, stable launcher, obsolete-file cleanup and preserved settings`);
  console.log(root);
 }finally{close();if(browser)await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
