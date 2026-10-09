// DAX semantics, on the small sales model of fixtures/contoso.js. Every expected result is
// worked out by hand from its 11 sales; the comment above each says how.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { harness, sorted } from './helpers.js';
import { bim, setup } from './fixtures/contoso.js';

let h;
before(async () => { h = await harness(bim, setup); });

const eq = async (dax, expected, { ordered = false } = {}) => {
  const rows = await h.run(dax);
  assert.deepEqual(ordered ? rows : sorted(rows), ordered ? expected : sorted(expected));
};
const r = (...names) => (...values) => Object.fromEntries(names.map((n, i) => [n, values[i]]));

// --- grouping and blanks --------------------------------------------------------------------

test('a measure on its own', () => eq('EVALUATE ROW("s", [Sales Amount])', [{ s: 6130 }]));

test('grouped by a dimension column', async () => {
  // Red: Road Bike + Jersey = 1000+100+50+2000+200+1000; Black: Mountain Bike 800+800; Blue: Cap 60+100+20.
  // Helmet (Black) has no sales and adds nothing.
  const row = r('Color', 's');
  await eq('EVALUATE SUMMARIZECOLUMNS(Product[Color], "s", [Sales Amount])', [row('Red', 4350), row('Black', 1600), row('Blue', 180)]);
});

test('grouped by a column two relationships away (snowflake), empty groups left out', async () => {
  const row = r('Category', 's');
  await eq('EVALUATE SUMMARIZECOLUMNS(Category[Category], "s", [Sales Amount])', [row('Bikes', 5600), row('Clothing', 530)]);
});

test('sales to an unknown customer go to the blank customer', async () => {
  const row = r('Customer', 's');
  await eq('EVALUATE SUMMARIZECOLUMNS(Customer[Customer], "s", [Sales Amount])',
    [row('Alice', 2000), row('Bob', 1850), row('Chloe', 2260), row(null, 20)]);
});

test('two dimensions: their combinations that have a value', async () => {
  // Paris is Alice and Chloe. Berlin (Dan) has no sales.
  const row = r('City', 'Year', 's');
  await eq('EVALUATE SUMMARIZECOLUMNS(Customer[City], \'Date\'[Year], "s", [Sales Amount])', [
    row('Paris', 2023, 1160), row('Paris', 2024, 3100), row('London', 2023, 850), row('London', 2024, 1000), row(null, 2024, 20)]);
});

test('blank arithmetic and comparison', () => eq(
  'EVALUATE ROW("a", BLANK() + 1, "b", BLANK() * 2, "c", IF(BLANK() = 0, "yes", "no"), "d", BLANK() = BLANK(), "e", BLANK() == 0, "f", "x" & BLANK() & 1)',
  [{ a: 1, b: null, c: 'yes', d: true, e: false, f: 'x1' }]));

test('COUNTROWS of nothing is blank', () => eq('EVALUATE CALCULATETABLE(ROW("n", [Orders]), Product[Color] = "Green")', [{ n: null }]));

test('a grouping with constant expressions keeps every value of the column, and the blank row', async () => {
  // ISFILTERED is never blank, so Berlin stays, with a blank sum; so does the blank city of
  // the blank row Customer has for customer 99, who bought 20.
  const row = r('City', 'f', 'cf', 'pf', 's');
  await eq('EVALUATE SUMMARIZECOLUMNS(Customer[City], "f", ISFILTERED(Customer[City]), "cf", ISCROSSFILTERED(Sales[Qty]), "pf", ISFILTERED(Product[Color]), "s", [Sales Amount])', [
    row('Berlin', true, true, false, null), row('London', true, true, false, 1850), row('Paris', true, true, false, 4260), row(null, true, true, false, 20)]);
  // The same groups whether or not the expressions can be read from the sales alone.
  const two = r('Customer', 's', 'one');
  await eq('EVALUATE SUMMARIZECOLUMNS(Customer[Customer], "s", [Sales Amount], "one", 1)',
    [two('Alice', 2000, 1), two('Bob', 1850, 1), two('Chloe', 2260, 1), two('Dan', null, 1), two(null, 20, 1)]);
  // A filter on the city leaves the blank row out.
  await eq('EVALUATE SUMMARIZECOLUMNS(Customer[Customer], TREATAS({"Paris"}, Customer[City]), "one", 1)',
    [{ Customer: 'Alice', one: 1 }, { Customer: 'Chloe', one: 1 }]);
});

