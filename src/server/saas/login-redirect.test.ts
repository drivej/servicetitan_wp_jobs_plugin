import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { test } from 'node:test';
import { createSaaSApp } from './app.js';
import type { AccountStore } from './store.js';
import { SecretVault } from './crypto.js';

test('login sends superadmins to members and preserves regular pricing and invitation destinations',async()=>{
  let admin=false,returnTo='/pricing';
  const store={
    allowRequest:async()=>true,
    consumeLogin:async()=>({nonce:'nonce',verifier:'verifier',returnTo}),
    login:async()=>({token:'s'.repeat(43),user:{id:'user'}}),
    session:async()=>({id:'user',isPlatformAdmin:admin}),
  } as unknown as AccountStore;
  const app=createSaaSApp({store,config:{databaseUrl:'unused',origin:'http://localhost:3000',googleClientId:'test',googleClientSecret:'test',secureCookies:false,trustProxyHops:0,vault:new SecretVault({test:randomBytes(32).toString('base64')},'test')},google:{authorization:async()=>'',exchange:async()=>({subject:'test',email:'test@example.com',name:'Test'})},websiteApp:()=>express()});
  const server=app.listen(0,'127.0.0.1');
  try{
    await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert(address && typeof address==='object');
    for(const scenario of [{admin:false,returnTo:'/pricing',destination:'/pricing'},{admin:false,returnTo:'/invite',destination:'/invite'},{admin:true,returnTo:'/pricing',destination:'/admin/members'},{admin:true,returnTo:'/invite',destination:'/admin/members'}]){
      admin=scenario.admin;returnTo=scenario.returnTo;
      const response=await fetch(`http://127.0.0.1:${address.port}/auth/google/callback?state=${'a'.repeat(43)}`,{headers:{Cookie:`st_login=${'b'.repeat(43)}`},redirect:'manual'});
      assert.equal(response.status,302);assert.equal(response.headers.get('location'),scenario.destination);
    }
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
