export function setupSnippets({paste,execute,save,confirm,report}) {
  const panel = document.createElement('aside'); panel.id = 'snippets'; panel.hidden = true;
  panel.innerHTML = '<div class="panel-title"><span>常用代码</span><button id="snippets-close" title="关闭代码面板">×</button></div><button id="snippet-add">＋ 新增代码块</button><div id="snippet-list"></div>';
  document.querySelector('.workspace-body').append(panel);
  const dialog = document.createElement('dialog'); dialog.id = 'snippet-dialog';
  dialog.innerHTML = '<form id="snippet-form"><div class="dialog-heading"><h2>代码块</h2><button type="button" id="snippet-cancel">×</button></div><label>代码<textarea id="snippet-code" required maxlength="100000" spellcheck="false" rows="10"></textarea></label><div class="dialog-actions"><button type="submit" class="primary">保存</button></div></form>';
  document.body.append(dialog);
  let items = [];
  const $ = id => document.getElementById(id);
  function add() { $('snippet-code').value = ''; dialog.showModal(); $('snippet-code').focus(); }
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
      const code=document.createElement('pre'); code.textContent=item.code; use.append(code);
      use.onclick=()=>paste(item.code);
      const actions=document.createElement('div'); actions.className='snippet-actions';
      const run=document.createElement('button');run.className='snippet-run';run.textContent='执行';run.title='粘贴并回车执行';run.onclick=()=>execute(item.code);
      const remove=document.createElement('button'); remove.textContent='删除'; remove.onclick=async()=>{ if(await confirm('删除代码块？',item.code.slice(0,100))) await persist(items.filter(x=>x.id!==item.id)); };
      actions.append(run,remove); row.append(use,actions); list.append(row);
    }
  }
  $('snippet-add').onclick=()=>add(); $('snippets-close').onclick=()=>{panel.hidden=true;};
  $('snippet-cancel').onclick=()=>dialog.close();
  $('snippet-form').onsubmit=async e=>{
    e.preventDefault(); const code=$('snippet-code').value;
    if(!code.trim()) return;
    const item={id:crypto.randomUUID(),title:code.trim().slice(0,100),code};
    if(await persist([...items,item])) dialog.close();
  };
  return {get items(){return items;},load(value){items=Array.isArray(value)?value:[];render();},toggle(){panel.hidden=!panel.hidden;}};
}
