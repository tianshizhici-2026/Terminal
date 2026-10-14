const {chromium,expect} = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const root = path.resolve('src/Mist.Terminal/www');
  const server = http.createServer((req,res) => {
    const file = path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if (!file.startsWith(root+path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type',file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({channel:'msedge',headless:true});
    const page = await browser.newPage({viewport:{width:1100,height:700}});
    const errors = []; page.on('pageerror',e => errors.push(e.message));
    await page.addInitScript(() => {
      const listeners = [];
      window.testBridge = {calls:[],download:null,emit:m => listeners.forEach(fn => fn({data:m}))};
      window.chrome = window.chrome || {};
      window.chrome.webview = {
        addEventListener:(_,fn) => listeners.push(fn),
        postMessage:m => {
          testBridge.calls.push(m);
          const reply = result => queueMicrotask(() => testBridge.emit({request:m.request,ok:true,result}));
          if (m.action === 'load') reply({profiles:[],fontSize:14});
          else if (m.action === 'sftp' && m.op === 'list') reply({path:'/home/test',entries:[{name:'sample.bin',path:'/home/test/sample.bin',size:1048576,directory:false},{name:'folder',path:'/home/test/folder',directory:true}]});
          else if (m.action === 'sftp' && m.op === 'download') { testBridge.download=m; testBridge.emit({type:'transfer',id:m.id,done:262144,total:1048576}); }
          else if (m.action === 'pauseDownload') { reply(null); testBridge.emit({request:testBridge.download.request,ok:true,result:{paused:true}}); }
          else reply(null);
        }
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.clock.install();
    const connect = async name => {
      await page.evaluate(() => window.terminalAction('connections'));
      await page.locator('#add-profile').click();
      await page.locator('[name=name]').fill(name);
      await page.locator('[name=host]').fill('127.0.0.1');
      await page.locator('[name=username]').fill('test');
      await page.locator('#connect-form button[type=submit]').click();
      await expect(page.locator('#status')).toHaveText('test@127.0.0.1');
    };
    await connect('first');
    await page.evaluate(() => window.terminalAction('files'));
    const file = page.locator('.file-row').filter({hasText:'sample.bin'});
    await file.click({button:'right'});
    await expect(page.locator('#file-menu')).toBeVisible();
    await expect(page.locator('#file-menu [role=menuitem]').first()).toHaveText('下载 / 续传');
    fs.mkdirSync('artifacts',{recursive:true});
    await page.screenshot({path:'artifacts/sftp-menu.png'});
    await page.keyboard.press('Escape');
    await expect(page.locator('#file-menu')).toBeHidden();
    await file.locator('.file-rename').click();
    await page.locator('#file-menu').getByText('下载 / 续传').click();
    await expect(page.locator('#transfer')).toContainText('25%');
    await page.locator('#transfer-toggle').click();
    await expect(page.locator('#transfer')).toContainText('已暂停');
    await expect(page.locator('#transfer-toggle')).toHaveText('继续');
    await page.locator('#transfer-toggle').click();
    expect(await page.evaluate(() => testBridge.download.resume)).toBe('yes');
    await expect(page.locator('#transfer')).toContainText('传输中');

    // A transfer must not fail merely because five minutes passed in the UI.
    await page.clock.fastForward(301000);
    await expect(page.locator('#transfer')).toContainText('传输中');
    await connect('second');
    await expect(page.locator('#transfer-toggle')).toBeHidden();
    await page.getByRole('tab',{name:'first',exact:true}).click();
    await expect(page.locator('#transfer')).toContainText('25%');
    await page.evaluate(() => { const m=testBridge.download; testBridge.emit({request:m.request,ok:true,result:{success:true}}); });
    await expect(page.locator('#transfer')).toContainText('已完成');
    await expect(page.locator('#transfer-toggle')).toBeHidden();
    await page.locator('.file-row').filter({hasText:'folder'}).click({button:'right'});
    await expect(page.locator('#file-menu [role=menuitem]').first()).toHaveText('打开文件夹');
    await page.locator('#files-close').click();
    await expect(page.locator('#file-menu')).toBeHidden();
    expect(errors).toEqual([]);
    console.log('PASS SFTP right-click/menu dismissal, pause/resume, long transfer, per-session status and directory actions');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode=1; });
