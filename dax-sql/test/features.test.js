// Calculated tables, calculation groups, field parameters, row-level security, ALLSELECTED's
// shadow filter contexts, START AT, the window functions, and the blank row; on the model of
// fixtures/contoso.js, every expected result worked out by hand from its 11 sales.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { harness, sorted } from './helpers.js';
import { bim, setup } from './fixtures/contoso.js';

let h;
before(async () => { h = await harness(bim, setup); });

const eqWith = async (hh, dax, expected, { ordered = false } = {}) => {
  const rows = await hh.run(dax);
  assert.deepEqual(ordered ? rows : sorted(rows), ordered ? expected : sorted(expected));
};
const eq = (dax, expected, o) => eqWith(h, dax, expected, o);
const r = (...names) => (...values) => Object.fromEntries(names.map((n, i) => [n, values[i]]));

// --- calculated tables and field parameters -------------------------------------------------

test('a calculated table: its expression, as a table of its own', async () => {
  await eq("EVALUATE 'Big Products'", [{ ProductKey: 1, Name: 'Road Bike', Price: 1000 }, { ProductKey: 2, Name: 'Mountain Bike', Price: 800 }]);
  // Its columns are its own: a filter on them does not reach Product.
  await eq(`EVALUATE CALCULATETABLE(ROW("n", COUNTROWS(Product), "b", COUNTROWS('Big Products')), 'Big Products'[Price] > 900)`, [{ n: 5, b: 1 }]);
  // A relationship to it works as to any table; the other products' sales (530) are its blank row's.
  const b = structuredClone(bim);
  b.model.relationships.push({ name: 'sales_big', fromTable: 'Sales', fromColumn: 'ProductKey', toTable: 'Big Products', toColumn: 'ProductKey' });
  const row = r('Name', 's');
  await eqWith(await harness(b, setup), `EVALUATE SUMMARIZECOLUMNS('Big Products'[Name], "s", [Sales Amount])`,
    [row('Road Bike', 4000), row('Mountain Bike', 1600), row(null, 530)]);
});

test("CALENDARAUTO: the whole years of the model's dates", () => eq(
  'EVALUATE ROW("n", COUNTROWS(Days), "first", MIN(Days[Date]), "last", MAX(Days[Date]))', [{ n: 731, first: '2023-01-01', last: '2024-12-31' }]));

test('a field parameter: NAMEOF, and the fields a selection stands for', async () => {
  const row = r('Fields', 'Fields Fields', 'Fields Order');
  await eq('EVALUATE Fields', [row('Sales', "'Sales'[Sales Amount]", 0), row('Quantity', "'Sales'[Quantity]", 1), row('Color', "'Product'[Color]", 2)]);
  await eq('EVALUATE ROW("m", NAMEOF([Quantity]), "c", NAMEOF(Product[Color]))', [{ m: "'Sales'[Quantity]", c: "'Product'[Color]" }]);
  const [p] = h.dax.fieldParameters();
  assert.equal(p.table, 'Fields');
  assert.deepEqual(h.dax.expandFieldParameter('Fields', ['Color', 'Sales']).map(f => [f.ref, f.kind]),
    [["'Sales'[Sales Amount]", 'measure'], ["'Product'[Color]", 'column']]);
});

// --- calculation groups ---------------------------------------------------------------------

test('a calculation item replaces the measure; the measure is SELECTEDMEASURE()', async () => {
  // Year to date at March 2024: January 2000 + February 300 + March 800; quantity 2 + 5 + 4 + 1.
  await eq(`EVALUATE CALCULATETABLE(ROW("s", [Sales Amount], "q", [Quantity], "implicit", SUM(Sales[Amount])),
    'Time Calc'[Time Calc] = "YTD", 'Date'[Year] = 2024, 'Date'[Month] = 3)`, [{ s: 3100, q: 12, implicit: 800 }]);
});

test('grouped by the calculation group: each item; sideways recursion (YOY uses PY)', async () => {
  const row = r('Year', 'Time Calc', 's');
  await eq(`EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Date'[Year], 'Time Calc'[Time Calc], "s", [Sales Amount]),
    'Time Calc'[Time Calc] IN {"Current", "PY", "YOY"})`,
  [row(2023, 'Current', 2010), row(2023, 'YOY', 2010), row(2024, 'Current', 4120), row(2024, 'PY', 2010), row(2024, 'YOY', 2110)]);
});

