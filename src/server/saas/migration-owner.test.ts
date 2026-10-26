import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,readdir,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate,type Sql } from './database.js';

async function ownerFixture() {
  const db=new PGlite();
  const directory=await mkdtemp(join(tmpdir(),'migration-owner-'));
  const sql:Sql={async query<T extends Record<string,unknown>>(query:string,values?:unknown[]){
    const result=values?await db.query<T>(query,values):(await db.exec(query)).at(-1);
    return {rows:(result?.rows||[]) as T[]};
  }};
  await sql.query('CREATE ROLE migration_owner NOLOGIN; CREATE SCHEMA migration_test AUTHORIZATION migration_owner; SET ROLE migration_owner; SET search_path TO migration_test; BEGIN;');
  for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)&&name<'015')) {
    await writeFile(join(directory,name),await readFile(join('migrations',name),'utf8'));
  }
  await migrate(sql,directory);
  await sql.query('COMMIT; RESET ROLE;');
  const userId=randomUUID(),websiteId=randomUUID(),transactionId=randomUUID();
  await sql.query('BEGIN');
  await sql.query("INSERT INTO users(id,google_subject,email,name) VALUES($1,'test-subject','test@example.com','Test')",[userId]);
  await sql.query("INSERT INTO workspaces(id,owner_user_id,name) VALUES($1,$1,'Test account')",[userId]);
  await sql.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$1,'owner')",[userId]);
  await sql.query("INSERT INTO websites(id,workspace_id,name,url) VALUES($1,$2,'Test site','https://example.com')",[websiteId,userId]);
  await sql.query(`INSERT INTO token_transactions(id,workspace_id,sequence,kind,amount,requested_amount,balance_before,balance_after,reference,reason,website_id)
    VALUES($1,$2,1,'test_credit',7,7,0,7,'test-credit','Test credit',$3)`,[transactionId,userId,websiteId]);
  await sql.query('COMMIT; SET ROLE migration_owner;');
  assert.equal((await sql.query('SELECT id FROM websites')).rows.length,0,'FORCE RLS must hide the existing website from the migration owner');
  assert.deepEqual((await sql.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],{rolsuper:false,rolbypassrls:false});
  return {sql,directory,userId,websiteId,transactionId,async close(){await db.close();await rm(directory,{recursive:true,force:true});}};
}

test('populated ownership/deletion upgrade validates real website references as a non-superuser owner and restores FORCE RLS',async()=>{
  const f=await ownerFixture();
  try {
    await f.sql.query('BEGIN');await migrate(f.sql);await f.sql.query('COMMIT');
    const row=(await f.sql.query('SELECT website_id,amount,balance_after FROM token_transactions WHERE id=$1',[f.transactionId])).rows[0];
    assert.deepEqual(row,{website_id:f.websiteId,amount:7,balance_after:7});
    assert.equal((await f.sql.query('SELECT job_tokens FROM workspaces WHERE id=$1',[f.userId])).rows[0]!.job_tokens,7);
    assert.equal((await f.sql.query("SELECT convalidated FROM pg_constraint WHERE conname='token_transactions_website_id_deletion_fk'")).rows[0]!.convalidated,true);
    assert.equal((await f.sql.query('SELECT id FROM websites')).rows.length,0,'owner filtering must be restored after commit');
    assert.equal((await f.sql.query("SELECT relrowsecurity AND relforcerowsecurity AS protected FROM pg_class WHERE oid='websites'::regclass")).rows[0]!.protected,true);
    await f.sql.query('BEGIN');await migrate(f.sql);await f.sql.query('COMMIT');
    assert.equal((await f.sql.query("SELECT count(*)::integer AS count FROM schema_migrations WHERE name='015_account_deletion.sql'")).rows[0]!.count,1);
    await assert.rejects(f.sql.query('UPDATE token_transactions SET amount=0 WHERE id=$1',[f.transactionId]),/append-only/);
  } finally {await f.close();}
});

test('failed deletion migration rolls back its temporary owner visibility and remains safely retryable',async()=>{
  const f=await ownerFixture();
  try {
    // The fixture already contains valid website references. Inject a failure
    // after FK replacement, while the migration owner's exception is active.
    const source=await readFile('migrations/015_account_deletion.sql','utf8');
    await writeFile(join(f.directory,'015_account_deletion.sql'),source+'\nSELECT migration_failure_for_test();');
    await f.sql.query('BEGIN');
    await assert.rejects(migrate(f.sql,f.directory),/migration_failure_for_test/);
    await f.sql.query('ROLLBACK');
    assert.equal((await f.sql.query("SELECT relforcerowsecurity FROM pg_class WHERE oid='websites'::regclass")).rows[0]!.relforcerowsecurity,true);
    assert.equal((await f.sql.query('SELECT id FROM websites')).rows.length,0);
    assert.equal((await f.sql.query("SELECT name FROM schema_migrations WHERE name='015_account_deletion.sql'")).rows.length,0);
    assert.equal((await f.sql.query("SELECT column_name FROM information_schema.columns WHERE table_schema='migration_test' AND table_name='token_transactions' AND column_name='actor_deleted'")).rows.length,0);
    await f.sql.query('BEGIN');await migrate(f.sql);await f.sql.query('COMMIT');
    assert.equal((await f.sql.query('SELECT website_id FROM token_transactions WHERE id=$1',[f.transactionId])).rows[0]!.website_id,f.websiteId);
  } finally {await f.close();}
});

test('SQL editor recovery handles persisted columns and can be rerun without changing ledger data',async()=>{
  const f=await ownerFixture();
  try {
    const original=await readFile('migrations/015_account_deletion.sql','utf8');
    await f.sql.query(original.slice(0,original.indexOf('\nDO $$\nDECLARE item record; fk record;')));
    const recovery=await readFile('scripts/recover-account-deletion.sql','utf8');
    for(let attempt=0;attempt<2;attempt++) {
      await f.sql.query(recovery);
      assert.deepEqual((await f.sql.query('SELECT website_id,amount,balance_after FROM token_transactions WHERE id=$1',[f.transactionId])).rows[0],{website_id:f.websiteId,amount:7,balance_after:7});
      assert.equal((await f.sql.query("SELECT relrowsecurity AND relforcerowsecurity AS protected FROM pg_class WHERE oid='websites'::regclass")).rows[0]!.protected,true);
      assert.equal((await f.sql.query("SELECT convalidated FROM pg_constraint WHERE conname='token_transactions_website_id_deletion_fk'")).rows[0]!.convalidated,true);
    }
    await f.sql.query('BEGIN');await migrate(f.sql);await f.sql.query('COMMIT');
    assert.equal((await f.sql.query("SELECT count(*)::integer AS count FROM schema_migrations WHERE name='015_account_deletion.sql'")).rows[0]!.count,1);
  } finally {await f.close();}
});

test('SQL editor recovery rejects incompatible existing columns and rolls back RLS changes',async()=>{
  const f=await ownerFixture();
  try {
    await f.sql.query('ALTER TABLE token_transactions ADD COLUMN actor_deleted text');
    await assert.rejects(f.sql.query(await readFile('scripts/recover-account-deletion.sql','utf8')),/does not match boolean/);
    await f.sql.query('ROLLBACK');
    assert.equal((await f.sql.query("SELECT relforcerowsecurity FROM pg_class WHERE oid='websites'::regclass")).rows[0]!.relforcerowsecurity,true);
    assert.deepEqual((await f.sql.query('SELECT website_id,amount FROM token_transactions WHERE id=$1',[f.transactionId])).rows[0],{website_id:f.websiteId,amount:7});
  } finally {await f.close();}
});