test('SUMMARIZECOLUMNS filter table, and IGNORE', async () => {
  const row = r('Color', 's', 'i');
  await eq('EVALUATE SUMMARIZECOLUMNS(Product[Color], TREATAS({"Red", "Black"}, Product[Color]), "s", [Sales Amount], "i", IGNORE(1))',
    [row('Red', 4350, 1), row('Black', 1600, 1)]);
});

test('subtotals with ROLLUPADDISSUBTOTAL, and ISINSCOPE', async () => {
  const row = r('Color', 'IsTotal', 's', 'lvl');
  await eq(`DEFINE MEASURE Sales[Level] = IF(ISINSCOPE(Product[Color]), "color", "total")
    EVALUATE SUMMARIZECOLUMNS(ROLLUPADDISSUBTOTAL(Product[Color], "IsTotal"), "s", [Sales Amount], "lvl", [Level])`, [
    row('Red', false, 4350, 'color'), row('Black', false, 1600, 'color'), row('Blue', false, 180, 'color'), row(null, true, 6130, 'total')]);
});

// --- CALCULATE and the filter context ---------------------------------------------------

test('a filter replaces the filter on its column; KEEPFILTERS intersects', async () => {
  const row = r('Color', 'red', 'kept');
  await eq('EVALUATE SUMMARIZECOLUMNS(Product[Color], "red", [Red Sales], "kept", [Red Sales Kept])',
    [row('Red', 4350, 4350), row('Black', 4350, null), row('Blue', 4350, null)]);
});

test('ALL on the fact table removes the filters on its dimensions too', async () => {
  const row = r('Color', 'all');
  await eq('EVALUATE SUMMARIZECOLUMNS(Product[Color], "all", [All Sales])', [row('Red', 6130), row('Black', 6130), row('Blue', 6130)]);
});

test('ALL on a column keeps the other filters on its table', () => eq(
  'EVALUATE CALCULATETABLE(ROW("s", CALCULATE([Sales Amount], ALL(Product[Color]))), Product[Color] = "Black", Product[Name] = "Jersey")',
  [{ s: 350 }]));

test('ALLEXCEPT keeps the filter on the category, when there is one', async () => {
  // Road Bike 4000 of Bikes 5600, Mountain Bike 1600; Jersey 350 of Clothing 530, Cap 180. Helmet: blank.
  const row = r('Category', 'Name', 'share');
  await eq('EVALUATE SUMMARIZECOLUMNS(Category[Category], Product[Name], "share", [Share of Category])', [
    row('Bikes', 'Road Bike', 0.714285714), row('Bikes', 'Mountain Bike', 0.285714286),
    row('Clothing', 'Jersey', 0.660377358), row('Clothing', 'Cap', 0.339622642)]);
  // Grouped by the name alone, nothing filters the category: the share is of all sales (6130).
  const one = r('Name', 'share');
  await eq('EVALUATE SUMMARIZECOLUMNS(Product[Name], "share", [Share of Category])', [
    one('Road Bike', 0.652528548), one('Mountain Bike', 0.261011419), one('Jersey', 0.057096248), one('Cap', 0.029363785)]);
});

test('a filter on a dimension two relationships away', () => eq(
  'EVALUATE CALCULATETABLE(ROW("s", [Sales Amount]), Category[Category] = "Clothing")', [{ s: 530 }]));

test('a table filter on the fact: FILTER(Sales, ...)', async () => {
  // Amount > 100: Red 1000, 2000, 200, 1000; Black 800, 800; Blue none (100 is not > 100).
  const row = r('Color', 'big');
  await eq('EVALUATE SUMMARIZECOLUMNS(Product[Color], "big", [Big Orders])', [row('Red', 4), row('Black', 2)]);
});

test('USERELATIONSHIP: by ship date instead of order date', async () => {
  // Sale 5 is ordered on 2023-12-30 and shipped on 2024-01-03.
  const row = r('Year', 'order', 'ship');
  await eq('EVALUATE SUMMARIZECOLUMNS(\'Date\'[Year], "order", [Sales Amount], "ship", [Sales by Ship Date])',
    [row(2023, 2010, 1960), row(2024, 4120, 4170)]);
});

