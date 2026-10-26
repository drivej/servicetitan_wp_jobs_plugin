import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyWebsiteIdentity } from './website-identity.js';
import { websiteUrl } from './validation.js';
const credentials={username:'admin',applicationPassword:'secret'};
test('URL normalization preserves installation paths and rejects unsafe destinations',()=>{
  assert.equal(websiteUrl('https://EXAMPLE.com:443/blog///'),'https://example.com/blog');
  assert.equal(websiteUrl('https://example.com/a/../blog/'),'https://example.com/blog');
  assert.notEqual(websiteUrl('https://example.com/site-a'),websiteUrl('https://example.com/site-b'));
  for(const url of ['https://example.com/a%2fb','https://example.com/a%5cb','https://example.com/?x=1','http://example.com','https://user:secret@example.com','https://example.com\\evil','https://127.0.0.1']) assert.throws(()=>websiteUrl(url));
});
test('installation verification authenticates and confirms canonical aliases',async()=>{
  const id=randomUUID();const calls:string[]=[];
  const mock:typeof fetch=async(input,init)=>{
    calls.push(String(input));
    assert.equal(new Headers(init?.headers).get('Authorization'),'Basic '+Buffer.from('admin:secret').toString('base64'));
    assert.equal(init?.redirect,'error');
    return Response.json({installationId:id,canonicalUrl:'https://example.com/blog/'});
  };
  assert.deepEqual(await verifyWebsiteIdentity('https://example.com/alias',credentials,mock),{installationId:id,canonicalUrl:'https://example.com/blog'});
  assert.equal(calls.length,2);
  assert.equal(calls[1],'https://example.com/blog/wp-json/servicetitan-job-integration/v1/identity');
  await assert.rejects(verifyWebsiteIdentity('https://example.com',credentials,async()=>new Response('',{status:403})),/administrator credentials/);
  await assert.rejects(verifyWebsiteIdentity('https://example.com',credentials,async()=>Response.json({installationId:'bad',canonicalUrl:'https://example.com'})),/invalid installation/);
  let crossOriginCalls=0;
  await assert.rejects(verifyWebsiteIdentity('https://example.com',credentials,async()=>{crossOriginCalls++;return Response.json({installationId:id,canonicalUrl:'https://other.example.com'});}),/cannot be forwarded/);
  assert.equal(crossOriginCalls,1);
  let n=0;
  await assert.rejects(verifyWebsiteIdentity('https://example.com/alias',credentials,async()=>Response.json({installationId:n++===0?id:randomUUID(),canonicalUrl:'https://example.com'})),/same installation/);
});

test('cached and background WordPress providers reject unclaimed, changed, or revoked ownership before a write',async()=>{
  const { websiteBuildProviders }=await import('./providers.js');
  const { DisabledJobCopyGenerator }=await import('../openai.js');
  const installationId=randomUUID();
  let authorized=true;let changed=false;let requests=0;let writes=0;let spends=0;
  const store={
    assertWebsiteOwnership:async()=>{if(!authorized) throw new Error('Membership revoked');},
    spendJobToken:async()=>{spends++;},
    withWebsiteOwnership:async(_user:unknown,_site:unknown,_workspace:unknown,_version:unknown,operation:()=>Promise<unknown>)=>{if(!authorized) throw new Error('Membership revoked');return operation();},
  } as unknown as import('./store.js').AccountStore;
  const context:import('./store.js').WebsiteContext={
    workspaceId:randomUUID(),
    website:{id:randomUUID(),name:'Site',url:'https://example.com',connectionId:randomUUID(),restBase:'st-jobs',zipAcfField:'my_zip_codes',wordpressConfigured:true,version:1,ownershipVerified:true,installationId,canonicalUrl:'https://example.com'},
    connection:{id:randomUUID(),name:'ST',environment:'production',tenantId:'123',version:1,clientId:'id',clientSecret:'secret',appKey:'key'},wordpress:credentials,
  };
  const fetcher:typeof fetch=async(input)=>{
    requests++;
    if(String(input).endsWith('/identity')) return Response.json({installationId:changed?randomUUID():installationId,canonicalUrl:'https://example.com'});
    writes++;return Response.json({});
  };
  const providers=websiteBuildProviders(store,new DisabledJobCopyGenerator(),'user',context,fetcher);
  authorized=false;
  await assert.rejects(providers.wordpress!.getStatuses([123]),/Membership revoked/);
  assert.equal(requests,0);assert.equal(writes,0);
  authorized=true;changed=true;
  await assert.rejects(providers.wordpress!.getStatuses([123]),/identity changed/);
  assert.equal(writes,0);
  await assert.rejects(providers.spendJobToken!('build',async()=>{},123,randomUUID()),/identity changed/);
  assert.equal(spends,0);
  const unclaimed=websiteBuildProviders(store,new DisabledJobCopyGenerator(),'user',{...context,website:{...context.website,ownershipVerified:false}},fetcher);
  await assert.rejects(unclaimed.wordpress!.getStatuses([123]),/Verify website ownership/);
  assert.equal(writes,0);
});
