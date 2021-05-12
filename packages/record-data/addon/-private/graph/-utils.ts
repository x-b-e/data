import { assert, inspect, warn } from '@ember/debug';

import { coerceId, recordDataFor as peekRecordData } from '@ember-data/store/-private';

type RecordDataStoreWrapper = import('@ember-data/store/-private/ts-interfaces/record-data-store-wrapper').RecordDataStoreWrapper;

type Graph = import('./index').Graph;
type RecordData = import('@ember-data/store/-private/ts-interfaces/record-data').RecordData;
type RelationshipRecordData = import('../ts-interfaces/relationship-record-data').RelationshipRecordData;
type StableRecordIdentifier = import('@ember-data/store/-private/ts-interfaces/identifier').StableRecordIdentifier;
type ImplicitRelationship = import('../relationships/state/implicit').default;
type ManyRelationship = import('../relationships/state/has-many').default;
type BelongsToRelationship = import('../relationships/state/belongs-to').default;
type UpdateRelationshipOperation = import('./-operations').UpdateRelationshipOperation;
type Dict<T> = import('@ember-data/store/-private/ts-interfaces/utils').Dict<T>;

export function expandingGet<T>(cache: Dict<Dict<T>>, key1: string, key2: string): T | undefined {
  let mainCache = (cache[key1] = cache[key1] || Object.create(null));
  return mainCache[key2];
}

export function expandingSet<T>(cache: Dict<Dict<T>>, key1: string, key2: string, value: T): void {
  let mainCache = (cache[key1] = cache[key1] || Object.create(null));
  mainCache[key2] = value;
}

export function assertValidRelationshipPayload(graph: Graph, op: UpdateRelationshipOperation) {
  const relationship = graph.get(op.record, op.field);
  assert(`Cannot update an implicit relationship`, isHasMany(relationship) || isBelongsTo(relationship));
  const payload = op.value;
  const { definition, identifier, state } = relationship;
  const { type } = identifier;
  const { field } = op;
  const { isAsync, kind } = definition;

  if (payload.links) {
    warn(
      `You pushed a record of type '${type}' with a relationship '${field}' configured as 'async: false'. You've included a link but no primary data, this may be an error in your payload. EmberData will treat this relationship as known-to-be-empty.`,
      isAsync || !!payload.data || state.hasReceivedData,
      {
        id: 'ds.store.push-link-for-sync-relationship',
      }
    );
  } else if (payload.data) {
    if (kind === 'belongsTo') {
      assert(
        `A ${type} record was pushed into the store with the value of ${field} being ${inspect(
          payload.data
        )}, but ${field} is a belongsTo relationship so the value must not be an array. You should probably check your data payload or serializer.`,
        !Array.isArray(payload.data)
      );
      assertRelationshipData(graph.store._store, identifier, payload.data, definition);
    } else if (kind === 'hasMany') {
      assert(
        `A ${type} record was pushed into the store with the value of ${field} being '${inspect(
          payload.data
        )}', but ${field} is a hasMany relationship so the value must be an array. You should probably check your data payload or serializer.`,
        Array.isArray(payload.data)
      );
      if (Array.isArray(payload.data)) {
        for (let i = 0; i < payload.data.length; i++) {
          assertRelationshipData(graph.store._store, identifier, payload.data[i], definition);
        }
      }
    }
  }
}

export function isNew(identifier: StableRecordIdentifier): boolean {
  if (!identifier.id) {
    return true;
  }
  const recordData = peekRecordData(identifier);
  return recordData ? isRelationshipRecordData(recordData) && recordData.isNew() : false;
}

function isRelationshipRecordData(
  recordData: RecordData | RelationshipRecordData
): recordData is RelationshipRecordData {
  return typeof (recordData as RelationshipRecordData).isNew === 'function';
}

export function isBelongsTo(
  relationship: ManyRelationship | ImplicitRelationship | BelongsToRelationship
): relationship is BelongsToRelationship {
  return relationship.definition.kind === 'belongsTo';
}