test('CROSSFILTER both: the customers of the sales of each colour', async () => {
  // Red: Alice, Bob, Chloe; Black: Bob, Alice; Blue: Chloe, Alice (and customer 99, unknown).
  const row = r('Color', 'c', 'n');
  await eq(`EVALUATE SUMMARIZECOLUMNS(Product[Color],
      "c", CALCULATE(COUNTROWS(Customer), CROSSFILTER(Sales[CustomerKey], Customer[CustomerKey], Both)),
      "n", COUNTROWS(Customer))`, [row('Red', 3, 4), row('Black', 2, 4), row('Blue', 2, 4)]);
});

test('ALLSELECTED: share of what the query selects', async () => {
  // Red and Blue are selected: 4350 + 180 = 4530.
  const row = r('Color', 'pct');
  await eq(`EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS(Product[Color],
      "pct", DIVIDE([Sales Amount], CALCULATE([Sales Amount], ALLSELECTED(Product[Color])))), Product[Color] IN {"Red", "Blue"})`,
  [row('Red', 0.960264901), row('Blue', 0.039735099)]);
});

test('IN a table variable, TREATAS', async () => {
  await eq('EVALUATE VAR t = {"Red", "Blue"} RETURN CALCULATETABLE(ROW("s", [Sales Amount]), Product[Color] IN t)', [{ s: 4530 }]);
  await eq('EVALUATE CALCULATETABLE(ROW("s", [Sales Amount]), TREATAS({"Paris"}, Customer[City]))', [{ s: 4260 }]);
});

// --- row context and context transition ----------------------------------------------------

test('context transition in an iterator', () => eq('EVALUATE ROW("best", [Best Customer Sales])', [{ best: 2260 }]));

test('FILTER over a table with a measure, counted', async () => {
  // Products with sales: Bikes 2, Clothing 2; Accessories (Helmet) none: blank, left out.
  const row = r('Category', 'n');
  await eq('EVALUATE SUMMARIZECOLUMNS(Category[Category], "n", [Products Sold])', [row('Bikes', 2), row('Clothing', 2)]);
});

test('ALL inside CALCULATE in an iterator undoes the transition', () => eq(
  'EVALUATE ROW("x", SUMX(VALUES(Product[Color]), CALCULATE([Sales Amount], ALL(Product))))', [{ x: 18390 }]));

test('RELATED in an iterator, and calculated columns', async () => {
  await eq('EVALUATE ROW("a", [Line Value], "b", [Line Value Column])', [{ a: 6130, b: 6130 }]);
  const row = r('PriceBand', 's');
  await eq('EVALUATE SUMMARIZECOLUMNS(Product[PriceBand], "s", [Sales Amount])', [row('High', 5600), row('Low', 530)]);
});

test('ADDCOLUMNS over SUMMARIZE, by a related column', async () => {
  const row = r('City', 's');
  await eq('EVALUATE ADDCOLUMNS(SUMMARIZE(Sales, Customer[City]), "s", [Sales Amount])', [row('Paris', 4260), row('London', 1850), row(null, 20)]);
});

test('GROUPBY with CURRENTGROUP', async () => {
  const row = r('Color', 'q');
  await eq('EVALUATE GROUPBY(Sales, Product[Color], "q", SUMX(CURRENTGROUP(), Sales[Qty]))', [row('Red', 11), row('Black', 2), row('Blue', 9)]);
});

test('EARLIER', async () => {
  const row = r('Price', 'cheaper');
  await eq('EVALUATE ADDCOLUMNS(VALUES(Product[Price]), "cheaper", COUNTROWS(FILTER(ALL(Product), Product[Price] < EARLIER(Product[Price]))))', [
    row(1000, 4), row(800, 3), row(60, 2), row(50, 1), row(20, null)]);
});

test('RANKX over all products, a blank ranked last', async () => {
  const row = r('Name', 'rank');
  await eq('EVALUATE ADDCOLUMNS(VALUES(Product[Name]), "rank", RANKX(ALL(Product[Name]), [Sales Amount]))', [
    row('Road Bike', 1), row('Mountain Bike', 2), row('Jersey', 3), row('Cap', 4), row('Helmet', 5)]);
});

