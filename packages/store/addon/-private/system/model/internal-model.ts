import { A, default as EmberArray } from '@ember/array';
import { assert, inspect } from '@ember/debug';
import EmberError from '@ember/error';
import { get } from '@ember/object';
import { _backburner as emberBackburner, cancel, run } from '@ember/runloop';
import type { EmberRunTimer } from '@ember/runloop/types';
import { DEBUG } from '@glimmer/env';

import { importSync } from '@embroider/macros';
import RSVP, { resolve } from 'rsvp';

import type { ManyArray } from '@ember-data/model/-private';
import RecordState from '@ember-data/model/-private/record-state';
import type { ManyArrayCreateArgs } from '@ember-data/model/-private/system/many-array';
import type {
  BelongsToProxyCreateArgs,
  BelongsToProxyMeta,
} from '@ember-data/model/-private/system/promise-belongs-to';
import type PromiseBelongsTo from '@ember-data/model/-private/system/promise-belongs-to';
import type { HasManyProxyCreateArgs } from '@ember-data/model/-private/system/promise-many-array';
import type PromiseManyArray from '@ember-data/model/-private/system/promise-many-array';
import { HAS_MODEL_PACKAGE, HAS_RECORD_DATA_PACKAGE } from '@ember-data/private-build-infra';
import type {
  BelongsToRelationship,
  ManyRelationship,
  RecordData as DefaultRecordData,
} from '@ember-data/record-data/-private';
import type { UpgradedRelationshipMeta } from '@ember-data/record-data/-private/graph/-edge-definition';
import type {
  DefaultSingleResourceRelationship,
  RelationshipRecordData,
} from '@ember-data/record-data/-private/ts-interfaces/relationship-record-data';
import type { ResolvedRegistry } from '@ember-data/types';
import type {
  BelongsToRelationshipFieldsFor,
  HasManyRelationshipFieldsFor,
  RecordField,
  RecordInstance,
  RecordType,
  RelatedType,
  RelationshipFieldsFor,
} from '@ember-data/types/utils';

import type { DSModel } from '../../ts-interfaces/ds-model';
import type { StableRecordIdentifier } from '../../ts-interfaces/identifier';
import type { ChangedAttributesHash, RecordData } from '../../ts-interfaces/record-data';
import type { JsonApiResource, JsonApiValidationError } from '../../ts-interfaces/record-data-json-api';
import type { RelationshipSchema } from '../../ts-interfaces/record-data-schemas';
import type { FindOptions } from '../../ts-interfaces/store';
import type { Dict } from '../../ts-interfaces/utils';
import { errorsHashToArray } from '../errors-utils';
import { PromiseObject } from '../promise-proxies';
import recordDataFor from '../record-data-for';
import { BelongsToReference, HasManyReference, RecordReference } from '../references';
import Snapshot from '../snapshot';
import type Store from '../store';
import type { CreateRecordProperties } from '../store';
import { internalModelFactoryFor } from '../store/internal-model-factory';
import RootState from './states';

type PrivateModelModule = {
  ManyArray: {
    create<R extends ResolvedRegistry, T extends RecordType<R>, F extends RecordField<R, T>, RT extends RecordType<R>>(
      args: ManyArrayCreateArgs<R, T, F, RT>
    ): ManyArray<R, T, F, RT>;
  };
  PromiseBelongsTo: {
    create<R extends ResolvedRegistry, T extends RecordType<R>, F extends RecordField<R, T>, RT extends RecordType<R>>(
      args: BelongsToProxyCreateArgs<R, T, F, RT>
    ): PromiseBelongsTo<R, T, F, RT>;
  };
  PromiseManyArray: new (...args: unknown[]) => PromiseManyArray;
};

/**
  @module @ember-data/store
*/

const { hasOwnProperty } = Object.prototype;

let _ManyArray: PrivateModelModule['ManyArray'];
let _PromiseBelongsTo: PrivateModelModule['PromiseBelongsTo'];
let _PromiseManyArray: PrivateModelModule['PromiseManyArray'];

let _found = false;
let _getModelPackage: () => boolean;
if (HAS_MODEL_PACKAGE) {
  _getModelPackage = function () {
    if (!_found) {
      let modelPackage = importSync('@ember-data/model/-private') as PrivateModelModule;
      ({
        ManyArray: _ManyArray,
        PromiseBelongsTo: _PromiseBelongsTo,
        PromiseManyArray: _PromiseManyArray,
      } = modelPackage);
      if (_ManyArray && _PromiseBelongsTo && _PromiseManyArray) {
        _found = true;
      }
    }
    return _found;
  };
}

function assertIs<Expected>(msg: string, cond: unknown, thing: unknown | Expected): asserts thing is Expected {
  assert(msg, cond);
}

/*
  The TransitionChainMap caches the `state.enters`, `state.setups`, and final state reached
  when transitioning from one state to another, so that future transitions can replay the
  transition without needing to walk the state tree, collect these hook calls and determine
   the state to transition into.

   A future optimization would be to build a single chained method out of the collected enters
   and setups. It may also be faster to do a two level cache (from: { to }) instead of caching based
   on a key that adds the two together.
 */
// TODO before deleting the state machine we should
// ensure all things in this map were properly accounted for.
// in the RecordState class.
const TransitionChainMap = Object.create(null);

const _extractPivotNameCache = Object.create(null);
const _splitOnDotCache = Object.create(null);

function splitOnDot(name: string): string[] {
  return _splitOnDotCache[name] || (_splitOnDotCache[name] = name.split('.'));
}

function extractPivotName(name: string): string {
  return _extractPivotNameCache[name] || (_extractPivotNameCache[name] = splitOnDot(name)[0]);
}

function isDSModel<R extends ResolvedRegistry, T extends RecordType<R>>(
  record: RecordInstance<R, T> | DSModel<R, T> | null
): record is DSModel<R, T> {
  return (
    HAS_MODEL_PACKAGE &&
    !!record &&
    'constructor' in record &&
    'isModel' in record.constructor &&
    record.constructor.isModel === true
  );
}
export default class InternalModel<R extends ResolvedRegistry, T extends RecordType<R>> {
  declare _id: string | null;
  declare modelName: T;
  declare clientId: string;
  declare __recordData: RecordData<R, T> | null;
  declare _isDestroyed: boolean;
  declare isError: boolean;
  declare _pendingRecordArrayManagerFlush: boolean;
  declare _isDematerializing: boolean;
  declare _doNotDestroy: boolean;
  declare isDestroying: boolean;
  declare _isUpdatingId: boolean;
  declare _deletedRecordWasNew: boolean;