export function isImplicit(
  relationship: ManyRelationship | ImplicitRelationship | BelongsToRelationship
): relationship is ImplicitRelationship {
  return relationship.definition.isImplicit;
}

export function isHasMany(
  relationship: ManyRelationship | ImplicitRelationship | BelongsToRelationship
): relationship is ManyRelationship {
  return relationship.definition.kind === 'hasMany';
}

export function assertRelationshipData(store, identifier, data, meta) {
  assert(
    `A ${identifier.type} record was pushed into the store with the value of ${meta.key} being '${JSON.stringify(
      data
    )}', but ${
      meta.key
    } is a belongsTo relationship so the value must not be an array. You should probably check your data payload or serializer.`,
    !Array.isArray(data)
  );
  assert(
    `Encountered a relationship identifier without a type for the ${meta.kind} relationship '${meta.key}' on <${
      identifier.type
    }:${identifier.id}>, expected a json-api identifier with type '${meta.type}' but found '${JSON.stringify(
      data
    )}'. Please check your serializer and make sure it is serializing the relationship payload into a JSON API format.`,
    data === null || (typeof data.type === 'string' && data.type.length)
  );
  assert(
    `Encountered a relationship identifier without an id for the ${meta.kind} relationship '${meta.key}' on <${
      identifier.type
    }:${identifier.id}>, expected a json-api identifier but found '${JSON.stringify(
      data
    )}'. Please check your serializer and make sure it is serializing the relationship payload into a JSON API format.`,
    data === null || !!coerceId(data.id)
  );
  assert(
    `Encountered a relationship identifier with type '${data.type}' for the ${meta.kind} relationship '${meta.key}' on <${identifier.type}:${identifier.id}>, Expected a json-api identifier with type '${meta.type}'. No model was found for '${data.type}'.`,
    data === null || !data.type || store._hasModelFor(data.type)
  );
}

export function forAllRelatedIdentifiers(
  rel: BelongsToRelationship | ManyRelationship | ImplicitRelationship,
  cb: (identifier: StableRecordIdentifier) => void
): void {
  if (isBelongsTo(rel)) {
    if (rel.remoteState) {
      cb(rel.remoteState);
    }
    if (rel.localState && rel.localState !== rel.remoteState) {
      cb(rel.localState);
    }
  } else if (isHasMany(rel)) {
    // ensure we don't walk anything twice if an entry is
    // in both members and canonicalMembers
    let seen = Object.create(null);

    for (let i = 0; i < rel.currentState.length; i++) {
      const inverseIdentifier = rel.currentState[i];
      const id = inverseIdentifier.lid;
      if (!seen[id]) {
        seen[id] = true;
        cb(inverseIdentifier);
      }
    }

    for (let i = 0; i < rel.canonicalState.length; i++) {
      const inverseIdentifier = rel.canonicalState[i];
      const id = inverseIdentifier.lid;
      if (!seen[id]) {
        seen[id] = true;
        cb(inverseIdentifier);
      }
    }
  } else {
    let seen = Object.create(null);
    rel.members.forEach((inverseIdentifier) => {
      const id = inverseIdentifier.lid;
      if (!seen[id]) {
        seen[id] = true;
        cb(inverseIdentifier);
      }
    });
    rel.canonicalMembers.forEach((inverseIdentifier) => {
      const id = inverseIdentifier.lid;
      if (!seen[id]) {
        seen[id] = true;
        cb(inverseIdentifier);
      }
    });
  }
}

export function notifyInverseOfDematerialization(
  graph: Graph,
  inverseIdentifier: StableRecordIdentifier,
  inverseKey: string,
  identifier: StableRecordIdentifier
): void {
  if (!inverseIdentifier || !graph.has(inverseIdentifier, inverseKey)) {
    return;
  }

  let relationship = graph.get(inverseIdentifier, inverseKey);
  assert(`expected no implicit`, !isImplicit(relationship));

  // For canonical state of a belongsTo, it is possible that inverseIdentifier has
  // already been associated to to another record. For such cases, do not notify the
  // demterialization.
  if (!isBelongsTo(relationship) || !relationship.localState || identifier === relationship.localState) {
    removeDematerializedInverse(relationship, identifier);
  }
}