test('two calculation groups: the higher precedence outermost; SELECTEDMEASURENAME', async () => {
  // Scale (20) around Time Calc (10): (sales of 2023) * 2.
  await eq(`EVALUATE CALCULATETABLE(ROW("s", [Sales Amount]), 'Time Calc'[Time Calc] = "PY", Scale[Scale] = "x2", 'Date'[Year] = 2024)`, [{ s: 4020 }]);
  // plus1 around x2 is not possible (one item per group): plus1 around YTD of 2024 = 4120 + 1.
  await eq(`EVALUATE CALCULATETABLE(ROW("s", [Sales Amount]), 'Time Calc'[Time Calc] = "YTD", Scale[Scale] = "plus1", 'Date'[Year] = 2024)`, [{ s: 4121 }]);
  await eq(`EVALUATE CALCULATETABLE(ROW("n", [Quantity]), 'Time Calc'[Time Calc] = "Name")`, [{ n: 'Quantity' }]);
  // Several items selected, and no selection expression: the measure as it is.
  await eq(`EVALUATE CALCULATETABLE(ROW("s", [Sales Amount]), 'Time Calc'[Time Calc] IN {"PY", "YTD"}, 'Date'[Year] = 2024)`, [{ s: 4120 }]);
  // An item that names a measure itself: the item is not applied to it a second time.
  const b = structuredClone(bim);
  b.model.tables.find(t => t.name === 'Time Calc').calculationGroup.calculationItems.push({ name: 'Tenfold', expression: '[Sales Amount] * 10' });
  await eqWith(await harness(b, setup), `EVALUATE ROW("q", CALCULATE([Quantity], 'Time Calc'[Time Calc] = "Tenfold"))`, [{ q: 61300 }]);
});

test('calculation groups: selection expressions; iterating the items keeps them numbers', async () => {
  const b = structuredClone(bim), group = n => b.model.tables.find(t => t.name === n).calculationGroup;
  group('Time Calc').multipleOrEmptySelectionExpression = { expression: 'SELECTEDMEASURE() * 1000' };
  group('Scale').noSelectionExpression = 'SELECTEDMEASURE() * 3';
  const h2 = await harness(b, setup);
  // Scale unfiltered: * 3, once; Time Calc with two items: * 1000.
  await eqWith(h2, 'EVALUATE ROW("s", [Sales Amount])', [{ s: 18390 }]);
  await eqWith(h2, `EVALUATE CALCULATETABLE(ROW("s", [Sales Amount]), 'Time Calc'[Time Calc] IN {"PY", "YTD"}, Scale[Scale] = "plus1")`, [{ s: 6130001 }]);
  // The items a row of the group can be are those the filters allow: no "Name" (text) among
  // them, so the sum is a number. 2024: Current 4120, YTD 4120, PY 2010, YOY 2110.
  await eq(`EVALUATE CALCULATETABLE(ROW("s", SUMX(VALUES('Time Calc'[Time Calc]), [Sales Amount])),
    'Time Calc'[Time Calc] IN {"Current", "YTD", "PY", "YOY"}, 'Date'[Year] = 2024)`, [{ s: 12360 }]);
  await eq(`EVALUATE CALCULATETABLE(ROW("s", [Sales Amount]), FILTER(ALL('Time Calc'), 'Time Calc'[Ordinal] = 2), 'Date'[Year] = 2024)`, [{ s: 2010 }]);
  await eq(`EVALUATE CALCULATETABLE(ROW("s", SUMX({"PY", "YTD"}, CALCULATE([Sales Amount], 'Time Calc'[Time Calc] = [Value]))), 'Date'[Year] = 2024)`, [{ s: 6130 }]);
});

// --- row-level security -----------------------------------------------------------------------

