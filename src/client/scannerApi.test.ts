import assert from 'node:assert/strict';
import test from 'node:test';
import { configureApi } from './api';
import { startJobScan } from './scannerApi';

test('scanner entry points reuse the scoped request key on failure and clear it after success',async()=>{
  const originalWindow=globalThis.window,originalFetch=globalThis.fetch;
  const storage=new Map<string,string>(),keys:string[]=[],zips:string[]=[];let nextId=0;
  Object.defineProperty(globalThis,'window',{configurable:true,value:{
    dispatchEvent:()=>true,location:{origin:'https://app.example'},crypto:{randomUUID:()=>`scan-${++nextId}`},
    sessionStorage:{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)},
  }});
  configureApi('user','site','csrf','workspace');
  globalThis.fetch=async(path,init)=>{
    assert.equal(path,'/api/websites/site/scanner/start');
    const headers=new Headers(init?.headers);
    assert.equal(headers.get('X-CSRF-Token'),'csrf');
    assert.equal(headers.get('X-Workspace-ID'),'workspace');
    keys.push(headers.get('Idempotency-Key')!);
    const payload=JSON.parse(init?.body as string);zips.push(payload.zip);
    if(payload.allDates){assert.equal(payload.start,undefined);assert.equal(payload.end,undefined);}
    return new Response(JSON.stringify(keys.length===1?{error:'Please retry'}:{scan:{id:'accepted'}}),{status:keys.length===1?503:202});
  };
  try {
    await assert.rejects(startJobScan(),/Please retry/);
    assert.equal(storage.size,1);
    assert.equal((await startJobScan()).id,'accepted');
    assert.equal(keys[0],keys[1]);assert.equal(storage.size,0);
    await startJobScan();assert.notEqual(keys[1],keys[2]);
    await startJobScan(' 01234 ',{start:'2026-10-01',end:'2026-10-07'});assert.equal(zips.at(-1),'01234');
    await startJobScan('',{start:'invalid',end:'invalid',useDateRange:false});
  }finally{
    globalThis.fetch=originalFetch;Object.defineProperty(globalThis,'window',{configurable:true,value:originalWindow});configureApi('local','','');
  }
});