  // Not typed yet
  declare _promiseProxy: PromiseObject<RecordInstance<R, T>> | null;
  declare _record: RecordInstance<R, T> | null;
  declare _scheduledDestroy: EmberRunTimer | null;
  declare _modelClass: unknown;
  declare __recordArrays: unknown;
  declare references: {
    [F in RelationshipFieldsFor<R, T>]: F extends BelongsToRelationshipFieldsFor<R, T>
      ? BelongsToRelationship<R, T, F>
      : F extends HasManyRelationshipFieldsFor<R, T>
      ? HasManyReference<R, T, F>
      : never;
  };
  declare _recordReference: RecordReference;
  declare _manyArrayCache: Dict<ManyArray<R, T>>;

  declare _relationshipPromisesCache: Dict<Promise<ManyArray<R, T> | RecordInstance<R, T>>>;
  declare _relationshipProxyCache: Dict<PromiseManyArray | PromiseBelongsTo<R, T, RecordField<R, T>, RecordType<R>>>;
  declare error: unknown;
  declare currentState: RecordState;
  declare _previousState: unknown;
  declare store: Store<R>;
  declare identifier: StableRecordIdentifier<T>;

  constructor(store: Store<R>, identifier: StableRecordIdentifier<T>) {
    if (HAS_MODEL_PACKAGE) {
      _getModelPackage();
    }
    this.store = store;
    this.identifier = identifier;
    this._id = identifier.id;
    this._isUpdatingId = false;
    this.modelName = identifier.type;
    this.clientId = identifier.lid;

    this.__recordData = null;

    this._promiseProxy = null;
    this._isDestroyed = false;
    this._doNotDestroy = false;
    this.isError = false;
    this._pendingRecordArrayManagerFlush = false; // used by the recordArrayManager

    // During dematerialization we don't want to rematerialize the record.  The
    // reason this might happen is that dematerialization removes records from
    // record arrays,  and Ember arrays will always `objectAt(0)` and
    // `objectAt(len - 1)` to test whether or not `firstObject` or `lastObject`
    // have changed.
    this._isDematerializing = false;
    this._scheduledDestroy = null;

    this._record = null;
    this.error = null;

    // caches for lazy getters
    this._modelClass = null;
    this.__recordArrays = null;
    this._recordReference = null;
    this.__recordData = null;

    this.error = null;

    // other caches
    // class fields have [[DEFINE]] semantics which are significantly slower than [[SET]] semantics here
    this._manyArrayCache = Object.create(null);
    this._relationshipPromisesCache = Object.create(null);
    this._relationshipProxyCache = Object.create(null);
    this.references = Object.create(null);
    this.currentState = RootState.empty;
  }

  get id(): string | null {
    return this.identifier.id;
  }
  set id(value: string | null) {
    if (value !== this._id) {
      let newIdentifier = { type: this.identifier.type, lid: this.identifier.lid, id: value };
      this.store.identifierCache.updateRecordIdentifier(this.identifier, newIdentifier);
      this.notifyPropertyChange('id');
    }
  }

  get modelClass() {
    if (this.store.modelFor) {
      return this._modelClass || (this._modelClass = this.store.modelFor(this.modelName));
    }
  }

  get recordReference(): RecordReference {
    if (this._recordReference === null) {
      this._recordReference = new RecordReference(this.store, this.identifier);
    }
    return this._recordReference;
  }

  get _recordData(): RecordData<R, T> {
    if (this.__recordData === null) {
      let recordData = this.store._createRecordData(this.identifier);
      this.__recordData = recordData;
      return recordData;
    }
    return this.__recordData;
  }

  set _recordData(newValue) {
    this.__recordData = newValue;
  }

  isHiddenFromRecordArrays() {
    // During dematerialization we don't want to rematerialize the record.
    // recordWasDeleted can cause other records to rematerialize because it
    // removes the internal model from the array and Ember arrays will always
    // `objectAt(0)` and `objectAt(len -1)` to check whether `firstObject` or
    // `lastObject` have changed.  When this happens we don't want those
    // models to rematerialize their records.

    // eager checks to avoid instantiating record data if we are empty or loading
    if (this.currentState.isEmpty) {
      return true;
    }

    if (this.currentState.isLoading) {
      return false;
    }

    let isRecordFullyDeleted = this._isRecordFullyDeleted();
    return this._isDematerializing || this.hasScheduledDestroy() || this.isDestroyed || isRecordFullyDeleted;
  }

  _isRecordFullyDeleted(): boolean {
    if (this._recordData.isDeletionCommitted && this._recordData.isDeletionCommitted()) {
      return true;
    } else if (
      this._recordData.isNew &&
      this._recordData.isDeleted &&
      this._recordData.isNew() &&
      this._recordData.isDeleted()
    ) {
      return true;
    } else {
      return this.currentState.stateName === 'root.deleted.saved';
    }
  }

  isDeleted(): boolean {
    if (this._recordData.isDeleted) {
      return this._recordData.isDeleted();
    } else {
      return this.currentState.isDeleted;
    }
  }

  isNew(): boolean {
    if (this._recordData.isNew) {
      return this._recordData.isNew();
    } else {
      return this.currentState.isNew;
    }
  }

  getRecord(properties?: CreateRecordProperties): RecordInstance<R, T> {
    let record = this._record;

    if (this._isDematerializing) {
      // TODO we should assert here instead of this return.
      return null as unknown as RecordInstance<R, T>;
    }

    if (!record) {
      let { store } = this;

      this._record = record = store._instantiateRecord<T>(
        this,
        this.modelName,
        this._recordData,
        this.identifier,
        properties
      );
    }

    return record;
  }