test('row-level security: the rows a role keeps, which ALL does not bring back', async () => {
  const paris = await harness(bim, setup, { roles: ['Paris'] });
  await eqWith(paris, 'EVALUATE SUMMARIZECOLUMNS(Customer[Customer], "s", [Sales Amount])', [{ Customer: 'Alice', s: 2000 }, { Customer: 'Chloe', s: 2260 }]);
  await eqWith(paris, 'EVALUATE ROW("s", [Sales Amount], "all", CALCULATE([Sales Amount], ALL(Customer)), "c", COUNTROWS(ALL(Customer)))', [{ s: 4260, all: 4260, c: 2 }]);
  // Two roles: what either keeps. Paris's 4260, and Bob's red sales (50 and 1000).
  const two = await harness(bim, setup, { roles: ['Paris', 'RedOnly'] });
  await eqWith(two, 'EVALUATE ROW("s", [Sales Amount])', [{ s: 5310 }]);
  // Dynamic: the customer named by USERPRINCIPALNAME().
  const bob = await harness(bim, setup, { roles: 'Me', user: 'Bob' });
  await eqWith(bob, 'EVALUATE ROW("s", [Sales Amount], "c", COUNTROWS(Customer))', [{ s: 1850, c: 1 }]);
  await assert.rejects(() => harness(bim, setup, { roles: ['Nobody'] }), /no role Nobody/);
});

test('row-level security: across relationships that filter both ways for it, and many-to-many ones', async () => {
  // Returns of more than one: the Cap's (Product 4). Security both ways from Returns to
  // Product, then on to Sales as any filter on Product: the Cap's 60 + 100 + 20.
  const b = structuredClone(bim);
  const rel = b.model.relationships.find(r => r.name === 'returns_product');
  Object.assign(rel, { crossFilteringBehavior: 'bothDirections', securityFilteringBehavior: 'bothDirections' });
  b.model.roles.push({ name: 'BigReturns', modelPermission: 'read', tablePermissions: [{ name: 'Returns', filterExpression: 'Returns[ReturnQty] > 1' }] });
  const h2 = await harness(b, setup, { roles: 'BigReturns' });
  await eqWith(h2, 'EVALUATE ROW("p", COUNTROWS(Product), "s", [Sales Amount], "o", COUNTROWS(Sales))', [{ p: 1, s: 180, o: 3 }]);
  // CityTarget is many-to-many with Customer: Paris's customers keep Paris's target.
  const paris = await harness(bim, setup, { roles: 'Paris' });
  await eqWith(paris, 'EVALUATE SUMMARIZECOLUMNS(CityTarget[City], "t", [Target])', [{ City: 'Paris', t: 5000 }]);
});

test('calculated columns: computed without security, and blank on the blank row', async () => {
  const b = structuredClone(bim), cols = n => b.model.tables.find(t => t.name === n).columns;
  cols('Product').push({ name: 'Total Sales', dataType: 'double', type: 'calculated', expression: 'CALCULATE(SUM(Sales[Amount]))' });
  cols('Customer').push({ name: 'Flag', dataType: 'int64', type: 'calculated', expression: '1' });
  const paris = await harness(b, setup, { roles: 'Paris' });
  await eqWith(paris, `EVALUATE SELECTCOLUMNS(FILTER(Product, Product[Name] = "Road Bike"), "t", Product[Total Sales])`, [{ t: 4000 }]);
  const h2 = await harness(b, setup);
  await eqWith(h2, 'EVALUATE SUMMARIZECOLUMNS(Customer[Flag], "s", [Sales Amount])', [{ Flag: 1, s: 6110 }, { Flag: null, s: 20 }]);
});

// --- ALLSELECTED, START AT --------------------------------------------------------------------

test('ALLSELECTED inside an iterator restores the filter the iteration started in', async () => {
  // Red and Blue are selected (4350 + 180 = 4530): each of the two rows of the iteration sees both.
  await eq(`EVALUATE CALCULATETABLE(ROW("x", SUMX(VALUES(Product[Color]), CALCULATE([Sales Amount], ALLSELECTED(Product[Color])))),
    Product[Color] IN {"Red", "Blue"})`, [{ x: 9060 }]);
  const row = r('Color', 'pct');
  await eq(`EVALUATE CALCULATETABLE(ADDCOLUMNS(VALUES(Product[Color]), "pct", DIVIDE([Sales Amount], CALCULATE([Sales Amount], ALLSELECTED(Product[Color])))),
    Product[Color] IN {"Red", "Blue"})`, [row('Red', 0.960264901), row('Blue', 0.039735099)]);
});

