// The function library: name -> (compiler, args, env, ast) => ir.
//   SCALAR     functions that return a value
//   TABLE      functions that return a table
//   MODIFIERS  what a function means as a filter argument of CALCULATE when that is not a
//              filter (ALL removes filters, USERELATIONSHIP changes a relationship)
import * as scalarFns from './scalar.js';
import * as aggregateFns from './aggregate.js';
import * as tableFns from './table.js';
import * as timeFns from './time.js';

export const SCALAR = new Map(Object.entries({ ...scalarFns.scalar, ...aggregateFns.scalar, ...timeFns.scalar }));
export const TABLE = new Map(Object.entries({ ...tableFns.table, ...timeFns.table }));
export const MODIFIERS = new Map(Object.entries(tableFns.modifiers));
