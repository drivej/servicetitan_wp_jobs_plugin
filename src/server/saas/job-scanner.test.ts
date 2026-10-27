import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSaaSApp } from './app.js';
import { websiteAppFactory } from './providers.js';
import { DisabledJobCopyGenerator } from '../openai.js';
import { FileScannerStore } from '../scanner-store.js';
import { FileBuildQueueStore } from '../build-queue.js';
import { csrfToken, SecretVault } from './crypto.js';
import { HttpError } from './validation.js';
import type { AccountStore } from './store.js';

test('scanner HTTP requires session, CSRF, tokens and website access; retries remain one scoped task',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'scanner-http-'));
  const userId=randomUUID(),workspaceId=randomUUID(),websiteId=randomUUID(),connectionId=randomUUID();
  const token='s'.repeat(43);let balance=6;
  const store={
    session:async(value:string)=>value===token?{id:userId,workspaceId,role:'member',jobTokens:balance}:undefined,
    allowRequest:async()=>true,
    recordAction:async()=>{},
    websiteContext:async(user:string,id:string,workspace:string)=>{
      if(user!==userId || id!==websiteId || workspace!==workspaceId) throw new HttpError('Website not found.',404);
      return{workspaceId,website:{id:websiteId,url:'https://example.com',version:1},connection:{id:connectionId,version:1,tenantId:'123',clientId:'client',clientSecret:'private',appKey:'key'}};
    },
  } as unknown as AccountStore;
  const scanners=new FileScannerStore(join(dir,'scans.json')),queue=new FileBuildQueueStore(join(dir,'builds.json'));
  const config={databaseUrl:'unused',origin:'http://localhost:3000',googleClientId:'test',googleClientSecret:'test',secureCookies:false,trustProxyHops:0,vault:new SecretVault({test:randomBytes(32).toString('base64')},'test')};
  const app=createSaaSApp({config,store,google:{authorization:async()=>'',exchange:async()=>{throw new Error('unused');}},websiteApp:websiteAppFactory(store,new DisabledJobCopyGenerator(),queue,scanners)});
  const server=app.listen(0,'127.0.0.1');
  try{
    await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert(address&&typeof address==='object');
    const base=`http://127.0.0.1:${address.port}/api/websites/${websiteId}/scanner`;
    const headers={Cookie:`st_session=${token}`,Origin:config.origin,'X-CSRF-Token':csrfToken(token),'Idempotency-Key':randomUUID()};
    assert.equal((await fetch(base+'/latest')).status,401);
    assert.equal((await fetch(base+'/start',{method:'POST',headers:{Cookie:headers.Cookie}})).status,403);
    assert.equal((await fetch(base.replace(websiteId,randomUUID())+'/latest',{headers})).status,404);
    assert.equal((await fetch(base+'/start',{method:'POST',headers:{...headers,'X-Workspace-ID':randomUUID()}})).status,409);
    balance=0;assert.equal((await fetch(base+'/start',{method:'POST',headers})).status,402);balance=6;
    assert.equal((await fetch(base+'/start',{method:'POST',headers:{...headers,'Idempotency-Key':'invalid'}})).status,400);
    for(const zip of ['bad',12345,['01234']])assert.equal((await fetch(base+'/start',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({zip})})).status,400);
    const response=await fetch(base+'/start',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({zip:' 01234 '})});assert.equal(response.status,202);const first=await response.json();
    assert.equal(first.scan.zip,'01234');
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    const second=await(await fetch(base+'/start',{method:'POST',headers})).json();assert.equal(first.scan.id,second.scan.id);
    const latest=await(await fetch(base+'/latest',{headers})).json();assert.equal(latest.scan.id,first.scan.id);assert.equal(latest.scan.userId,undefined);assert.equal(latest.scan.workspaceId,undefined);
    const cancel=base+`/${first.scan.id}/cancel`;
    assert.equal((await fetch(cancel,{method:'POST'})).status,401);
    assert.equal((await fetch(cancel,{method:'POST',headers:{Cookie:headers.Cookie}})).status,403);
    assert.equal((await fetch(cancel.replace(websiteId,randomUUID()),{method:'POST',headers})).status,404);
    assert.equal((await fetch(base+`/${randomUUID()}/cancel`,{method:'POST',headers})).status,404);
    balance=0;
    const stopped=await fetch(cancel,{method:'POST',headers});assert.equal(stopped.status,200);
    const stoppedBody=await stopped.json();assert.equal(stoppedBody.scan.stopReason,'canceled');assert.equal(stoppedBody.scan.scanFeeCharged,undefined);
    assert.equal(stoppedBody.scan.userId,undefined);assert.equal(await scanners.claim(),undefined);

  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
