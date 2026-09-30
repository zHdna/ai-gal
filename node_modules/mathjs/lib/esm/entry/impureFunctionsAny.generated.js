import _extends from "@babel/runtime/helpers/extends";
/**
 * THIS FILE IS AUTO-GENERATED
 * DON'T MAKE CHANGES HERE
 */
import { config } from './configReadonly.js';
import { createNode, createObjectNode, createOperatorNode, createParenthesisNode, createRelationalNode, createArrayNode, createBlockNode, createConditionalNode, createRangeNode, createReviver, createChainClass, createFunctionAssignmentNode, createChain, createConstantNode, createIndexNode, createAccessorNode, createAssignmentNode, createSymbolNode, createFunctionNode, createParse, createResolve, createSimplifyConstant, createCompile, createEvaluate, createHelpClass, createParserClass, createSimplifyCore, createHelp, createSimplify, createSymbolicEqual, createDerivative, createParser, createLeafCount, createRationalize, createMapTransform, createFilterTransform, createForEachTransform, createMapSlicesTransform, createOrTransform, createAndTransform, createCumSumTransform, createMaxTransform, createNullishTransform, createPrintTransform, createBitAndTransform, createConcatTransform, createDiffTransform, createMinTransform, createSubsetTransform, createBitOrTransform, createSumTransform, createIndexTransform, createRowTransform, createColumnTransform, createMeanTransform, createRangeTransform, createVarianceTransform, createQuantileSeqTransform, createStdTransform } from '../factoriesAny.js';
import { BigNumber, Complex, e, _false, fineStructure, Fraction, i, _Infinity, LN10, LOG10E, Matrix, _NaN, _null, phi, Range, ResultSet, SQRT1_2,
// eslint-disable-line camelcase
sackurTetrode, tau, _true, version, DenseMatrix, efimovFactor, LN2, pi, replacer, SQRT2, typed, weakMixingAngle, abs, acos, acot, acsc, addScalar, arg, asech, asinh, atan, atanh, bigint, bitNot, boolean, clone, combinations, complex, conj, cos, cot, csc, cube, equalScalar, erf, exp, expm1, filter, flatten, forEach, format, getMatrixDataType, hex, im, isBounded, isNaN, isNumeric, isPrime, LOG2E, lgamma, log10, log2, map, mode, multiplyScalar, not, number, oct, pickRandom, print, random, re, sec, sign, sin, size, SparseMatrix, splitUnit, square, string, subtractScalar, tan, toBest, typeOf, acosh, acsch, asec, bignumber, combinationsWithRep, cosh, csch, dot, hasNumericValue, isFinite, isNegative, isZero, matrix, matrixFromFunction, multiply, ones, randomInt, resize, sech, sinh, sparse, sqrt, squeeze, tanh, transpose, xgcd, zeros, acoth, asin, bin, coth, ctranspose, diag, equal, fraction, identity, isInteger, kron, mapSlices, matrixFromColumns, num, reshape, round, unaryMinus, bernoulli, cbrt, concat, deepEqual, dotMultiply, floor, gcd, isPositive, larger, lcm, leftShift, mod, nthRoot, nullish, numeric, prod, rightArithShift, smaller, subtract, to, unaryPlus, xor, add, atan2, bitAnd, bitOr, bitXor, ceil, compare, compareText, composition, count, cross, diff, divideScalar, equalText, FibonacciHeap, fix, hypot, ImmutableDenseMatrix, Index, intersect, invmod, largerEq, log, lsolve, matrixFromRows, min, nthRoots, partitionSelect, qr, rightLogShift, slu, Spa, subset, sum, trace, usolve, zpk2tf, catalan, compareNatural, cumsum, det, dotDivide, index, inv, log1p, lsolveAll, max, or, pinv, pow, setCartesian, setDistinct, setIsSubset, setPowerset, smallerEq, sort, sqrtm, unequal, usolveAll, and, den, distance, dotPow, expm, fft, gamma, ifft, lup, range, row, setDifference, setMultiplicity, setSymDifference, Unit, vacuumImpedance, wienDisplacement, atomicMass, bohrMagneton, boltzmann, column, conductanceQuantum, coulomb, createUnit, deuteronMass, eigs, electronMass, factorial, fermiCoupling, gasConstant, gravity, klitzing, loschmidt, magneticConstant, molarMass, molarPlanckConstant, neutronMass, nuclearMagneton, permutations, planckConstant, planckMass, planckTime, protonMass, quantumOfCirculation, reducedPlanckConstant, secondRadiation, setSize, speedOfLight, stefanBoltzmann, thomsonCrossSection, avogadro, bohrRadius, coulombConstant, divide, elementaryCharge, faraday, freqz, gravitationConstant, inverseConductanceQuantum, lusolve, magneticFluxQuantum, molarMassC12, multinomial, planckCharge, planckTemperature, quantileSeq, rydberg, setIntersect, solveODE, stirlingS2, unit, bellNumbers, electricConstant, firstRadiation, hartreeEnergy, kldivergence, mean, molarVolume, planckLength, setUnion, variance, classicalElectronRadius, corr, median, polynomialRoot, std, zeta, mad, norm, rotationMatrix, rotate, schur, sylvester, lyap } from './pureFunctionsAny.generated.js';
var math = {}; // NOT pure!
var mathWithTransform = {}; // NOT pure!
var classes = {}; // NOT pure!