  dematerializeRecord() {
    this._isDematerializing = true;

    // TODO IGOR add a test that fails when this is missing, something that involves canceling a destroy
    // and the destroy not happening, and then later on trying to destroy
    this._doNotDestroy = false;
    // this has to occur before the internal model is removed
    // for legacy compat.
    if (this._record) {
      this.store.teardownRecord(this._record);
    }

    // move to an empty never-loaded state
    // ensure any record notifications happen prior to us
    // unseting the record but after we've triggered
    // destroy
    this.store._backburner.join(() => {
      this._recordData.unloadRecord();
    });

    if (this._record) {
      let keys = Object.keys(this._relationshipProxyCache);
      keys.forEach((key) => {
        let proxy = this._relationshipProxyCache[key]!;
        if (proxy.destroy) {
          proxy.destroy();
        }
        delete this._relationshipProxyCache[key];
      });
    }

    this._record = null;
    this.error = null;
    this._previousState = this.currentState;
    this.currentState = RootState.empty;
    this.store.recordArrayManager.recordDidChange(this.identifier);
  }

  deleteRecord() {
    run(() => {
      const backburner = this.store._backburner;
      backburner.run(() => {
        if (this._recordData.setIsDeleted) {
          this._recordData.setIsDeleted(true);
        }

        if (this.isNew()) {
          // destroyRecord follows up deleteRecord with save(). This prevents an unecessary save for a new record
          this._deletedRecordWasNew = true;
          this.send('deleteRecord');
          this.unloadRecord();
        } else {
          this.send('deleteRecord');
        }
      });
    });
  }

  save(options: FindOptions = {}): Promise<void> {
    if (this._deletedRecordWasNew) {
      return resolve();
    }
    let promiseLabel = 'DS: Model#save ' + this;
    let resolver = RSVP.defer<void>(promiseLabel);

    // Casting to promise to narrow due to the feature flag paths inside scheduleSave
    return this.store.scheduleSave(this, resolver, options) as Promise<void>;
  }

  reload(options: Dict<unknown> = {}): Promise<InternalModel<R, T>> {
    return this.store._reloadRecord(this, options);
  }

  /*
    Unload the record for this internal model. This will cause the record to be
    destroyed and freed up for garbage collection. It will also do a check
    for cleaning up internal models.

    This check is performed by first computing the set of related internal
    models. If all records in this set are unloaded, then the entire set is
    destroyed. Otherwise, nothing in the set is destroyed.

    This means that this internal model will be freed up for garbage collection
    once all models that refer to it via some relationship are also unloaded.
  */
  unloadRecord() {
    if (this.isDestroyed) {
      return;
    }
    this.send('unloadRecord');
    this.dematerializeRecord();
    if (this._scheduledDestroy === null) {
      this._scheduledDestroy = emberBackburner.schedule('destroy', this, '_checkForOrphanedInternalModels');
    }
  }

  hasScheduledDestroy() {
    return !!this._scheduledDestroy;
  }

  cancelDestroy() {
    assert(
      `You cannot cancel the destruction of an InternalModel once it has already been destroyed`,
      !this.isDestroyed
    );

    this._doNotDestroy = true;
    this._isDematerializing = false;
    if (this._scheduledDestroy !== null) {
      cancel(this._scheduledDestroy);
      this._scheduledDestroy = null;
    }
  }

  // typically, we prefer to async destroy this lets us batch cleanup work.
  // Unfortunately, some scenarios where that is not possible. Such as:
  //
  // ```js
  // const record = store.findRecord(‘record’, 1);
  // record.unloadRecord();
  // store.createRecord(‘record’, 1);
  // ```
  //
  // In those scenarios, we make that model's cleanup work, sync.
  //
  destroySync() {
    if (this._isDematerializing) {
      this.cancelDestroy();
    }
    this._checkForOrphanedInternalModels();
    if (this.isDestroyed || this.isDestroying) {
      return;
    }

    // just in-case we are not one of the orphaned, we should still
    // still destroy ourselves
    this.destroy();
  }

  _checkForOrphanedInternalModels() {
    this._isDematerializing = false;
    this._scheduledDestroy = null;
    if (this.isDestroyed) {
      return;
    }
  }

  _findBelongsTo<K extends BelongsToRelationshipFieldsFor<R, T>, RT extends RecordType<R>>(
    key: K,
    resource: DefaultSingleResourceRelationship<R, T, K, RT>,
    relationshipMeta: RelationshipSchema<R, T, K, RT>,
    options?: Dict<unknown>
  ): Promise<RecordInstance<R, RT> | null> {
    // TODO @runspired follow up if parent isNew then we should not be attempting load here
    // TODO @runspired follow up on whether this should be in the relationship requests cache
    const relationship = resource._relationship;
    return this.store._findBelongsToByJsonApiResource<T, K, RT>(resource, this, relationshipMeta, options).then(
      (internalModel: InternalModel<R, RT> | null) =>
        handleCompletedRelationshipRequest<R, T, K, RT>(this, key, relationship, internalModel),
      (e: Error) => handleCompletedRelationshipRequest<R, T, K, RT>(this, key, relationship, null, e)
    );
  }

