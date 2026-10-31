import { setupSnippetSort } from './snippet-sort';
import { keepCursorBlinking } from './cursor';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import './style.css';
import { setupSftpResize } from './sftp-resize';
import { setupSnippets } from './snippets';
import { setupDownloadQueue } from './download-queue';
import { setupFileFilter } from './file-filter';
import { setupUpdates } from './updates';

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
function toast(message, duration=4500) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), duration); }
function report(error) { toast(error.message || String(error)); }
window.addEventListener('unhandledrejection', e => { e.preventDefault(); report(e.reason); });
const sessions = new Map();
let activeId = null, profiles = [], fontSize = 14, editingProfile = null, connectionEpoch = 0, searchTimer, filePath = '.';
const fileBusy = new Set();
const current = () => sessions.get(activeId);
let fileSession=null, displayedFileSession=null;
const fileServers=new Map();
const fileServerKey=s=>JSON.stringify([s.connection.username,s.connection.host.trim().toLowerCase(),Number(s.connection.port)||22]);
const fileCurrent=()=>fileSession && sessions.get(fileSession.id)===fileSession ? fileSession : null;
const fonts = {'JetBrains Mono':'"JetBrains Mono"','Consolas':'Consolas','SimHei':'SimHei, "黑体"','FangSong':'FangSong, "仿宋"'};
let fontFamily = 'JetBrains Mono';
const theme = { background:'#2d2f34', foreground:'#edf0f5', cursor:'#d1f0da', cursorAccent:'#2d2f34', selectionBackground:'#445a78', selectionForeground:'#ffffff', selectionInactiveBackground:'#414c5e', black:'#737d8c', red:'#ff7885', green:'#82db70', yellow:'#f5ca57', blue:'#75adff', magenta:'#d18cff', cyan:'#4dd9df', white:'#e0e6ef', brightBlack:'#a5afbf', brightRed:'#ffa0a9', brightGreen:'#adf299', brightYellow:'#ffe293', brightBlue:'#a6caff', brightMagenta:'#e5b5ff', brightCyan:'#96f0ee', brightWhite:'#ffffff' };
const decorations = {matchBackground:'#665320', matchBorder:'#e3bc51', matchOverviewRuler:'#e3bc51', activeMatchBackground:'#3f6652', activeMatchBorder:'#c7f0d4', activeMatchColorOverviewRuler:'#c7f0d4'};
const sftpSize = setupSftpResize($('files'), () => save().catch(report));
const snippets = setupSnippets({paste:text=>pasteText(current(),text),execute:text=>executeSnippet(current(),text),save:()=>save(),confirm:confirmAction,report});
const updates = setupUpdates({call,bridge,report});
function save(credential) { return call('save', {fontSize, fontFamily, snippets:snippets.items, sftpWidth:sftpSize.width, profiles, defaultShell:$('shell').value,...(credential ? {credential} : {})}); }
async function copySelection(s, quiet=false) {
  const text=s?.term.getSelection(), version=s?.selectionVersion;
  if(!text)return;
  await call('copy',{text});
  if(sessions.get(s.id)===s && s.selectionVersion===version && !s.selectionDragging){
    s.term.clearSelection();
    if(activeId===s.id)focusTerminal();
  }
  if(!quiet)toast('已复制');
}
function pasteText(s,text) { if(s?.state!=='connected'){toast('请先连接终端');return;} s.term.paste(text);s.term.focus(); }
function executeSnippet(s,text) {
  if(s?.state!=='connected'){toast('请先连接终端');return;}
  s.term.paste(text.replace(/[\r\n]+$/, ''));
  s.term.input('\r',true);s.term.focus();
}
async function pasteClipboard(s) { const text=await call('paste');if(sessions.has(s.id))pasteText(s,text); }
function focusTerminal() { if(!document.querySelector('dialog[open]') && !document.activeElement?.matches('input,textarea:not(.xterm-helper-textarea),select')) current()?.term.focus(); }
window.addEventListener('focus',()=>requestAnimationFrame(focusTerminal));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)requestAnimationFrame(focusTerminal);});
function updateStatus() {
  const s = current();
  $('status').textContent = s ? (s.state === 'connected' ? (s.kind === 'ssh' ? `${s.connection.username}@${s.connection.host}` : '本地 · ' + s.name) : s.state === 'connecting' ? '正在连接…' : '会话已结束') : '未连接';
  $('session-count').textContent = `${sessions.size} 个会话`;
  $('status-dot').style.background = s?.state === 'offline' ? '#ff7885' : '#b1cebc';
}
setupSnippetSort($('tabs'),{axis:'x',rowSelector:'.tab',ignoreSelector:'.tab-close',idKey:'session',restore:renderTabs,commit:ids=>{
  if(ids.length!==sessions.size || new Set(ids).size!==sessions.size || ids.some(id=>!sessions.has(id))){renderTabs();return;}
  const ordered=ids.map(id=>[id,sessions.get(id)]);sessions.clear();for(const [id,s] of ordered)sessions.set(id,s);
  renderTabs();focusTerminal();
}});
function renderTabs() {
  $('tabs').replaceChildren();
  for (const s of sessions.values()) {
    const tab = document.createElement('div'); tab.dataset.session=s.id; tab.className = `tab ${s.id === activeId ? 'selected' : ''} ${s.state}`;
    const dot = document.createElement('span'); dot.className = 'tab-dot'; dot.title=s.state==='offline'?'已断开':s.state==='connecting'?'正在连接':'已连接';
    const label = document.createElement('button'); label.className = 'tab-label'; label.textContent = s.name; label.setAttribute('role', 'tab'); label.setAttribute('aria-selected', String(s.id === activeId)); label.title = s.name;
    label.onclick = () => activate(s.id); label.ondblclick = async () => { const name = await askText('重命名终端', s.name); if (name) { s.name = name.slice(0,60); renderTabs(); updateStatus(); } };
    const close = document.createElement('button'); close.className = 'tab-close'; close.textContent = '×'; close.title = '关闭 ' + s.name; close.onclick = () => closeSession(s.id);
    tab.append(dot,label,close); $('tabs').append(tab);
    tab.oncontextmenu=e=>{e.preventDefault();showSessionMenu(s,e.clientX,e.clientY);};
  }
  $('empty').hidden = sessions.size > 0; updateStatus();
}
function fit(s) {
  if (!s || s.pane.hidden) return;
  try {
    const dimensions=s.fit.proposeDimensions();
    // Keep a full spare cell for glyph overhang and scrollbar rounding at fractional DPI.
    if(dimensions) s.term.resize(Math.max(2,dimensions.cols-1),dimensions.rows);
  } catch {}
}
function activate(id) {
  activeId = id;
  for (const s of sessions.values()) s.pane.hidden = s.id !== id;
  renderTabs();
  requestAnimationFrame(() => { fit(current()); current()?.term.focus(); });
  updateFilePanel();
}
async function newSession(connection = null, replaceId = null, localShell = null) {
  if(replaceId)return reconnectSession(sessions.get(replaceId),connection);
  const id = crypto.randomUUID(), kind = connection ? 'ssh' : 'local';
  const shell = localShell || $('shell').value;
  const name = connection?.name || (shell === 'cmd' ? 'CMD' : 'PowerShell');
  const pane = document.createElement('div'); pane.className = 'terminal-pane'; pane.dataset.session = id; $('terminals').append(pane);
  const term = new Terminal({fontFamily:fonts[fontFamily],fontSize,fontWeight:'400',fontWeightBold:fontFamily==='JetBrains Mono'?'500':'700',lineHeight:1.32,letterSpacing:0,cursorBlink:true,cursorStyle:'bar',scrollback:10000,theme,allowProposedApi:true,convertEol:false,overviewRuler:{width:7},minimumContrastRatio:4.5,windowsPty:kind === 'local' ? {backend:'conpty',buildNumber:22621} : undefined});
  keepCursorBlinking(term);
  const fitter = new FitAddon(), search = new SearchAddon(); term.loadAddon(fitter); term.loadAddon(search);
  const s = {id,kind,name,shell,pane,term,fit:fitter,search,state:'connecting',connection:connection ? {...connection,password:undefined,passphrase:undefined} : null};

  sessions.set(id,s); term.open(pane);
  s.selectionVersion=0;
  term.onSelectionChange(()=>{s.selectionVersion++;});
  pane.addEventListener('pointerdown',e=>{if(e.button===0){s.selectionDragging=true;}},true);
  for(const event of ['pointerdown','mousedown','mouseup']) pane.addEventListener(event,e=>{if(e.button===2){e.preventDefault();e.stopImmediatePropagation();}},true);
  pane.addEventListener('contextmenu',e=>{e.preventDefault();e.stopImmediatePropagation();if(term.hasSelection())copySelection(s).catch(report);else if(!e.shiftKey)pasteClipboard(s).catch(report);},true);
  term.onData(data => { s.search.clearDecorations(); term.clearSelection(); if (s.state === 'connected') notify('input', {id:s.id,data}); });
  term.onResize(({cols,rows}) => { if (s.state === 'connected') notify('resize',{id:s.id,cols,rows}); });
  term.attachCustomKeyEventHandler(e => {
    const clipboardKey = e.code === 'KeyC' ? 'c' : e.code === 'KeyV' ? 'v' : e.key.toLowerCase();
    if (e.ctrlKey && !e.altKey && ['c','v'].includes(clipboardKey) && (!e.isComposing || clipboardKey === 'c' && term.hasSelection())) {
      if (clipboardKey === 'c' && !term.hasSelection()) return !e.shiftKey;
      if (e.type === 'keydown') {
        e.preventDefault();
        if (clipboardKey === 'c') copySelection(s).catch(report);
        else pasteClipboard(s).catch(report);
      }
      return false;
    }
    if(e.isComposing || e.keyCode===229 || e.key==='Process' || e.key==='Shift') return true;
    if (e.ctrlKey && (['t','w','k','Tab','0'].includes(e.key) || e.shiftKey && e.key.toLowerCase() === 'f')) return false;
    return true;
  });
  activate(id);
  try {
    await document.fonts.ready; fit(s);
    await call('create',{id,kind,shell,cols:term.cols,rows:term.rows,...connection});
    if (!sessions.has(id)) return;
    if (s.state !== 'offline') s.state = 'connected';
    const profile=profiles.find(p=>p.id===connection?.profileId);
    if(profile && s.state==='connected'){profile.lastUsed=Date.now();renderProfiles();save().catch(report);}
    notify('resize',{id,cols:term.cols,rows:term.rows});
    renderTabs(); updateFilePanel(); downloadQueue.pump(s);
  } catch (e) { if (sessions.has(id)) { s.state = 'offline'; term.writeln('\r\n\x1b[31m连接失败：' + String(e.message).replace(/[\x00-\x1f\x7f]/g,' ') + '\x1b[0m'); renderTabs();updateFilePanel(); } report(e); }
}
async function reconnectSession(s, connection) {
  if(!s || s.state==='connecting')return;
  const oldId=s.id, id=crypto.randomUUID(), wasActive=activeId===oldId;
  const order=[...sessions.entries()];
  downloadQueue.invalidate(s);
  s.fileEpoch=(s.fileEpoch||0)+1;s.fileLoading=false;
  s.id=id;s.state='connecting';s.pane.dataset.session=id;
  if(connection)s.connection={...connection,password:undefined,passphrase:undefined};
  sessions.clear();for(const [key,value] of order)sessions.set(key===oldId?id:key,value);
  if(wasActive)activeId=id;
  renderTabs();updateFilePanel();
  try {
    await call('close',{id:oldId});
    if(!sessions.has(id))return;
    const viewport=s.term.buffer.active.viewportY, atBottom=viewport===s.term.buffer.active.baseY;
    await new Promise(resolve=>s.term.write((s.term.buffer.active.type==='alternate'?'\x1b[?1049l':'')+'\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[0m\r\n',()=>{if(atBottom)s.term.scrollToBottom();else s.term.scrollToLine(viewport);resolve();}));
    await call('create',{id,kind:s.kind,shell:s.shell,cols:s.term.cols,rows:s.term.rows,...connection});
    if(!sessions.has(id))return;
    if(s.state!=='offline')s.state='connected';
    notify('resize',{id,cols:s.term.cols,rows:s.term.rows});
    renderTabs();updateFilePanel();if(activeId===id)s.term.focus();downloadQueue.pump(s);
  } catch(e) {
    if(sessions.has(id)){s.state='offline';s.term.writeln('\r\n连接失败：'+String(e.message).replace(/[\x00-\x1f\x7f]/g,' '));renderTabs();updateFilePanel();}
    report(e);
  }
}
async function closeSession(id) {
  const s = sessions.get(id); if (!s) return;
  if (s.state !== 'offline' && !await confirmAction('关闭这个终端？','当前终端中的运行任务与连接将结束。')) return;
  downloadQueue.invalidate(s);sessions.delete(id); notify('close',{id}); s.term.dispose(); s.pane.remove();
  if (activeId === id) activate([...sessions.keys()].at(-1) || null); else {renderTabs();updateFilePanel();}
}
function setFont(value) {
  fontSize = Math.max(10,Math.min(28,value)); $('font-size').textContent = fontSize;
  for (const s of sessions.values()) { s.term.options.fontSize = fontSize; fit(s); }
  clearTimeout(setFont.timer); setFont.timer = setTimeout(() => save().catch(report), 200);
}
for(const event of ['pointerup','pointercancel'])window.addEventListener(event,()=>{for(const s of sessions.values())if(s.selectionDragging){s.selectionDragging=false;}});
window.addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); if (e.deltaY || e.deltaX) setFont(fontSize + ((e.deltaY || e.deltaX) < 0 ? 1 : -1)); } }, {passive:false,capture:true});
new ResizeObserver(() => fit(current())).observe($('terminals'));
window.addEventListener('resize',()=>{if(innerWidth<1100 && !$('files').hidden && !$('snippets').hidden)$('files').hidden=true;});
bridge?.addEventListener('message', ({data:m}) => {
  if (m.request) { const p = pending.get(m.request); if (p) { clearTimeout(p.timer); pending.delete(m.request); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)); } return; }
  const s = sessions.get(m.id);
  if (m.type === 'output' && s) s.term.write(m.data, () => { if ($('search-dialog').open) { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch,180); } });
  if (m.type === 'exit' && s && s.state !== 'offline') { s.state = 'offline'; downloadQueue.invalidate(s); s.term.writeln('\r\n\x1b[90m— 会话已结束 —\x1b[0m'); notify('close',{id:s.id}); renderTabs(); updateFilePanel(); }
  if (m.type === 'transfer' && s?.transfer && (!m.transferId || s.transfer.attempt===m.transferId)) { s.transfer.done = m.done; s.transfer.total = m.total; renderTransfer(); }
  if (m.type === 'error') report(m.error);
});
function orderedProfiles() {
  return profiles.some(p=>Number.isFinite(p.sortOrder))
    ? [...profiles].sort((a,b)=>(a.sortOrder??Number.MAX_SAFE_INTEGER)-(b.sortOrder??Number.MAX_SAFE_INTEGER))
    : [...profiles].reverse().sort((a,b)=>(b.lastUsed||0)-(a.lastUsed||0));
}
async function reorderProfiles(ids) {
  const ordered=orderedProfiles(), visible=new Set(ids), old=profiles;
  const next=[...ids.map(id=>ordered.find(p=>p.id===id)),...ordered.filter(p=>!visible.has(p.id))];
  if(next.length!==profiles.length || next.some(p=>!p))return;
  profiles=next.map((p,index)=>({...p,sortOrder:index}));
  try{await save();renderProfiles();}catch(e){profiles=old;renderProfiles();report(e);}
}
for(const id of ['profiles','recent-profiles'])setupSnippetSort($(id),{commit:reorderProfiles,restore:renderProfiles,rowSelector:'.profile',ignoreSelector:'.profile-connect',idKey:'profile'});
function renderProfiles() {
  $('profiles').replaceChildren();
  $('recent-profiles').replaceChildren();
  if (!profiles.length) { const hint = document.createElement('div'); hint.className = 'no-profiles'; hint.textContent = '暂无连接'; $('profiles').append(hint); }
  const ordered=orderedProfiles();
  for (const [index,p] of ordered.entries()) {
    const makeRow=()=>{
    const row = document.createElement('div'); row.className = 'profile'; row.dataset.profile=p.id;
    const button = document.createElement('button'); button.className = 'profile-main'; button.title = '编辑 / 连接 ' + p.name;
    const name = document.createElement('b'); name.textContent = '⌁  ' + p.name;
    const host = document.createElement('small'); host.textContent = `${p.username}@${p.host}`; button.append(name,host); button.onclick = () => openConnection(p);
    const connect = document.createElement('button'); connect.textContent = '连接'; connect.title = '连接 '+p.name; connect.className = 'profile-connect';
    connect.onclick=()=>connectProfile(p).catch(report);
    row.append(button,connect);return row;
    };
    $('profiles').append(makeRow());if(index<8)$('recent-profiles').append(makeRow());
  }
}
const profileOpening=new Set();
function requestSecret(profile) {
  return new Promise(resolve=>{
    const dialog=$('quick-auth-dialog'), input=$('quick-secret');
    $('quick-auth-title').textContent=profile.name || profile.host;
    $('quick-auth-label').textContent=profile.keyPath?'私钥口令（可留空）':'密码';input.value='';let answer=null;
    $('quick-auth-form').onsubmit=e=>{e.preventDefault();answer=input.value;dialog.close();};
    dialog.addEventListener('close',()=>{input.value='';resolve(answer);},{once:true});dialog.showModal();input.focus();
  });
}
async function credentialsFor(profile) {
  const {id,rememberPassword,lastUsed,sortOrder,...data}=profile;
  const connection={...data,profileId:profile.profileId || id};
  if(profile.keyPath) { const secret=await requestSecret(profile);if(secret===null)return null;connection.passphrase=secret; }
  else if(rememberPassword) connection.password=await call('password',{id});
  else { const secret=await requestSecret(profile);if(secret===null)return null;connection.password=secret; }
  return connection;
}
async function connectProfile(profile,replaceId=null) {
  const key=replaceId || profile.id || profile.host;
  if(profileOpening.has(key) || $('quick-auth-dialog').open)return;
  profileOpening.add(key);$('connections-menu').hidePopover();
  try { const connection=await credentialsFor(profile);if(connection)await newSession(connection,replaceId); }
  finally {profileOpening.delete(key);}
}
async function repeatSession(s,replace=false) {
  if(!sessions.has(s.id) || s.state==='connecting')return;
  if(replace && s.state==='connected' && !await confirmAction('重新连接？','当前连接和正在运行的任务将结束。'))return;
  if(s.kind==='local')return newSession(null,replace?s.id:null,s.shell);
  const profile=profiles.find(p=>p.id===s.connection.profileId) || s.connection;
  await connectProfile(profile,replace?s.id:null);
}
function showSessionMenu(s,x,y) {
  const menu=$('session-menu');menu.replaceChildren();
  for(const [label,action] of [['复制会话',()=>repeatSession(s)],['复制连接信息',()=>call('copy',{text:s.kind==='ssh'?`${s.connection.username}@${s.connection.host}:${s.connection.port||22}`:s.shell})],['重新连接',()=>repeatSession(s,true)],['关闭',()=>closeSession(s.id)]]) {
    const button=document.createElement('button');button.role='menuitem';button.textContent=label;
    button.onclick=()=>{menu.hidePopover();Promise.resolve(action()).catch(report);};menu.append(button);
  }
  menu.showPopover();menu.style.left=Math.max(6,Math.min(x,innerWidth-menu.offsetWidth-6))+'px';menu.style.top=Math.max(6,Math.min(y,innerHeight-menu.offsetHeight-6))+'px';menu.firstElementChild.focus();
}
$('session-menu').onkeydown=e=>{
  if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();
  const buttons=[...$('session-menu').children],i=buttons.indexOf(document.activeElement);
  buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();
};
async function openConnection(profile = null) {
  $('connections-menu').hidePopover();
  const epoch = ++connectionEpoch;
  editingProfile = profile?.id || null; $('connect-form').reset(); $('connect-form').elements.password.disabled = false;
  $('delete-profile').hidden=!profile;
  for (const key of ['name','host','port','username','keyPath','initialDirectory']) if (profile?.[key]) $('connect-form').elements[key].value = profile[key];
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
  const profile = {id:editingProfile || crypto.randomUUID(),name:p.name,host:p.host,port:p.port,username:p.username,keyPath:p.keyPath,initialDirectory:p.initialDirectory,rememberPassword:$('auth').value === 'password' && $('remember-password').checked,lastUsed:profiles.find(x=>x.id===editingProfile)?.lastUsed||0};
  const previous = profiles;
  if(profiles.some(p=>Number.isFinite(p.sortOrder)))profile.sortOrder=profiles.find(p=>p.id===profile.id)?.sortOrder ?? Math.max(-1,...profiles.map(p=>p.sortOrder??-1))+1;
  profiles = profiles.filter(x => x.id !== profile.id); profiles.push(profile);
  try { await save({id:profile.id,rememberPassword:profile.rememberPassword,password:p.password}); renderProfiles(); }
  catch (e) { profiles = previous; report(e); return null; }
  return {...p,profileId:profile.id};
}
$('delete-profile').onclick=async()=>{
  const profile=profiles.find(p=>p.id===editingProfile);if(!profile)return;
  if(!await confirmAction('删除连接配置？',profile.name))return;
  const old=profiles;profiles=profiles.filter(p=>p.id!==profile.id);
  try{await save();renderProfiles();$('connect-dialog').close();}catch(e){profiles=old;report(e);}
};
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
const serverBar=document.createElement('div');serverBar.className='file-server';
serverBar.innerHTML='<select id="file-server" aria-label="文件服务器"></select><button id="file-reconnect" hidden>重新连接</button>';
$('files-hint').before(serverBar);
$('file-server').onchange=()=>{fileSession=sessions.get($('file-server').value)||null;updateFilePanel();};
$('file-reconnect').onclick=()=>{const s=fileCurrent();if(s)repeatSession(s,true).catch(report);};
function updateFilePanel() {
  const servers=[...sessions.values()].filter(s=>s.kind==='ssh');
  const groups=new Map();
  for(const s of servers){const key=fileServerKey(s);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(s);}
  for(const key of fileServers.keys())if(!groups.has(key))fileServers.delete(key);
  for(const [key,group] of groups){
    // Keep each server's chosen session stable so tab changes cannot hide its transfer queue.
    const previous=fileServers.get(key);
    fileServers.set(key,group.includes(fileCurrent())?fileCurrent():group.includes(previous)?previous:group.find(s=>s.state==='connected')||group[0]);
  }
  if(!fileCurrent())fileSession=(fileSession && fileServers.get(fileServerKey(fileSession))) ||
    (current()?.kind==='ssh' && fileServers.get(fileServerKey(current()))) || fileServers.values().next().value || null;
  const select=$('file-server'), options=[...fileServers.values()].map(s=>({id:s.id,label:`${s.name} · ${s.connection.username}@${s.connection.host}${Number(s.connection.port)&&Number(s.connection.port)!==22?':'+s.connection.port:''}${s.state==='connected'?'':' · 未连接'}`}));
  const key=JSON.stringify(options);
  if(select.dataset.options!==key){select.replaceChildren(...options.map(o=>new Option(o.label,o.id)));select.dataset.options=key;}
  const s=fileCurrent();select.value=s?.id||'';select.disabled=!servers.length;
  $('file-reconnect').hidden=!s || s.state==='connected';$('file-reconnect').disabled=s?.state==='connecting';
  $('files-hint').hidden=!!s && s.state==='connected';
  $('files-hint').textContent=s?(s.state==='connecting'?'连接中…':'连接已断开'):'请先连接 SSH。';
  $('files-content').hidden=!s;
  for(const control of $('path-form').querySelectorAll('button,textarea'))control.disabled=s?.state!=='connected';
  for(const id of ['upload','mkdir','refresh'])$(id).disabled=s?.state!=='connected';
  if(displayedFileSession!==s){
    $('file-menu').hidePopover();
    if(displayedFileSession)displayedFileSession.fileView={scroll:$('file-list').scrollTop,pattern:fileFilter.pattern,draft:$('remote-path').value};
    displayedFileSession=s;
    filePath=s?.remotePath||s?.connection?.initialDirectory||'.';
    $('remote-path').value=s?.fileView?.draft??filePath;$('remote-path').title=filePath;
    fileFilter.set(s?.fileEntries||[],s?.fileView?.pattern||'');
    $('file-list').scrollTop=s?.fileView?.scroll||0;
  }
  renderTransfer();resizeRemotePath();
  if(!$('files').hidden && s?.state==='connected' && !s.fileLoaded && !s.fileLoading)loadFiles(filePath,s);
}
function completeTransfer(s, transfer) {
  transfer.state='completed';transfer.expiresAt=Date.now()+5000;
  setTimeout(()=>{
    const expired=t=>t?.state==='completed' && t.expiresAt<=Date.now();
    if(expired(s.transfer))s.transfer=null;
    s.downloadJobs=(s.downloadJobs||[]).filter(t=>!expired(t));
    if(sessions.get(s.id)===s)renderTransfer();
  },5000);
}
const downloadQueue=setupDownloadQueue({call,current:fileCurrent,sessions,busy:fileBusy,render:()=>renderTransfer(),report,complete:completeTransfer});
function renderTransfer() {
  downloadQueue.refresh();
  const s = fileCurrent(), t = s?.transfer;
  $('transfer-toggle').hidden = !t || t.op !== 'download' || !['running','pausing','paused','failed'].includes(t.state);
  $('transfer-toggle').disabled = t?.state === 'pausing' || s?.state !== 'connected';
  $('transfer-toggle').textContent = ['paused','failed'].includes(t?.state) ? '继续' : t?.state === 'pausing' ? '暂停中…' : '暂停';
  if (!t) { $('transfer').textContent = s?.fileSummary || ''; return; }
  const label = {queued:'等待',selecting:'选择位置',running:'传输中',pausing:'暂停中',paused:'已暂停',failed:'已中断',completed:'已完成'}[t.state];
  $('transfer').textContent = `${label} · ${t.name}${t.total != null ? ` · ${t.total ? Math.round(t.done/t.total*100) : 100}%` : ''}`;
  $('transfer').title = t.error || (t.done != null ? `${formatSize(t.done)} / ${formatSize(t.total)}` : t.name);
}
$('transfer-toggle').onclick=()=>{
  const s=fileCurrent(),t=s?.transfer;if(!t)return;
  if(t.state==='running')downloadQueue.pause(s,t);
  else if(['paused','failed'].includes(t.state))downloadQueue.resume(s,t);
};
function openFileMenu(entry, id, row, x, y) {
  const menu = $('file-menu'); menu.replaceChildren();
  const add = (label, action) => {
    const button = document.createElement('button'); button.role = 'menuitem'; button.textContent = label;
    button.onclick = () => { menu.hidePopover(); if (fileSession?.id === id) action(); };
    menu.append(button);
  };
  add(entry.directory ? '打开文件夹' : '下载 / 续传', () => entry.directory ? loadFiles(entry.path) : fileAction('download',{path:entry.path}));
  if(entry.directory)add('下载文件夹 / 续传',()=>fileAction('download',{path:entry.path,directory:'yes'}));
  add('重新下载并覆盖…',()=>fileAction('download',{path:entry.path,directory:entry.directory?'yes':undefined,restart:'yes'}));
  add('重命名', async () => { const name = await askText('重命名',entry.name); if (fileSession?.id === id && name && validFileName(name)) fileAction('rename',{path:entry.path,destination:entry.path.slice(0,entry.path.lastIndexOf('/')+1)+name}); });
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
const fileFilter = setupFileFilter(entries => {
  const id=fileSession?.id; $('file-list').replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('div'); row.className = 'file-row';
      const open = document.createElement('button'); open.className = 'file-open'; open.title = entry.path;
      const icon = document.createElement('span'); icon.textContent = entry.directory ? '▱' : '≡';
      const name = document.createElement('b'); name.textContent = entry.name; open.append(icon,name);
      open.onclick = () => entry.directory ? loadFiles(entry.path) : fileAction('download',{path:entry.path});
      const size = document.createElement('small'); size.textContent = entry.directory ? '' : formatSize(entry.size);
      const rename = document.createElement('button'); rename.className = 'file-rename'; rename.textContent = '⋯'; rename.title = '文件操作'; rename.setAttribute('aria-haspopup','menu');
      rename.onclick = () => openFileMenu(entry,id,row);
      row.oncontextmenu = e => { e.preventDefault(); openFileMenu(entry,id,row,e.clientX,e.clientY); };
      row.append(open,size,rename); $('file-list').append(row);
    }
});
async function loadFiles(path,s=fileCurrent()) {
  if(!s || s.state!=='connected')return;
  $('file-menu').hidePopover();
  const id=s.id,epoch=s.fileEpoch=(s.fileEpoch||0)+1;
  s.fileLoading=true;s.fileSummary='读取目录…';renderTransfer();
  try {
    const result=await call('sftp',{id,op:'list',path});
    if(sessions.get(id)!==s || s.id!==id || epoch!==s.fileEpoch)return;
    s.remotePath=result.path;s.fileEntries=result.entries;s.fileLoaded=true;s.fileSummary=`${result.entries.length} 个项目`;
    if(fileCurrent()===s){filePath=result.path;$('remote-path').value=filePath;$('remote-path').title=filePath;resizeRemotePath();fileFilter.set(result.entries);$('file-list').scrollTop=0;}
    else s.fileView={...s.fileView,draft:result.path,scroll:0};
  }catch(e){if(sessions.get(id)===s && epoch===s.fileEpoch){s.fileLoaded=true;s.fileSummary='读取失败：'+e.message;}}
  finally{if(epoch===s.fileEpoch)s.fileLoading=false;renderTransfer();}
}
function validFileName(name) { if (!name || name === '.' || name === '..' || /[/\\\x00]/.test(name)) { toast('名称不能包含路径分隔符'); return false; } return true; }
async function fileAction(op,args) {
  const s = fileCurrent(), id = s?.id;
  if (!s || s.state !== 'connected') return;
  if(op==='download')return downloadQueue.enqueue(s,args);
  if (fileBusy.has(id)) { toast('请等待当前传输完成'); return; }
  const path = filePath, previous = s.transfer, isTransfer = ['download','upload'].includes(op);
  fileBusy.add(id);
  if (isTransfer) s.transfer = {op,path:args.path,name:args.path.split('/').at(-1),state:'running'};
  renderTransfer();
  try {
    const result = await call('sftp',{id,op,...args});
    if (result?.cancelled) s.transfer = previous;
    else if (result?.paused) s.transfer.state = 'paused';
    else { if (isTransfer) completeTransfer(s,s.transfer); toast('文件操作已完成',5000); }
    if (fileCurrent()===s && !result?.paused && !result?.cancelled && op !== 'download') await loadFiles(path);
  }
  catch (e) { if (isTransfer) { s.transfer.state = 'failed'; s.transfer.error = e.message; } report(e); }
  finally { fileBusy.delete(id); renderTransfer(); downloadQueue.pump(s); }
}
function toggleFiles() { if($('files').hidden && innerWidth<1100) $('snippets').hidden=true; $('file-menu').hidePopover(); $('files').hidden = !$('files').hidden; updateFilePanel(); }
$('files-close').onclick = () => { $('file-menu').hidePopover(); $('files').hidden = true; };
function resizeRemotePath(){
  const field=$('remote-path');
  if(!field.getClientRects().length)return;
  field.style.height='auto';
  const style=getComputedStyle(field);
  field.style.height=Math.ceil(field.scrollHeight+parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth))+'px';
}
new ResizeObserver(resizeRemotePath).observe($('path-form'));
document.fonts.ready.then(resizeRemotePath);
document.fonts.addEventListener('loadingdone',resizeRemotePath);
$('remote-path').oninput=resizeRemotePath;
$('remote-path').onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();$('path-form').requestSubmit();}};
$('path-form').onsubmit = e => { e.preventDefault(); loadFiles($('remote-path').value); };
$('parent-dir').onclick = () => loadFiles(filePath.replace(/\/[^/]+\/?$/,'') || '/');
$('refresh').onclick = () => loadFiles(filePath);
$('upload').onclick = () => fileAction('upload',{path:filePath});
$('mkdir').onclick = async () => { const s=fileCurrent(),path=filePath;const name = await askText('新建远程文件夹',''); if (fileCurrent()===s && name && validFileName(name)) fileAction('mkdir',{path:path.replace(/\/$/,'')+'/'+name}); };
function askText(title,value) { return new Promise(resolve => { $('text-title').textContent = title; $('text-value').value = value; let answer = null; $('text-form').onsubmit = e => { e.preventDefault(); answer = $('text-value').value.trim(); $('text-dialog').close(); }; $('text-dialog').addEventListener('close',() => resolve(answer),{once:true}); $('text-dialog').showModal(); $('text-value').select(); }); }
function confirmAction(title,message) { return new Promise(resolve => { $('confirm-title').textContent = title; $('confirm-message').textContent = message; let answer = false; $('confirm-yes').onclick = () => { answer = true; $('confirm-dialog').close(); }; $('confirm-no').onclick = () => $('confirm-dialog').close(); $('confirm-dialog').addEventListener('close',() => resolve(answer),{once:true}); $('confirm-dialog').showModal(); }); }
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => $(b.dataset.close).close());
function openConnections() { $('connections-menu').togglePopover(); }
window.terminalAction = action => {
  $('file-menu').hidePopover(); $('session-menu').hidePopover();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  if (action !== 'connections') $('connections-menu').hidePopover();
  if (action === 'connections') openConnections();
  else if (action === 'search') openSearch();
  else if (action === 'files') toggleFiles();
  else if (action === 'snippets') { if($('snippets').hidden && innerWidth<1100) $('files').hidden=true; snippets.toggle(); }
  else if (action === 'settings') $('settings-dialog').showModal();
  else if (action === 'help') $('help-dialog').showModal();
};
$('new-local').onclick = () => { $('connections-menu').hidePopover(); newSession(); };
for (const id of ['tab-plus','empty-new']) $(id).onclick = openConnections;
for (const id of ['new-ssh','add-profile']) $(id).onclick = () => openConnection();
$('font-reset').onclick = () => setFont(14);
$('font-minus').onclick = () => setFont(fontSize-1);
$('font-plus').onclick = () => setFont(fontSize+1);
$('terminal-font').onchange = async () => {
  fontFamily=$('terminal-font').value;
  await document.fonts.load(`${fontSize}px ${fonts[fontFamily].split(',')[0]}`);
  for(const s of sessions.values()){s.term.options.fontFamily=fonts[fontFamily];s.term.options.fontWeightBold=fontFamily==='JetBrains Mono'?'500':'700';}
  requestAnimationFrame(()=>requestAnimationFrame(()=>{for(const s of sessions.values())fit(s);}));
  await save();
};
document.fonts.addEventListener('loadingdone',()=>requestAnimationFrame(()=>fit(current())));
$('shell').onchange = () => save().catch(report);
window.addEventListener('keydown', e => {
  if(e.isComposing || e.keyCode===229 || e.key==='Process' || e.key==='Shift') return;
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
  sftpSize.load();
  try { const settings = await call('load'); sftpSize.load(settings.sftpWidth); snippets.load(settings.snippets); fontFamily=Object.hasOwn(fonts,settings.fontFamily)?settings.fontFamily:'JetBrains Mono'; $('terminal-font').value=fontFamily; profiles = Array.isArray(settings.profiles) ? settings.profiles : []; fontSize = Math.max(10,Math.min(28,settings.fontSize || 14)); $('font-size').textContent = fontSize; $('shell').value = settings.defaultShell === 'cmd' ? 'cmd' : 'powershell'; renderProfiles(); renderTabs(); }
  catch (e) { report(e); renderProfiles(); }
  updates.start();
}
init();