test('ALLSELECTED: shadow filter contexts are on the columns iterated (SQLBI\'s examples)', async () => {
  const F = `Product[Color] IN {"Red", "Blue"}, Product[CategoryKey] IN {1, 2}`;
  // Iterating ALL(Color): its shadow (every color) replaces the filter on Color; the one on
  // the category stays: Road Bike, Mountain Bike, Jersey, Cap.
  await eq(`EVALUATE CALCULATETABLE(ADDCOLUMNS(ALL(Product[Color]), "n", COUNTROWS(ALLSELECTED(Product))), ${F})`,
    [{ Color: 'Black', n: 4 }, { Color: 'Blue', n: 4 }, { Color: 'Red', n: 4 }]);
  // No iterator: a table keeps the filters; a column no shadow covers has all its values.
  await eq(`EVALUATE CALCULATETABLE(ROW("t", COUNTROWS(ALLSELECTED(Product)), "c", COUNTROWS(ALLSELECTED(Product[Name]))), ${F})`, [{ t: 3, c: 5 }]);
  // A filter set inside the iteration stays: Red sales of all cities are 4350.
  const row = r('City', 'x');
  await eq(`EVALUATE SUMMARIZECOLUMNS(Customer[City], "x", CALCULATE(DIVIDE([Sales Amount], CALCULATE([Sales Amount], ALLSELECTED())), Product[Color] = "Red"))`,
    [row('Paris', 0.75862069), row('London', 0.24137931)]);
  // SUMMARIZE's groups are a shadow too.
  await eq(`EVALUATE CALCULATETABLE(SUMMARIZE(Product, Product[Color], "pct", DIVIDE([Sales Amount], CALCULATE([Sales Amount], ALLSELECTED(Product[Color])))),
    Product[Color] IN {"Red", "Blue"})`, [{ Color: 'Red', pct: 0.960264901 }, { Color: 'Blue', pct: 0.039735099 }]);
});

test('START AT', async () => {
  await eq('EVALUATE SUMMARIZECOLUMNS(Product[Color], "s", [Sales Amount]) ORDER BY [s] ASC START AT -5',
    [{ Color: 'Blue', s: 180 }, { Color: 'Black', s: 1600 }, { Color: 'Red', s: 4350 }], { ordered: true });
  await eq('EVALUATE SUMMARIZECOLUMNS(Product[Color], "s", [Sales Amount]) ORDER BY [s] DESC START AT 1600',
    [{ Color: 'Black', s: 1600 }, { Color: 'Blue', s: 180 }], { ordered: true });
  // Within Black, from Paris on; a blank city comes first under Blue.
  const row = r('Color', 'City', 's');
  await eq('EVALUATE SUMMARIZECOLUMNS(Product[Color], Customer[City], "s", [Sales Amount]) ORDER BY Product[Color], Customer[City] START AT "Black", "Paris"',
    [row('Black', 'Paris', 800), row('Blue', null, 20), row('Blue', 'Paris', 160), row('Red', 'London', 1050), row('Red', 'Paris', 3300)], { ordered: true });
  const p = await harness(bim, setup, { params: { first: 'Cap' } });
  await eqWith(p, 'EVALUATE VALUES(Product[Name]) ORDER BY Product[Name] DESC START AT @first', [{ Name: 'Cap' }], { ordered: true });
});

// --- window functions ---------------------------------------------------------------------------

test('RANK and ROWNUMBER', async () => {
  // By sales, descending: Road Bike 4000, Mountain Bike 1600, Jersey 350, Cap 180, Helmet blank (last).
  const row = r('Name', 'rank', 'rn');
  await eq(`EVALUATE SUMMARIZECOLUMNS(Product[Name], "rank", RANK(DENSE, ALLSELECTED(Product[Name]), ORDERBY([Sales Amount], DESC)),
    "rn", ROWNUMBER(ALLSELECTED(Product[Name]), ORDERBY(Product[Name])))`,
  [row('Road Bike', 1, 5), row('Mountain Bike', 2, 4), row('Jersey', 3, 3), row('Cap', 4, 1), row('Helmet', 5, 2)]);
});

test('OFFSET: the month before, in the calendar', async () => {
  const rows = await h.run(`EVALUATE SUMMARIZECOLUMNS('Date'[Year], 'Date'[Month], "s", [Sales Amount],
    "prev", CALCULATE([Sales Amount], OFFSET(-1, ALLSELECTED('Date'[Year], 'Date'[Month]), ORDERBY('Date'[Year], ASC, 'Date'[Month], ASC))))`);
  const at = (y, m) => rows.find(x => x.Year === y && x.Month === m);
  assert.deepEqual([at(2023, 2).prev, at(2023, 6).prev, at(2024, 1).prev, at(2024, 3).prev, at(2024, 6).prev], [1000, null, 50, 300, null]);
  // 2024-04 has no sales, but March's are 800.
  assert.equal(at(2024, 4)?.prev, 800);
});

