import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSaveSession} from './save-session.mjs';

function fixture(overrides={}) {
	const events=[];
	const io={preflight:()=>events.push('preflight'),capture:()=>({world:'live'}),record:()=>{},
		save:host=>events.push(`save${host}`),confirm:host=>events.push(`confirm${host}`),
		reload:(host,save)=>events.push(`reload${host}:${save}`),verify:before=>assert.equal(before.world,'live'),...overrides};
	return {events,session:createSaveSession(io,{1:'before-1.zip',2:'before-2.zip'})};
}
test('both snapshots are verified before displacement and originals are restored once',async()=>{
	const {session,events}=fixture(); await session.prepare();
	await session.enter(()=>events.push('load')); await session.restore(); await session.restore();
	assert.deepEqual(events,['preflight','save1','save2','confirm1','confirm2','load',
		'reload1:before-1.zip','reload2:before-2.zip']);
});
test('snapshot failure never permits test loading or recovery over an unchanged world',async()=>{
	const {session,events}=fixture({confirm:()=>{throw new Error('backup incomplete');}});
	await assert.rejects(session.prepare(),/backup incomplete/);
	await assert.rejects(session.enter(()=>events.push('load')),/confirmed/);
	assert.ok((await session.restore()).skipped); assert.ok(!events.includes('load'));
});
test('partial test-world loading still restores both original snapshots',async()=>{
	const {session,events}=fixture(); await session.prepare();
	await assert.rejects(session.enter(()=>{throw new Error('second host failed');}),/second host/);
	await session.restore(); assert.deepEqual(events.slice(-2),['reload1:before-1.zip','reload2:before-2.zip']);
});
test('a failed restore still recovers the other host and permits retry of the failed host',async()=>{
	let fail=true; const attempts=[];
	const {session}=fixture({reload:host=>{attempts.push(host);if(host===1&&fail)throw new Error('offline');}});
	await session.prepare(); await session.enter(()=>{}); await assert.rejects(session.restore(),/offline/);
	fail=false; assert.equal((await session.restore()).verified,true); assert.deepEqual(attempts,[1,2,1]);
});
test('world verification failure never reports restoration as verified',async()=>{
	let fail=true;
	const {session}=fixture({verify:()=>{if(fail)throw new Error('player positions changed');}});
	await session.prepare(); await session.enter(()=>{});
	await assert.rejects(session.restore(),/player positions/); fail=false;
	assert.equal((await session.restore()).verified,true);
});
