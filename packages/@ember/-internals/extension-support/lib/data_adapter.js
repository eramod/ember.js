import { getOwner } from '@ember/-internals/owner';
import { backburner } from '@ember/runloop';
import { get } from '@ember/-internals/metal';
import { dasherize } from '@ember/string';
import { Namespace, Object as EmberObject, A as emberA } from '@ember/-internals/runtime';
import { consumeTag, createCache, getValue, tagFor, untrack } from '@glimmer/validator';

function iterate(arr, fn) {
  if (Symbol.iterator in arr) {
    for (let item of arr) {
      fn(item);
    }
  } else {
    arr.forEach(fn);
  }
}

class RecordsWatcher {
  recordCaches = new Map();

  constructor(records, recordsAdded, recordsUpdated, recordsRemoved, wrapRecord, release) {
    let { recordCaches } = this;

    this.release = release;

    let added, updated, removed;

    this.recordArrayCache = createCache(() => {
      let seen = new Set();

      added = [];
      updated = [];
      removed = [];

      // Track `[]` for legacy support
      consumeTag(tagFor(records, '[]'));

      iterate(records, (record) => {
        let recordCache = recordCaches.get(record);

        if (!recordCache) {
          let hasBeenAdded = false;

          recordCache = createCache(() => {
            if (!hasBeenAdded) {
              added.push(wrapRecord(record));
              hasBeenAdded = true;
            } else {
              updated.push(wrapRecord(record));
            }
          });

          recordCaches.set(record, recordCache);
        }

        getValue(recordCache);

        seen.add(record);
      });

      // Untrack this operation because these records are being removed, they
      // should not be polled again in the future
      untrack(() => {
        recordCaches.forEach((cache, record) => {
          if (!seen.has(record)) {
            removed.push(wrapRecord(record));
            recordCaches.delete(record);
          }
        });
      });

      if (added.length > 0) {
        recordsAdded(added);
      }

      if (updated.length > 0) {
        recordsUpdated(updated);
      }

      if (removed.length > 0) {
        recordsRemoved(removed);
      }
    });
  }

  revalidate() {
    getValue(this.recordArrayCache);
  }
}

class TypeWatcher {
  constructor(records, onChange, release) {
    let hasBeenAccessed = false;

    this.cache = createCache(() => {
      // Empty iteration, we're doing this just
      // to track changes to the records array
      iterate(records, () => {});

      // Also track `[]` for legacy support
      consumeTag(tagFor(records, '[]'));

      if (hasBeenAccessed === true) {
        onChange();
      } else {
        hasBeenAccessed = true;
      }
    });

    this.release = release;
  }

  revalidate() {
    getValue(this.cache);
  }
}

/**
@module @ember/debug
*/

