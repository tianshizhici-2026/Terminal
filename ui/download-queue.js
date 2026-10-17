export function setupDownloadQueue({call,current,sessions,busy,render,report}) {
  const panel=document.createElement('div');panel.id='download-queue';document.getElementById('file-list').after(panel);
  const labels={selecting:'选择位置',queued:'等待',running:'下载中',pausing:'暂停中',paused:'已暂停',failed:'失败',completed:'完成'};
  function refresh(){
    panel.replaceChildren();const s=current();if(!s)return;
    for(const job of s.downloadJobs||[]){
      const row=document.createElement('div');row.className='download-job';
      const name=document.createElement('span');name.textContent=job.name;name.title=job.error||job.path;
      const status=document.createElement('small');status.textContent=labels[job.state];row.append(name,status);
      const button=(label,action)=>{const b=document.createElement('button');b.textContent=label;b.onclick=action;row.append(b);};
      if(['failed','paused'].includes(job.state))button('继续',()=>resume(s,job));
      if(!['running','pausing','selecting'].includes(job.state))button('×',()=>{s.downloadJobs=s.downloadJobs.filter(x=>x!==job);if(s.transfer===job)s.transfer=null;render();pump(s);});
      panel.append(row);
    }
    panel.hidden=!panel.childElementCount;
  }
  async function enqueue(s,args){
    s.downloadJobs ||= [];
    if(s.downloadJobs.some(j=>j.path===args.path&&!['completed','failed'].includes(j.state)))return;
    const job={...args,op:'download',name:args.path.split('/').filter(Boolean).at(-1),state:'selecting'};
    s.downloadJobs.push(job);refresh();
    try{
      const result=await call('sftp',{id:s.id,op:'prepareDownload',...args});
      if(result?.cancelled){s.downloadJobs=s.downloadJobs.filter(j=>j!==job);return;}
      job.destination=result?.destination;job.state='queued';
    }catch(e){job.state='failed';job.error=e.message;report(e);}
    finally{render();pump(s);}
  }
  async function pump(s){
    if(!sessions.has(s.id)||s.state!=='connected'||busy.has(s.id)||(s.downloadJobs||[]).some(j=>['paused','pausing','running','selecting'].includes(j.state)))return;
    const job=s.downloadJobs?.find(j=>j.state==='queued');if(!job)return;
    const runId=s.id;busy.add(runId);job.state='running';s.transfer=job;render();
    try{
      const result=await call('sftp',{id:s.id,op:'download',path:job.path,directory:job.directory,destination:job.destination,resume:'yes'});
      job.state=result?.paused?'paused':result?.cancelled?'failed':'completed';
    }catch(e){job.state='failed';job.error=e.message;report(e);}
    finally{busy.delete(runId);if(s.id===runId){render();pump(s);}}
  }
  function resume(s,job){if(!job)return;job.state='queued';job.error=null;pump(s);render();}
  return {enqueue,pump,refresh,resume};
}
