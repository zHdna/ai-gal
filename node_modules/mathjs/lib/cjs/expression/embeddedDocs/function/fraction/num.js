"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.numDocs = void 0;
const numDocs = exports.numDocs = {
  name: 'num',
  category: 'Fraction',
  syntax: ['num(x)'],
  description: 'Get the numerator of a fraction.',
  examples: ['num(fraction(2, 3))', 'num(fraction(5, 8))'],
  seealso: ['den', 'fraction']
};