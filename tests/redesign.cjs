const {chromium,expect}=require('@playwright/test');
(async()=>{
 const browser=await chromium.connectOverCDP('http://127.0.0.1:9224');const page=browser.contexts()[0].pages()[0];
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await expect(page).toHaveTitle('Terminal');await expect(page.locator('.sidebar')).toHaveCount(0);await expect(page.locator('header,footer')).toHaveCount(0);await expect(page.locator('.tab')).toHaveCount(0);
 const layout=await page.evaluate(()=>({body:innerHeight,terminal:document.getElementById('terminals').getBoundingClientRect().height}));if(layout.terminal/layout.body<.93)throw Error('Terminal area too small');
 await page.evaluate(()=>window.terminalAction('connections'));await expect(page.locator('#connections-menu')).toBeVisible();await expect(page.locator('#new-ssh')).toBeHidden();await page.locator('#new-menu summary').click();await expect(page.locator('#new-ssh')).toBeVisible();await page.locator('#new-ssh').click();await expect(page.locator('#connect-dialog')).toBeVisible();await expect(page.locator('#connections-menu')).toBeHidden();await page.locator('[data-close="connect-dialog"]').click();
 await page.evaluate(()=>window.terminalAction('settings'));await expect(page.locator('#settings-dialog')).toBeVisible();await page.locator('#font-plus').click();await expect(page.locator('#font-size')).toHaveText('15');await page.locator('#font-reset').click();await expect(page.locator('#font-size')).toHaveText('14');await page.locator('[data-close="settings-dialog"]').click();
 await page.evaluate(()=>window.terminalAction('search'));await expect(page.locator('#search-dialog')).toBeVisible();await page.keyboard.press('Escape');await page.evaluate(()=>window.terminalAction('help'));await expect(page.locator('#help-dialog')).toBeVisible();await page.keyboard.press('Escape');
 await page.evaluate(()=>window.terminalAction('files'));await expect(page.locator('#files')).toBeVisible();await page.locator('#files-close').click();
 if(errors.length)throw Error(errors.join('\n'));console.log('PASS minimal layout, SSH-first startup, nested connection menu, settings, search, help and SFTP panels');await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
