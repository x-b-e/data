import Cache from '@ember-data/json-api';
import type { StructuredDataDocument } from '@ember-data/request';
import type { NotificationType } from '@ember-data/store';
import Store from '@ember-data/store';
import type { CacheCapabilitiesManager } from '@ember-data/store/types';
import type { StableExistingRecordIdentifier, StableRecordIdentifier } from '@warp-drive/core-types/identifier';
import type { CollectionResourceDataDocument } from '@warp-drive/core-types/spec/document';
import type { CollectionResourceDocument, ResourceObject } from '@warp-drive/core-types/spec/json-api-raw';
import { module, test } from '@warp-drive/diagnostic';

import { TestSchema } from '../../utils/schema';

function asStructuredDocument<T>(doc: {
  request?: { url: string; cacheOptions?: { key?: string } };
  content: T;
}): StructuredDataDocument<T> {
  return doc as unknown as StructuredDataDocument<T>;
}

type FakeRecord = { [key: string]: unknown; destroy: () => void };

class TestStore extends Store {
  createSchemaService() {
    return new TestSchema();
  }

  override createCache(wrapper: CacheCapabilitiesManager) {
    return new Cache(wrapper);
  }

  override instantiateRecord(identifier: StableRecordIdentifier) {
    const { id, lid, type } = identifier;
    const record: FakeRecord = { id, lid, type } as unknown as FakeRecord;
    Object.assign(record, (this.cache.peek(identifier) as ResourceObject).attributes);

    const token = this.notifications.subscribe(
      identifier,
      (_: StableRecordIdentifier, kind: NotificationType, key?: string) => {
        if (kind === 'attributes' && key) {
          record[key] = this.cache.getAttr(identifier, key);
        }
      }
    );

    record.destroy = () => {
      this.notifications.unsubscribe(token);
    };

    return record;
  }

  override teardownRecord(record: FakeRecord) {
    record.destroy();
  }
}

