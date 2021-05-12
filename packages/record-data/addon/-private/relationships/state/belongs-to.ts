import { createState } from '../../graph/-state';
import { isNew } from '../../graph/-utils';

type ManyRelationship = import('../..').ManyRelationship;

type UpgradedMeta = import('../../graph/-edge-definition').UpgradedMeta;
type Graph = import('../../graph').Graph;
type StableRecordIdentifier = import('@ember-data/store/-private/ts-interfaces/identifier').StableRecordIdentifier;
type DefaultSingleResourceRelationship = import('../../ts-interfaces/relationship-record-data').DefaultSingleResourceRelationship;

type Links = import('@ember-data/store/-private/ts-interfaces/ember-data-json-api').Links;

type Meta = import('@ember-data/store/-private/ts-interfaces/ember-data-json-api').Meta;

type RelationshipState = import('../../graph/-state').RelationshipState;
type RecordDataStoreWrapper = import('@ember-data/store/-private').RecordDataStoreWrapper;
type PaginationLinks = import('@ember-data/store/-private/ts-interfaces/ember-data-json-api').PaginationLinks;

export default class BelongsToRelationship {
  declare localState: StableRecordIdentifier | null;
  declare remoteState: StableRecordIdentifier | null;

  declare graph: Graph;
  declare store: RecordDataStoreWrapper;
  declare definition: UpgradedMeta;
  declare identifier: StableRecordIdentifier;
  declare _state: RelationshipState | null;

  declare meta: Meta | null;
  declare links: Links | PaginationLinks | null;

  constructor(graph: Graph, definition: UpgradedMeta, identifier: StableRecordIdentifier) {
    this.graph = graph;
    this.store = graph.store;
    this.definition = definition;
    this.identifier = identifier;
    this._state = null;

    this.meta = null;
    this.links = null;

    this.localState = null;
    this.remoteState = null;
  }

  get state(): RelationshipState {
    let { _state } = this;
    if (!_state) {
      _state = this._state = createState();
    }
    return _state;
  }

  getData(): DefaultSingleResourceRelationship {
    let data;
    let payload: any = {};
    if (this.localState) {
      data = this.localState;
    }
    if (this.localState === null && this.state.hasReceivedData) {
      data = null;
    }
    if (this.links) {
      payload.links = this.links;
    }
    if (data !== undefined) {
      payload.data = data;
    }
    if (this.meta) {
      payload.meta = this.meta;
    }

    payload._relationship = this;
    return payload;
  }

  /*
      Removes the given RecordData from BOTH canonical AND current state.
  
      This method is useful when either a deletion or a rollback on a new record
      needs to entirely purge itself from an inverse relationship.
     */
  removeCompletelyFromOwn(recordData: StableRecordIdentifier) {
    if (this.remoteState === recordData) {
      this.remoteState = null;
    }

    if (this.localState === recordData) {
      this.localState = null;
      // This allows dematerialized inverses to be rematerialized
      // we shouldn't be notifying here though, figure out where
      // a notification was missed elsewhere.
      this.notifyBelongsToChange();
    }
  }

  notifyBelongsToChange() {
    let recordData = this.identifier;
    this.store.notifyBelongsToChange(recordData.type, recordData.id, recordData.lid, this.definition.key);
  }

  clear() {
    this.localState = null;
    this.remoteState = null;
    this.state.hasReceivedData = false;
    this.state.isEmpty = true;
  }
}