  getBelongsTo<K extends BelongsToRelationshipFieldsFor<R, T>, RT extends RecordType<R> = RecordType<R>>(
    key: K,
    options?: Dict<unknown>
  ): PromiseBelongsTo<R, T, K, RT> | RecordInstance<R, RT> | null {
    assertIs<DefaultRecordData<R, T>>(
      `Expected the RecordData instance for ${this.modelName} to be an intance of @ember-data/record-data when using @ember-data/model belongsTo relationship.`,
      '_bfsId' in this._recordData, // TODO come up with a more sure check
      this._recordData
    );
    let resource = this._recordData.getBelongsTo(key) as DefaultSingleResourceRelationship<R, T, K, RT>;
    let identifier =
      resource && resource.data ? this.store.identifierCache.getOrCreateRecordIdentifier<RT>(resource.data) : null;
    let relationshipMeta = this.store._relationshipMetaFor<T, K, RT>(this.modelName, null, key);
    assert(`Attempted to access a belongsTo relationship but no definition exists for it`, relationshipMeta);

    let store = this.store;
    let parentInternalModel = this;
    let async = relationshipMeta.options.async;
    let isAsync = typeof async === 'undefined' ? true : async;
    let _belongsToState: BelongsToProxyMeta<R, T, K, RT> = {
      key,
      store,
      originatingInternalModel: this,
      modelName: relationshipMeta.type,
    };

    if (isAsync) {
      let internalModel = identifier !== null ? store._internalModelForResource(identifier) : null;

      if (resource._relationship.state.hasFailedLoadAttempt) {
        return this._relationshipProxyCache[key] as PromiseBelongsTo<R, T, K, RT>;
      }

      let promise = this._findBelongsTo<K, RT>(key, resource, relationshipMeta, options);

      return this._updatePromiseProxyFor('belongsTo', key, {
        promise,
        content: internalModel ? internalModel.getRecord() : null,
        _belongsToState,
      });
    } else {
      if (identifier === null) {
        return null;
      } else {
        let internalModel = store._internalModelForResource(identifier);
        let toReturn = internalModel.getRecord();
        assert(
          "You looked up the '" +
            key +
            "' relationship on a '" +
            parentInternalModel.modelName +
            "' with id " +
            parentInternalModel.id +
            ' but some of the associated records were not loaded. Either make sure they are all loaded together with the parent record, or specify that the relationship is async (`belongsTo({ async: true })`)',
          toReturn === null || !internalModel.currentState.isEmpty
        );
        return toReturn;
      }
    }
  }

  getManyArray<F extends HasManyRelationshipFieldsFor<R, T>>(
    key: F,
    definition?: UpgradedRelationshipMeta<R, T, F, RelatedType<R, T, F>>
  ): ManyArray<R, T, F, RelatedType<R, T, F>> {
    assert('hasMany only works with the @ember-data/record-data package', HAS_RECORD_DATA_PACKAGE);
    let manyArray: ManyArray<R, T, F, RelatedType<R, T, F>> | undefined = this._manyArrayCache[key];
    if (!definition) {
      const graphFor = (
        importSync('@ember-data/record-data/-private') as typeof import('@ember-data/record-data/-private')
      ).graphFor;
      definition = graphFor(this.store).get(this.identifier, key).definition as UpgradedRelationshipMeta<
        R,
        T,
        F,
        RelatedType<R, T, F>
      >;
    }

    if (!manyArray) {
      manyArray = _ManyArray.create({
        store: this.store,
        type: this.store.modelFor(definition.type),
        recordData: this._recordData as RelationshipRecordData<R, T>,
        key,
        isPolymorphic: definition.isPolymorphic,
        isAsync: definition.isAsync,
        _inverseIsAsync: definition.inverseIsAsync,
        internalModel: this,
        isLoaded: !definition.isAsync,
      });
      this._manyArrayCache[key] = manyArray;
    }

    return manyArray;
  }

  fetchAsyncHasMany<F extends HasManyRelationshipFieldsFor<R, T>>(
    key: F,
    relationship: ManyRelationship<R, T, F, RelatedType<R, T, F>>,
    manyArray: ManyArray<R, T, F, RelatedType<R, T, F>>,
    options?: Dict<unknown>
  ): Promise<ManyArray<R, T, F, RelatedType<R, T, F>>> {
    if (HAS_RECORD_DATA_PACKAGE) {
      let loadingPromise = this._relationshipPromisesCache[key] as
        | Promise<ManyArray<R, T, F, RelatedType<R, T, F>>>
        | undefined;
      if (loadingPromise) {
        return loadingPromise;
      }

      const jsonApi = this._recordData.getHasMany(key);

      loadingPromise = this.store._findHasManyByJsonApiResource(jsonApi, this, relationship, options).then(
        () => handleCompletedRelationshipRequest(this, key, relationship, manyArray),
        (e) => handleCompletedRelationshipRequest(this, key, relationship, manyArray, e)
      );
      this._relationshipPromisesCache[key] = loadingPromise;
      return loadingPromise;
    }
    assert('hasMany only works with the @ember-data/record-data package');
  }

  getHasMany<F extends HasManyRelationshipFieldsFor<R, T>, RT extends RelatedType<R, T, F> = RelatedType<R, T, F>>(
    key: F,
    options?: Dict<unknown>
  ): PromiseManyArray<R, T, F, RT> | ManyArray<R, T, F, RT> {
    if (HAS_RECORD_DATA_PACKAGE) {
      const graphFor = (
        importSync('@ember-data/record-data/-private') as typeof import('@ember-data/record-data/-private')
      ).graphFor;
      const relationship = graphFor(this.store).get(this.identifier, key) as ManyRelationship<R, T, F, RT>;
      const { definition, state } = relationship;
      let manyArray = this.getManyArray(key, definition);

      if (definition.isAsync) {
        if (state.hasFailedLoadAttempt) {
          return this._relationshipProxyCache[key] as PromiseManyArray<R, T, F, RT>;
        }

        let promise = this.fetchAsyncHasMany(key, relationship, manyArray, options);

        return this._updatePromiseProxyFor('hasMany', key, { promise, content: manyArray });
      } else {
        assert(
          `You looked up the '${key}' relationship on a '${this.modelName}' with id ${this.id} but some of the associated records were not loaded. Either make sure they are all loaded together with the parent record, or specify that the relationship is async ('hasMany({ async: true })')`,
          !anyUnloaded(this.store, relationship)
        );

        return manyArray;
      }
    }
    assert(`hasMany only works with the @ember-data/record-data package`);
  }