test('INDEX and WINDOW', async () => {
  await eq('EVALUATE INDEX(1, ALL(Product[Name], Product[Price]), ORDERBY(Product[Price], DESC))', [{ Name: 'Road Bike', Price: 1000 }]);
  await eq('EVALUATE INDEX(-1, ALL(Product[Name], Product[Price]), ORDERBY(Product[Price], DESC))', [{ Name: 'Cap', Price: 20 }]);
  // The cheapest product of each category.
  await eq('EVALUATE INDEX(1, ALL(Product[Name], Product[CategoryKey], Product[Price]), ORDERBY(Product[Price]), PARTITIONBY(Product[CategoryKey]))', [
    { Name: 'Mountain Bike', CategoryKey: 1, Price: 800 }, { Name: 'Cap', CategoryKey: 2, Price: 20 }, { Name: 'Helmet', CategoryKey: 3, Price: 60 }]);
  // A running total by name: Cap 180, Helmet (none) 180, Jersey +350, Mountain Bike +1600, Road Bike +4000.
  const row = r('Name', 'running');
  await eq(`EVALUATE ADDCOLUMNS(VALUES(Product[Name]), "running", CALCULATE([Sales Amount], WINDOW(1, ABS, 0, REL, ALL(Product[Name]), ORDERBY(Product[Name]))))`,
    [row('Cap', 180), row('Helmet', 180), row('Jersey', 530), row('Mountain Bike', 2130), row('Road Bike', 6130)]);
  // A moving window of three, by price: 20, 50, 60 | 50, 60, 800 | ...
  const m = r('Price', 'n');
  await eq(`EVALUATE ADDCOLUMNS(VALUES(Product[Price]), "n", CALCULATE(SUM(Product[Price]), WINDOW(-1, 1, ALL(Product[Price]), ORDERBY(Product[Price]))))`,
    [m(20, 70), m(50, 130), m(60, 910), m(800, 1860), m(1000, 1800)]);
});

test('window functions: no outer value, both ends absolute, RANK by its ORDERBY columns, BLANKS LAST, a related PARTITIONBY', async () => {
  // OFFSET(-1) with no current product: the union of each product's previous one (all but Road Bike).
  await eq('EVALUATE ROW("prev", CALCULATE([Sales Amount], OFFSET(-1, ALL(Product[Name]), ORDERBY(Product[Name]))))', [{ prev: 2130 }]);
  // The whole partition, once: 5 rows.
  await eq(`EVALUATE ROW("n", COUNTROWS(WINDOW(1, ABS, -1, ABS, ALL(Product[Name], Product[CategoryKey]), ORDERBY(Product[Name]), PARTITIONBY(Product[CategoryKey]))))`, [{ n: 5 }]);
  // RANK's current row is the color's: the names under it tie.
  const c = r('Color', 'r');
  await eq(`EVALUATE SUMMARIZECOLUMNS(Product[Color], "r", RANK(DENSE, ALL(Product[Color], Product[Name]), ORDERBY(Product[Color])))`, [c('Black', 1), c('Blue', 2), c('Red', 3)]);
  // Helmet has no sales: last.
  const n = r('Name', 'r');
  await eq(`EVALUATE ADDCOLUMNS(VALUES(Product[Name]), "r", RANK(DENSE, ALL(Product[Name]), ORDERBY([Sales Amount], ASC BLANKS LAST)))`,
    [n('Cap', 1), n('Jersey', 2), n('Mountain Bike', 3), n('Road Bike', 4), n('Helmet', 5)]);
  // With no relation, ALLSELECTED of the column, blank row included.
  const k = r('Customer', 'r');
  await eq(`EVALUATE SUMMARIZECOLUMNS(Customer[Customer], "r", RANK(DENSE, ORDERBY(Customer[Customer])))`, [k(null, 1), k('Alice', 2), k('Bob', 3), k('Chloe', 4), k('Dan', 5)]);
  // Partitioned by a related table's column: the cheaper product of the same category.
  const p = r('Name', 'prev');
  await eq(`EVALUATE SELECTCOLUMNS(ALL(Product), "Name", Product[Name], "prev", CALCULATE(SELECTEDVALUE(Product[Name]), OFFSET(-1, ALL(Product), ORDERBY(Product[Price]), PARTITIONBY(Category[Category]))))`,
    [p('Road Bike', 'Mountain Bike'), p('Mountain Bike', null), p('Jersey', 'Cap'), p('Cap', null), p('Helmet', null)]);
});