test('GENERATE with TOPN: both row contexts become filters', async () => {
  // Red: Chloe 2200 > Alice 1100 > Bob 1050. Black: Alice and Bob tie at 800. Blue: Alice 100.
  const row = r('Color', 'Customer');
  await eq('EVALUATE GENERATE(VALUES(Product[Color]), TOPN(1, VALUES(Customer[Customer]), [Sales Amount]))',
    [row('Red', 'Chloe'), row('Black', 'Alice'), row('Black', 'Bob'), row('Blue', 'Alice')]);
});

// --- two facts ------------------------------------------------------------------------------

test('two facts through shared dimensions', async () => {
  const row = r('Year', 'q', 'ret');
  await eq('EVALUATE SUMMARIZECOLUMNS(\'Date\'[Year], "q", [Quantity], "ret", [Returned])', [row(2023, 8, 1), row(2024, 14, 3)]);
});

test('a ratio of two facts', async () => {
  // Jersey 1 of 7, Cap 2 of 9, Mountain Bike 1 of 2; Road Bike has no returns: blank.
  const row = r('Name', 'rr');
  await eq('EVALUATE SUMMARIZECOLUMNS(Product[Name], "rr", [Return Rate])', [row('Jersey', 0.142857143), row('Cap', 0.222222222), row('Mountain Bike', 0.5)]);
});

// --- time intelligence ------------------------------------------------------------------------

test('TOTALYTD by month', async () => {
  const row = r('Month', 's', 'ytd');
  const months = [[1, 2000, 2000], [2, 300, 2300], [3, 800, 3100], [4, null, 3100], [5, null, 3100], [6, 1000, 4100],
    [7, 20, 4120], [8, null, 4120], [9, null, 4120], [10, null, 4120], [11, null, 4120], [12, null, 4120]];
  await eq(`EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('Date'[Month], "s", [Sales Amount], "ytd", [Sales YTD]), 'Date'[Year] = 2024)`,
    months.map(m => row(...m)));
});

test('SAMEPERIODLASTYEAR: no dates before 2023, so blank', async () => {
  const row = r('Year', 's', 'py');
  await eq('EVALUATE SUMMARIZECOLUMNS(\'Date\'[Year], "s", [Sales Amount], "py", [Sales PY])', [row(2023, 2010, null), row(2024, 4120, 2010)]);
});

test('DATESBETWEEN, DATESINPERIOD, PREVIOUSMONTH', async () => {
  await eq('EVALUATE ROW("s", CALCULATE([Sales Amount], DATESBETWEEN(\'Date\'[Date], dt"2024-01-01", dt"2024-02-29")))', [{ s: 2300 }]);
  // (2023-12-31, 2024-03-31]: sale 5 (2023-12-30) is out.
  await eq('EVALUATE ROW("s", CALCULATE([Sales Amount], DATESINPERIOD(\'Date\'[Date], dt"2024-03-31", -3, MONTH)))', [{ s: 3100 }]);
  await eq(`EVALUATE CALCULATETABLE(ROW("pm", CALCULATE([Sales Amount], PREVIOUSMONTH('Date'[Date]))), 'Date'[Year] = 2024, 'Date'[Month] = 3)`, [{ pm: 300 }]);
});

// --- tables --------------------------------------------------------------------------------

test('TOPN keeps ties', async () => {
  const row = r('Value1', 'Value2');
  await eq('EVALUATE TOPN(1, {("a", 1), ("b", 1), ("c", 0)}, [Value2])', [row('a', 1), row('b', 1)]);
  await eq('EVALUATE TOPN(2, VALUES(Product[Name]), [Sales Amount])', [{ Name: 'Road Bike' }, { Name: 'Mountain Bike' }]);
});

test('set operations', async () => {
  await eq('EVALUATE EXCEPT(VALUES(Product[Color]), {"Red"})', [{ Color: 'Black' }, { Color: 'Blue' }]);
  await eq('EVALUATE INTERSECT(VALUES(Customer[City]), {"Paris", "Rome"})', [{ City: 'Paris' }]);
  await eq('EVALUATE UNION({1}, {2})', [{ Value: 1 }, { Value: 2 }]);
});

test('ORDER BY, a blank last when descending', () => eq(
  'EVALUATE SUMMARIZECOLUMNS(Customer[Customer], "s", [Sales Amount]) ORDER BY [s] DESC',
  [{ Customer: 'Chloe', s: 2260 }, { Customer: 'Alice', s: 2000 }, { Customer: 'Bob', s: 1850 }, { Customer: null, s: 20 }], { ordered: true }));