  _updatePromiseProxyFor<F extends HasManyRelationshipFieldsFor<R, T>, RT extends RelatedType<R, T, F>>(
    kind: 'hasMany',
    key: F,
    args: HasManyProxyCreateArgs<R, T, F, RT>
  ): PromiseManyArray<R, T, F, RT>;
  _updatePromiseProxyFor<F extends BelongsToRelationshipFieldsFor<R, T>, RT extends RelatedType<R, T, F>>(
    kind: 'belongsTo',
    key: F,
    args: BelongsToProxyCreateArgs<R, T, F, RT>
  ): PromiseBelongsTo<R, T, F, RT>;
  _updatePromiseProxyFor<F extends BelongsToRelationshipFieldsFor<R, T>, RT extends RelatedType<R, T, F>>(
    kind: 'belongsTo',
    key: F,
    args: { promise: Promise<RecordInstance<R, T> | null> }
  ): PromiseBelongsTo<R, T, F, RT>;
  _updatePromiseProxyFor<F extends RelationshipFieldsFor<R, T>, RT extends RelatedType<R, T, F>>(
    kind: 'hasMany' | 'belongsTo',
    key: F,
    args:
      | BelongsToProxyCreateArgs<R, T, F, RT>
      | HasManyProxyCreateArgs<R, T, F, RT>
      | { promise: Promise<RecordInstance<R, RT> | null> }
  ): PromiseBelongsTo<R, T, F, RT> | PromiseManyArray<R, T, F, RT> {
    let promiseProxy = this._relationshipProxyCache[key];
    if (kind === 'hasMany') {
      const { promise, content } = args as HasManyProxyCreateArgs<R, T, F, RT>;
      if (promiseProxy) {
        assert(`Expected a PromiseManyArray`, '_update' in promiseProxy);
        promiseProxy._update(promise, content);
      } else {
        promiseProxy = this._relationshipProxyCache[key] = new _PromiseManyArray(promise, content);
      }
      return promiseProxy;
    }

    if (promiseProxy) {
      const { promise, content } = args as BelongsToProxyCreateArgs<R, T, F, RT>;
      assert(
        `Expected a PromiseBelongsTo`,
        '_belongsToState' in promiseProxy && promiseProxy._belongsToState.key === key
      );
      assertIs<PromiseBelongsTo<R, T, F, RT>>(
        `Expected the PromiseBelongsTo for field ${key}`,
        promiseProxy._belongsToState.key === key,
        promiseProxy
      );

      // these types are happy if we use dot notation, figure out if tests still pass...
      if (content !== undefined) {
        promiseProxy.set('content', content);
      }
      promiseProxy.set('promise', promise);
    } else {
      // this usage of `any` can be removed when `@types/ember_object` proxy allows `null` for content
      this._relationshipProxyCache[key] = promiseProxy = _PromiseBelongsTo.create(args as any);
      assertIs<PromiseBelongsTo<R, T, F, RT>>(
        `Expected the PromiseBelongsTo for field ${key}`,
        promiseProxy._belongsToState.key === key,
        promiseProxy
      );
    }

    return promiseProxy;
  }

  reloadHasMany<K extends RecordField<R, T>>(key: K, options?: Dict<unknown>) {
    if (HAS_RECORD_DATA_PACKAGE) {
      let loadingPromise = this._relationshipPromisesCache[key];
      if (loadingPromise) {
        return loadingPromise;
      }
      const graphFor = (
        importSync('@ember-data/record-data/-private') as typeof import('@ember-data/record-data/-private')
      ).graphFor;
      const relationship = graphFor(this.store).get(this.identifier, key) as ManyRelationship;
      const { definition, state } = relationship;

      state.hasFailedLoadAttempt = false;
      state.shouldForceReload = true;
      let manyArray = this.getManyArray(key, definition);
      let promise = this.fetchAsyncHasMany(key, relationship, manyArray, options);

      if (this._relationshipProxyCache[key]) {
        return this._updatePromiseProxyFor('hasMany', key, { promise });
      }

      return promise;
    }
    assert(`hasMany only works with the @ember-data/record-data package`);
  }

  reloadBelongsTo<K extends RecordField<R, T>>(key: K, options?: Dict<unknown>): Promise<RecordInstance<R, T> | null> {
    let loadingPromise = this._relationshipPromisesCache[key] as Promise<RecordInstance<R, T> | null> | undefined;
    if (loadingPromise) {
      return loadingPromise;
    }

    let resource = (this._recordData as DefaultRecordData<R, T>).getBelongsTo(key);
    // TODO move this to a public api
    if (resource._relationship) {
      resource._relationship.state.hasFailedLoadAttempt = false;
      resource._relationship.state.shouldForceReload = true;
    }
    let relationshipMeta = this.store._relationshipMetaFor(this.modelName, null, key);
    assert(`Attempted to reload a belongsTo relationship but no definition exists for it`, relationshipMeta);
    let promise = this._findBelongsTo(key, resource, relationshipMeta, options);
    if (this._relationshipProxyCache[key]) {
      return this._updatePromiseProxyFor('belongsTo', key, { promise });
    }
    return promise;
  }

  destroyFromRecordData() {
    if (this._doNotDestroy) {
      this._doNotDestroy = false;
      return;
    }
    this.destroy();
  }

  destroy() {
    // TODO should we utilize the destroyables RFC here for records ?
    // TODO unify this with the logic in RecordDataStoreWrapper as either
    // a util for records, esp if using destroyables RFC
    assert(
      `Record should implement destroyable behavior`,
      !this._record || 'isDestroyed' in this._record || 'isDestroying' in this._record
    );
    assert(
      'Cannot destroy an internalModel while its record is materialized',
      !this._record ||
        !(this._record as unknown as { isDestroyed: boolean }).isDestroyed ||
        !(this._record as unknown as { isDestroying: boolean }).isDestroying
    );
    this.isDestroying = true;
    if (this._recordReference) {
      this._recordReference.destroy();
    }
    this._recordReference = null;
    let cache = this._manyArrayCache;
    Object.keys(cache).forEach((key) => {
      cache[key]!.destroy();
      delete cache[key];
    });
    if (this.references) {
      cache = this.references;
      Object.keys(cache).forEach((key) => {
        cache[key]!.destroy();
        delete cache[key];
      });
    }

    internalModelFactoryFor(this.store).remove(this);
    this._isDestroyed = true;
  }

  setupData(data) {
    const hasRecord = this.hasRecord;
    if (hasRecord) {
      let changedKeys = this._recordData.pushData(data, true);
      this.notifyAttributes(changedKeys);
    } else {
      this._recordData.pushData(data);
    }
    this.send('pushedData');
  }

  notifyAttributes(keys: RecordField<R, T>[]): void {
    let manager = this.store._notificationManager;
    let { identifier } = this;

    for (let i = 0; i < keys.length; i++) {
      manager.notify(identifier, 'attributes', keys[i]);
    }
  }

  setDirtyHasMany<K extends RecordField<R, T>>(key: K, records) {
    assertRecordsPassedToHasMany(records);
    return this._recordData.setDirtyHasMany(key, extractRecordDatasFromRecords(records));
  }

