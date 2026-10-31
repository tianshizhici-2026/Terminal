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
          if (m.action === 'load') reply({profiles:[],fontSize:14,sftpWidth:Number(sessionStorage.getItem('sftpWidth') || 440)});
          else if (m.action === 'save') { sessionStorage.setItem('sftpWidth',m.sftpWidth); reply(null); }
          else if (m.action === 'sftp' && m.op === 'list') reply({path:'/home/test',entries:[{name:'sample.bin',path:'/home/test/sample.bin',size:1048576,directory:false},{name:'folder',path:'/home/test/folder',directory:true}]});
          else if (m.action === 'sftp' && m.op === 'prepareDownload') reply({destination:m.destination||'C:/fixture/'+m.path.split('/').at(-1),overwrite:'yes'});
          else if (m.action === 'sftp' && m.op === 'download') { testBridge.download=m; testBridge.emit({type:'transfer',id:m.id,done:262144,total:1048576}); }
          else if (m.action === 'pauseDownload') { reply(null); testBridge.emit({request:testBridge.download.request,ok:true,result:{paused:true}}); }
          else reply(null);
        }
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.clock.install();
    const connect = async (name,{host='127.0.0.1',username='test',port='22'}={}) => {
      await page.evaluate(() => window.terminalAction('connections'));
      await page.locator('#add-profile').click();
      await page.locator('[name=name]').fill(name);
      await page.locator('[name=host]').fill(host);
      await page.locator('[name=username]').fill(username);
      await page.locator('[name=port]').fill(port);
      await page.locator('#remember-password').check();
      await page.locator('#connect-form button[type=submit]').click();
      await expect(page.locator('#status')).toHaveText(`${username}@${host}`);
    };
    await connect('first');
    // Fractional rows must not add variable blank space below the terminal grid.
    for (const font of [28,14]) {
      await page.evaluate(() => window.terminalAction('settings'));
      if (font === 28) for (let i=0;i<14;i++) await page.locator('#font-plus').click();
      else await page.locator('#font-reset').click();
      await page.locator('[data-close="settings-dialog"]').click();
      for (const size of [{width:1920,height:1030},{width:1280,height:740},{width:1536,height:815},{width:1100,height:700}]) {
        await page.setViewportSize(size);
        await expect(page.locator('.xterm-viewport')).toHaveCSS('background-color','rgb(45, 47, 52)');
        await expect.poll(() => page.evaluate(() => {
          const area=document.getElementById('terminals').getBoundingClientRect();
          const grid=document.querySelector('.xterm-screen').getBoundingClientRect();
          return Math.abs(area.bottom-grid.bottom)<1 && grid.top>=area.top+11;
        })).toBe(true);
      }
    }
    await page.evaluate(() => window.terminalAction('files'));
    const resizer = page.locator('#sftp-resizer');
    const grip = await resizer.boundingBox();
    await page.mouse.move(grip.x+4,grip.y+100); await page.mouse.down();
    await page.mouse.move(grip.x+124,grip.y+100); await page.mouse.up();
    await expect(resizer).toHaveAttribute('aria-valuenow','560');
    expect(await page.evaluate(() => Number(sessionStorage.getItem('sftpWidth')))).toBe(560);
    await page.setViewportSize({width:760,height:700});
    await expect(resizer).toHaveAttribute('aria-valuenow','440');
    await page.setViewportSize({width:1100,height:700});
    await expect(resizer).toHaveAttribute('aria-valuenow','560');
    await resizer.focus(); await page.keyboard.press('Home');
    await expect(resizer).toHaveAttribute('aria-valuenow','300');
    await page.keyboard.press('End');
    await expect(resizer).toHaveAttribute('aria-valuenow','780');
    await resizer.dblclick();
    await expect(resizer).toHaveAttribute('aria-valuenow','440');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(resizer).toHaveAttribute('aria-valuenow','480');
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
    const listCount=()=>page.evaluate(()=>testBridge.calls.filter(m=>m.action==='sftp'&&m.op==='list').length);
    const firstId=await page.locator('#file-server').inputValue(),beforeSwitch=await listCount();
    await connect('duplicate');
    const duplicateId=await page.locator('.tab.selected').getAttribute('data-session');
    await expect(page.locator('#file-server option')).toHaveCount(1);
    await expect(page.locator('#file-server')).toHaveValue(firstId);
    await expect(page.locator('#transfer')).toContainText('传输中');
    expect(await listCount()).toBe(beforeSwitch);
    await connect('second',{username:'Test'});
    await expect(page.locator('#file-server option')).toHaveCount(2);
    await expect(page.locator('#file-server')).toHaveValue(firstId);
    await expect(page.locator('#transfer')).toContainText('传输中');
    expect(await listCount()).toBe(beforeSwitch);
    await page.locator('#files-close').click();await page.evaluate(()=>window.terminalAction('files'));
    expect(await listCount()).toBe(beforeSwitch);
    await page.locator('#file-filter').fill('sample');await expect(page.locator('.file-row')).toHaveCount(1);
    const secondId=await page.locator('.tab.selected').getAttribute('data-session');
    await page.locator('#file-server').selectOption(secondId);await expect(page.locator('#transfer-toggle')).toBeHidden();
    await expect.poll(listCount).toBe(beforeSwitch+1);
    await page.locator('#file-server').selectOption(firstId);await expect(page.locator('#file-filter')).toHaveValue('sample');
    await expect(page.locator('.file-row')).toHaveCount(1);expect(await listCount()).toBe(beforeSwitch+1);
    await page.locator('#file-filter').fill('');
    await page.locator('#transfer-toggle').click();await expect(page.locator('#transfer')).toContainText('已暂停');
    await page.locator('#transfer-toggle').click();await expect(page.locator('#transfer')).toContainText('传输中');
    expect(await page.evaluate(()=>testBridge.download.id)).toBe(firstId);
    console.log('PASS shared SFTP selection, cached listings/filter and resume across terminal/server switches');
    await page.getByRole('tab',{name:'first',exact:true}).click();
    await expect(page.locator('#transfer')).toContainText('25%');
    await page.evaluate(() => { const m=testBridge.download; testBridge.emit({request:m.request,ok:true,result:{success:true}}); });
    await expect(page.locator('#transfer')).toContainText('已完成');
    await page.clock.fastForward(4000);await expect(page.locator('#transfer')).toContainText('已完成');
    await page.clock.fastForward(1100);await expect(page.locator('#transfer')).not.toContainText('已完成');await expect(page.locator('.download-job').filter({hasText:'完成'})).toHaveCount(0);
    await expect(page.locator('#transfer-toggle')).toBeHidden();
    await page.locator('.file-row').filter({hasText:'folder'}).click({button:'right'});
    await expect(page.locator('#file-menu [role=menuitem]').first()).toHaveText('打开文件夹');
    await page.locator('#file-menu').getByText('下载文件夹 / 续传',{exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>testBridge.download.directory)).toBe('yes');
    const folderRequest=await page.evaluate(()=>testBridge.download.request);
    await file.locator('.file-open').click();
    await expect(page.locator('.download-job').filter({hasText:'等待'})).toHaveCount(1);
    expect(await page.evaluate(()=>testBridge.download.request)).toBe(folderRequest);
    await page.locator('#transfer-toggle').click();
    await expect(page.locator('#transfer')).toContainText('已暂停');
    expect(await page.evaluate(()=>testBridge.download.request)).toBe(folderRequest);
    await page.locator('#transfer-toggle').click();
    await expect.poll(()=>page.evaluate(()=>testBridge.download.request)).not.toBe(folderRequest);
    await page.evaluate(()=>{const m=testBridge.download;testBridge.emit({request:m.request,ok:true,result:{success:true}});});
    await expect.poll(()=>page.evaluate(()=>testBridge.download.path)).toBe('/home/test/sample.bin');
    expect(await page.evaluate(()=>testBridge.download.destination)).toBe('C:/fixture/sample.bin');
    await page.clock.fastForward(5100);await expect(page.locator('#transfer')).toContainText('传输中');await expect(page.locator('.download-job').filter({hasText:'完成'})).toHaveCount(0);
    await page.locator('.file-row').filter({hasText:'folder'}).click({button:'right'});
    await page.locator('#file-menu').getByText('下载文件夹 / 续传',{exact:true}).click();
    const pendingFolder=page.locator('.download-job').filter({hasText:'folder'}).filter({hasText:'等待'});
    await expect(pendingFolder).toHaveCount(1);await pendingFolder.getByRole('button',{name:'×',exact:true}).click();
    await expect(page.locator('.download-job').filter({hasText:'等待'})).toHaveCount(0);
    await page.evaluate(()=>{const m=testBridge.download;testBridge.emit({request:m.request,ok:false,error:'fixture interrupted'});});
    await expect(page.locator('.download-job').filter({hasText:'失败'})).toHaveCount(1);
    await page.locator('.download-job').filter({hasText:'失败'}).getByText('继续',{exact:true}).click();
    await expect(page.locator('#transfer')).toContainText('传输中');
    await page.evaluate(()=>{const m=testBridge.download;testBridge.emit({request:m.request,ok:true,result:{success:true}});});
    await expect(page.locator('#transfer')).toContainText('已完成');
    console.log('PASS completed status expires after five seconds without clearing active transfers');
    console.log('PASS folder queue serial ordering, pause holds queue, retry and remove pending task');

    await page.clock.fastForward(5100);
    await file.locator('.file-open').click();
    const stale=await page.evaluate(()=>testBridge.download);
    await page.evaluate(id=>testBridge.emit({type:'exit',id}),stale.id);
    await expect(page.locator('#transfer-toggle')).toBeDisabled();
    await page.locator('#file-reconnect').click();
    await expect(page.locator('#file-reconnect')).toBeHidden();
    await page.locator('#transfer-toggle').click();
    await expect(page.locator('#transfer')).toContainText('传输中');
    const fresh=await page.evaluate(()=>testBridge.download);expect(fresh.id).not.toBe(stale.id);
    await expect(page.locator('#file-server option')).toHaveCount(2);
    await page.evaluate(m=>testBridge.emit({request:m.request,ok:false,error:'late old transfer failure'}),stale);
    await page.clock.fastForward(100);
    await expect(page.locator('#transfer')).toContainText('传输中');
    await page.evaluate(m=>testBridge.emit({request:m.request,ok:false,error:'remote changed'}),fresh);
    await expect(page.locator('#transfer')).toContainText('已中断');
    await page.locator('.download-job').filter({hasText:'失败'}).getByText('覆盖重下',{exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>testBridge.download.restart)).toBe('yes');
    await page.locator('#transfer-toggle').click();await expect(page.locator('#transfer')).toContainText('已暂停');
    await page.locator('#transfer-toggle').click();
    await expect.poll(()=>page.evaluate(()=>testBridge.download.restart)).toBe('no');
    expect(await page.evaluate(()=>testBridge.download.destination)).toBe(fresh.destination);
    await page.evaluate(()=>{const m=testBridge.download;testBridge.emit({request:m.request,ok:true,result:{success:true}});});
    await expect(page.locator('#transfer')).toContainText('已完成');
    console.log('PASS reconnect keeps destination, ignores stale completion and restarts overwrite only once');

    await connect('other-port',{port:'2222'});
    await expect(page.locator('#file-server option')).toHaveCount(3);
    await expect(page.locator('#file-server option').filter({hasText:':2222'})).toHaveCount(1);
    await connect('other-host',{host:'127.0.0.2'});
    await expect(page.locator('#file-server option')).toHaveCount(4);
    await page.locator(`.tab[data-session="${fresh.id}"] .tab-close`).click();await page.locator('#confirm-yes').click();
    await expect(page.locator('#file-server option')).toHaveCount(4);
    await expect(page.locator('#file-server')).toHaveValue(duplicateId);
    console.log('PASS server deduplication preserves transfers and reconnect selection; distinct users/ports/hosts remain selectable, closing a representative keeps its remaining session');

    await page.locator('#files-close').click();
    await expect(page.locator('#file-menu')).toBeHidden();
    await page.reload();
    await page.evaluate(() => window.terminalAction('files'));
    await expect(page.locator('#sftp-resizer')).toHaveAttribute('aria-valuenow','480');
    expect(errors).toEqual([]);
    console.log('PASS SFTP drag, limits, viewport recovery, keyboard resize, reset and persisted width');
    console.log('PASS SFTP right-click/menu dismissal, pause/resume, long transfer, per-session status and directory actions');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode=1; });
