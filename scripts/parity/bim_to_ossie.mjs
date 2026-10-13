// semantic_model/model.bim as an Apache Ossie model (https://github.com/apache/ossie,
// core-spec 0.2.0.dev0), written next to it as semantic_model/ossie.yaml:
//   node scripts/parity/bim_to_ossie.mjs
// model.bim stays the model (Power BI runs it); this file is a copy of it in Ossie, kept in
// step by repo.test.mjs, which also has dax-sql compile every query of the page from both and
// asks for the same SQL.
// Tables are datasets (source schema.table), columns fields (the source column, ANSI_SQL),
// key columns primary keys, relationships many-to-one, and the measures metrics in the DAX
// dialect, as written. What Ossie has no property for is in a POWER_BI extension, as the TMSL
// properties it stands for (dax-sql reads them so): a relationship's crossFilteringBehavior
// and relyOnReferentialIntegrity, and a measure's home table. Nothing else of the TMSL (format
// strings, hidden flags, the Direct Lake partitions) is carried: the compiler does not read it.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const root = new URL('../../', import.meta.url);
export const BIM = new URL('semantic_model/model.bim', root);
export const OSSIE = new URL('semantic_model/ossie.yaml', root);

const text = e => (Array.isArray(e) ? e.join('\n') : e);
const powerBi = data => (Object.keys(data).length
  ? { custom_extensions: [{ vendor_name: 'POWER_BI', data: JSON.stringify(data) }] } : {});
// A dateTime column whose format has no time of day is a date.
const datatype = c => ({ string: 'String', int64: 'Integer', decimal: 'Decimal', double: 'Float', boolean: 'Boolean',
  dateTime: /[Hhms]/.test(c.formatString ?? 'H') ? 'DateTime' : 'Date' })[c.dataType];
const RELATIONSHIP = ['name', 'fromTable', 'fromColumn', 'toTable', 'toColumn'];

export function toOssie(bim) {
  const m = bim.model;
  const doc = {
    version: '0.2.0.dev0',
    name: 'nem',
    description: m.description,
    datasets: m.tables.map(t => {
      const s = t.partitions[0].source;
      const keys = t.columns.filter(c => c.isKey).map(c => c.name);
      return {
        name: t.name,
        source: s.schemaName ? `${s.schemaName}.${s.entityName}` : s.entityName,
        ...(keys.length ? { primary_key: keys } : {}),
        description: t.description,
        fields: t.columns.map(c => ({
          name: c.name,
          expression: { dialects: [{ dialect: 'ANSI_SQL', expression: c.sourceColumn }] },
          datatype: datatype(c),
          description: c.description,
        })),
      };
    }),
    relationships: m.relationships.map(r => ({
      name: r.name, from: r.fromTable, to: r.toTable, from_columns: [r.fromColumn], to_columns: [r.toColumn],
      ...powerBi(Object.fromEntries(Object.entries(r).filter(([k]) => !RELATIONSHIP.includes(k)))),
    })),
    metrics: m.tables.flatMap(t => (t.measures ?? []).map(ms => ({
      name: ms.name,
      expression: { dialects: [{ dialect: 'DAX', expression: text(ms.expression) }] },
      description: ms.description,
      ...powerBi({ table: t.name }),
    }))),
  };
  return '# Generated from model.bim by scripts/parity/bim_to_ossie.mjs: edit model.bim, not this file.\n'
    + stringify(doc, { lineWidth: 0 });
}

export const generate = () => toOssie(JSON.parse(fs.readFileSync(BIM, 'utf8').replace(/^﻿/, '')));

if (process.argv[1] === fileURLToPath(import.meta.url)) fs.writeFileSync(OSSIE, generate());