test('SELECTEDVALUE, LOOKUPVALUE, CONCATENATEX', async () => {
  const row = r('Color', 'name');
  await eq('EVALUATE SUMMARIZECOLUMNS(Product[Color], "name", SELECTEDVALUE(Product[Name], "many"))', [row('Red', 'many'), row('Black', 'many'), row('Blue', 'Cap')]);
  await eq('EVALUATE ROW("p", LOOKUPVALUE(Product[Price], Product[Name], "Cap"))', [{ p: 20 }]);
  await eq('EVALUATE ROW("c", CONCATENATEX(DISTINCT(Customer[City]), Customer[City], ", ", Customer[City], ASC))', [{ c: 'Berlin, London, Paris' }]);
  // VALUES lists the blank row (customer 99 is not in Customer), first when ascending.
  await eq('EVALUATE ROW("c", CONCATENATEX(VALUES(Customer[City]), Customer[City], ", ", Customer[City], ASC))', [{ c: ', Berlin, London, Paris' }]);
});

test('DEFINE MEASURE and a query VAR', () => eq(
  'DEFINE MEASURE Sales[Double] = [Sales Amount] * 2 VAR minAmount = 500 EVALUATE CALCULATETABLE(ROW("d", [Double]), Sales[Amount] > minAmount)',
  [{ d: 11200 }]));

test('scalar functions', () => eq(`EVALUATE ROW("l", LEFT("Hello", 2), "u", UPPER("ab"), "len", LEN("abc"), "y", YEAR(dt"2024-03-05"),
    "eom", EOMONTH(dt"2024-02-10", 0), "f", FORMAT(1234.5, "#,##0.00"), "fd", FORMAT(dt"2024-03-05", "yyyy-mm-dd"),
    "sw", SWITCH(2, 1, "one", 2, "two", "other"), "d", DATEDIFF(dt"2024-01-01", dt"2024-03-01", MONTH),
    "dv", DIVIDE(1, 0, -1), "r", ROUND(2.5, 0), "c", CONTAINSSTRING("Hello", "ELL"), "dt", DATE(2024, 14, 1))`,
[{ l: 'He', u: 'AB', len: 3, y: 2024, eom: '2024-02-29', f: '1,234.50', fd: '2024-03-05', sw: 'two', d: 2, dv: -1, r: 3, c: true, dt: '2025-02-01' }]));

// --- more relationships, time intelligence, errors ------------------------------------------

test('a many-to-many relationship: Customer filters CityTarget, nothing else does', async () => {
  const row = r('Customer', 't');
  await eq('EVALUATE SUMMARIZECOLUMNS(Customer[Customer], "t", [Target])', [row('Alice', 5000), row('Bob', 2000), row('Chloe', 5000)]);
  await eq('EVALUATE CALCULATETABLE(ROW("t", [Target]), Customer[City] = "Paris")', [{ t: 5000 }]);
  // Product filters Sales, and Sales does not filter Customer.
  await eq('EVALUATE CALCULATETABLE(ROW("t", [Target]), Product[Color] = "Red")', [{ t: 8000 }]);
});

test('two filters on one column intersect; REMOVEFILTERS() clears all', async () => {
  await eq('EVALUATE ROW("s", CALCULATE([Sales Amount], Product[Color] = "Red", Product[Color] = "Blue"))', [{ s: null }]);
  await eq('EVALUATE CALCULATETABLE(ROW("s", CALCULATE([Sales Amount], REMOVEFILTERS())), Product[Color] = "Red", Customer[City] = "Paris")', [{ s: 6130 }]);
});

test('KEEPFILTERS on a table filter', async () => {
  // Under Red, keeping {Red, Blue} leaves Red; replacing with it gives Red and Blue.
  await eq(`EVALUATE CALCULATETABLE(ROW("keep", CALCULATE([Sales Amount], KEEPFILTERS(TREATAS({"Red", "Blue"}, Product[Color]))),
    "replace", CALCULATE([Sales Amount], TREATAS({"Red", "Blue"}, Product[Color]))), Product[Color] = "Red")`, [{ keep: 4350, replace: 4530 }]);
});

