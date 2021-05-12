import { createState } from '../../graph/-state';

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

  clear() {
    this.localState = null;
    this.remoteState = null;
    this.state.hasReceivedData = false;
    this.state.isEmpty = true;
  }
}