/**
  The `DataAdapter` helps a data persistence library
  interface with tools that debug Ember such
  as the [Ember Inspector](https://github.com/emberjs/ember-inspector)
  for Chrome and Firefox.

  This class will be extended by a persistence library
  which will override some of the methods with
  library-specific code.

  The methods likely to be overridden are:

  * `getFilters`
  * `detect`
  * `columnsForType`
  * `getRecords`
  * `getRecordColumnValues`
  * `getRecordKeywords`
  * `getRecordFilterValues`
  * `getRecordColor`

  The adapter will need to be registered
  in the application's container as `dataAdapter:main`.

  Example:

  ```javascript
  Application.initializer({
    name: "data-adapter",

    initialize: function(application) {
      application.register('data-adapter:main', DS.DataAdapter);
    }
  });
  ```

  @class DataAdapter
  @extends EmberObject
  @public
*/
export default EmberObject.extend({
  init() {
    this._super(...arguments);
    this.releaseMethods = emberA();
    this.recordsWatchers = new Map();
    this.typeWatchers = new Map();
    this.flushWatchers = this.flushWatchers.bind(this);
  },

  /**
    The container-debug-adapter which is used
    to list all models.

    @property containerDebugAdapter
    @default undefined
    @since 1.5.0
    @public
  **/
  containerDebugAdapter: undefined,

  /**
    The number of attributes to send
    as columns. (Enough to make the record
    identifiable).

    @private
    @property attributeLimit
    @default 3
    @since 1.3.0
  */
  attributeLimit: 3,

  /**
     Ember Data > v1.0.0-beta.18
     requires string model names to be passed
     around instead of the actual factories.

     This is a stamp for the Ember Inspector
     to differentiate between the versions
     to be able to support older versions too.

     @public
     @property acceptsModelName
   */
  acceptsModelName: true,

  /**
     Map from records arrays to RecordsWatcher instances

     @private
     @property recordsWatchers
     @since 3.26.0
   */
  recordsWatchers: null,

  /**
    Map from records arrays to TypeWatcher instances

    @private
    @property typeWatchers
    @since 3.26.0
   */
  typeWatchers: null,

  /**
    Stores all methods that clear observers.
    These methods will be called on destruction.

    @private
    @property releaseMethods
    @since 1.3.0
  */
  releaseMethods: null,

  /**
    Specifies how records can be filtered.
    Records returned will need to have a `filterValues`
    property with a key for every name in the returned array.

    @public
    @method getFilters
    @return {Array} List of objects defining filters.
     The object should have a `name` and `desc` property.
  */
  getFilters() {
    return emberA();
  },

  /**
    Fetch the model types and observe them for changes.

    @public
    @method watchModelTypes

    @param {Function} typesAdded Callback to call to add types.
    Takes an array of objects containing wrapped types (returned from `wrapModelType`).

    @param {Function} typesUpdated Callback to call when a type has changed.
    Takes an array of objects containing wrapped types.

    @return {Function} Method to call to remove all observers
  */
  watchModelTypes(typesAdded, typesUpdated) {
    let modelTypes = this.getModelTypes();
    let releaseMethods = emberA();
    let typesToSend;

    typesToSend = modelTypes.map((type) => {
      let klass = type.klass;
      let wrapped = this.wrapModelType(klass, type.name);
      releaseMethods.push(this.observeModelType(type.name, typesUpdated));
      return wrapped;
    });

    typesAdded(typesToSend);

    let release = () => {
      releaseMethods.forEach((fn) => fn());
      this.releaseMethods.removeObject(release);
    };
    this.releaseMethods.pushObject(release);
    return release;
  },

  _nameToClass(type) {
    if (typeof type === 'string') {
      let owner = getOwner(this);
      let Factory = owner.factoryFor(`model:${type}`);
      type = Factory && Factory.class;
    }
    return type;
  },

  /**
    Fetch the records of a given type and observe them for changes.

    @public
    @method watchRecords

    @param {String} modelName The model name.

    @param {Function} recordsAdded Callback to call to add records.
    Takes an array of objects containing wrapped records.
    The object should have the following properties:
      columnValues: {Object} The key and value of a table cell.
      object: {Object} The actual record object.

    @param {Function} recordsUpdated Callback to call when a record has changed.
    Takes an array of objects containing wrapped records.

    @param {Function} recordsRemoved Callback to call when a record has removed.
    Takes an array of objects containing wrapped records.

    @return {Function} Method to call to remove all observers.
  */
  watchRecords(modelName, recordsAdded, recordsUpdated, recordsRemoved) {
    let klass = this._nameToClass(modelName);
    let records = this.getRecords(klass, modelName);
    let { recordsWatchers } = this;

    let recordsWatcher = recordsWatchers.get(records);

    if (!recordsWatcher) {
      if (recordsWatchers.size === 0) {
        backburner.on('end', this.flushWatchers);
      }

      recordsWatcher = new RecordsWatcher(
        records,
        recordsAdded,
        recordsUpdated,
        recordsRemoved,
        (record) => this.wrapRecord(record),
        () => {
          if (recordsWatchers.size === 1) {
            backburner.off('end', this.flushWatchers);
          }

          recordsWatchers.delete(records);
        }
      );

      recordsWatchers.set(records, recordsWatcher);

      recordsWatcher.revalidate();
    }

    return recordsWatcher.release;
  },

  flushWatchers() {
    this.typeWatchers.forEach((watcher) => watcher.revalidate());
    this.recordsWatchers.forEach((watcher) => watcher.revalidate());
  },

  /**
    Clear all observers before destruction
    @private
    @method willDestroy
  */
  willDestroy() {
    this._super(...arguments);

    this.typeWatchers.forEach((watcher) => watcher.release());
    this.recordsWatchers.forEach((watcher) => watcher.release());

    this.releaseMethods.forEach((fn) => fn());
  },

  /**
    Detect whether a class is a model.

    Test that against the model class
    of your persistence library.

    @public
    @method detect
    @return boolean Whether the class is a model class or not.
  */
  detect() {
    return false;
  },

  /**
    Get the columns for a given model type.

    @public
    @method columnsForType
    @return {Array} An array of columns of the following format:
     name: {String} The name of the column.
     desc: {String} Humanized description (what would show in a table column name).
  */
  columnsForType() {
    return emberA();
  },

  /**
    Adds observers to a model type class.

    @private
    @method observeModelType
    @param {String} modelName The model type name.
    @param {Function} typesUpdated Called when a type is modified.
    @return {Function} The function to call to remove observers.
  */

  observeModelType(modelName, typesUpdated) {
    let klass = this._nameToClass(modelName);
    let records = this.getRecords(klass, modelName);

    let onChange = () => {
      typesUpdated([this.wrapModelType(klass, modelName)]);
    };

    let { typeWatchers } = this;

    let typeWatcher = typeWatchers.get(records);

    if (!typeWatcher) {
      if (typeWatchers.size === 0) {
        backburner.on('end', this.flushWatchers);
      }

      typeWatcher = new TypeWatcher(records, onChange, () => {
        if (typeWatchers.size === 1) {
          backburner.off('end', this.flushWatchers);
        }

        typeWatchers.delete(records);
      });

      typeWatchers.set(records, typeWatcher);

      typeWatcher.revalidate();
    }

    return typeWatcher.release;
  },

  /**
    Wraps a given model type and observes changes to it.

    @private
    @method wrapModelType
    @param {Class} klass A model class.
    @param {String} modelName Name of the class.
    @return {Object} Contains the wrapped type and the function to remove observers
    Format:
      type: {Object} The wrapped type.
        The wrapped type has the following format:
          name: {String} The name of the type.
          count: {Integer} The number of records available.
          columns: {Columns} An array of columns to describe the record.
          object: {Class} The actual Model type class.
      release: {Function} The function to remove observers.
  */
  wrapModelType(klass, name) {
    let records = this.getRecords(klass, name);
    let typeToSend;

    typeToSend = {
      name,
      count: get(records, 'length'),
      columns: this.columnsForType(klass),
      object: klass,
    };

    return typeToSend;
  },

  /**
    Fetches all models defined in the application.

    @private
    @method getModelTypes
    @return {Array} Array of model types.
  */
  getModelTypes() {
    let containerDebugAdapter = this.get('containerDebugAdapter');
    let types;

    if (containerDebugAdapter.canCatalogEntriesByType('model')) {
      types = containerDebugAdapter.catalogEntriesByType('model');
    } else {
      types = this._getObjectsOnNamespaces();
    }

    // New adapters return strings instead of classes.
    types = emberA(types).map((name) => {
      return {
        klass: this._nameToClass(name),
        name,
      };
    });
    types = emberA(types).filter((type) => this.detect(type.klass));

    return emberA(types);
  },

  /**
    Loops over all namespaces and all objects
    attached to them.

    @private
    @method _getObjectsOnNamespaces
    @return {Array} Array of model type strings.
  */
  _getObjectsOnNamespaces() {
    let namespaces = emberA(Namespace.NAMESPACES);
    let types = emberA();

    namespaces.forEach((namespace) => {
      for (let key in namespace) {
        if (!Object.prototype.hasOwnProperty.call(namespace, key)) {
          continue;
        }
        // Even though we will filter again in `getModelTypes`,
        // we should not call `lookupFactory` on non-models
        if (!this.detect(namespace[key])) {
          continue;
        }
        let name = dasherize(key);
        types.push(name);
      }
    });
    return types;
  },

  /**
    Fetches all loaded records for a given type.

    @public
    @method getRecords
    @return {Array} An array of records.
     This array will be observed for changes,
     so it should update when new records are added/removed.
  */
  getRecords() {
    return emberA();
  },

  /**
    Wraps a record and observers changes to it.

    @private
    @method wrapRecord
    @param {Object} record The record instance.
    @return {Object} The wrapped record. Format:
    columnValues: {Array}
    searchKeywords: {Array}
  */
  wrapRecord(record) {
    let recordToSend = { object: record };

    recordToSend.columnValues = this.getRecordColumnValues(record);
    recordToSend.searchKeywords = this.getRecordKeywords(record);
    recordToSend.filterValues = this.getRecordFilterValues(record);
    recordToSend.color = this.getRecordColor(record);

    return recordToSend;
  },

  /**
    Gets the values for each column.

    @public
    @method getRecordColumnValues
    @return {Object} Keys should match column names defined
    by the model type.
  */
  getRecordColumnValues() {
    return {};
  },

  /**
    Returns keywords to match when searching records.

    @public
    @method getRecordKeywords
    @return {Array} Relevant keywords for search.
  */
  getRecordKeywords() {
    return emberA();
  },

  /**
    Returns the values of filters defined by `getFilters`.

    @public
    @method getRecordFilterValues
    @param {Object} record The record instance.
    @return {Object} The filter values.
  */
  getRecordFilterValues() {
    return {};
  },

  /**
    Each record can have a color that represents its state.

    @public
    @method getRecordColor
    @param {Object} record The record instance
    @return {String} The records color.
      Possible options: black, red, blue, green.
  */
  getRecordColor() {
    return null;
  },
});