test('FILTERS and HASONEFILTER', async () => {
  await eq(`EVALUATE CALCULATETABLE(ROW("n", COUNTROWS(FILTERS(Product[Color])), "one", HASONEFILTER(Product[Color]),
    "v", HASONEVALUE(Product[Color])), Product[Color] IN {"Red", "Blue"})`, [{ n: 2, one: false, v: false }]);
});

test('DATEADD from a whole month reaches the end of the moved month', async () => {
  // February 2024 (29 days, ending on the last day of the month) moved a month: all 31 days of March.
  await eq(`EVALUATE CALCULATETABLE(ROW("n", COUNTROWS(DATEADD('Date'[Date], 1, MONTH))), 'Date'[Year] = 2024, 'Date'[Month] = 2)`, [{ n: 31 }]);
  // The 10th to the 20th of March 2024 moved back a month: the 10th to the 20th of February.
  await eq(`EVALUATE CALCULATETABLE(ROW("n", COUNTROWS(DATEADD('Date'[Date], -1, MONTH))), DATESBETWEEN('Date'[Date], dt"2024-03-10", dt"2024-03-20"))`, [{ n: 11 }]);
});

test('PARALLELPERIOD, STARTOF / ENDOF, FIRSTDATE / LASTDATE, NEXTDAY, PREVIOUSYEAR, NEXTYEAR', async () => {
  // From the first visible date for PREVIOUS*, the last for NEXT*: across 2023-12-30 .. 2024-01-02, the year before
  // the first is 2022 (not in the table), the year after the last is 2025 (not either), the previous day is 2023-12-29.
  await eq(`EVALUATE CALCULATETABLE(ROW("py", COUNTROWS(PREVIOUSYEAR('Date'[Date])), "ny", COUNTROWS(NEXTYEAR('Date'[Date])),
      "pd", PREVIOUSDAY('Date'[Date]), "nd", NEXTDAY('Date'[Date])), DATESBETWEEN('Date'[Date], dt"2023-12-30", dt"2024-01-02"))`,
  [{ py: null, ny: null, pd: '2023-12-29', nd: '2024-01-03' }]);
  await eq(`EVALUATE CALCULATETABLE(ROW("py", COUNTROWS(PREVIOUSYEAR('Date'[Date])), "ny", COUNTROWS(NEXTYEAR('Date'[Date]))),
      DATESBETWEEN('Date'[Date], dt"2023-12-30", dt"2023-12-31"))`, [{ py: null, ny: 366 }]);
  await eq(`EVALUATE CALCULATETABLE(ROW("py", COUNTROWS(PARALLELPERIOD('Date'[Date], -1, YEAR)),
      "eom", ENDOFMONTH('Date'[Date]), "soq", STARTOFQUARTER('Date'[Date]), "first", FIRSTDATE('Date'[Date]),
      "last", LASTDATE('Date'[Date]), "next", NEXTDAY('Date'[Date])), 'Date'[Year] = 2024, 'Date'[Month] = 2)`,
  [{ py: 365, eom: '2024-02-29', soq: '2024-01-01', first: '2024-02-01', last: '2024-02-29', next: '2024-03-01' }]);
});

test('CLOSINGBALANCEMONTH, OPENINGBALANCEMONTH', async () => {
  // Sales on the last day of February 2024: sale 8 (200); on the day before it began (2024-01-31): none.
  await eq(`EVALUATE CALCULATETABLE(ROW("c", CLOSINGBALANCEMONTH([Sales Amount], 'Date'[Date]), "o", OPENINGBALANCEMONTH([Sales Amount], 'Date'[Date])),
    'Date'[Year] = 2024, 'Date'[Month] = 2)`, [{ c: 200, o: null }]);
});

test('what is not supported, and what is wrong, says so', async () => {
  const fails = async (dax, code, re) => {
    await assert.rejects(() => h.run(dax), e => e.name === 'DaxError' && e.code === code && re.test(e.message));
  };
  await fails('EVALUATE ROW("x", NOSUCHFUNCTION(1))', 'UNSUPPORTED', /NOSUCHFUNCTION/);
  await fails('EVALUATE ROW("x", [No such measure])', 'SEMANTIC', /No such measure/);
  await fails('EVALUATE ROW("x", Sales[Qty])', 'SEMANTIC', /row context/);
  await fails('EVALUATE ROW("x", SUM(Sales[Qty]', 'SYNTAX', /expected/);
  await fails('EVALUATE ROW("x", CALCULATE([Orders], Product[Color] = "Red" || Customer[City] = "Paris"))', 'SEMANTIC', /one table/);
});

