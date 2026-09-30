"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createNum = void 0;
var _factory = require("../../utils/factory.js");
var _collection = require("../../utils/collection.js");
const name = 'num';
const dependencies = ['typed', 'fraction'];
const createNum = exports.createNum = /* #__PURE__ */(0, _factory.factory)(name, dependencies, _ref => {
  let {
    typed,
    fraction
  } = _ref;
  /**
   * Get the numerator of a fraction.
   * For a fraction `a/b`, the function returns `a`.
   *
   * The result is always in lowest terms. For example, `num(fraction(8, 6))`
   * returns `4n` because 8/6 simplifies to 4/3.
   *
   * For negative fractions like `-a/b` or `a/-b`, the sign is always
   * included in the numerator. Both forms are normalized internally, so
   * `num(fraction(-2, 3))` and `num(fraction(2, -3))` both return `-2`.
   *
   * For matrices, the function is evaluated element wise.
   *
   * Syntax:
   *
   *    math.num(x)
   *
   * Examples:
   *
   *    math.num(math.fraction(2, 3))   // returns 2n
   *    math.num(math.fraction(8, 6))   // returns 4n
   *    math.num(math.fraction('5/8'))  // returns 5n
   *    math.num(math.fraction(-2, 3))  // returns -2n
   *    math.num(math.fraction(2, -3))  // returns -2n
   *    math.num(math.bignumber('0.5'))  // returns 1n
   *
   * See also:
   *
   *    den, fraction
   *
   * History:
   *
   *    v15.2.0      Created
   *
   * @param {Fraction | BigNumber | Array | Matrix} x
   *            A fraction, BigNumber, or array with fractions
   * @return {bigint | Array | Matrix} The numerator of x (in lowest terms)
   */
  return typed(name, {
    Fraction: x => x.s * x.n,
    BigNumber: x => {
      const f = fraction(x);
      return f.s * f.n;
    },
    'Array | Matrix': typed.referToSelf(self => x => (0, _collection.deepMap)(x, self))
  });
});