export var Node = createNode({
  mathWithTransform
});
export var ObjectNode = createObjectNode({
  Node
});
export var OperatorNode = createOperatorNode({
  Node
});
export var ParenthesisNode = createParenthesisNode({
  Node
});
export var RelationalNode = createRelationalNode({
  Node
});
export var ArrayNode = createArrayNode({
  Node
});
export var BlockNode = createBlockNode({
  Node,
  ResultSet
});
export var ConditionalNode = createConditionalNode({
  Node
});
export var RangeNode = createRangeNode({
  Node
});
export var reviver = createReviver({
  classes
});
export var Chain = createChainClass({
  math,
  typed
});
export var FunctionAssignmentNode = createFunctionAssignmentNode({
  Node,
  typed
});
export var chain = createChain({
  Chain,
  typed
});
export var ConstantNode = createConstantNode({
  Node,
  isBounded
});
export var IndexNode = createIndexNode({
  Node,
  size
});
export var AccessorNode = createAccessorNode({
  Node,
  subset
});
export var AssignmentNode = createAssignmentNode({
  matrix,
  Node,
  subset
});
export var SymbolNode = createSymbolNode({
  Unit,
  Node,
  math
});
export var FunctionNode = createFunctionNode({
  Node,
  SymbolNode,
  math
});
export var parse = createParse({
  AccessorNode,
  ArrayNode,
  AssignmentNode,
  BlockNode,
  ConditionalNode,
  ConstantNode,
  FunctionAssignmentNode,
  FunctionNode,
  IndexNode,
  ObjectNode,
  OperatorNode,
  ParenthesisNode,
  RangeNode,
  RelationalNode,
  SymbolNode,
  config,
  numeric,
  typed
});
export var resolve = createResolve({
  ConstantNode,
  FunctionNode,
  OperatorNode,
  ParenthesisNode,
  parse,
  typed
});
export var simplifyConstant = createSimplifyConstant({
  bignumber,
  fraction,
  AccessorNode,
  ArrayNode,
  ConstantNode,
  FunctionNode,
  IndexNode,
  ObjectNode,
  OperatorNode,
  SymbolNode,
  config,
  isBounded,
  mathWithTransform,
  matrix,
  typed
});
export var compile = createCompile({
  parse,
  typed
});
export var evaluate = createEvaluate({
  parse,
  typed
});
export var Help = createHelpClass({
  evaluate
});
export var Parser = createParserClass({
  evaluate,
  parse
});
export var simplifyCore = createSimplifyCore({
  AccessorNode,
  ArrayNode,
  ConstantNode,
  FunctionNode,
  IndexNode,
  ObjectNode,
  OperatorNode,
  ParenthesisNode,
  SymbolNode,
  add,
  divide,
  equal,
  isZero,
  multiply,
  parse,
  pow,
  subtract,
  typed
});
export var help = createHelp({
  Help,
  mathWithTransform,
  typed
});
export var simplify = createSimplify({
  AccessorNode,
  ArrayNode,
  ConstantNode,
  FunctionNode,
  IndexNode,
  ObjectNode,
  OperatorNode,
  ParenthesisNode,
  SymbolNode,
  equal,
  parse,
  replacer,
  resolve,
  simplifyConstant,
  simplifyCore,
  typed
});
export var symbolicEqual = createSymbolicEqual({
  OperatorNode,
  parse,
  simplify,
  typed
});
export var derivative = createDerivative({
  ConstantNode,
  FunctionNode,
  OperatorNode,
  ParenthesisNode,
  SymbolNode,
  config,
  equal,
  isZero,
  numeric,
  parse,
  simplify,
  typed
});
export var parser = createParser({
  Parser,
  typed
});
export var leafCount = createLeafCount({
  parse,
  typed
});
export var rationalize = createRationalize({
  bignumber,
  fraction,
  AccessorNode,
  ArrayNode,
  ConstantNode,
  FunctionNode,
  IndexNode,
  ObjectNode,
  OperatorNode,
  ParenthesisNode,
  SymbolNode,
  add,
  config,
  divide,
  equal,
  isZero,
  mathWithTransform,
  matrix,
  multiply,
  parse,
  pow,
  simplify,
  simplifyConstant,
  simplifyCore,
  subtract,
  typed
});
_extends(math, {
  e,
  false: _false,
  fineStructure,
  i,
  Infinity: _Infinity,
  LN10,
  LOG10E,
  NaN: _NaN,
  null: _null,
  phi,
  SQRT1_2,
  sackurTetrode,
  tau,
  true: _true,
  'E': e,
  version,
  efimovFactor,
  LN2,
  pi,
  replacer,
  reviver,
  SQRT2,
  typed,
  'PI': pi,
  weakMixingAngle,
  abs,
  acos,
  acot,
  acsc,
  addScalar,
  arg,
  asech,
  asinh,
  atan,
  atanh,
  bigint,
  bitNot,
  boolean,
  clone,
  combinations,
  complex,
  conj,
  cos,
  cot,
  csc,
  cube,
  equalScalar,
  erf,
  exp,
  expm1,
  filter,
  flatten,
  forEach,
  format,
  getMatrixDataType,
  hex,
  im,
  isBounded,
  isNaN,
  isNumeric,
  isPrime,
  LOG2E,
  lgamma,
  log10,
  log2,
  map,
  mode,
  multiplyScalar,
  not,
  number,
  oct,
  pickRandom,
  print,
  random,
  re,
  sec,
  sign,
  sin,
  size,
  splitUnit,
  square,
  string,
  subtractScalar,
  tan,
  toBest,
  typeOf,
  acosh,
  acsch,
  asec,
  bignumber,
  chain,
  combinationsWithRep,
  cosh,
  csch,
  dot,
  hasNumericValue,
  isFinite,
  isNegative,
  isZero,
  matrix,
  matrixFromFunction,
  multiply,
  ones,
  randomInt,
  resize,
  sech,
  sinh,
  sparse,
  sqrt,
  squeeze,
  tanh,
  transpose,
  xgcd,
  zeros,
  acoth,
  asin,
  bin,
  coth,
  ctranspose,
  diag,
  equal,
  fraction,
  identity,
  isInteger,
  kron,
  mapSlices,
  matrixFromColumns,
  num,
  reshape,
  round,
  unaryMinus,
  bernoulli,
  cbrt,
  concat,
  deepEqual,
  dotMultiply,
  floor,
  gcd,
  isPositive,
  larger,
  lcm,
  leftShift,
  mod,
  nthRoot,
  nullish,
  numeric,
  prod,
  rightArithShift,
  smaller,
  subtract,
  to,
  unaryPlus,
  xor,
  add,
  atan2,
  bitAnd,
  bitOr,
  bitXor,
  ceil,
  compare,
  compareText,
  composition,
  count,
  cross,
  diff,
  divideScalar,
  equalText,
  fix,
  hypot,
  intersect,
  invmod,
  largerEq,
  log,
  lsolve,
  matrixFromRows,
  min,
  nthRoots,
  partitionSelect,
  qr,
  rightLogShift,
  slu,
  subset,
  sum,
  trace,
  usolve,
  zpk2tf,
  catalan,
  compareNatural,
  cumsum,
  det,
  dotDivide,
  index,
  inv,
  log1p,
  lsolveAll,
  max,
  or,
  pinv,
  pow,
  setCartesian,
  setDistinct,
  setIsSubset,
  setPowerset,
  smallerEq,
  sort,
  sqrtm,
  unequal,
  usolveAll,
  and,
  den,
  distance,
  dotPow,
  expm,
  fft,
  gamma,
  ifft,
  lup,
  range,
  row,
  setDifference,
  setMultiplicity,
  setSymDifference,
  vacuumImpedance,
  wienDisplacement,
  atomicMass,
  bohrMagneton,
  boltzmann,
  column,
  conductanceQuantum,
  coulomb,
  createUnit,
  deuteronMass,
  eigs,
  electronMass,
  factorial,
  fermiCoupling,
  gasConstant,
  gravity,
  klitzing,
  loschmidt,
  magneticConstant,
  molarMass,
  molarPlanckConstant,
  neutronMass,
  nuclearMagneton,
  permutations,
  planckConstant,
  planckMass,
  planckTime,
  protonMass,
  quantumOfCirculation,
  reducedPlanckConstant,
  secondRadiation,
  setSize,
  speedOfLight,
  stefanBoltzmann,
  thomsonCrossSection,
  avogadro,
  bohrRadius,
  coulombConstant,
  divide,
  elementaryCharge,
  faraday,
  freqz,
  gravitationConstant,
  inverseConductanceQuantum,
  lusolve,
  magneticFluxQuantum,
  molarMassC12,
  multinomial,
  planckCharge,
  planckTemperature,
  quantileSeq,
  rydberg,
  setIntersect,
  solveODE,
  stirlingS2,
  unit,
  bellNumbers,
  electricConstant,
  firstRadiation,
  hartreeEnergy,
  kldivergence,
  mean,
  molarVolume,
  planckLength,
  setUnion,
  variance,
  classicalElectronRadius,
  corr,
  median,
  parse,
  polynomialRoot,
  resolve,
  simplifyConstant,
  std,
  zeta,
  compile,
  evaluate,
  mad,
  simplifyCore,
  help,
  norm,
  rotationMatrix,
  simplify,
  symbolicEqual,
  derivative,
  parser,
  rotate,
  leafCount,
  rationalize,
  schur,
  sylvester,
  lyap,
  config
});
_extends(mathWithTransform, math, {
  map: createMapTransform({
    typed
  }),
  filter: createFilterTransform({
    typed
  }),
  forEach: createForEachTransform({
    typed
  }),
  mapSlices: createMapSlicesTransform({
    isInteger,
    typed
  }),
  or: createOrTransform({
    DenseMatrix,
    concat,
    equalScalar,
    matrix,
    typed
  }),
  and: createAndTransform({
    add,
    concat,
    equalScalar,
    matrix,
    not,
    typed,
    zeros
  }),
  cumsum: createCumSumTransform({
    add,
    typed,
    unaryPlus
  }),
  max: createMaxTransform({
    config,
    isNaN,
    larger,
    numeric,
    typed
  }),
  nullish: createNullishTransform({
    deepEqual,
    flatten,
    matrix,
    size,
    typed
  }),
  print: createPrintTransform({
    add,
    matrix,
    typed,
    zeros
  }),
  bitAnd: createBitAndTransform({
    add,
    concat,
    equalScalar,
    matrix,
    not,
    typed,
    zeros
  }),
  concat: createConcatTransform({
    isInteger,
    matrix,
    typed
  }),
  diff: createDiffTransform({
    bignumber,
    matrix,
    number,
    subtract,
    typed
  }),
  min: createMinTransform({
    config,
    isNaN,
    numeric,
    smaller,
    typed
  }),
  subset: createSubsetTransform({
    add,
    matrix,
    typed,
    zeros
  }),
  bitOr: createBitOrTransform({
    DenseMatrix,
    concat,
    equalScalar,
    matrix,
    typed
  }),
  sum: createSumTransform({
    add,
    config,
    numeric,
    typed
  }),
  index: createIndexTransform({
    Index,
    getMatrixDataType
  }),
  row: createRowTransform({
    Index,
    matrix,
    range,
    typed
  }),
  column: createColumnTransform({
    Index,
    matrix,
    range,
    typed
  }),
  mean: createMeanTransform({
    add,
    divide,
    typed
  }),
  range: createRangeTransform({
    bignumber,
    matrix,
    add,
    config,
    equal,
    isPositive,
    isZero,
    larger,
    largerEq,
    smaller,
    smallerEq,
    typed
  }),
  variance: createVarianceTransform({
    add,
    divide,
    isNaN,
    mapSlices,
    multiply,
    subtract,
    typed
  }),
  quantileSeq: createQuantileSeqTransform({
    add,
    bignumber,
    compare,
    divide,
    isInteger,
    larger,
    mapSlices,
    multiply,
    partitionSelect,
    smaller,
    smallerEq,
    subtract,
    typed
  }),
  std: createStdTransform({
    map,
    sqrt,
    typed,
    variance
  })
});
_extends(classes, {
  BigNumber,
  Complex,
  Fraction,
  Matrix,
  Node,
  ObjectNode,
  OperatorNode,
  ParenthesisNode,
  Range,
  RelationalNode,
  ResultSet,
  ArrayNode,
  BlockNode,
  ConditionalNode,
  DenseMatrix,
  RangeNode,
  Chain,
  FunctionAssignmentNode,
  SparseMatrix,
  ConstantNode,
  IndexNode,
  FibonacciHeap,
  ImmutableDenseMatrix,
  Index,
  Spa,
  AccessorNode,
  AssignmentNode,
  Unit,
  SymbolNode,
  FunctionNode,
  Help,
  Parser
});
Chain.createProxy(math);
export { embeddedDocs as docs } from '../expression/embeddedDocs/embeddedDocs.js';