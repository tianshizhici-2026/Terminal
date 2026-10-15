export function setupSnippets({paste,save,confirm,report}) {
  const panel = document.createElement('aside'); panel.id = 'snippets'; panel.hidden = true;
  panel.innerHTML = '<div class="panel-title"><span>常用代码</span><button id="snippets-close" title="关闭代码面板">×</button></div><button id="snippet-add">＋ 新增代码块</button><div id="snippet-list"></div>';
  document.querySelector('.workspace-body').append(panel);
  const dialog = document.createElement('dialog'); dialog.id = 'snippet-dialog';
  dialog.innerHTML = '<form id="snippet-form"><div class="dialog-heading"><h2>代码块</h2><button type="button" id="snippet-cancel">×</button></div><label>名称<input id="snippet-title" required maxlength="100"></label><label>代码<textarea id="snippet-code" required maxlength="100000" spellcheck="false" rows="10"></textarea></label><div class="dialog-actions"><button type="submit" class="primary">保存</button></div></form>';
  document.body.append(dialog);
  let items = [], editing = null;
  const $ = id => document.getElementById(id);
  function edit(item) { editing = item?.id || null; $('snippet-title').value = item?.title || ''; $('snippet-code').value = item?.code || ''; dialog.showModal(); $('snippet-title').focus(); }
  async function persist(next) {
    const old = items; items = next;
    try { await save(); render(); return true; } catch(e) { items = old; report(e); return false; }
  }
  function render() {
    const list = $('snippet-list'); list.replaceChildren();
    if (!items.length) { const hint=document.createElement('p'); hint.className='panel-empty'; hint.textContent='暂无代码块'; list.append(hint); }
    for (const item of items) {
      const row = document.createElement('div'); row.className='snippet-row';
      const use = document.createElement('button'); use.className='snippet-use'; use.title='粘贴到当前终端';
      const title=document.createElement('b'), code=document.createElement('pre'); title.textContent=item.title; code.textContent=item.code; use.append(title,code);
      use.onclick=()=>paste(item.code);
      const actions=document.createElement('div'); actions.className='snippet-actions';
      const change=document.createElement('button'); change.textContent='编辑'; change.onclick=()=>edit(item);
      const remove=document.createElement('button'); remove.textContent='删除'; remove.onclick=async()=>{ if(await confirm('删除代码块？',item.title)) await persist(items.filter(x=>x.id!==item.id)); };
      actions.append(change,remove); row.append(use,actions); list.append(row);
    }
  }
  $('snippet-add').onclick=()=>edit(); $('snippets-close').onclick=()=>{panel.hidden=true;};
  $('snippet-cancel').onclick=()=>dialog.close();
  $('snippet-form').onsubmit=async e=>{
    e.preventDefault(); const title=$('snippet-title').value.trim(), code=$('snippet-code').value;
    if(!title || !code.trim()) return;
    const item={id:editing || crypto.randomUUID(),title,code};
    if(await persist(editing ? items.map(x=>x.id===editing ? item : x) : [...items,item])) dialog.close();
  };
  return {get items(){return items;},load(value){items=Array.isArray(value)?value:[];render();},toggle(){panel.hidden=!panel.hidden;}};
}
