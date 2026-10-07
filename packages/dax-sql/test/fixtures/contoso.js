// A small sales model (in the manner of Contoso) and its data, small enough that every
// expected result in the tests can be worked out by hand.
//
// Sales (11 rows) -> Product -> Category, Sales -> Customer, Sales -> Date by OrderDate
// (active) and by ShipDate (inactive); Returns -> Product, Returns -> Date. Date is a date
// table (dataCategory Time). Sale 11 is to customer 99, who is not in Customer. CityTarget
// is related to Customer many-to-many on the city, Customer filtering it.
const col = (name, dataType, extra = {}) => ({ name, dataType, sourceColumn: name, ...extra });
const table = (name, columns, measures = [], extra = {}) => ({
  name, columns, measures: measures.map(([n, e]) => ({ name: n, expression: e })),
  partitions: [{ name, source: { type: 'entity', entityName: name } }], ...extra,
});

export const bim = {
  name: 'contoso',
  compatibilityLevel: 1604,
  model: {
    tables: [
      table('Category', [col('CategoryKey', 'int64', { isKey: true }), col('Category', 'string')]),
      table('Product', [
        col('ProductKey', 'int64', { isKey: true }), col('Name', 'string'), col('Color', 'string'),
        col('CategoryKey', 'int64'), col('Price', 'double'),
        { name: 'PriceBand', dataType: 'string', type: 'calculated', expression: 'IF(Product[Price] >= 100, "High", "Low")' },
      ], [
        ['Avg Price', 'AVERAGE(Product[Price])'],
        ['Product Count', 'COUNTROWS(Product)'],
      ]),
      table('Customer', [col('CustomerKey', 'int64', { isKey: true }), col('Customer', 'string'), col('City', 'string')]),
      table('Date', [col('Date', 'dateTime', { isKey: true }), col('Year', 'int64'), col('Month', 'int64'), col('Quarter', 'int64')],
        [], { dataCategory: 'Time' }),
      table('Sales', [
        col('OrderDate', 'dateTime'), col('ShipDate', 'dateTime'), col('ProductKey', 'int64'), col('CustomerKey', 'int64'),
        col('Qty', 'int64'), col('Amount', 'decimal'),
        { name: 'LineValue', dataType: 'double', type: 'calculated', expression: 'Sales[Qty] * RELATED(Product[Price])' },
      ], [
        ['Sales Amount', 'SUM(Sales[Amount])'],
        ['Quantity', 'SUM(Sales[Qty])'],
        ['Orders', 'COUNTROWS(Sales)'],
        ['Customers', 'DISTINCTCOUNT(Sales[CustomerKey])'],
        ['All Sales', 'CALCULATE([Sales Amount], ALL(Sales))'],
        ['Red Sales', 'CALCULATE([Sales Amount], Product[Color] = "Red")'],
        ['Red Sales Kept', 'CALCULATE([Sales Amount], KEEPFILTERS(Product[Color] = "Red"))'],
        ['Share of Category', 'DIVIDE([Sales Amount], CALCULATE([Sales Amount], ALLEXCEPT(Product, Category[Category])))'],
        ['Sales by Ship Date', 'CALCULATE([Sales Amount], USERELATIONSHIP(Sales[ShipDate], \'Date\'[Date]))'],
        ['Sales YTD', "TOTALYTD([Sales Amount], 'Date'[Date])"],
        ['Sales PY', "CALCULATE([Sales Amount], SAMEPERIODLASTYEAR('Date'[Date]))"],
        ['Big Orders', 'CALCULATE([Orders], FILTER(Sales, Sales[Amount] > 100))'],
        ['Best Customer Sales', 'MAXX(VALUES(Customer[Customer]), [Sales Amount])'],
        ['Products Sold', 'COUNTROWS(FILTER(Product, [Sales Amount] > 0))'],
        ['Line Value', 'SUMX(Sales, Sales[Qty] * RELATED(Product[Price]))'],
        ['Line Value Column', 'SUM(Sales[LineValue])'],
        ['Return Rate', 'DIVIDE([Returned], [Quantity])'],
      ]),
      table('Returns', [col('Date', 'dateTime'), col('ProductKey', 'int64'), col('ReturnQty', 'int64')],
        [['Returned', 'SUM(Returns[ReturnQty])']]),
      table('CityTarget', [col('City', 'string'), col('Target', 'int64')], [['Target', 'SUM(CityTarget[Target])']]),
    ],
    relationships: [
      { name: 'sales_product', fromTable: 'Sales', fromColumn: 'ProductKey', toTable: 'Product', toColumn: 'ProductKey' },
      { name: 'product_category', fromTable: 'Product', fromColumn: 'CategoryKey', toTable: 'Category', toColumn: 'CategoryKey' },
      { name: 'sales_customer', fromTable: 'Sales', fromColumn: 'CustomerKey', toTable: 'Customer', toColumn: 'CustomerKey' },
      { name: 'sales_orderdate', fromTable: 'Sales', fromColumn: 'OrderDate', toTable: 'Date', toColumn: 'Date' },
      { name: 'sales_shipdate', fromTable: 'Sales', fromColumn: 'ShipDate', toTable: 'Date', toColumn: 'Date', isActive: false },
      { name: 'returns_product', fromTable: 'Returns', fromColumn: 'ProductKey', toTable: 'Product', toColumn: 'ProductKey' },
      { name: 'returns_date', fromTable: 'Returns', fromColumn: 'Date', toTable: 'Date', toColumn: 'Date' },
      { name: 'target_city', fromTable: 'CityTarget', fromColumn: 'City', toTable: 'Customer', toColumn: 'City',
        fromCardinality: 'many', toCardinality: 'many' },
    ],
  },
};