// --- the blank row ----------------------------------------------------------------------------

test('the blank row: VALUES and ALL list it, DISTINCT, ALLNOBLANKROW and the table do not', async () => {
  // Customer 99 bought, and is not in Customer.
  await eq(`EVALUATE ROW("values", COUNTROWS(VALUES(Customer)), "distinct", COUNTROWS(DISTINCT(Customer)), "table", COUNTROWS(Customer),
    "all", COUNTROWS(ALL(Customer[Customer])), "noblank", COUNTROWS(ALLNOBLANKROW(Customer[Customer])))`,
  [{ values: 5, distinct: 4, table: 4, all: 5, noblank: 4 }]);
  // Its sales are the unknown customer's.
  const row = r('Customer', 's');
  await eq('EVALUATE ADDCOLUMNS(VALUES(Customer[Customer]), "s", [Sales Amount])',
    [row('Alice', 2000), row('Bob', 1850), row('Chloe', 2260), row('Dan', null), row(null, 20)]);
  // A filter on the customer leaves it out; Product, whose keys all match, has none.
  await eq('EVALUATE CALCULATETABLE(ROW("n", COUNTROWS(VALUES(Customer[City]))), Customer[City] <> "Berlin")', [{ n: 3 }]);
  await eq('EVALUATE ROW("n", COUNTROWS(VALUES(Product[Color])))', [{ n: 3 }]);
  // As a filter: the blank row's sales.
  await eq('EVALUATE ROW("s", CALCULATE([Sales Amount], FILTER(VALUES(Customer[Customer]), ISBLANK(Customer[Customer]))))', [{ s: 20 }]);
  const off = await harness(bim, setup, { blankRows: false });
  await eqWith(off, 'EVALUATE ROW("n", COUNTROWS(VALUES(Customer)))', [{ n: 4 }]);
});

test('the blank row: matched by blanks in table filters, in HASONEVALUE, and down a snowflake', async () => {
  // A blank city: the unknown customer's 20, as a constant, a table, or a filter on the fact.
  await eq(`EVALUATE ROW("t", CALCULATE([Sales Amount], TREATAS({BLANK()}, Customer[City])), "c", CONTAINSROW({BLANK()}, BLANK()),
    "v", CALCULATE([Sales Amount], VALUES(Customer[City])), "d", CALCULATE([Sales Amount], DISTINCT(Customer[City])))`, [{ t: 20, c: true, v: 6130, d: 6110 }]);
  const c = r('City', 's');
  await eq('EVALUATE CALCULATETABLE(ADDCOLUMNS(VALUES(Customer[City]), "s", [Sales Amount]), FILTER(Sales, Sales[Qty] = 1))', [c('Paris', 1800), c('London', 1850), c(null, 20)]);
  const k = r('Customer', 'h', 'sv');
  await eq(`EVALUATE SUMMARIZECOLUMNS(Customer[Customer], "h", HASONEVALUE(Customer[Customer]), "sv", SELECTEDVALUE(Customer[Customer], "none"))`,
    [k('Alice', true, 'Alice'), k('Bob', true, 'Bob'), k('Chloe', true, 'Chloe'), k('Dan', true, 'Dan'), k(null, true, null)]);
  // A sale of an unknown product: Product's blank row, and so Category's.
  const s2 = setup.replace("('2024-07-01', '2024-07-05', 4, 99, 1, 20)) t(o, s, p, c, q, a);", "('2024-07-01', '2024-07-05', 4, 99, 1, 20), ('2024-08-01', '2024-08-02', 99, 1, 2, 30)) t(o, s, p, c, q, a);");
  const g = r('Category', 's', 'one');
  await eqWith(await harness(bim, s2), 'EVALUATE SUMMARIZECOLUMNS(Category[Category], "s", [Sales Amount], "one", 1)',
    [g('Bikes', 5600, 1), g('Clothing', 530, 1), g('Accessories', null, 1), g(null, 30, 1)]);
});

