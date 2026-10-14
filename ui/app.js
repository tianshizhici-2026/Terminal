import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import './style.css';

const $ = id => document.getElementById(id);
const bridge = window.chrome?.webview;
const pending = new Map();
let sequence = 0;
function call(action, args = {}) {
  if (!bridge) return Promise.reject(new Error('请在 Terminal 桌面应用中打开。'));
  const request = String(++sequence);
  return new Promise((resolve, reject) => {
    const transfer = action === 'sftp' && ['download','upload'].includes(args.op);
    const timer = transfer ? null : setTimeout(() => { pending.delete(request); reject(new Error('操作超时，请检查连接状态。')); }, 300000);
    pending.set(request, {resolve, reject, timer});
    bridge.postMessage({action, request, ...args});
  });
}
function notify(action, args = {}) { bridge?.postMessage({action, ...args}); }
let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4500); }
function report(error) { toast(error.message || String(error)); }
window.addEventListener('unhandledrejection', e => { e.preventDefault(); report(e.reason); });
const sessions = new Map();
let activeId = null, profiles = [], fontSize = 14, editingProfile = null, connectionEpoch = 0, searchTimer, fileEpoch = 0, filePath = '.';
const fileBusy = new Set();
const current = () => sessions.get(activeId);
const theme = { background:'#2d2f34', foreground:'#edf0f5', cursor:'#d1f0da', cursorAccent:'#2d2f34', selectionBackground:'#445a78', selectionForeground:'#ffffff', selectionInactiveBackground:'#414c5e', black:'#737d8c', red:'#ff7885', green:'#82db70', yellow:'#f5ca57', blue:'#75adff', magenta:'#d18cff', cyan:'#4dd9df', white:'#e0e6ef', brightBlack:'#a5afbf', brightRed:'#ffa0a9', brightGreen:'#adf299', brightYellow:'#ffe293', brightBlue:'#a6caff', brightMagenta:'#e5b5ff', brightCyan:'#96f0ee', brightWhite:'#ffffff' };
const decorations = {matchBackground:'#665320', matchBorder:'#e3bc51', matchOverviewRuler:'#e3bc51', activeMatchBackground:'#3f6652', activeMatchBorder:'#c7f0d4', activeMatchColorOverviewRuler:'#c7f0d4'};
function save(credential) { return call('save', {fontSize, profiles, defaultShell:$('shell').value,...(credential ? {credential} : {})}); }
function updateStatus() {
  const s = current();
  $('status').textContent = s ? (s.state === 'connected' ? (s.kind === 'ssh' ? `${s.connection.username}@${s.connection.host}` : '本地 · ' + s.name) : s.state === 'connecting' ? '正在连接…' : '会话已结束') : '未连接';
  $('session-count').textContent = `${sessions.size} 个会话`;
  $('status-dot').style.background = s?.state === 'offline' ? '#c29684' : '#b1cebc';
}
function renderTabs() {
  $('tabs').replaceChildren();
  for (const s of sessions.values()) {
    const tab = document.createElement('div'); tab.className = `tab ${s.id === activeId ? 'selected' : ''} ${s.state}`;
    const dot = document.createElement('span'); dot.className = 'tab-dot';
    const label = document.createElement('button'); label.className = 'tab-label'; label.textContent = s.name; label.setAttribute('role', 'tab'); label.setAttribute('aria-selected', String(s.id === activeId)); label.title = s.name;
    label.onclick = () => activate(s.id); label.ondblclick = async () => { const name = await askText('重命名终端', s.name); if (name) { s.name = name.slice(0,60); renderTabs(); updateStatus(); } };
    const close = document.createElement('button'); close.className = 'tab-close'; close.textContent = '×'; close.title = '关闭 ' + s.name; close.onclick = () => closeSession(s.id);
    tab.append(dot,label,close); $('tabs').append(tab);
  }
  $('empty').hidden = sessions.size > 0; updateStatus();
}
function fit(s) { if (!s || s.pane.hidden) return; try { s.fit.fit(); } catch {} }
function activate(id) {
  activeId = id;
  for (const s of sessions.values()) s.pane.hidden = s.id !== id;
  renderTabs();
  requestAnimationFrame(() => { fit(current()); current()?.term.focus(); });
  updateFilePanel();
}
async function newSession(connection = null) {
  const id = crypto.randomUUID(), kind = connection ? 'ssh' : 'local';
  const shell = $('shell').value;
  const name = connection?.name || (shell === 'cmd' ? 'CMD' : 'PowerShell');
  const pane = document.createElement('div'); pane.className = 'terminal-pane'; pane.dataset.session = id; $('terminals').append(pane);
  const term = new Terminal({fontFamily:'"JetBrains Mono"',fontSize,fontWeight:'400',fontWeightBold:'500',lineHeight:1.32,letterSpacing:0,cursorBlink:true,cursorStyle:'bar',scrollback:10000,theme,allowProposedApi:true,convertEol:false,overviewRulerWidth:7,minimumContrastRatio:4.5,windowsPty:kind === 'local' ? {backend:'conpty',buildNumber:22621} : undefined});
  const fitter = new FitAddon(), search = new SearchAddon(); term.loadAddon(fitter); term.loadAddon(search);
  const s = {id,kind,name,pane,term,fit:fitter,search,state:'connecting',connection:connection ? {...connection,password:undefined,passphrase:undefined} : null};
  sessions.set(id,s); term.open(pane);
  term.onData(data => { s.search.clearDecorations(); term.clearSelection(); if (s.state === 'connected') notify('input', {id,data}); });
  term.onResize(({cols,rows}) => { if (s.state === 'connected') notify('resize',{id,cols,rows}); });
  term.attachCustomKeyEventHandler(e => {
    if (e.ctrlKey && !e.altKey && ['c','v'].includes(e.key.toLowerCase())) {
      if (e.key.toLowerCase() === 'c' && !term.hasSelection()) return true;
      if (e.type === 'keydown') {
        e.preventDefault();
        if (e.key.toLowerCase() === 'c') call('copy',{text:term.getSelection()}).then(() => toast('已复制')).catch(report);
        else call('paste').then(text => { if (s.state === 'connected') term.paste(text); }).catch(report);
      }
      return false;
    }
    if (e.ctrlKey && (['t','w','k','Tab','0'].includes(e.key) || e.shiftKey && e.key.toLowerCase() === 'f')) return false;
    return true;
  });
  activate(id);
  try {
    await document.fonts.ready; fit(s);
    await call('create',{id,kind,shell,cols:term.cols,rows:term.rows,...connection});
    if (!sessions.has(id)) return;
    if (s.state !== 'offline') s.state = 'connected';
    notify('resize',{id,cols:term.cols,rows:term.rows});
    renderTabs(); if (activeId === id) updateFilePanel();
  } catch (e) { if (sessions.has(id)) { s.state = 'offline'; term.writeln('\r\n\x1b[31m连接失败：' + String(e.message).replace(/[\x00-\x1f\x7f]/g,' ') + '\x1b[0m'); renderTabs(); } report(e); }
}
async function closeSession(id) {
  const s = sessions.get(id); if (!s) return;
  if (s.state !== 'offline' && !await confirmAction('关闭这个终端？','当前终端中的运行任务与连接将结束。')) return;
  sessions.delete(id); notify('close',{id}); s.term.dispose(); s.pane.remove();
  if (activeId === id) activate([...sessions.keys()].at(-1) || null); else renderTabs();
}
function setFont(value) {
  fontSize = Math.max(10,Math.min(28,value)); $('font-size').textContent = fontSize;
  for (const s of sessions.values()) { s.term.options.fontSize = fontSize; fit(s); }
  clearTimeout(setFont.timer); setFont.timer = setTimeout(() => save().catch(report), 200);
}
window.addEventListener('wheel', e => { if (e.shiftKey) { e.preventDefault(); if (e.deltaY || e.deltaX) setFont(fontSize + ((e.deltaY || e.deltaX) < 0 ? 1 : -1)); } }, {passive:false,capture:true});
new ResizeObserver(() => fit(current())).observe($('terminals'));
bridge?.addEventListener('message', ({data:m}) => {
  if (m.request) { const p = pending.get(m.request); if (p) { clearTimeout(p.timer); pending.delete(m.request); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)); } return; }
  const s = sessions.get(m.id);
  if (m.type === 'output' && s) s.term.write(m.data, () => { if ($('search-dialog').open) { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch,180); } });
  if (m.type === 'exit' && s) { s.state = 'offline'; s.term.writeln('\r\n\x1b[90m— 会话已结束 —\x1b[0m'); notify('close',{id:s.id}); renderTabs(); if (activeId === s.id) updateFilePanel(); }
  if (m.type === 'transfer' && s?.transfer) { s.transfer.done = m.done; s.transfer.total = m.total; renderTransfer(); }
  if (m.type === 'error') report(m.error);
});
function renderProfiles() {
  $('profiles').replaceChildren();
  if (!profiles.length) { const hint = document.createElement('div'); hint.className = 'no-profiles'; hint.textContent = '暂无连接'; $('profiles').append(hint); }
  for (const p of profiles) {
    const row = document.createElement('div'); row.className = 'profile';
    const button = document.createElement('button'); button.className = 'profile-main'; button.title = '编辑 / 连接 ' + p.name;
    const name = document.createElement('b'); name.textContent = '⌁  ' + p.name;
    const host = document.createElement('small'); host.textContent = `${p.username}@${p.host}`; button.append(name,host); button.onclick = () => openConnection(p);
    const remove = document.createElement('button'); remove.textContent = '×'; remove.title = '删除配置'; remove.className = 'profile-delete';
    remove.onclick = async () => { if (await confirmAction('删除连接配置？', p.name)) { profiles = profiles.filter(x => x.id !== p.id); renderProfiles(); await save(); } };
    row.append(button,remove); $('profiles').append(row);
  }
}
async function openConnection(profile = null) {
  $('connections-menu').hidePopover();
  const epoch = ++connectionEpoch;
  editingProfile = profile?.id || null; $('connect-form').reset(); $('connect-form').elements.password.disabled = false;
  for (const key of ['name','host','port','username','keyPath']) if (profile?.[key]) $('connect-form').elements[key].value = profile[key];
  $('remember-password').checked = !!profile?.rememberPassword;
  $('auth').value = profile?.keyPath ? 'key' : 'password'; authChanged(); $('connect-dialog').showModal();
  const field = $('connect-form').elements.password;
  if (profile?.rememberPassword && !profile.keyPath) {
    field.disabled = true;
    try { const password = await call('password',{id:profile.id}); if (epoch === connectionEpoch && $('connect-dialog').open && !field.value) field.value = password; }
    catch (e) { report(e); }
    finally { if (epoch === connectionEpoch) field.disabled = false; }
  }
}
function authChanged() { const isKey = $('auth').value === 'key'; $('key-fields').hidden = !isKey; $('password-label').hidden = isKey; $('remember-label').hidden = isKey; }
async function connectionFromForm() {
  if ($('connect-form').elements.password.disabled) return null;
  if (!$('connect-form').reportValidity()) return null;
  const p = Object.fromEntries(new FormData($('connect-form'))); p.port = Number(p.port); p.host = p.host.trim(); p.username = p.username.trim(); p.name = p.name.trim();
  if (!p.host || !p.username || !p.name) { toast('请完整填写连接信息'); return null; }
  if ($('auth').value === 'password') { p.keyPath = ''; p.passphrase = ''; } else { p.password = ''; if (!p.keyPath) { toast('请选择 SSH 私钥'); return null; } }
  const profile = {id:editingProfile || crypto.randomUUID(),name:p.name,host:p.host,port:p.port,username:p.username,keyPath:p.keyPath,rememberPassword:$('auth').value === 'password' && $('remember-password').checked};
  const previous = profiles;
  profiles = profiles.filter(x => x.id !== profile.id); profiles.push(profile);
  try { await save({id:profile.id,rememberPassword:profile.rememberPassword,password:p.password}); renderProfiles(); }
  catch (e) { profiles = previous; report(e); return null; }
  return p;
}
$('auth').onchange = authChanged;
$('choose-key').onclick = async () => { const path = await call('chooseKey'); if (path) $('connect-form').elements.keyPath.value = path; };
$('save-profile').onclick = async () => { if (await connectionFromForm()) { $('connect-dialog').close(); toast('连接配置已保存'); } };
$('connect-form').onsubmit = async e => { e.preventDefault(); const p = await connectionFromForm(); if (p) { $('connect-dialog').close(); newSession(p); } };
$('connect-dialog').addEventListener('close', () => { connectionEpoch++; $('connect-form').elements.password.disabled = false; $('connect-form').elements.password.value = ''; $('connect-form').elements.passphrase.value = ''; });
function openSearch() { $('search-dialog').showModal(); $('search-input').focus(); runSearch(); }
function runSearch() {
  const query = $('search-input').value, sensitive = $('case-sensitive').checked;
  $('search-results').replaceChildren();
  let count = 0;
  for (const s of sessions.values()) {
    s.search.clearDecorations();
    if (!query) continue;
    s.search.findNext(query,{caseSensitive:sensitive,incremental:true,decorations});
    const buffer = s.term.buffer.active;
    for (let i = 0; i < buffer.length; i++) {
      const start = i; let text = buffer.getLine(i)?.translateToString(false) || '';
      while (i + 1 < buffer.length && buffer.getLine(i + 1)?.isWrapped) { text += buffer.getLine(++i)?.translateToString(false) || ''; }
      text = text.trimEnd();
      const haystack = sensitive ? text : text.toLowerCase(), needle = sensitive ? query : query.toLowerCase();
      let index = haystack.indexOf(needle); if (index < 0) continue;
      count++;
      if (count > 200) continue;
      const button = document.createElement('button'); button.className = 'search-result';
      const label = document.createElement('small'); label.textContent = `${s.name}  /  第 ${start + 1} 行`;
      const content = document.createElement('p'); let cursor = 0;
      while (index >= 0) { content.append(document.createTextNode(text.slice(cursor,index))); const mark = document.createElement('mark'); mark.textContent = text.slice(index,index+query.length); content.append(mark); cursor = index + query.length; index = haystack.indexOf(needle,cursor); }
      content.append(document.createTextNode(text.slice(cursor))); button.append(label,content);
      const firstMatch = haystack.indexOf(needle);
      button.onclick = () => { activate(s.id); $('search-dialog').close(); requestAnimationFrame(() => {
        let offset = 0, begin = null, end = null;
        for (let row = start; row <= i && end === null; row++) {
          const line = buffer.getLine(row);
          for (let col = 0; col < s.term.cols; col++) {
            const cell = line.getCell(col); if (!cell || cell.getWidth() === 0) continue;
            const chars = cell.getChars() || ' ';
            if (begin === null && offset + chars.length > firstMatch) begin = (row-start)*s.term.cols+col;
            offset += chars.length;
            if (begin !== null && offset >= firstMatch+query.length) { end = (row-start)*s.term.cols+col+cell.getWidth(); break; }
          }
        }
        if (begin !== null && end !== null) s.term.select(begin%s.term.cols,start+Math.floor(begin/s.term.cols),end-begin);
        s.term.scrollToLine(Math.max(0,start-3)); s.term.focus();
      }); };
      $('search-results').append(button);
    }
  }
  $('search-summary').textContent = query ? `${count} 行匹配 · ${sessions.size} 个终端${count > 200 ? ' · 显示前 200 行' : ''}` : '输入关键词，即刻查找';
  if (!query || !count) { const hint = document.createElement('p'); hint.className = 'search-empty'; hint.textContent = query ? '没有匹配的内容，试试其他关键词。' : '输入关键词'; $('search-results').append(hint); }
}
$('search-input').oninput = () => { $('search-results').replaceChildren(); clearTimeout(searchTimer); searchTimer = setTimeout(runSearch,100); };
$('case-sensitive').onchange = runSearch;
function formatSize(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/1048576).toFixed(1)} MB`; }
function updateFilePanel() {
  $('file-menu').hidePopover();
  const s = current(), available = s?.kind === 'ssh' && s.state === 'connected';
  fileEpoch++; $('files-hint').hidden = available; $('files-content').hidden = !available;
  renderTransfer();
  if (!$('files').hidden && available) loadFiles(s.remotePath || '.');
}
function renderTransfer() {
  const s = current(), t = s?.transfer;
  $('transfer-toggle').hidden = !t || t.op !== 'download' || !['running','pausing','paused','failed'].includes(t.state);
  $('transfer-toggle').disabled = t?.state === 'pausing' || s?.state !== 'connected';
  $('transfer-toggle').textContent = ['paused','failed'].includes(t?.state) ? '继续' : t?.state === 'pausing' ? '暂停中…' : '暂停';
  if (!t) { $('transfer').textContent = s?.fileSummary || ''; return; }
  const label = {running:'传输中',pausing:'暂停中',paused:'已暂停',failed:'已中断',completed:'已完成'}[t.state];
  $('transfer').textContent = `${label} · ${t.name}${t.total != null ? ` · ${t.total ? Math.round(t.done/t.total*100) : 100}%` : ''}`;
  $('transfer').title = t.error || (t.done != null ? `${formatSize(t.done)} / ${formatSize(t.total)}` : t.name);
}
$('transfer-toggle').onclick = async () => {
  const s = current(), t = s?.transfer;
  if (!t) return;
  if (t.state === 'running') { t.state = 'pausing'; renderTransfer(); try { await call('pauseDownload',{id:s.id}); } catch(e) { report(e); } }
  else if (['paused','failed'].includes(t.state)) fileAction('download',{path:t.path,resume:'yes'});
};
function openFileMenu(entry, id, row, x, y) {
  const menu = $('file-menu'); menu.replaceChildren();
  const add = (label, action) => {
    const button = document.createElement('button'); button.role = 'menuitem'; button.textContent = label;
    button.onclick = () => { menu.hidePopover(); if (activeId === id) action(); };
    menu.append(button);
  };
  add(entry.directory ? '打开文件夹' : '下载 / 续传', () => entry.directory ? loadFiles(entry.path) : fileAction('download',{path:entry.path}));
  add('重命名', async () => { const name = await askText('重命名',entry.name); if (activeId === id && name && validFileName(name)) fileAction('rename',{path:entry.path,destination:entry.path.slice(0,entry.path.lastIndexOf('/')+1)+name}); });
  menu.showPopover();
  const bounds = row.getBoundingClientRect();
  menu.style.left = Math.max(6,Math.min(x ?? bounds.right-160,innerWidth-menu.offsetWidth-6))+'px';
  menu.style.top = Math.max(6,Math.min(y ?? bounds.bottom,innerHeight-menu.offsetHeight-6))+'px';
  menu.firstElementChild.focus();
}
$('file-menu').onkeydown = e => {
  if (!['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
  e.preventDefault(); const buttons = [...$('file-menu').children], index = buttons.indexOf(document.activeElement);
  buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length-1 : (index+(e.key === 'ArrowDown' ? 1 : buttons.length-1))%buttons.length]?.focus();
};
async function loadFiles(path) {
  $('file-menu').hidePopover();
  const id = activeId, epoch = ++fileEpoch;
  if (current()) current().fileSummary = '读取目录…'; renderTransfer();
  try {
    const result = await call('sftp',{id,op:'list',path});
    if (activeId !== id || epoch !== fileEpoch) return;
    filePath = result.path; current().remotePath = filePath; $('remote-path').value = filePath; $('file-list').replaceChildren(); current().fileSummary = `${result.entries.length} 个项目`; renderTransfer();
    for (const entry of result.entries) {
      const row = document.createElement('div'); row.className = 'file-row';
      const open = document.createElement('button'); open.className = 'file-open'; open.title = entry.directory ? '打开目录' : '下载 ' + entry.name;
      const icon = document.createElement('span'); icon.textContent = entry.directory ? '▱' : '≡';
      const name = document.createElement('b'); name.textContent = entry.name; open.append(icon,name);
      open.onclick = () => entry.directory ? loadFiles(entry.path) : fileAction('download',{path:entry.path});
      const size = document.createElement('small'); size.textContent = entry.directory ? '' : formatSize(entry.size);
      const rename = document.createElement('button'); rename.className = 'file-rename'; rename.textContent = '⋯'; rename.title = '文件操作'; rename.setAttribute('aria-haspopup','menu');
      rename.onclick = () => openFileMenu(entry,id,row);
      row.oncontextmenu = e => { e.preventDefault(); openFileMenu(entry,id,row,e.clientX,e.clientY); };
      row.append(open,size,rename); $('file-list').append(row);
    }
  } catch (e) { if (activeId === id && epoch === fileEpoch) { current().fileSummary = '读取失败：' + e.message; renderTransfer(); $('file-list').replaceChildren(); } }
}
function validFileName(name) { if (!name || name === '.' || name === '..' || /[/\\\x00]/.test(name)) { toast('名称不能包含路径分隔符'); return false; } return true; }
async function fileAction(op,args) {
  const id = activeId, s = current();
  if (!s || s.state !== 'connected') return;
  if (fileBusy.has(id)) { toast('请等待当前传输完成'); return; }
  const path = filePath, previous = s.transfer, isTransfer = ['download','upload'].includes(op);
  fileBusy.add(id);
  if (isTransfer) s.transfer = {op,path:args.path,name:args.path.split('/').at(-1),state:'running'};
  renderTransfer();
  try {
    const result = await call('sftp',{id,op,...args});
    if (result?.cancelled) s.transfer = previous;
    else if (result?.paused) s.transfer.state = 'paused';
    else { if (isTransfer) s.transfer.state = 'completed'; toast('文件操作已完成'); }
    if (activeId === id && !result?.paused && !result?.cancelled && op !== 'download') await loadFiles(path);
  }
  catch (e) { if (isTransfer) { s.transfer.state = 'failed'; s.transfer.error = e.message; } report(e); }
  finally { fileBusy.delete(id); renderTransfer(); }
}
function toggleFiles() { $('file-menu').hidePopover(); $('files').hidden = !$('files').hidden; updateFilePanel(); }
$('files-close').onclick = () => { $('file-menu').hidePopover(); $('files').hidden = true; fileEpoch++; };
$('path-form').onsubmit = e => { e.preventDefault(); loadFiles($('remote-path').value); };
$('parent-dir').onclick = () => loadFiles(filePath.replace(/\/[^/]+\/?$/,'') || '/');
$('refresh').onclick = () => loadFiles(filePath);
$('upload').onclick = () => fileAction('upload',{path:filePath});
$('mkdir').onclick = async () => { const name = await askText('新建远程文件夹',''); if (name && validFileName(name)) fileAction('mkdir',{path:filePath.replace(/\/$/,'')+'/'+name}); };
function askText(title,value) { return new Promise(resolve => { $('text-title').textContent = title; $('text-value').value = value; let answer = null; $('text-form').onsubmit = e => { e.preventDefault(); answer = $('text-value').value.trim(); $('text-dialog').close(); }; $('text-dialog').addEventListener('close',() => resolve(answer),{once:true}); $('text-dialog').showModal(); $('text-value').select(); }); }
function confirmAction(title,message) { return new Promise(resolve => { $('confirm-title').textContent = title; $('confirm-message').textContent = message; let answer = false; $('confirm-yes').onclick = () => { answer = true; $('confirm-dialog').close(); }; $('confirm-no').onclick = () => $('confirm-dialog').close(); $('confirm-dialog').addEventListener('close',() => resolve(answer),{once:true}); $('confirm-dialog').showModal(); }); }
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => $(b.dataset.close).close());
function openConnections() { $('connections-menu').togglePopover(); }
window.terminalAction = action => {
  $('file-menu').hidePopover();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  if (action !== 'connections') $('connections-menu').hidePopover();
  if (action === 'connections') openConnections();
  else if (action === 'search') openSearch();
  else if (action === 'files') toggleFiles();
  else if (action === 'settings') $('settings-dialog').showModal();
  else if (action === 'help') $('help-dialog').showModal();
};
$('new-local').onclick = () => { $('connections-menu').hidePopover(); newSession(); };
for (const id of ['tab-plus','empty-new']) $(id).onclick = openConnections;
for (const id of ['new-ssh','add-profile']) $(id).onclick = () => openConnection();
$('font-reset').onclick = () => setFont(14);
$('font-minus').onclick = () => setFont(fontSize-1);
$('font-plus').onclick = () => setFont(fontSize+1);
$('shell').onchange = () => save().catch(report);
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { for (const s of sessions.values()) { s.search.clearDecorations(); s.term.clearSelection(); } }
  if (!e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  const key = e.key.toLowerCase();
  if (key === 'k' || e.shiftKey && key === 'f') { e.preventDefault(); openSearch(); }
  else if (key === 't') { e.preventDefault(); openConnections(); }
  else if (key === 'w') { e.preventDefault(); if (activeId) closeSession(activeId); }
  else if (key === '0') { e.preventDefault(); setFont(14); }
  else if (key === 'tab') { e.preventDefault(); const ids = [...sessions.keys()]; if (ids.length) activate(ids[(ids.indexOf(activeId)+(e.shiftKey ? ids.length-1 : 1)) % ids.length]); }
},true);
async function init() {
  try { const settings = await call('load'); profiles = Array.isArray(settings.profiles) ? settings.profiles : []; fontSize = Math.max(10,Math.min(28,settings.fontSize || 14)); $('font-size').textContent = fontSize; $('shell').value = settings.defaultShell === 'cmd' ? 'cmd' : 'powershell'; renderProfiles(); renderTabs(); }
  catch (e) { report(e); renderProfiles(); }
}
init();
