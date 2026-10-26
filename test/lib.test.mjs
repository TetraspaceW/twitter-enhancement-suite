import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/lib.js';

const { extractUsers, restUser, bottomCursor, waitMs, needsSync, merge } = globalThis.TES;

// Trimmed from a real BlockedAccountsAll response (October 2026).
const user = (id, sn) => ({
  entryId: 'user-' + id,
  content: {
    itemContent: {
      user_results: {
        result: {
          __typename: 'User',
          rest_id: id,
          core: { created_at: '', name: sn.toUpperCase(), screen_name: sn },
          relationship_perspectives: { blocking: true, blocked_by: false, following: false },
        },
      },
    },
  },
});
const page = {
  data: { viewer: { timeline: { timeline: { instructions: [{
    type: 'TimelineAddEntries',
    entries: [
      user('1', 'alice'),
      user('2', 'bob'),
      { entryId: 'cursor-bottom-x', content: { __typename: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'NEXT' } },
      { entryId: 'cursor-top-x', content: { __typename: 'TimelineTimelineCursor', cursorType: 'Top', value: 'PREV' } },
    ],
  }] } } } },
};

test('extractUsers reads GraphQL user objects', () => {
  assert.deepEqual(extractUsers(page), [
    { id: '1', sn: 'alice', nm: 'ALICE', blocking: true },
    { id: '2', sn: 'bob', nm: 'BOB', blocking: true },
  ]);
});

test('extractUsers falls back to legacy fields', () => {
  assert.deepEqual(extractUsers({ rest_id: '3', legacy: { screen_name: 'c', name: 'C', blocking: false } }),
    [{ id: '3', sn: 'c', nm: 'C', blocking: false }]);
});

test('bottomCursor finds the next page', () => {
  assert.equal(bottomCursor(page), 'NEXT');
  assert.equal(bottomCursor({ data: {} }), null);
});

test('restUser reads v1.1 user objects', () => {
  assert.deepEqual(restUser({ id_str: '9', screen_name: 'z', name: 'Z' }), { id: '9', sn: 'z', nm: 'Z' });
  assert.equal(restUser({ errors: [] }), null);
});

test('waitMs enforces every window', () => {
  const limits = [[2, 1000], [3, 10000]];
  assert.equal(waitMs([], 0, limits), 0);
  assert.equal(waitMs([0], 10, limits), 0);
  assert.equal(waitMs([0, 100], 200, limits), 801); // short window full until t=1000
  assert.equal(waitMs([0, 100], 1100, limits), 0);
  assert.equal(waitMs([0, 1100, 1200], 1300, limits), 8701); // long window full until t=10000
  assert.equal(waitMs([0, 1100, 1200], 10001, limits), 0);
});

test('merge is last-writer-wins per user', () => {
  const local = {
    a: { sn: 'a', tags: ['x'], note: '', t: 5 },
    b: { sn: 'b', tags: ['old'], note: '', t: 1 },
  };
  const remote = {
    b: { sn: 'b', tags: ['new'], note: '', t: 2 },
    c: { sn: 'c', tags: ['y'], note: '', t: 3 },
    d: { sn: 'd', tags: [], note: '', t: 4 }, // a cleared reason for someone we never knew
  };
  const { merged, toLocal, dirty } = merge(local, remote);
  assert.equal(dirty, true);
  assert.deepEqual(Object.keys(merged).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(merged.b.tags, ['new']);
  assert.deepEqual(toLocal.map(r => r.id).sort(), ['b', 'c']);
});

test('merge of identical sides changes nothing', () => {
  const side = { a: { sn: 'a', tags: ['x'], note: '', t: 5 } };
  const { toLocal, dirty } = merge(side, structuredClone(side));
  assert.equal(dirty, false);
  assert.deepEqual(toLocal, []);
});

test('needsSync ignores untagged records coming and going', () => {
  const plain = { id: '1', sn: 'a', b: 1, tags: [], note: '', t: 0 };
  assert.equal(needsSync('u:1', { newValue: plain }), false);                         // found by a scan
  assert.equal(needsSync('u:1', { oldValue: plain }), false);                         // unblocked and dropped
  assert.equal(needsSync('u:1', { oldValue: plain, newValue: { ...plain, sn: 'b' } }), false); // renamed
  assert.equal(needsSync('u:1', { oldValue: plain, newValue: { ...plain, tags: ['x'], t: 5 } }), true);
  assert.equal(needsSync('settings', { oldValue: { rt: 1 }, newValue: { rt: 1, gistId: 'g' } }), false);
  assert.equal(needsSync('settings', { oldValue: { rt: 1 }, newValue: { rt: 2 } }), true);
  assert.equal(needsSync('ulog', { newValue: [1] }), false);
});