module('Integration | @ember-data/json-api Cache.put(<CollectionDataDocument>)', function () {
  test('simple collection resource documents are correctly managed', function (assert) {
    const store = new TestStore();

    const responseDocument = store.cache.put(
      asStructuredDocument({
        content: {
          data: [
            { type: 'user', id: '1', attributes: { name: 'Chris' } },
            { type: 'user', id: '2', attributes: { name: 'Wesley' } },
          ],
        },
      })
    );
    const identifier = store.identifierCache.getOrCreateRecordIdentifier({ type: 'user', id: '1' });
    const identifier2 = store.identifierCache.getOrCreateRecordIdentifier({ type: 'user', id: '2' });

    assert.deepEqual(responseDocument.data, [identifier, identifier2], 'We were given the correct data back');
  });

  test('collection resource documents are correctly cached', function (assert) {
    const store = new TestStore();

    const responseDocument = store.cache.put(
      asStructuredDocument({
        request: { url: 'https://api.example.com/v1/users' },
        content: {
          data: [
            { type: 'user', id: '1', attributes: { name: 'Chris' } },
            { type: 'user', id: '2', attributes: { name: 'Wesley' } },
          ],
        },
      })
    );
    const identifier = store.identifierCache.getOrCreateRecordIdentifier({
      type: 'user',
      id: '1',
    }) as StableExistingRecordIdentifier;
    const identifier2 = store.identifierCache.getOrCreateRecordIdentifier({
      type: 'user',
      id: '2',
    }) as StableExistingRecordIdentifier;
    assert.equal(identifier.id, '1', 'We were given the correct data back');
    assert.equal(identifier2.id, '2', 'We were given the correct data back');

    assert.deepEqual(responseDocument.data, [identifier, identifier2], 'We were given the correct data back');

    const structuredDocument = store.cache.peekRequest({ lid: 'https://api.example.com/v1/users' });
    assert.deepEqual(
      structuredDocument as Partial<StructuredDataDocument<CollectionResourceDocument>>,
      {
        request: { url: 'https://api.example.com/v1/users' },
        content: {
          lid: 'https://api.example.com/v1/users',
          data: [identifier, identifier2],
        },
      },
      'We got the cached structured document back'
    );
    const cachedResponse = store.cache.peek({ lid: 'https://api.example.com/v1/users' });
    assert.deepEqual(
      cachedResponse,
      {
        lid: 'https://api.example.com/v1/users',
        data: [identifier, identifier2],
      },
      'We got the cached response document back'
    );
  });

  test('resources are accessible via `peek`', function (assert) {
    const store = new TestStore();

    const responseDocument = store.cache.put(
      asStructuredDocument({
        content: {
          data: [{ type: 'user', id: '1', attributes: { name: 'Chris' } }],
        },
      })
    );
    const identifier = store.identifierCache.getOrCreateRecordIdentifier({ type: 'user', id: '1' });

    assert.deepEqual(responseDocument.data, [identifier], 'We were given the correct data back');

    let resourceData = store.cache.peek(identifier);

    assert.deepEqual(
      resourceData,
      { type: 'user', id: '1', lid: '@lid:user-1', attributes: { name: 'Chris' }, relationships: {} },
      'We can fetch from the cache'
    );

    const record = store.peekRecord<{ name: string | null }>(identifier);

    assert.equal(record?.name, 'Chris', 'record name is correct');

    store.cache.setAttr(identifier, 'name', 'James');
    resourceData = store.cache.peek(identifier);

    assert.deepEqual(
      resourceData,
      { type: 'user', id: '1', lid: '@lid:user-1', attributes: { name: 'James' }, relationships: {} },
      'Resource Blob is kept updated in the cache after mutation'
    );

    store.cache.put(
      asStructuredDocument({
        content: {
          data: [{ type: 'user', id: '1', attributes: { username: '@runspired' } }],
        },
      })
    );

    resourceData = store.cache.peek(identifier);
    assert.deepEqual(
      resourceData,
      {
        type: 'user',
        id: '1',
        lid: '@lid:user-1',
        attributes: { name: 'James', username: '@runspired' },
        relationships: {},
      },
      'Resource Blob is kept updated in the cache after additional put'
    );

    store.cache.rollbackAttrs(identifier);
    resourceData = store.cache.peek(identifier);
    assert.deepEqual(
      resourceData,
      {
        type: 'user',
        id: '1',
        lid: '@lid:user-1',
        attributes: { name: 'Chris', username: '@runspired' },
        relationships: {},
      },
      'Resource Blob is kept updated in the cache after rollback'
    );
  });

  test('resource relationships are accessible via `peek`', function (assert) {
    const store = new TestStore();
    store.schema.registerResource({
      identity: null,
      type: 'user',
      fields: [
        { kind: 'attribute', name: 'name', type: null },
        {
          kind: 'belongsTo',
          type: 'user',
          name: 'bestFriend',
          options: {
            async: false,
            inverse: 'bestFriend',
          },
        },
        {
          kind: 'belongsTo',
          type: 'user',
          name: 'worstEnemy',
          options: {
            async: false,
            inverse: null,
          },
        },
        {
          kind: 'hasMany',
          type: 'user',
          name: 'friends',
          options: {
            async: false,
            inverse: 'friends',
          },
        },
      ],
    });

    let responseDocument: CollectionResourceDataDocument;
    store._run(() => {
      responseDocument = store.cache.put(
        asStructuredDocument({
          content: {
            data: [
              {
                type: 'user',
                id: '1',
                attributes: { name: 'Chris' },
                relationships: {
                  bestFriend: {
                    data: { type: 'user', id: '2' },
                  },
                  worstEnemy: {
                    data: { type: 'user', id: '3' },
                  },
                  friends: {
                    data: [
                      { type: 'user', id: '2' },
                      { type: 'user', id: '3' },
                    ],
                  },
                },
              },
            ],
            included: [
              {
                type: 'user',
                id: '2',
                attributes: { name: 'Wesley' },
                relationships: {
                  bestFriend: {
                    data: { type: 'user', id: '1' },
                  },
                  friends: {
                    data: [
                      { type: 'user', id: '1' },
                      { type: 'user', id: '3' },
                    ],
                  },
                },
              },
              {
                type: 'user',
                id: '3',
                attributes: { name: 'Rey' },
                relationships: {
                  bestFriend: {
                    data: null,
                  },
                  friends: {
                    data: [
                      { type: 'user', id: '1' },
                      { type: 'user', id: '2' },
                    ],
                  },
                },
              },
            ],
          },
        })
      );
    });
    const identifier1 = store.identifierCache.getOrCreateRecordIdentifier({ type: 'user', id: '1' });
    const identifier2 = store.identifierCache.getOrCreateRecordIdentifier({ type: 'user', id: '2' });
    const identifier3 = store.identifierCache.getOrCreateRecordIdentifier({ type: 'user', id: '3' });

    assert.deepEqual(responseDocument!.data, [identifier1], 'We were given the correct data back');

    const resourceData1 = store.cache.peek(identifier1);
    const resourceData2 = store.cache.peek(identifier2);
    const resourceData3 = store.cache.peek(identifier3);

    assert.deepEqual(
      resourceData1,
      {
        type: 'user',
        id: '1',
        lid: '@lid:user-1',
        attributes: { name: 'Chris' },
        relationships: {
          bestFriend: {
            data: identifier2,
          },
          friends: {
            data: [identifier2, identifier3],
          },
          worstEnemy: {
            data: identifier3,
          },
        },
      },
      'We can fetch from the cache'
    );
    assert.deepEqual(
      resourceData2,
      {
        type: 'user',
        id: '2',
        lid: '@lid:user-2',
        attributes: { name: 'Wesley' },
        relationships: {
          bestFriend: {
            data: identifier1,
          },
          friends: {
            data: [identifier1, identifier3],
          },
        },
      },
      'We can fetch included data from the cache'
    );
    assert.deepEqual(
      resourceData3,
      {
        type: 'user',
        id: '3',
        lid: '@lid:user-3',
        attributes: { name: 'Rey' },
        relationships: {
          bestFriend: {
            data: null,
          },
          friends: {
            data: [identifier1, identifier2],
          },
        },
      },
      'We can fetch more included data from the cache'
    );
  });
});