export const setup = `
CREATE TABLE "Category" AS SELECT * FROM (VALUES (1, 'Bikes'), (2, 'Clothing'), (3, 'Accessories')) t("CategoryKey", "Category");
CREATE TABLE "Product" AS SELECT * FROM (VALUES
  (1, 'Road Bike', 'Red', 1, 1000.0), (2, 'Mountain Bike', 'Black', 1, 800.0), (3, 'Jersey', 'Red', 2, 50.0),
  (4, 'Cap', 'Blue', 2, 20.0), (5, 'Helmet', 'Black', 3, 60.0)) t("ProductKey", "Name", "Color", "CategoryKey", "Price");
CREATE TABLE "Customer" AS SELECT * FROM (VALUES (1, 'Alice', 'Paris'), (2, 'Bob', 'London'), (3, 'Chloe', 'Paris'), (4, 'Dan', 'Berlin'))
  t("CustomerKey", "Customer", "City");
CREATE TABLE "Date" AS SELECT CAST(d AS DATE) AS "Date", year(d) AS "Year", month(d) AS "Month", quarter(d) AS "Quarter"
  FROM generate_series(TIMESTAMP '2023-01-01', TIMESTAMP '2024-12-31', INTERVAL 1 DAY) g(d);
CREATE TABLE "Sales" AS SELECT CAST(o AS DATE) AS "OrderDate", CAST(s AS DATE) AS "ShipDate", p AS "ProductKey", c AS "CustomerKey",
  q AS "Qty", CAST(a AS DECIMAL(18,4)) AS "Amount" FROM (VALUES
  ('2023-01-15', '2023-01-20', 1, 1, 1, 1000), ('2023-02-10', '2023-02-12', 3, 1, 2, 100),
  ('2023-02-20', '2023-03-02', 2, 2, 1, 800), ('2023-06-05', '2023-06-07', 4, 3, 3, 60),
  ('2023-12-30', '2024-01-03', 3, 2, 1, 50), ('2024-01-10', '2024-01-12', 1, 3, 2, 2000),
  ('2024-02-14', '2024-02-16', 4, 1, 5, 100), ('2024-02-29', '2024-03-02', 3, 3, 4, 200),
  ('2024-03-15', '2024-03-18', 2, 1, 1, 800), ('2024-06-30', '2024-07-02', 1, 2, 1, 1000),
  ('2024-07-01', '2024-07-05', 4, 99, 1, 20)) t(o, s, p, c, q, a);
CREATE TABLE "Returns" AS SELECT CAST(d AS DATE) AS "Date", p AS "ProductKey", q AS "ReturnQty" FROM (VALUES
  ('2023-02-15', 3, 1), ('2024-02-20', 4, 2), ('2024-03-20', 2, 1)) t(d, p, q);
CREATE TABLE "CityTarget" AS SELECT * FROM (VALUES ('Paris', 5000), ('London', 2000), ('Rome', 1000)) t("City", "Target");
`;
