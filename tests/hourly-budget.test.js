import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createConversationAudioService,CONVERSATION_AUDIO_LIMITS} from '../server/openai-transcription.js';
test('short starts do not exhaust six-session quota and paid usage stays durable',()=>{
 const db=new DatabaseSync(':memory:'); const env={OPENAI_API_KEY:'synthetic-not-real'};
 const service=createConversationAudioService({db,env});
 const conversationId=randomUUID();
 for(let i=0;i<12;i++){const session=service.start({conversationId,ownerKey:'owner'});service.end({...session,ownerKey:'owner'});}
 db.prepare('INSERT INTO conversation_audio_requests VALUES(?,?,?,?,?,?)').run(randomUUID(),'hash','scope','pending',Date.now(),JSON.stringify({durationMs:1000}));
 service.close(); const restarted=createConversationAudioService({db,env});
 assert.equal(db.prepare('SELECT status FROM conversation_audio_requests').get().status,'uncertain');
 assert.equal(CONVERSATION_AUDIO_LIMITS.maxHourlyAudioMs,3600000);
 restarted.close();db.close();
});