test('context transition filters every column of the row', async () => {
  // ALLEXCEPT keeps the city; removing the key's filter keeps the others (the customer's).
  const row = r('Customer', 'city', 'noKey');
  await eq(`EVALUATE SELECTCOLUMNS(Customer, "Customer", Customer[Customer], "city", CALCULATE([Sales Amount], ALLEXCEPT(Customer, Customer[City])),
    "noKey", CALCULATE([Sales Amount], REMOVEFILTERS(Customer[CustomerKey])))`,
  [row('Alice', 4260, 2000), row('Bob', 1850, 1850), row('Chloe', 4260, 2260), row('Dan', null, null)]);
  // A time intelligence function's date column is CALCULATETABLE(DISTINCT(column)): in a row
  // of the date table, the month before that day. Each day of 2024 adds its previous month's
  // sales: 31 * 50 + 29 * 2000 + 31 * 300 + 30 * 800 + 31 * 1000 + 31 * 20.
  await eq(`EVALUATE ROW("s", SUMX(FILTER('Date', 'Date'[Year] = 2024), CALCULATE([Sales Amount], PREVIOUSMONTH('Date'[Date]))))`, [{ s: 124470 }]);
});

// --- FORMAT -------------------------------------------------------------------------------

// FORMAT(value, pattern) for each [value, pattern, text]: in one ROW, one column each.
const formats = async cases => {
  const cols = cases.map(([v, f], i) => `"c${i}", FORMAT(${v}, "${f.replace(/"/g, '""')}")`).join(', ');
  const [row] = await h.run(`EVALUATE ROW(${cols})`);
  assert.deepEqual(cases.map((_, i) => row[`c${i}`]), cases.map(c => c[2]));
};

test('FORMAT: the named number formats (the documented 12345.67 examples)', () => formats([
  ['12345.67', 'General Number', '12345.67'], ['12345.67', 'Currency', '$12,345.67'], ['12345.67', 'Fixed', '12345.67'],
  ['12345.67', 'Standard', '12,345.67'], ['12345.67', 'Percent', '1,234,567.00 %'], ['12345.67', 'Scientific', '1.23E+04'],
  ['-12345.67', 'Currency', '($12,345.67)'], ['0', 'Yes/No', 'No'], ['3', 'True/False', 'True'], ['0', 'On/Off', 'Off'],
  ['TRUE()', 'Yes/No', 'Yes'], ['1e20', 'General Number', '1E+20'], ['0.1 + 0.2', 'General Number', '0.3'], ['12345', 'General Number', '12345'],
]));

test('FORMAT: custom number patterns', () => formats([
  // Rounding: at 15 significant digits, then half away from zero.
  ['1.005', '0.00', '1.01'], ['2.5', '0', '3'], ['-2.5', '0', '-3'], ['-0.001', '0.00', '0.00'],
  // # shows a digit or nothing; 0 a digit or 0; the point stays.
  ['0.5', '#.##', '.5'], ['5', '#.##', '5.'], ['5', '0.0#', '5.0'], ['5.125', '0.0#', '5.13'], ['0', '#', ''], ['0', '0', '0'],
  ['5', '0000', '0005'], ['5', '0,000', '0,005'],
  // Thousands, and scaling by 1000 for each comma before the point or at the end.
  ['1234567', '#,##0', '1,234,567'], ['1234567', '#,##0,', '1,235'], ['1234567890', '#,##0.0,,', '1,234.6'],
  ['1e20', '#,##0', '100,000,000,000,000,000,000'],
  // Literals, in place: quoted, escaped, between the digits.
  ['5551234567', '(###) ###-####', '(555) 123-4567'], ['123456789', '000-00-0000', '123-45-6789'],
  ['1234.5', '\\$#,##0.00', '$1,234.50'], ['1234.5', '"USD "0', 'USD 1235'], ['0.256', '0.0%', '25.6%'],
  // Sections: positive; negative; zero. A negative that rounds to zero is the zero.
  ['-5', '0;(0)', '(5)'], ['0', '0;(0);"zero"', 'zero'], ['-0.001', '0.0;(0.0);"zero"', 'zero'], ['-5', '0;;"z"', '-5'],
  // Exponents.
  ['0.000123', '0.00E+00', '1.23E-04'], ['123456', '0.00e-0', '1.23e5'], ['9.996', '0.00E+00', '1.00E+01'],
  ['0', '0.00E+00', '0.00E+00'], ['-123456', '0.0E+00', '-1.2E+05'],
  // A blank is "", text itself, and an empty pattern General Number.
  ['BLANK()', '0.00', ''], ['"abc"', '0', 'abc'], ['1234.5678', '', '1234.5678'],
]));