  setDirtyBelongsTo<K extends RecordField<R, T>>(key: K, value) {
    return this._recordData.setDirtyBelongsTo(key, extractRecordDataFromRecord(value));
  }

  setDirtyAttribute<K extends RecordField<R, T>, V>(key: K, value: V): V {
    if (this.isDeleted()) {
      if (DEBUG) {
        throw new EmberError(`Attempted to set '${key}' to '${value}' on the deleted record ${this}`);
      } else {
        throw new EmberError(`Attempted to set '${key}' on the deleted record ${this}`);
      }
    }

    let currentValue = this._recordData.getAttr(key);
    if (currentValue !== value) {
      this._recordData.setDirtyAttribute(key, value);
      let isDirty = this._recordData.isAttrDirty(key);
      this.send('didSetProperty', {
        name: key,
        isDirty: isDirty,
      });
    }

    return value;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  get hasRecord(): boolean {
    return !!this._record;
  }

  createSnapshot(options: FindOptions = {}): Snapshot<R, T> {
    return new Snapshot(options, this.identifier, this.store);
  }

  hasChangedAttributes(): boolean {
    if (!this.__recordData) {
      // no need to calculate changed attributes when calling `findRecord`
      return false;
    }
    return this._recordData.hasChangedAttributes();
  }

  changedAttributes(): ChangedAttributesHash<R, T> {
    if (!this.__recordData) {
      // no need to calculate changed attributes when calling `findRecord`
      return {};
    }
    return this._recordData.changedAttributes();
  }

  adapterWillCommit(): void {
    this._recordData.willCommit();
    this.send('willCommit');
  }

  adapterDidDirty(): void {
    this.send('becomeDirty');
  }

  send(name: string, context?) {
    let currentState = this.currentState;

    if (!currentState[name]) {
      this._unhandledEvent(currentState, name, context);
    }

    return currentState[name](this, context);
  }

  notifyHasManyChange(key: string) {
    if (this.hasRecord) {
      let manyArray = this._manyArrayCache[key];
      let hasPromise = !!this._relationshipPromisesCache[key];

      if (manyArray && hasPromise) {
        // do nothing, we will notify the ManyArray directly
        // once the fetch has completed.
        return;
      }

      this.store._notificationManager.notify(this.identifier, 'relationships', key);
    }
  }

  notifyBelongsToChange(key: string) {
    if (this.hasRecord) {
      this.store._notificationManager.notify(this.identifier, 'relationships', key);
    }
  }

  notifyPropertyChange(key: string) {
    if (this.hasRecord) {
      // TODO this should likely *mostly* be the `attributes` bucket
      // but it seems for local mutations we rely on computed updating
      // iteself when set. As we design our own thing we may need to change
      // that.
      this.store._notificationManager.notify(this.identifier, 'property', key);
    }
  }

  notifyStateChange(key?: string) {
    if (this.hasRecord) {
      this.store._notificationManager.notify(this.identifier, 'state');
    }
    if (!key || key === 'isDeletionCommitted') {
      this.store.recordArrayManager.recordDidChange(this.identifier);
    }
  }

  didCreateRecord() {
    this._recordData.clientDidCreate();
  }

  rollbackAttributes() {
    this.store._backburner.join(() => {
      let dirtyKeys = this._recordData.rollbackAttributes();
      if (this.isError) {
        this.didCleanError();
      }

      this.send('rolledBack');

      if (this.hasRecord && dirtyKeys && dirtyKeys.length > 0) {
        this.notifyAttributes(dirtyKeys);
      }
    });
  }

  transitionTo(name: string) {
    // POSSIBLE TODO: Remove this code and replace with
    // always having direct reference to state objects

    let pivotName = extractPivotName(name);
    let state: any = this.currentState;
    let transitionMapId = `${state.stateName}->${name}`;

    do {
      if (state.exit) {
        state.exit(this);
      }
      state = state.parentState;
    } while (!state[pivotName]);

    let setups;
    let enters;
    let i;
    let l;
    let map = TransitionChainMap[transitionMapId];

    if (map) {
      setups = map.setups;
      enters = map.enters;
      state = map.state;
    } else {
      setups = [];
      enters = [];

      let path = splitOnDot(name);

      for (i = 0, l = path.length; i < l; i++) {
        state = state[path[i]];

        if (state.enter) {
          enters.push(state);
        }
        if (state.setup) {
          setups.push(state);
        }
      }

      TransitionChainMap[transitionMapId] = { setups, enters, state };
    }

    for (i = 0, l = enters.length; i < l; i++) {
      enters[i].enter(this);
    }

    this.currentState = state;

    // isDSModel is the guard we want, but may be too restrictive if
    // ember-m3 / ember-data-model-fragments were relying on this still.
    if (this.hasRecord && isDSModel(this._record)) {
      // TODO eliminate this.
      this.notifyStateChange('currentState');
    }

    for (i = 0, l = setups.length; i < l; i++) {
      setups[i].setup(this);
    }
  }

  _unhandledEvent(state, name: string, context) {
    let errorMessage = 'Attempted to handle event `' + name + '` ';
    errorMessage += 'on ' + String(this) + ' while in state ';
    errorMessage += state.stateName + '. ';

    if (context !== undefined) {
      errorMessage += 'Called with ' + inspect(context) + '.';
    }

    throw new EmberError(errorMessage);
  }

  removeFromInverseRelationships() {
    if (this.__recordData) {
      this.store._backburner.join(() => {
        this._recordData.removeFromInverseRelationships();
      });
    }
  }

  /*
    When a find request is triggered on the store, the user can optionally pass in
    attributes and relationships to be preloaded. These are meant to behave as if they
    came back from the server, except the user obtained them out of band and is informing
    the store of their existence. The most common use case is for supporting client side
    nested URLs, such as `/posts/1/comments/2` so the user can do
    `store.findRecord('comment', 2, { preload: { post: 1 } })` without having to fetch the post.

    Preloaded data can be attributes and relationships passed in either as IDs or as actual
    models.
  */
  preloadData(preload) {
    let jsonPayload: JsonApiResource = {};
    //TODO(Igor) consider the polymorphic case
    Object.keys(preload).forEach((key) => {
      let preloadValue = get(preload, key);
      let relationshipMeta = this.modelClass.metaForProperty(key);
      if (relationshipMeta.isRelationship) {
        if (!jsonPayload.relationships) {
          jsonPayload.relationships = {};
        }
        jsonPayload.relationships[key] = this._preloadRelationship(key, preloadValue);
      } else {
        if (!jsonPayload.attributes) {
          jsonPayload.attributes = {};
        }
        jsonPayload.attributes[key] = preloadValue;
      }
    });
    this._recordData.pushData(jsonPayload);
  }

  _preloadRelationship(key, preloadValue) {
    let relationshipMeta = this.modelClass.metaForProperty(key);
    let modelClass = relationshipMeta.type;
    let data;
    if (relationshipMeta.kind === 'hasMany') {
      assert('You need to pass in an array to set a hasMany property on a record', Array.isArray(preloadValue));
      data = preloadValue.map((value) => this._convertPreloadRelationshipToJSON(value, modelClass));
    } else {
      data = this._convertPreloadRelationshipToJSON(preloadValue, modelClass);
    }
    return { data };
  }

  _convertPreloadRelationshipToJSON(value, modelClass) {
    if (typeof value === 'string' || typeof value === 'number') {
      return { type: modelClass, id: value };
    }
    let internalModel;
    if (value._internalModel) {
      internalModel = value._internalModel;
    } else {
      internalModel = value;
    }
    // TODO IGOR DAVID assert if no id is present
    return { type: internalModel.modelName, id: internalModel.id };
  }

  /*
   * calling `store.setRecordId` is necessary to update
   * the cache index for this record if we have changed.
   *
   * However, since the store is not aware of whether the update
   * is from us (via user set) or from a push of new data
   * it will also call us so that we can notify and update state.
   *
   * When it does so it calls with `fromCache` so that we can
   * short-circuit instead of cycling back.
   *
   * This differs from the short-circuit in the `_isUpdatingId`
   * case in that the the cache can originate the call to setId,
   * so on first entry we will still need to do our own update.
   */
  setId(id: string, fromCache: boolean = false) {
    if (this._isUpdatingId === true) {
      return;
    }
    this._isUpdatingId = true;
    let didChange = id !== this._id;
    this._id = id;

    if (didChange && id !== null) {
      if (!fromCache) {
        this.store.setRecordId(this.modelName, id, this.clientId);
      }
      // internal set of ID to get it to RecordData from DS.Model
      // if we are within create we may not have a recordData yet.
      if (this.__recordData && this._recordData.__setId) {
        this._recordData.__setId(id);
      }
    }

    if (didChange && this.hasRecord) {
      this.store._notificationManager.notify(this.identifier, 'identity');
    }
    this._isUpdatingId = false;
  }

  didError() {}

  didCleanError() {}

  /*
    If the adapter did not return a hash in response to a commit,
    merge the changed attributes and relationships into the existing
    saved data.
  */
  adapterDidCommit(data) {
    this.didCleanError();

    this._recordData.didCommit(data);
    this.send('didCommit');
    this.store.recordArrayManager.recordDidChange(this.identifier);

    if (!data) {
      return;
    }
    this.store._notificationManager.notify(this.identifier, 'attributes');
  }

  hasErrors(): boolean {
    // TODO add assertion forcing consuming RecordData's to implement getErrors
    if (this._recordData.getErrors) {
      return this._recordData.getErrors(this.identifier).length > 0;
    } else {
      // we can't have errors if we never tried loading
      if (!this._record) {
        return false;
      }
      assert(
        `Your RecordData instance does not implement getErrors but your model instance is also not an instance of @ember-data/model, either use @ember-data/model or update your RecordData implementation to handle errors`,
        isDSModel(this._record)
      );
      let errors = this._record.errors;
      return errors.length > 0;
    }
  }

  // FOR USE DURING COMMIT PROCESS
  adapterDidInvalidate(parsedErrors, error?) {
    // TODO @runspired this should be handled by RecordState
    // and errors should be dirtied but lazily fetch if at
    // all possible. We should only notify errors here.
    let attribute;
    if (error && parsedErrors) {
      // TODO add assertion forcing consuming RecordData's to implement getErrors
      if (!this._recordData.getErrors) {
        let record = this.getRecord();
        assert(
          `Your RecordData instance does not implement getErrors but your model instance is also not an instance of @ember-data/model, either use @ember-data/model or update your RecordData implementation to handle errors`,
          isDSModel(record)
        );
        let errors = record.errors;
        for (attribute in parsedErrors) {
          if (hasOwnProperty.call(parsedErrors, attribute)) {
            errors._add(attribute, parsedErrors[attribute]);
          }
        }
      }

      let jsonApiErrors: JsonApiValidationError[] = errorsHashToArray(parsedErrors);
      this.send('becameInvalid');
      if (jsonApiErrors.length === 0) {
        jsonApiErrors = [{ title: 'Invalid Error', detail: '', source: { pointer: '/data' } }];
      }
      this._recordData.commitWasRejected(this.identifier, jsonApiErrors);
    } else {
      this.send('becameError');
      this._recordData.commitWasRejected(this.identifier);
    }
  }

  notifyErrorsChange() {
    this.store._notificationManager.notify(this.identifier, 'errors');
  }

  adapterDidError() {
    this.send('becameError');

    this._recordData.commitWasRejected();
  }

  toString() {
    return `<${this.modelName}:${this.id}>`;
  }

  referenceFor<K extends RelationshipFieldsFor<R, T>>(kind: 'belongsTo' | 'hasMany', name: K) {
    let reference = this.references[name];

    if (!reference) {
      if (!HAS_RECORD_DATA_PACKAGE) {
        // TODO @runspired while this feels odd, it is not a regression in capability because we do
        // not today support references pulling from RecordDatas other than our own
        // because of the intimate API access involved. This is something we will need to redesign.
        assert(`snapshot.belongsTo only supported for @ember-data/record-data`);
      }
      const graphFor = (
        importSync('@ember-data/record-data/-private') as typeof import('@ember-data/record-data/-private')
      ).graphFor;
      const relationship = graphFor(this.store._storeWrapper).get(this.identifier, name);

      if (DEBUG && kind) {
        let modelName = this.modelName;
        let actualRelationshipKind = relationship.definition.kind;
        assert(
          `You tried to get the '${name}' relationship on a '${modelName}' via record.${kind}('${name}'), but the relationship is of kind '${actualRelationshipKind}'. Use record.${actualRelationshipKind}('${name}') instead.`,
          actualRelationshipKind === kind
        );
      }

      let relationshipKind = relationship.definition.kind;
      let identifierOrInternalModel = this.identifier;

      if (relationshipKind === 'belongsTo') {
        reference = new BelongsToReference(this.store, identifierOrInternalModel, relationship, name);
      } else if (relationshipKind === 'hasMany') {
        reference = new HasManyReference(this.store, identifierOrInternalModel, relationship, name);
      }

      this.references[name] = reference;
    }

    return reference;
  }
}

function handleCompletedRelationshipRequest<
  R extends ResolvedRegistry,
  T extends RecordType<R>,
  F extends BelongsToRelationshipFieldsFor<R, T>,
  RT extends RecordType<R>
>(
  internalModel: InternalModel<R, T>,
  key: F,
  relationship: BelongsToRelationship<R, T, F, RT>,
  value: InternalModel<R, RT> | null
): RecordInstance<R, RT> | null;
function handleCompletedRelationshipRequest<
  R extends ResolvedRegistry,
  T extends RecordType<R>,
  F extends HasManyRelationshipFieldsFor<R, T>,
  RT extends RecordType<R>
>(
  internalModel: InternalModel<R, T>,
  key: F,
  relationship: ManyRelationship<R, T, F, RT>,
  value: ManyArray<R, T, F, RT>
): ManyArray<R, T, F, RT>;
function handleCompletedRelationshipRequest<
  R extends ResolvedRegistry,
  T extends RecordType<R>,
  F extends BelongsToRelationshipFieldsFor<R, T>,
  RT extends RecordType<R>
>(
  internalModel: InternalModel<R, T>,
  key: F,
  relationship: BelongsToRelationship<R, T, F, RT>,
  value: null,
  error: Error
): never;
function handleCompletedRelationshipRequest<
  R extends ResolvedRegistry,
  T extends RecordType<R>,
  F extends HasManyRelationshipFieldsFor<R, T>,
  RT extends RecordType<R>
>(
  internalModel: InternalModel<R, T>,
  key: F,
  relationship: ManyRelationship<R, T, F, RT>,
  value: ManyArray<R, T, F, RT>,
  error: Error
): never;
function handleCompletedRelationshipRequest<
  R extends ResolvedRegistry,
  T extends RecordType<R>,
  F extends RelationshipFieldsFor<R, T>,
  RT extends RecordType<R>,
  BF extends BelongsToRelationshipFieldsFor<R, T>,
  MF extends HasManyRelationshipFieldsFor<R, T>
>(
  internalModel: InternalModel<R, T>,
  key: F,
  relationship: BelongsToRelationship<R, T, BF, RT> | ManyRelationship<R, T, MF, RT>,
  value: ManyArray<R, T, F, RT> | InternalModel<R, RT> | null,
  error?: Error
): ManyArray<R, T, F, RT> | RecordInstance<R, RT> | null {
  delete internalModel._relationshipPromisesCache[key];
  relationship.state.shouldForceReload = false;
  const isHasMany = relationship.definition.kind === 'hasMany';

  if (isHasMany) {
    // we don't notify the record property here to avoid refetch
    // only the many array
    (value as ManyArray<R, T, F, RT>).notify();
  }

  if (error) {
    relationship.state.hasFailedLoadAttempt = true;
    let proxy = internalModel._relationshipProxyCache[key];
    // belongsTo relationships are sometimes unloaded
    // when a load fails, in this case we need
    // to make sure that we aren't proxying
    // to destroyed content
    // for the sync belongsTo reload case there will be no proxy
    // for the async reload case there will be no proxy if the ui
    // has never been accessed
    if (proxy && !isHasMany) {
      if (proxy.content && proxy.content.isDestroying) {
        // TODO @types/ember__object incorrectly disallows `null`, we should either
        // override or fix upstream
        (proxy as PromiseBelongsTo<R, T, BF, RT>).set('content', null as unknown as undefined);
      }
    }

    throw error;
  }

  if (isHasMany) {
    (value as ManyArray<R, T, F, RT>).set('isLoaded', true);
  }

  relationship.state.hasFailedLoadAttempt = false;
  // only set to not stale if no error is thrown
  relationship.state.isStale = false;

  return isHasMany || !value ? (value as ManyArray<R, T, F, RT> | null) : (value as InternalModel<R, RT>).getRecord();
}

export function assertRecordsPassedToHasMany(records) {
  // TODO only allow native arrays
  assert(
    `You must pass an array of records to set a hasMany relationship`,
    Array.isArray(records) || EmberArray.detect(records)
  );
  assert(
    `All elements of a hasMany relationship must be instances of Model, you passed ${inspect(records)}`,
    (function () {
      return A(records).every((record) => hasOwnProperty.call(record, '_internalModel') === true);
    })()
  );
}

export function extractRecordDatasFromRecords(records) {
  return records.map(extractRecordDataFromRecord);
}

export function extractRecordDataFromRecord(recordOrPromiseRecord) {
  if (!recordOrPromiseRecord) {
    return null;
  }

  if (recordOrPromiseRecord.then) {
    let content = recordOrPromiseRecord.get && recordOrPromiseRecord.get('content');
    assert(
      'You passed in a promise that did not originate from an EmberData relationship. You can only pass promises that come from a belongsTo or hasMany relationship to the get call.',
      content !== undefined
    );
    return content ? recordDataFor(content) : null;
  }

  return recordDataFor(recordOrPromiseRecord);
}

function anyUnloaded<R extends ResolvedRegistry>(store: Store<R>, relationship: ManyRelationship<R>) {
  let state = relationship.currentState;
  const unloaded = state.find((s) => {
    let im = store._internalModelForResource(s);
    return im._isDematerializing || !im.currentState.isLoaded;
  });

  return unloaded || false;
}