/*
    Removes the given RecordData from BOTH canonical AND current state.

    This method is useful when either a deletion or a rollback on a new record
    needs to entirely purge itself from an inverse relationship.
  */
export function removeIdentifierCompletelyFromRelationship(
  relationship: ManyRelationship | BelongsToRelationship | ImplicitRelationship,
  inverseIdentifier: StableRecordIdentifier
) {
  if (isBelongsTo(relationship)) {
    if (relationship.remoteState === inverseIdentifier) {
      relationship.remoteState = null;
    }

    if (relationship.localState === inverseIdentifier) {
      relationship.localState = null;
      // This allows dematerialized inverses to be rematerialized
      // we shouldn't be notifying here though, figure out where
      // a notification was missed elsewhere.
      notifyRelationshipChanged(relationship.store, relationship);
    }
  } else if (isHasMany(relationship)) {
    relationship.canonicalMembers.delete(inverseIdentifier);
    relationship.members.delete(inverseIdentifier);

    const canonicalIndex = relationship.canonicalState.indexOf(inverseIdentifier);
    if (canonicalIndex !== -1) {
      relationship.canonicalState.splice(canonicalIndex, 1);
    }

    const currentIndex = relationship.currentState.indexOf(inverseIdentifier);
    if (currentIndex !== -1) {
      relationship.currentState.splice(currentIndex, 1);
      // This allows dematerialized inverses to be rematerialized
      // we shouldn't be notifying here though, figure out where
      // a notification was missed elsewhere.
      notifyRelationshipChanged(relationship.store, relationship);
    }
  } else {
    relationship.canonicalMembers.delete(inverseIdentifier);
    relationship.members.delete(inverseIdentifier);
  }
}

function removeDematerializedInverse(
  relationship: ManyRelationship | BelongsToRelationship,
  inverseIdentifier: StableRecordIdentifier
) {
  if (isHasMany(relationship)) {
    if (!relationship.definition.isAsync || (inverseIdentifier && isNew(inverseIdentifier))) {
      // unloading inverse of a sync relationship is treated as a client-side
      // delete, so actually remove the models don't merely invalidate the cp
      // cache.
      // if the record being unloaded only exists on the client, we similarly
      // treat it as a client side delete
      removeIdentifierCompletelyFromRelationship(relationship, inverseIdentifier);
    } else {
      relationship.state.hasDematerializedInverse = true;
    }

    notifyRelationshipChanged(relationship.store, relationship);
  } else {
    assert(
      `Expected localState to match the identifier being dematerialized`,
      relationship.localState === inverseIdentifier && inverseIdentifier
    );
    if (!relationship.definition.isAsync || (inverseIdentifier && isNew(inverseIdentifier))) {
      // unloading inverse of a sync relationship is treated as a client-side
      // delete, so actually remove the models don't merely invalidate the cp
      // cache.
      // if the record being unloaded only exists on the client, we similarly
      // treat it as a client side delete
      if (inverseIdentifier !== null) {
        relationship.localState = null;
      }

      if (relationship.remoteState === inverseIdentifier && inverseIdentifier !== null) {
        relationship.remoteState = null;
        relationship.state.hasReceivedData = true;
        relationship.state.isEmpty = true;
        if (relationship.localState && !isNew(relationship.localState)) {
          relationship.localState = null;
        }
      }
    } else {
      relationship.state.hasDematerializedInverse = true;
    }
    notifyRelationshipChanged(relationship.store, relationship);
  }
}

export function notifyRelationshipChanged(
  store: RecordDataStoreWrapper,
  relationship: BelongsToRelationship | ManyRelationship
) {
  const { type, id, lid } = relationship.identifier;
  const { key, kind } = relationship.definition;

  if (kind === 'hasMany') {
    store.notifyHasManyChange(type, id, lid, key);
  } else {
    store.notifyBelongsToChange(type, id, lid, key);
  }
}
