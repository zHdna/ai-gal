/**
 * MVU schema: $meta -> structure rules, validation, reconciliation, metadata cleanup.
 *
 * Ported from MagVarUpdate/src/function/schema.ts (and variable_def.ts type shapes).
 *
 * The schema protects a card's data structure from a confused model:
 *   · extensible            — may this object/array gain or lose members?
 *   · required[]            — keys that may NOT be removed.
 *   · recursiveExtensible   — inheritable extensibility (stoppable by extensible:false).
 *   · template              — merged into newly assigned members.
 * Root-level switches live in stat_data.$meta and are hoisted onto the schema:
 *   strictSet / strictTemplate / concatTemplateArray.
 *
 * IMPORTANT: $meta, the $__META_EXTENSIBLE__$ marker and {$meta,$arrayMeta:true}
 * elements are REMOVED from stat_data after the schema is built (they must never be
 * sent to the model), while the generated schema is KEPT (it is part of MvuData).
 */
'use strict';

const _ = require('lodash');

const EXTENSIBLE_MARKER = '$__META_EXTENSIBLE__$';

function isArraySchema(node) { return !!node && node.type === 'array'; }
function isObjectSchema(node) { return !!node && node.type === 'object'; }

/** True for the {'$meta', '$arrayMeta':true} element that carries array-level meta. */
function isArrayMetaElement(item) {
  return _.isObject(item) && !_.isDate(item) && item.$arrayMeta === true && Object.hasOwn(item, '$meta');
}

/**
 * Recursively build a schema for `data`, inheriting metadata from `oldSchemaNode`.
 * NOTE: this MUTATES `data` (it splices out markers / meta elements) — callers must pass
 * a clone when the real stat_data must stay intact (see reconcileAndApplySchema).
 */
function generateSchema(data, oldSchemaNode, parentRecursiveExtensible = false) {
  if (Array.isArray(data)) {
    let isExtensible = false;
    let isRecursiveExtensible = parentRecursiveExtensible;
    let oldElementType;
    let template;

    if (oldSchemaNode) {
      if (isArraySchema(oldSchemaNode)) {
        isExtensible = oldSchemaNode.extensible === true;
        isRecursiveExtensible = oldSchemaNode.recursiveExtensible === true || parentRecursiveExtensible;
        oldElementType = oldSchemaNode.elementType;
        template = oldSchemaNode.template;
      } else {
        console.error('[mvu] schema type mismatch: expected array schema');
      }
    }

    const metaElementIndex = data.findIndex(item => isArrayMetaElement(item));
    if (metaElementIndex !== -1) {
      const metaElement = data[metaElementIndex];
      if (metaElement.$meta && metaElement.$meta.extensible !== undefined) {
        isExtensible = metaElement.$meta.extensible;
      }
      if (metaElement.$meta && metaElement.$meta.template !== undefined) {
        template = metaElement.$meta.template;
      }
      data.splice(metaElementIndex, 1);
    }

    const markerIndex = data.indexOf(EXTENSIBLE_MARKER);
    if (markerIndex > -1) {
      isExtensible = true;
      data.splice(markerIndex, 1);
    }

    const schemaNode = {
      type: 'array',
      extensible: isExtensible || parentRecursiveExtensible,
      recursiveExtensible: isRecursiveExtensible,
      elementType:
        data.length > 0 ? generateSchema(data[0], oldElementType, isRecursiveExtensible) : { type: 'any' },
    };
    if (template !== undefined) schemaNode.template = template;
    return schemaNode;
  }

  if (_.isObject(data) && !_.isDate(data)) {
    let oldExtensible = false;
    let oldRecursiveExtensible = parentRecursiveExtensible;
    let oldProperties;

    if (oldSchemaNode) {
      if (isObjectSchema(oldSchemaNode)) {
        oldExtensible = oldSchemaNode.extensible === true;
        oldRecursiveExtensible = oldSchemaNode.recursiveExtensible === true || parentRecursiveExtensible;
        oldProperties = oldSchemaNode.properties;
      } else {
        console.error('[mvu] schema type mismatch: expected object schema');
      }
    }

    const schemaNode = {
      type: 'object',
      properties: {},
      extensible:
        oldExtensible ||
        _.get(data, '$meta.extensible') === true ||
        _.get(data, '$meta.recursiveExtensible') === true ||
        parentRecursiveExtensible,
      recursiveExtensible:
        oldRecursiveExtensible || _.get(data, '$meta.recursiveExtensible') === true,
    };

    if (_.get(data, '$meta.template') !== undefined) {
      schemaNode.template = data.$meta.template;
    } else if (oldSchemaNode && isObjectSchema(oldSchemaNode) && oldSchemaNode.template) {
      schemaNode.template = oldSchemaNode.template;
    }

    const parentMeta = data.$meta;
    if (data.$meta) delete data.$meta;

    for (const key in data) {
      const oldChildNode = oldProperties ? oldProperties[key] : undefined;
      const childRecursiveExtensible = schemaNode.extensible !== false && schemaNode.recursiveExtensible;
      const childSchema = generateSchema(data[key], oldChildNode, childRecursiveExtensible);

      let isRequired = !schemaNode.extensible;
      if (Array.isArray(parentMeta && parentMeta.required) && parentMeta.required.includes(key)) {
        isRequired = true;
      }
      if (oldChildNode && oldChildNode.required === false) isRequired = false;
      else if (oldChildNode && oldChildNode.required === true) isRequired = true;

      schemaNode.properties[key] = Object.assign({}, childSchema, { required: isRequired });
    }
    return schemaNode;
  }

  const dataType = typeof data;
  if (dataType === 'string' || dataType === 'number' || dataType === 'boolean') return { type: dataType };
  return { type: 'any' };
}

