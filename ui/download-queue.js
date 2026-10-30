export function setupDownloadQueue({call,current,sessions,busy,render,report,complete}) {
  const panel=document.createElement('div');panel.id='download-queue';document.getElementById('file-list').after(panel);
  const labels={selecting:'选择位置',queued:'等待',running:'下载中',pausing:'暂停中',paused:'已暂停',failed:'失败',completed:'完成'};
  const attached=(s,job,id,attempt)=>sessions.get(id)===s && s.id===id && s.downloadJobs?.includes(job) && job.attempt===attempt;
  function refresh(){
    panel.replaceChildren();const s=current();
    for(const job of s?.downloadJobs||[]){
      const row=document.createElement('div');row.className='download-job';
      const name=document.createElement('span');name.textContent=job.name;name.title=job.error||job.path;
      const status=document.createElement('small');status.textContent=labels[job.state];row.append(name,status);
      const button=(label,action,disabled=false)=>{const b=document.createElement('button');b.textContent=label;b.onclick=action;b.disabled=disabled;row.append(b);};
      if(job.state==='running')button('暂停',()=>pause(s,job));
      if(['failed','paused'].includes(job.state)){
        button('继续',()=>resume(s,job),s.state!=='connected');
        button('覆盖重下',()=>resume(s,job,true),s.state!=='connected');
      }
      if(!['running','pausing','selecting'].includes(job.state))button('×',()=>{
        s.downloadJobs=s.downloadJobs.filter(x=>x!==job);job.attempt=null;
        if(s.transfer===job)s.transfer=null;
        s.queueHeld=s.downloadJobs.some(j=>['paused','failed','pausing'].includes(j.state));render();pump(s);
      });
      panel.append(row);
    }
    panel.hidden=!panel.childElementCount;
  }
  async function prepare(s,job,restart=false){
    const id=s.id,attempt=job.attempt=crypto.randomUUID(),previous=job.state;
    job.state='selecting';render();
    try{
      const result=await call('sftp',{id,op:'prepareDownload',path:job.path,directory:job.directory,destination:job.destination,restart:restart?'yes':'no'});
      if(!attached(s,job,id,attempt))return false;
      if(result?.cancelled){job.state=previous;return false;}
      if(!result?.destination)throw new Error('未选择保存位置，请重试。');
      job.destination=result.destination;job.overwrite=result.overwrite;job.restartPending=restart;return true;
    }catch(e){if(attached(s,job,id,attempt)){job.state='failed';job.error=e.message;report(e);}return false;}
  }
  async function enqueue(s,args){
    s.downloadJobs ||= [];
    const existing=s.downloadJobs.find(j=>j.path===args.path&&j.state!=='completed');
    if(existing){if(['paused','failed'].includes(existing.state))await resume(s,existing,args.restart==='yes');return;}
    const job={...args,op:'download',name:args.path.split('/').filter(Boolean).at(-1),state:'queued'};
    s.downloadJobs.push(job);
    if(await prepare(s,job,args.restart==='yes'))job.state='queued';
    else if(job.state==='queued')s.downloadJobs=s.downloadJobs.filter(j=>j!==job);
    render();pump(s);
  }
  async function pump(s){
    if(sessions.get(s.id)!==s || s.state!=='connected' || busy.has(s.id) || s.queueHeld || (s.downloadJobs||[]).some(j=>['pausing','running','selecting'].includes(j.state)))return;
    const job=s.downloadJobs?.find(j=>j.state==='queued');if(!job)return;
    const id=s.id,attempt=job.attempt=crypto.randomUUID();busy.add(id);job.state='running';s.transfer=job;render();
    const restart=job.restartPending;job.restartPending=false;
    try{
      const result=await call('sftp',{id,op:'download',path:job.path,directory:job.directory,destination:job.destination,resume:'yes',overwrite:job.overwrite,restart:restart?'yes':'no',transferId:attempt});
      if(!attached(s,job,id,attempt))return;
      if(result?.paused){job.state='paused';s.queueHeld=true;}
      else if(result?.cancelled){job.state='failed';job.error='下载已取消';s.queueHeld=true;}
      else {complete(s,job);if(result?.backup)report(new Error('下载已完成；旧目录保留在：'+result.backup));}
    }catch(e){if(attached(s,job,id,attempt)){job.state='failed';job.error=e.message;s.queueHeld=true;report(e);}}
    finally{busy.delete(id);if(attached(s,job,id,attempt)){render();pump(s);}}
  }
  async function resume(s,job,restart=false){
    if(!job || !['paused','failed'].includes(job.state) || s.state!=='connected')return;
    if((restart || !job.destination) && !await prepare(s,job,restart)){render();return;}
    job.state='queued';job.error=null;s.queueHeld=false;
    s.downloadJobs=[job,...s.downloadJobs.filter(j=>j!==job)];pump(s);render();
  }
  async function pause(s,job){
    if(job?.state!=='running')return;
    const id=s.id,attempt=job.attempt;job.state='pausing';s.queueHeld=true;render();
    try{await call('pauseDownload',{id,transferId:attempt});}
    catch(e){if(attached(s,job,id,attempt)&&job.state==='pausing'){job.state='running';s.queueHeld=false;render();report(e);}}
  }
  function invalidate(s){
    for(const job of s.downloadJobs||[]){job.attempt=null;if(['running','pausing','selecting'].includes(job.state))job.state='paused';}
    s.queueHeld=(s.downloadJobs||[]).some(j=>['paused','failed'].includes(j.state));
  }
  return {enqueue,pump,refresh,resume,pause,invalidate};
}
