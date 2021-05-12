import { createState } from '../../graph/-state';

type CollectionResourceRelationship = import('@ember-data/store/-private/ts-interfaces/ember-data-json-api').CollectionResourceRelationship;
type UpgradedMeta = import('../../graph/-edge-definition').UpgradedMeta;
type Graph = import('../../graph').Graph;
type StableRecordIdentifier = import('@ember-data/store/-private/ts-interfaces/identifier').StableRecordIdentifier;
type Links = import('@ember-data/store/-private/ts-interfaces/ember-data-json-api').Links;
type Meta = import('@ember-data/store/-private/ts-interfaces/ember-data-json-api').Meta;
type RelationshipState = import('../../graph/-state').RelationshipState;
type RecordDataStoreWrapper = import('@ember-data/store/-private').RecordDataStoreWrapper;
type PaginationLinks = import('@ember-data/store/-private/ts-interfaces/ember-data-json-api').PaginationLinks;

export default class ManyRelationship {
  declare graph: Graph;
  declare store: RecordDataStoreWrapper;
  declare definition: UpgradedMeta;
  declare identifier: StableRecordIdentifier;

  declare members: Set<StableRecordIdentifier>;
  declare canonicalMembers: Set<StableRecordIdentifier>;
  declare meta: Meta | null;
  declare links: Links | PaginationLinks | null;

  declare canonicalState: StableRecordIdentifier[];
  declare currentState: StableRecordIdentifier[];
  declare _willUpdateManyArray: boolean;
  declare _pendingManyArrayUpdates: any;
  declare _state: RelationshipState | null;

  constructor(graph: Graph, definition: UpgradedMeta, identifier: StableRecordIdentifier) {
    this.graph = graph;
    this.store = graph.store;
    this.definition = definition;
    this.identifier = identifier;
    this._state = null;

    this.members = new Set<StableRecordIdentifier>();
    this.canonicalMembers = new Set<StableRecordIdentifier>();

    this.meta = null;
    this.links = null;

    // persisted state
    this.canonicalState = [];
    // local client state
    this.currentState = [];
    this._willUpdateManyArray = false;
    this._pendingManyArrayUpdates = null;
  }

  get state(): RelationshipState {
    let { _state } = this;
    if (!_state) {
      _state = this._state = createState();
    }
    return _state;
  }

  clear() {
    this.members.clear();
    this.canonicalMembers.clear();
    this.currentState = [];
    this.canonicalState = [];
  }

  /*
    Removes the given RecordData from BOTH canonical AND current state.

    This method is useful when either a deletion or a rollback on a new record
    needs to entirely purge itself from an inverse relationship.
  */
  removeCompletelyFromOwn(recordData: StableRecordIdentifier) {
    this.canonicalMembers.delete(recordData);
    this.members.delete(recordData);

    const canonicalIndex = this.canonicalState.indexOf(recordData);
    if (canonicalIndex !== -1) {
      this.canonicalState.splice(canonicalIndex, 1);
    }

    const currentIndex = this.currentState.indexOf(recordData);
    if (currentIndex !== -1) {
      this.currentState.splice(currentIndex, 1);
      // This allows dematerialized inverses to be rematerialized
      // we shouldn't be notifying here though, figure out where
      // a notification was missed elsewhere.
      this.notifyHasManyChange();
    }
  }

  notifyHasManyChange() {
    const { store, identifier: recordData } = this;
    store.notifyHasManyChange(recordData.type, recordData.id, recordData.lid, this.definition.key);
  }

  getData(): CollectionResourceRelationship {
    let payload: any = {};
    if (this.state.hasReceivedData) {
      payload.data = this.currentState.slice();
    }
    if (this.links) {
      payload.links = this.links;
    }
    if (this.meta) {
      payload.meta = this.meta;
    }

    return payload;
  }
}