/** Resolve the schema node for a lodash path (numeric segments walk elementType). */
function getSchemaForPath(schema, path) {
  if (!path || !schema) return schema || null;
  const pathSegments = _.toPath(path);
  let currentSchema = schema;
  for (const segment of pathSegments) {
    if (!currentSchema) return null;
    if (/^\d+$/.test(segment)) {
      if (isArraySchema(currentSchema)) currentSchema = currentSchema.elementType;
      else return null;
    } else if (isObjectSchema(currentSchema) && currentSchema.properties[segment]) {
      currentSchema = currentSchema.properties[segment];
    } else {
      return null;
    }
  }
  return currentSchema;
}

/** Recursively strip $meta / EXTENSIBLE_MARKER / array-meta elements from stat_data. */
function cleanUpMetadata(data) {
  if (Array.isArray(data)) {
    let i = data.length;
    while (i--) {
      if (data[i] === EXTENSIBLE_MARKER) data.splice(i, 1);
      else if (isArrayMetaElement(data[i])) data.splice(i, 1);
      else cleanUpMetadata(data[i]);
    }
  } else if (_.isObject(data) && !_.isDate(data)) {
    delete data.$meta;
    for (const key in data) cleanUpMetadata(data[key]);
  }
}

/**
 * Rebuild the schema from the current stat_data, inheriting metadata from the old schema,
 * and carry over the root-level switches. Mirrors reconcileAndApplySchema().
 */
function reconcileAndApplySchema(variables) {
  const currentDataClone = _.cloneDeep(variables.stat_data);
  const newSchema = generateSchema(currentDataClone, variables.schema);
  if (!isObjectSchema(newSchema)) return;

  const prev = variables.schema || {};
  if (prev.strictTemplate !== undefined) newSchema.strictTemplate = prev.strictTemplate;
  if (prev.strictSet !== undefined) newSchema.strictSet = prev.strictSet;
  if (prev.concatTemplateArray !== undefined) newSchema.concatTemplateArray = prev.concatTemplateArray;
  if (_.has(variables.stat_data, '$meta.strictTemplate')) newSchema.strictTemplate = variables.stat_data.$meta.strictTemplate;
  if (_.has(variables.stat_data, '$meta.strictSet')) newSchema.strictSet = variables.stat_data.$meta.strictSet;
  if (_.has(variables.stat_data, '$meta.concatTemplateArray')) newSchema.concatTemplateArray = variables.stat_data.$meta.concatTemplateArray;

  variables.schema = newSchema;
}

/**
 * Build the initial schema for freshly initialised data (also hoists root switches).
 *
 * NOTE: generateSchema() builds from a CLONE (it mutates: it splices out markers), so the
 * LIVE stat_data must then be cleaned explicitly — otherwise $meta / $__META_EXTENSIBLE__$
 * would leak into the model prompt. This mirrors variable_init.ts:101-123.
 */
function buildInitialSchema(statData, oldSchema) {
  const dataForSchema = _.cloneDeep(statData);
  const generated = generateSchema(dataForSchema, oldSchema);
  if (isObjectSchema(generated)) {
    if (_.has(statData, '$meta.strictTemplate')) generated.strictTemplate = statData.$meta.strictTemplate;
    if (_.has(statData, '$meta.concatTemplateArray')) generated.concatTemplateArray = statData.$meta.concatTemplateArray;
    if (_.has(statData, '$meta.strictSet')) generated.strictSet = statData.$meta.strictSet;
  }
  cleanUpMetadata(statData);
  return generated;
}

module.exports = {
  EXTENSIBLE_MARKER,
  isArraySchema,
  isObjectSchema,
  generateSchema,
  getSchemaForPath,
  cleanUpMetadata,
  reconcileAndApplySchema,
  buildInitialSchema,
};