test('FORMAT: dates and times', () => formats([
  ['dt"2024-01-05"', 'Short Date', '1/5/2024'], ['dt"2024-01-05"', 'Long Date', 'Friday, January 5, 2024'],
  ['dt"2024-01-05"', 'dd/mm/yyyy', '05/01/2024'], ['dt"2024-01-05"', 'mmm d, yy', 'Jan 5, 24'], ['dt"2024-01-05"', 'ddd mmmm', 'Fri January'],
  ['dt"2024-08-05"', '"Q"q yyyy', 'Q3 2024'], ['dt"2024-01-05"', 'y w ww', '5 6 1'], ['dt"2024-12-31"', 'y ww', '366 53'],
  // m after h is minutes; with AM/PM the hours are on a 12-hour clock.
  ['dt"2024-01-05 15:04:09"', 'h:nn:ss AM/PM', '3:04:09 PM'], ['dt"2024-01-05 15:04:09"', 'hh:mm', '15:04'],
  ['dt"2024-01-05 15:04:09"', 'h:mm a/p', '3:04 p'], ['dt"2024-01-05 09:04:09"', 'Long Time', '9:04:09 AM'], ['dt"2024-01-05 09:04:09"', 'Short Time', '09:04'],
  ['dt"2024-01-05 15:04:09"', 'General Date', '1/5/2024 3:04:09 PM'], ['dt"2024-01-05"', 'General Date', '1/5/2024'],
  ['dt"2024-01-05"', 'c', '1/5/2024'], ['dt"2024-01-05"', 'ddddd', '1/5/2024'], ['dt"2024-01-05"', 'dddddd', 'Friday, January 5, 2024'],
  ['dt"2024-01-05"', 'yyyy\\mm', '2024m1'],
  // A date with a number pattern is its serial number, and a number with a date one a date.
  ['dt"2024-01-05"', '0', '45296'], ['45296.5', 'General Date', '1/5/2024 12:00:00 PM'],
]));

test('FORMAT over columns and measures; text as DAX converts values', async () => {
  const row = r('Name', 'p', 'k');
  await eq('EVALUATE SELECTCOLUMNS(FILTER(Product, Product[Price] >= 800), "Name", Product[Name], "p", FORMAT(-Product[Price], "$#,##0.00;($#,##0.00)"), "k", FORMAT(Product[ProductKey], "000"))',
    [row('Road Bike', '($1,000.00)', '001'), row('Mountain Bike', '($800.00)', '002')]);
  // FORMAT is never blank: SUMMARIZECOLUMNS keeps Berlin, which has no sales, as DAX does.
  const c = r('City', 's');
  await eq('EVALUATE SUMMARIZECOLUMNS(Customer[City], "s", FORMAT([Sales Amount], "#,##0", "en-US"))',
    [c('Paris', '4,260'), c('London', '1,850'), c('Berlin', ''), c(null, '20')]);
  await eq(`EVALUATE ROW("a", 3.0 & "", "b", (0.1 + 0.2) & "", "c", dt"2024-01-05" & "", "d", dt"2024-01-05 15:04:09" & "", "e", TRUE() & "", "f", 1e20 & "")`,
    [{ a: '3', b: '0.3', c: '1/5/2024', d: '1/5/2024 3:04:09 PM', e: 'True', f: '1E+20' }]);
  await assert.rejects(h.run('EVALUATE ROW("a", FORMAT(1, "0", "fr-FR"))'), /locale other than en-US/);
  // A time is a date on day zero; values of two kinds are each formatted as theirs; a number
  // with a date pattern is that date.
  await eq(`EVALUATE ROW("a", TIME(13, 5, 0) & "", "b", FORMAT(TIME(13, 5, 0), "hh:nn"), "c", FORMAT(DATE(2024, 1, 5) + TIME(13, 5, 0), "General Date"),
    "d", FORMAT(IF(1 = 1, 1.5, "x"), "0.00"), "e", FORMAT(45296, "dd/mm/yyyy"), "f", COMBINEVALUES(",", 1/3, dt"2024-01-05", TRUE()))`,
  [{ a: '1:05:00 PM', b: '13:05', c: '1/5/2024 1:05:00 PM', d: '1.50', e: '05/01/2024', f: '0.333333333333333,1/5/2024,True' }]);
});
