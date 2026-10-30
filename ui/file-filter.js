export function setupFileFilter(render) {
  const form=document.createElement('div'); form.className='file-filter';
  form.innerHTML='<input id="file-filter" aria-label="正则筛选文件" placeholder="正则筛选文件…" maxlength="500" spellcheck="false"><span id="file-filter-error" role="status"></span>';
  document.getElementById('file-list').before(form);
  const input=form.querySelector('input'), error=form.querySelector('span');
  let entries=[], worker, timer, debounce;
  function apply() {
    clearTimeout(timer); worker?.terminate(); error.textContent=''; input.removeAttribute('aria-invalid');
    if(!input.value) { render(entries); return; }
    const current = worker = new Worker('filter-worker.js');
    const fail = message => { current.terminate(); error.textContent=message; input.setAttribute('aria-invalid','true'); render(entries); };
    timer=setTimeout(()=>fail('表达式耗时过长，请简化'),400);
    current.onmessage=({data})=>{if(worker!==current)return; clearTimeout(timer); current.terminate(); if(data.error)fail(data.error); else render(data.indices.map(i=>entries[i]));};
    current.onerror=()=>{clearTimeout(timer);fail('筛选失败');};
    current.postMessage({pattern:input.value,names:entries.map(x=>x.name)});
  }
  input.oninput=()=>{clearTimeout(debounce);debounce=setTimeout(apply,100);};
  return {get pattern(){return input.value;},set(value,pattern=input.value){input.value=pattern;entries=value;clearTimeout(debounce);apply();}};
}
