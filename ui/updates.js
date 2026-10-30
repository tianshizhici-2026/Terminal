export function setupUpdates({call,bridge,report}) {
  const status=document.getElementById('update-status'),check=document.getElementById('check-update'),automatic=document.getElementById('auto-update');
  function render(s){
    if(!s)return;
    automatic.checked=s.automatic;
    const text={idle:`v${s.version}`,checking:'正在检查…',latest:`v${s.version} · 已是最新`,downloading:`下载更新 ${s.progress}%`,ready:`v${s.target} · 下次启动更新`,failed:'更新失败，可重试',development:`v${s.version} · 开发版`};
    status.textContent=text[s.state]||`v${s.version}`;
    check.disabled=['checking','downloading','ready','development'].includes(s.state);
    automatic.disabled=s.state==='development';
  }
  bridge?.addEventListener('message',({data:m})=>{if(m.type==='update')render(m.status);});
  check.onclick=()=>call('updateCheck').then(render).catch(report);
  automatic.onchange=()=>call('updateAutomatic',{enabled:automatic.checked?'yes':'no'}).then(render).catch(report);
  return {start:()=>call('ready').then(render).catch(report)};
}