test('names: quoted tables, comments, case', () => eq(
  `// a comment
   EVALUATE /* another */ ROW("s", calculate([sales amount], 'PRODUCT'[color] = "Red")) -- and one more`, [{ s: 4350 }]));

test('SUMMARIZE: its expressions are per group; DATATABLE', async () => {
  const row = r('Color', 'q');
  await eq('EVALUATE SUMMARIZE(Sales, Product[Color], "q", SUM(Sales[Qty]))', [row('Red', 11), row('Black', 2), row('Blue', 9)]);
  await eq('EVALUATE DATATABLE("a", INTEGER, "b", STRING, {{1, "x"}, {2, "y"}})', [{ a: 1, b: 'x' }, { a: 2, b: 'y' }]);
});

// --- found by review ----------------------------------------------------------------------------

test('branches of different types: numbers widen, other kinds are text', async () => {
  // Red 4350/7, Black 1600/7, Blue 180/7.
  const row = r('Color', 'a');
  await eq('EVALUATE SUMMARIZECOLUMNS(Product[Color], "a", IF([Orders] > 100, 0, DIVIDE([Sales Amount], 7)))',
    [row('Red', 621.428571429), row('Black', 228.571428571), row('Blue', 25.714285714)]);
  await eq(`EVALUATE ROW("a", IF([Orders] > 100, 1, 0.5), "b", SWITCH(TRUE(), [Orders] > 100, 1, [Orders] > 5, 0.25, 0.5),
    "c", MOD(8, 2.5), "d", SELECTEDVALUE('Date'[Year], "multi"), "e", SWITCH(TRUE(), 1 = 2, 5, "none"))`,
  [{ a: 0.5, b: 0.25, c: 0.5, d: 'multi', e: 'none' }]);
  await eq('EVALUATE CALCULATETABLE(ROW("a", COALESCE([Orders], 0.5)), Product[Name] = "Helmet")', [{ a: 0.5 }]);
});

test('CROSSFILTER None and one way stop the filter; RELATED still reads the relationship', async () => {
  await eq(`EVALUATE CALCULATETABLE(ROW("none", CALCULATE([Sales Amount], CROSSFILTER(Sales[ProductKey], Product[ProductKey], None)),
    "rev", CALCULATE([Sales Amount], CROSSFILTER(Sales[ProductKey], Product[ProductKey], OneWay_LeftFiltersRight)),
    "rel", CALCULATE(SUMX(Sales, Sales[Qty] * RELATED(Product[Price])), CROSSFILTER(Sales[ProductKey], Product[ProductKey], None))),
    Product[Color] = "Red")`, [{ none: 6130, rev: 6130, rel: 6130 }]);
});

test('GROUPBY over a column ADDCOLUMNS added to a model table', async () => {
  const row = r('big', 'n');
  await eq('EVALUATE GROUPBY(ADDCOLUMNS(Sales, "big", Sales[Amount] >= 1000), [big], "n", COUNTX(CURRENTGROUP(), Sales[Qty]))', [row(true, 3), row(false, 8)]);
});

test('constants: fractions in GENERATESERIES, 64-bit whole numbers, text functions on numbers, functions of BLANK()', async () => {
  await eq('EVALUATE GENERATESERIES(0, 1, 0.25)', [0, 0.25, 0.5, 0.75, 1].map(Value => ({ Value })));
  await eq(`EVALUATE ROW("a", 100000 * 100000, "b", 2147483647 + 1, "l", LEN(12345), "f", LEFT(12345, 2), "y", YEAR(BLANK()),
    "w", DATEDIFF(dt"2024-03-02", dt"2024-03-03", WEEK), "inf", 1 / BLANK())`,
  [{ a: 10000000000, b: 2147483648, l: 5, f: '12', y: null, w: 1, inf: Infinity }]);
  // 1 / BLANK() is infinity, not blank: Helmet stays.
  const rows = await h.run('EVALUATE SUMMARIZECOLUMNS(Product[Name], "x", 1 / [Sales Amount])');
  assert.equal(rows.find(x => x.Name === 'Helmet')?.x, Infinity);
});
