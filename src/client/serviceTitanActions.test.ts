import assert from 'node:assert/strict';
import test from 'node:test';
import { serviceTitanActions } from './serviceTitanActions';
import type { ApiHealthCheck } from '../shared/api-health';
const check = (name: string, state: ApiHealthCheck['state'], statusCode?: number): ApiHealthCheck => ({name,state,...(statusCode === undefined ? {} : {statusCode}),endpoint:`GET /${name}`,message:'Technical response'});
test('successful and unchecked endpoints produce no actions',()=>{
  assert.deepEqual(serviceTitanActions({checkedAt:'',checks:[check('Jobs','available',200),check('Attachment download','not_checked')]}),[]);
  assert.deepEqual(serviceTitanActions(undefined),[]);
});
test('only failed endpoints appear with actions appropriate to the failure',()=>{
  const actions=serviceTitanActions({checkedAt:'',checks:[check('Jobs','available',200),check('Locations','unavailable',403),check('Authentication','unavailable'),check('Notes','unavailable',429),check('History','unavailable',503)]});
  assert.deepEqual(actions.map(action=>action.name),['Locations','Authentication','Notes','History']);
  assert.match(actions[0]!.action,/allow read access to locations/);
  assert.equal(actions[0]!.endpoint,'GET /Locations');
  assert.match(actions[1]!.action,/Client ID/);
  assert.match(actions[2]!.action,/limiting requests/);
  assert.doesNotMatch(actions[3]!.action,/allow read access/);
});
