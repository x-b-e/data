type Graph = import('../../graph').Graph;
type UpgradedMeta = import('../../graph/-edge-definition').UpgradedMeta;
type StableRecordIdentifier = import('@ember-data/store/-private/ts-interfaces/identifier').StableRecordIdentifier;

/**
  @module @ember-data/store
*/
export default class ImplicitRelationship {
  declare graph: Graph;
  declare definition: UpgradedMeta;
  declare identifier: StableRecordIdentifier;

  declare members: Set<StableRecordIdentifier>;
  declare canonicalMembers: Set<StableRecordIdentifier>;

  constructor(graph: Graph, definition: UpgradedMeta, identifier: StableRecordIdentifier) {
    this.graph = graph;
    this.definition = definition;
    this.identifier = identifier;

    this.members = new Set<StableRecordIdentifier>();
    this.canonicalMembers = new Set<StableRecordIdentifier>();
  }

  clear() {
    this.canonicalMembers.clear();
    this.members.clear();
  }
}
