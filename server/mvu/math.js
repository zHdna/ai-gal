/**
 * MVU math-expression evaluator (mathjs based).
 *
 * Ported from MagVarUpdate/src/function/update_variables.ts lines 29-320.
 *
 * Two safety properties are required, because the expression text is MODEL-CONTROLLED:
 *
 *   1. Host namespaces are never exposed directly. `Math` and `math` are exposed as frozen
 *      facades (bound functions / constants only) — otherwise an expression such as
 *      `Math.random = 0` would corrupt global state.
 *   2. Only "pure" expressions reuse a shared mathjs instance. Anything that assigns,
 *      redefines a function, mutates units (`createUnit`), or calls `config()` runs on a
 *      throwaway instance, so it cannot leak into later arguments.
 *
 * See the reference regression suite (tests/parse_command_value.test.ts) for the exact
 * behaviours this must preserve.
 */
'use strict';

const math = require('mathjs');

/** Build a frozen namespace exposing only the listed names (functions bound to source). */
function createReadOnlyMathNamespace(source, names) {
  const namespace = {};
  for (const name of names) {
    const value = source[name];
    namespace[name] = typeof value === 'function' ? value.bind(source) : value;
  }
  return Object.freeze(namespace);
}

/** Immutable facade over the host Math object (no mutable members escape). */
const SAFE_JAVASCRIPT_MATH = createReadOnlyMathNamespace(Math, Object.getOwnPropertyNames(Math));

/** Immutable facade over the mathjs namespace — only pure numeric helpers and constants. */
const SAFE_MATHJS_NAMESPACE = createReadOnlyMathNamespace(math, [
  'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh',
  'ceil', 'cos', 'cosh', 'cube', 'e', 'exp', 'expm1', 'floor', 'gcd',
  'hypot', 'lcm', 'log', 'log10', 'log1p', 'log2', 'max', 'mean', 'median',
  'min', 'mod', 'nthRoot', 'pi', 'pow', 'prod', 'round', 'sign', 'sin',
  'sinh', 'sqrt', 'square', 'std', 'sum', 'tan', 'tanh', 'tau', 'variance',
]);

/** Functions that are safe to call on the shared instance. */
const REUSABLE_MATH_FUNCTIONS = new Set([
  ...Object.keys(SAFE_MATHJS_NAMESPACE).filter(n => typeof SAFE_MATHJS_NAMESPACE[n] === 'function'),
  'complex', 'det', 'matrix', 'number', 'unit',
]);

let reusableMath;

/** Only `Math.x` / `math.x` reads on the facades count as read-only access. */
function isReadOnlyMathAccessor(node) {
  const property = node.index.dimensions[0];
  if (
    !math.isSymbolNode(node.object) ||
    node.index.dimensions.length !== 1 ||
    !math.isConstantNode(property) ||
    typeof property.value !== 'string'
  ) {
    return false;
  }
  const namespace =
    node.object.name === 'Math'
      ? SAFE_JAVASCRIPT_MATH
      : node.object.name === 'math'
        ? SAFE_MATHJS_NAMESPACE
        : undefined;
  return namespace !== undefined && Object.hasOwn(namespace, property.value);
}

/** True only for expressions with no assignment / indirect call / config-style side effect. */
function canReuseMathInstance(expression) {
  return (
    expression.filter(node => {
      if (math.isAssignmentNode(node) || math.isFunctionAssignmentNode(node)) return true;
      if (math.isAccessorNode(node)) return !isReadOnlyMathAccessor(node);
      if (math.isFunctionNode(node)) {
        return math.isSymbolNode(node.fn)
          ? !REUSABLE_MATH_FUNCTIONS.has(node.fn.name)
          : !math.isAccessorNode(node.fn) || !isReadOnlyMathAccessor(node.fn);
      }
      return false;
    }).length === 0
  );
}

/** Evaluate one expression; returns { ok, value } — ok=false means "not a math expression". */
function evaluateExpression(text) {
  const trimmed = String(text).trim();
  try {
    const evaluator = (reusableMath ??= math.create(math.all));
    const expression = evaluator.parse(trimmed);
    const scope = { Math: SAFE_JAVASCRIPT_MATH, math: SAFE_MATHJS_NAMESPACE };
    const result = canReuseMathInstance(expression)
      ? expression.compile().evaluate(scope)
      : math.create(math.all).evaluate(trimmed, scope);

    if (math.isComplex(result) || math.isMatrix(result)) return { ok: true, value: result.toString() };
    // A single bare word is a symbol, not a value — treat the whole thing as a string.
    if (result === undefined && !/^[a-zA-Z_]+$/.test(trimmed)) return { ok: true, value: trimmed };
    if (result !== undefined) return { ok: true, value: parseFloat(result.toPrecision(12)) };
  } catch (err) {
    /* not a valid expression -> caller keeps the raw string */
  }
  return { ok: false };
}

module.exports = { evaluateExpression, SAFE_JAVASCRIPT_MATH, SAFE_MATHJS_NAMESPACE };
